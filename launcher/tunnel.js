'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { once } = require('events');
const { translate } = require('./i18n');
const environment = require('./environment');

const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const CONNECT_TIMEOUT_MS = 30000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

class TunnelManager {
  constructor({ root, store, log, onChange }) {
    this.root = root;
    this.store = store;
    this.log = log;
    this.onChange = onChange || (() => {});
    this.state = 'off';
    this.url = null;
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.error = null;
    this.lastLines = [];
    this.executableCache = null;
    this.executableCheckedAt = 0;
  }

  config() {
    return this.store.get().tunnel;
  }

  msg(key, params) {
    return translate(this.store.get().language, key, params);
  }

  setState(state, error) {
    this.state = state;
    if (error !== undefined) this.error = error;
    this.onChange();
  }

  status() {
    return {
      state: this.state,
      pid: this.pid,
      url: this.url || '',
      startedAt: this.startedAt,
      error: this.error
    };
  }

  tailHint() {
    const lines = this.lastLines.slice(-4).join(' ');
    return lines ? `：${lines}` : '';
  }

  resolveExecutable() {
    const configured = this.config().cloudflaredPath;
    const envPaths = environment.resolve(this.store.root, this.store.get());
    const candidates = [];
    // 相对路径先按项目根解析；其次是控制面板管理的 env\bin，最后兼容旧布局
    if (configured) candidates.push(path.isAbsolute(configured) ? configured : path.join(this.root, configured));
    candidates.push(envPaths.cloudflared);
    candidates.push(path.join(this.root, 'bin', 'cloudflared.exe'));
    candidates.push(path.join(this.root, 'bin', 'cloudflared'));
    candidates.push(path.join(this.root, 'karaoke_spo', 'bin', 'cloudflared.exe'));
    candidates.push(path.join(this.root, 'karaoke_ytb', 'bin', 'cloudflared.exe'));
    for (const candidate of candidates) {
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
    const onPath = this.findOnPath();
    if (onPath) return onPath;
    throw new Error(this.msg('tunnel.missing'));
  }

  findOnPath() {
    try {
      const command = process.platform === 'win32' ? 'where' : 'which';
      const output = execFileSync(command, ['cloudflared'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const first = output.split(/\r?\n/).map(item => item.trim()).filter(Boolean)[0];
      return first && fs.existsSync(first) ? first : '';
    } catch {
      return '';
    }
  }

  info() {
    const now = Date.now();
    if (this.executableCache && now - this.executableCheckedAt < 5000) {
      return { available: Boolean(this.executableCache), executable: this.executableCache || '' };
    }
    let executable = '';
    try { executable = this.resolveExecutable(); } catch {}
    this.executableCache = executable;
    this.executableCheckedAt = now;
    return { available: Boolean(executable), executable: executable || '' };
  }

  invalidateInfo() {
    this.executableCache = null;
    this.executableCheckedAt = 0;
  }

  async start() {
    if (this.state === 'on' || this.state === 'connecting') throw new Error(this.msg('tunnel.alreadyRunning'));
    // 两个模式互斥、共用同一个端口，所以直接指向 service.port
    const service = this.store.get().service;
    const executable = this.resolveExecutable();
    const target = `http://127.0.0.1:${service.port}`;

    this.error = null;
    this.url = null;
    this.lastLines = [];
    this.setState('connecting', null);
    this.log.line('tunnel', this.msg('tunnel.starting', { executable, target }));

    const args = ['tunnel', '--no-autoupdate', '--url', target];
    const child = (() => {
      try {
        return spawn(executable, args, {
          cwd: this.root,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const message = this.msg('tunnel.spawnFailed', { message: error.message });
        this.error = message;
        this.setState('failed', message);
        this.log.line('launcher', message);
        throw new Error(message);
      }
    })();
    this.child = child;
    this.pid = child.pid;

    const onChunk = chunk => {
      const text = stripAnsi(chunk);
      this.log.append('tunnel', text);
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) this.lastLines.push(line.trim());
      }
      if (this.lastLines.length > 25) this.lastLines.splice(0, this.lastLines.length - 25);
      if (!this.url) {
        const match = text.match(URL_PATTERN);
        if (match) {
          this.url = match[0];
          this.startedAt = new Date().toISOString();
          this.setState('on', null);
          this.log.line('launcher', this.msg('tunnel.url', { url: this.url }));
        }
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.once('error', error => {
      this.child = null;
      this.pid = null;
      this.error = this.msg('tunnel.spawnFailed', { message: error.message });
      this.setState('failed', this.error);
      this.log.line('launcher', this.error);
    });
    child.once('exit', (code, signal) => this.handleExit(code, signal));

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.url) return;
      if (this.state === 'failed') throw new Error(this.error || this.msg('tunnel.startFailed'));
      if (!this.child) throw new Error(this.error || this.msg('tunnel.childExited'));
      await delay(150);
    }

    this.error = this.msg('tunnel.timeout');
    this.log.line('launcher', this.error);
    await this.killTree();
    this.setState('failed', this.error);
    throw new Error(this.error);
  }

  handleExit(code, signal) {
    const previous = this.state;
    this.child = null;
    this.pid = null;
    if (previous === 'stopping' || previous === 'off') {
      this.setState('off', null);
      return;
    }
    const message = `${this.msg('tunnel.exited', { code, signal: signal ? `, ${signal}` : '' })}${this.tailHint()}`;
    this.url = null;
    this.error = message;
    this.setState('failed', message);
    this.log.line('launcher', message);
  }

  async stop() {
    if (this.state === 'off') return;
    this.setState('stopping', null);
    await this.killTree();
    this.url = null;
    this.startedAt = null;
    this.setState('off', null);
    this.log.line('launcher', this.msg('tunnel.stopped'));
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
    await Promise.race([once(child, 'exit').catch(() => {}), delay(5000)]);
  }

  // 控制台关闭或崩溃时兜底清理，避免 cloudflared 变成孤儿进程。
  killSync() {
    if (this.child && this.child.pid) {
      try {
        execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } catch {}
    }
  }
}

module.exports = { TunnelManager };
