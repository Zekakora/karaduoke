'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { once } = require('events');
const { translate } = require('./i18n');
const environment = require('./environment');

// 服务启动到能响应 /api/state 的等待上限。
// 20s 对「YouTube 在线版」不够：它启动时会一并初始化分离模型的 worker，
// 实测要 26s 左右才就绪，于是被误判成启动失败并把进程杀掉。
const READY_TIMEOUT_MS = 60000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class ServiceManager {
  /**
   * @param root  当前模式下要运行的工程目录（cwd + 数据根）
   * @param entry 显式入口。项目根的 main.js 就是统一入口：它按当前模式
   *              加载对应子工程（karaoke_spo / karaoke_ytb）的 server。
   *              没传时才回退到「工程目录里自己的 main.js / server.js」。
   */
  constructor({ root, entry, mode, store, log, internalToken, onChange }) {
    this.root = root;
    this.entry = entry || '';
    this.mode = mode || '';
    this.store = store;
    this.log = log;
    this.internalToken = internalToken;
    this.onChange = onChange || (() => {});
    this.state = 'stopped';
    this.child = null;
    this.pid = null;
    this.port = null;
    this.startedAt = null;
    this.error = null;
    this.portConflict = false;
    this.lastLines = [];
  }

  config() {
    return this.store.get().service;
  }

  msg(key, params) {
    return translate(this.store.get().language, key, params);
  }

  setState(state, error) {
    this.state = state;
    if (error !== undefined) this.error = error;
    this.onChange();
  }

  tailHint() {
    const lines = this.lastLines.slice(-4).join(' ');
    return lines ? `：${lines}` : '';
  }

  status() {
    const config = this.store.get();
    const configuredPort = this.config().port;
    const passwordChanged = Boolean(this.startedWith && this.startedWith.djPassword !== config.djPassword);
    return {
      state: this.state,
      pid: this.pid,
      port: this.port || configuredPort,
      configuredPort,
      restartRequired: this.state === 'running' && (this.port !== configuredPort || passwordChanged),
      url: this.state === 'running' ? `http://127.0.0.1:${this.port}` : '',
      startedAt: this.startedAt,
      error: this.error
    };
  }

  activePort() {
    return this.state === 'running' ? this.port : null;
  }

  // 解析要执行的入口脚本：优先用启动器指定的统一入口，其次工程自带的入口
  resolveEntry() {
    const candidates = [this.entry, path.join(this.root, 'main.js'), path.join(this.root, 'server.js')].filter(Boolean);
    return candidates.find((file) => {
      try { return fs.existsSync(file); } catch { return false; }
    }) || candidates[candidates.length - 1];
  }

  async start() {
    if (this.state === 'running' || this.state === 'starting') throw new Error(this.msg('service.alreadyRunning'));
    const config = this.store.get();
    const { port, host } = this.config();
    this.error = null;
    this.portConflict = false;
    this.lastLines = [];
    this.port = port;
    this.startedWith = null;
    this.setState('starting', null);

    const spotify = config.spotify || {};
    // 运行环境目录（Python / 模型缓存 / 二进制），由控制面板统一管理
    const envPaths = environment.resolve(this.store.root, config);
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: host,
      DJ_PASSWORD: config.djPassword,
      YOUTUBE_API_KEY: config.youtubeApiKey,
      // Spotify 凭证由控制面板注入，.env 里不再需要写真实值。
      // 空字符串也要传：显式覆盖掉可能残留的旧 .env 值。
      SPOTIFY_CLIENT_ID: spotify.clientId || '',
      SPOTIFY_CLIENT_SECRET: spotify.clientSecret || '',
      SPOTIFY_REDIRECT_URI: spotify.redirectUri || '',
      // 环境目录：karaoke_spo\lib\env.js 与 prepare-queue.js 都会读这几个值
      KARAOKE_ENV_DIR: envPaths.dir,
      KARAOKE_PYTHON: envPaths.python,
      KARAOKE_BIN_DIR: envPaths.binDir,
      KARAOKE_FFMPEG: envPaths.ffmpeg,
      KARAOKE_FFPROBE: envPaths.ffprobe,
      TORCH_HOME: envPaths.torch,
      HF_HOME: envPaths.hf,
      // 让 Python 里 shutil.which("ffmpeg") 也能命中 env\bin
      PATH: envPaths.binDir + path.delimiter + (process.env.PATH || ''),
      PUBLIC_URL: '',
      INTERNAL_TOKEN: this.internalToken,
      // 告诉项目根的 main.js 加载哪个模式的工程（它自己也能从 cwd / 配置推断，这里是显式指定）
      KARADUOKE_MODE: this.mode
    };

    const child = (() => {
      try {
        const entry = this.resolveEntry();
        return spawn(process.execPath, [entry], {
          cwd: this.root,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const message = this.msg('service.spawnFailed', { message: error.message });
        this.error = message;
        this.setState('failed', message);
        this.log.line('launcher', message);
        throw new Error(message);
      }
    })();
    this.child = child;
    this.pid = child.pid;

    const onChunk = chunk => {
      this.log.append('service', chunk);
      const text = String(chunk).replace(/\x1b\[[0-9;]*m/g, '');
      if (/EADDRINUSE|address already in use/i.test(text)) this.portConflict = true;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.lastLines.push(line.trim());
      }
      if (this.lastLines.length > 20) this.lastLines.splice(0, this.lastLines.length - 20);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.once('error', error => {
      this.child = null;
      this.pid = null;
      this.error = this.msg('service.spawnFailed', { message: error.message });
      this.setState('failed', this.error);
    });
    child.once('exit', (code, signal) => this.handleExit(code, signal));

    try {
      await this.waitReady(child, port);
    } catch (error) {
      const message = this.portConflict
        ? this.msg('service.portInUse', { port })
        : (error.message || this.msg('service.startFailed'));
      this.error = message;
      this.setState('failed', message);
      this.log.line('launcher', message);
      await this.killTree();
      throw new Error(message);
    }

    this.startedAt = new Date().toISOString();
    this.startedWith = { djPassword: config.djPassword };
    this.setState('running', null);
    this.log.line('launcher', this.msg('service.started', { url: `http://127.0.0.1:${port}` }));
  }

  async waitReady(child, port) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    // 判据是「进程已经在监听 HTTP」，不是「接口返回 200」。
    // YouTube 在线版是旧版本工程，没有 /api/state（返回 404），
    // 但 404 恰恰证明它已经在服务了 —— 之前按 response.ok 判断会把正常启动误判为失败。
    const endpoints = [
      `http://127.0.0.1:${port}/api/state`,
      `http://127.0.0.1:${port}/`,
    ];
    while (Date.now() < deadline) {
      if (this.state === 'failed') throw new Error(this.error || this.msg('service.startFailed'));
      if (this.child !== child) throw new Error(this.error || this.msg('service.childExited'));
      for (const endpoint of endpoints) {
        try {
          // 拿到任何 HTTP 响应就算就绪
          const response = await fetch(endpoint, { signal: AbortSignal.timeout(1500) });
          if (response.status > 0) return;
        } catch { /* 连接还没通，继续等 */ }
      }
      await delay(250);
    }
    throw new Error(this.msg('service.startTimeout', { seconds: READY_TIMEOUT_MS / 1000, port }));
  }

  handleExit(code, signal) {
    const previousState = this.state;
    this.child = null;
    this.pid = null;
    if (previousState === 'stopping' || previousState === 'stopped') {
      this.setState('stopped', null);
      return;
    }
    if (previousState === 'failed') return;
    const message = this.portConflict
      ? this.msg('service.portInUse', { port: this.port })
      : `${this.msg('service.exited', { code, signal: signal ? `, ${signal}` : '' })}${this.tailHint()}`;
    this.error = message;
    this.setState('failed', message);
    this.log.line('launcher', message);
  }

  async stop() {
    if (this.state === 'stopped') return;
    if (this.state === 'stopping') return;
    this.setState('stopping', null);
    await this.killTree();
    this.startedAt = null;
    this.startedWith = null;
    this.port = null;
    this.setState('stopped', null);
    this.log.line('launcher', this.msg('service.stopped'));
  }

  async restart() {
    await this.stop();
    await delay(250);
    await this.start();
  }

  async killTree() {
    const child = this.child;
    this.child = null;
    this.pid = null;
    if (!child || child.exitCode !== null) return;
    const pid = child.pid;
    if (pid) {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    }
    try { child.kill(); } catch {}
    await Promise.race([once(child, 'exit').catch(() => {}), delay(6000)]);
  }

  // 控制台关闭或崩溃时兜底清理，避免端口被幽灵进程占住。
  killSync() {
    if (this.child && this.child.pid) {
      try {
        execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } catch {}
    }
  }
}

module.exports = { ServiceManager };
