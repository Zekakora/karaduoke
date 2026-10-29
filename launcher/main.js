'use strict';

/*
 * 项目根启动器（控制台）。
 *
 * 布局约定 —— 本文件位于「项目根\launcher\main.js」，项目根同时是一个工程目录：
 *   <项目根>\launcher\     本项目（控制台、配置）
 *   <项目根>\main.js       当前运行的工程的入口（由下面的 PROJECT 决定）
 *   <项目根>\config\       控制台配置（一份，同时管 A/B 两个模式）
 *   <项目根>\karaoke_spo\  模式 B · 本地曲库工程
 *   <项目根>\karaoke_ytb\  模式 A · YouTube 工程
 *
 * 「工程 → 子目录」的映射是显式的：这里 ROOT 是项目根，绝不等于工程目录，
 * 否则会把 karaoke_spo 当成根、把模式 B 指向错误的路径。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { ConfigStore } = require('./config');
const { LogHub } = require('./logs');
const { ServiceManager } = require('./service');
const { TunnelManager } = require('./tunnel');
const environment = require('./environment');
const { translate } = require('./i18n');

const ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.join(__dirname, 'ui');
const LAUNCHER_PORT = Number(process.env.KARAOKE_LAUNCHER_PORT) || 8787;

// 两个模式各自的工程目录名（相对项目根）。发行版里是 karaoke_spo / karaoke_ytb。
const MODE_DIR = { A: 'karaoke_ytb', B: 'karaoke_spo' };
// 工程自带入口时会用它；根目录的 main.js 才是本项目的入口。
const PROJECT_ENTRY = path.join(ROOT, 'main.js');

const VERSION = (() => {
  try { return require(path.join(ROOT, 'version.json')).version || '0.0.0'; } catch { return '0.0.0'; }
})();

// 浏览器拿不到这两个值，所以本地控制接口不会被外部网页随意调用。
const TOKEN = crypto.randomBytes(24).toString('hex');
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex');

const store = new ConfigStore(ROOT);
const log = new LogHub(path.join(ROOT, 'logs'));

let busy = null;
let shuttingDown = false;
const sseClients = new Set();

let service;
let tunnel;

function msg(key, params) {
  return translate(store.get().language, key, params);
}

function lanAddresses() {
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      if (item.address.startsWith('169.254.')) continue;
      all.push({ name, address: item.address });
    }
  }
  const virtual = /(vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|loopback|tailscale|zerotier|tap|tun|npcap)/i;
  const physical = all.filter(item => !virtual.test(item.name));
  const list = physical.length ? physical : all;
  const score = item => item.address.startsWith('192.168.') ? 0
    : item.address.startsWith('10.') ? 1
      : /^172\.(1[6-9]|2\d|3[01])\./.test(item.address) ? 2 : 3;
  return list.sort((a, b) => score(a) - score(b));
}

/**
 * 解析某个模式对应的工程目录。
 *
 * 双工程是两个完全独立的目录（各自有 server.js / public / data）：
 *   A = YouTube 在线版  → <项目根>\karaoke_ytb
 *   B = 本地曲库版      → <项目根>\karaoke_spo
 * 配置里 rootA/rootB 可以覆盖路径。
 * 目录里没有 server.js 就视为不可用 —— 允许只装了其中一个版本。
 */
function modeRoot(key) {
  const cfg = store.get();
  const custom = key === 'A' ? cfg.mode.rootA : cfg.mode.rootB;
  const candidates = [];
  if (custom) candidates.push(path.resolve(ROOT, custom));
  candidates.push(path.join(ROOT, MODE_DIR[key]));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'server.js'))) return { dir, ok: true };
    } catch { /* ignore */ }
  }
  return { dir: candidates[0] || ROOT, ok: false };
}

/**
 * 模式显示名：始终按控制台当前语言生成，不读工程里的 MODE_LABEL ——
 * 那个值是 karaoke_spo/lib/mode.js 里写死的中文，切到 English/Deutsch 也不会变。
 */
function modeLabel(key) {
  return msg(`mode.${key.toLowerCase()}`);
}

/** 给 UI 用的模式清单 */
function modesView() {
  const cfg = store.get();
  return {
    active: cfg.mode.active,
    modes: ['A', 'B'].map((key) => {
      const { dir, ok } = modeRoot(key);
      return { key, dir, available: ok, label: modeLabel(key) };
    })
  };
}

function buildStatus() {
  const serviceStatus = service.status();
  const tunnelStatus = tunnel.status();
  const addresses = lanAddresses();
  // 「已选的模式」和「正在跑的模式」可能不同：切换后要等用户手动重启。
  const activeKey = store.get().mode.active;
  const activeRoot = modeRoot(activeKey);
  const running = ['running', 'starting', 'restarting'].includes(service.state);
  const effectiveRoot = running ? (service.root || ROOT) : (activeRoot.ok ? activeRoot.dir : ROOT);
  const restartRequired = running && activeRoot.ok && service.root !== activeRoot.dir;
  return {
    version: VERSION,
    // 模式标识：让控制台一眼看出这是「本地曲库版」还是「YouTube 版」
    // 读的是**当前生效工程**的 lib/mode.js，不是启动器自己的
    mode: (() => {
      try { return require(path.join(effectiveRoot, 'lib', 'mode.js')); } catch { return null; }
    })(),
    modes: modesView(),
    // 已选模式 != 正在跑的模式 → UI 提示「重启服务后生效」
    restartRequired,
    pendingMode: restartRequired ? activeKey : null,
    busy,
    language: store.get().language,
    service: serviceStatus,
    tunnel: tunnelStatus,
    lanUrl: addresses[0] ? `http://${addresses[0].address}:${serviceStatus.port}` : '',
    lanUrls: addresses.map(item => `http://${item.address}:${serviceStatus.port}`),
    publicUrl: tunnelStatus.url || store.get().tunnel.fixedPublicUrl || '',
    cloudflared: tunnel.info(),
    configPath: store.file,
    logFile: log.file
  };
}

function sendEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
}

function broadcast() {
  sendEvent('status', buildStatus());
}

/** 调服务进程的内部接口（仅回环 + internal token）。服务没跑时返回 null。 */
async function internalCall(pathname, init = {}) {
  const port = service.activePort();
  if (!port) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN, ...(init.headers || {}) },
      signal: AbortSignal.timeout(3000)
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return null;
  }
}

async function syncServiceConfig() {
  const port = service.activePort();
  if (!port) return;
  const config = store.get();
  const payload = {
    tunnelUrl: tunnel.status().url || '',
    fixedUrl: config.tunnel.fixedPublicUrl || '',
    youtubeApiKey: config.youtubeApiKey || '',
    // Spotify 凭证 + 授权状态一起推过去；服务端 applyRuntimeConfig 会写 process.env
    // 并把 refreshToken 落成 data/spotify-token.json。
    spotify: config.spotify || {}
  };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/internal/public-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) log.line('launcher', msg('launcher.syncFailed', { message: `HTTP ${response.status}` }));
  } catch (error) {
    log.line('launcher', msg('launcher.syncFailed', { message: error.message }));
  }
}

function onServiceChange() {
  broadcast();
  if (service.state === 'failed' && (tunnel.state === 'on' || tunnel.state === 'connecting')) {
    tunnel.stop().catch(() => {}).finally(() => syncServiceConfig());
    return;
  }
  if (service.state === 'stopped') syncServiceConfig();
}

function onTunnelChange() {
  broadcast();
  if (['on', 'off', 'failed'].includes(tunnel.state)) syncServiceConfig();
}

// 启动时按配置里的模式决定服务跑哪个工程目录；两个都找不到时退回项目根
function initialRoot() {
  const key = store.get().mode.active;
  const found = modeRoot(key);
  if (!found.ok) log.line('launcher', msg('mode.dirUnavailable', { key, dir: found.dir, root: ROOT }));
  return found.ok ? found.dir : ROOT;
}

const ACTIVE_ROOT = initialRoot();

service = new ServiceManager({
  root: ACTIVE_ROOT,
  entry: PROJECT_ENTRY,
  mode: store.get().mode.active,
  store,
  log,
  internalToken: INTERNAL_TOKEN,
  onChange: onServiceChange
});
tunnel = new TunnelManager({ root: ROOT, store, log, onChange: onTunnelChange });

/**
 * 启动/重启前把服务指向当前选中的模式目录。
 * 模式切换本身只改配置，不碰运行中的服务；真正生效发生在这里。
 */
function applyActiveModeRoot() {
  const key = store.get().mode.active;
  const found = modeRoot(key);
  const target = found.ok ? found.dir : ROOT;
  if (service.root !== target || service.mode !== key) {
    service.root = target;
    service.mode = key;
    log.line('launcher', msg('mode.serviceDir', { key, target }));
  }
  return target;
}

async function startService() {
  applyActiveModeRoot();
  await service.start();
  await syncServiceConfig();
  if (store.get().tunnel.autoStart && tunnel.state === 'off') {
    try {
      await tunnel.start();
      await syncServiceConfig();
    } catch (error) {
      log.line('launcher', msg('launcher.autoTunnelFailed', { message: error.message }));
    }
  }
}

async function restartService() {
  await service.stop();
  await new Promise(resolve => setTimeout(resolve, 250));
  applyActiveModeRoot();
  await service.start();
  await syncServiceConfig();
}

async function stopService() {
  if (tunnel.state !== 'off') {
    try { await tunnel.stop(); } catch {}
  }
  await service.stop();
}

async function startTunnel() {
  if (service.state !== 'running') {
    const error = new Error(msg('main.serviceRequired'));
    error.statusCode = 409;
    throw error;
  }
  await tunnel.start();
  await syncServiceConfig();
}

async function stopTunnel() {
  await tunnel.stop();
  await syncServiceConfig();
}

const operations = {
  '/api/service/start': { name: 'service-start', run: startService },
  '/api/service/restart': { name: 'service-restart', run: restartService },
  '/api/service/stop': { name: 'service-stop', run: stopService },
  '/api/tunnel/start': { name: 'tunnel-start', run: startTunnel },
  '/api/tunnel/stop': { name: 'tunnel-stop', run: stopTunnel }
};

function run(name, task) {
  if (busy) {
    const error = new Error(msg('main.busy'));
    error.statusCode = 409;
    return Promise.reject(error);
  }
  busy = name;
  broadcast();
  return Promise.resolve()
    .then(task)
    .finally(() => {
      busy = null;
      broadcast();
    });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error(msg('main.badJson'));
    error.statusCode = 400;
    throw error;
  }
}

function authorized(req, url) {
  const token = req.headers['x-launcher-token'] || url.searchParams.get('token');
  if (token !== TOKEN) return false;
  const origin = req.headers.origin;
  const allowed = [`http://127.0.0.1:${LAUNCHER_PORT}`, `http://localhost:${LAUNCHER_PORT}`];
  if (origin && !allowed.includes(origin)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return false;
  return true;
}

function configView() {
  const config = store.get();
  const info = tunnel.info();
  return {
    version: VERSION,
    language: config.language,
    service: config.service,
    djPassword: config.djPassword,
    youtubeApiKey: config.youtubeApiKey,
    // 控制面板是 127.0.0.1 单机页面，和 djPassword 一样按原值返回，便于编辑。
    spotify: config.spotify,
    env: config.env,
    tunnel: { ...config.tunnel, resolvedPath: info.executable },
    cloudflared: info,
    configPath: store.file,
    logFile: log.file
  };
}

function streamEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: status\ndata: ${JSON.stringify(buildStatus())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/ping') {
    return sendJson(res, 200, { app: 'karaoke-launcher', version: VERSION });
  }
  if (pathname === '/api/events') {
    if (!authorized(req, url)) return sendError(res, 403, msg('main.forbidden'));
    return streamEvents(req, res);
  }
  if (!authorized(req, url)) return sendError(res, 403, msg('main.forbidden'));

  if (method === 'GET' && pathname === '/api/status') return sendJson(res, 200, buildStatus());
  if (method === 'GET' && pathname === '/api/logs') return sendJson(res, 200, { lines: log.recent(500), file: log.file });
  if (method === 'GET' && pathname === '/api/config') return sendJson(res, 200, configView());

  if (method === 'GET' && pathname === '/api/modes') return sendJson(res, 200, modesView());

  // ---- Spotify 凭证与授权（发布前从这里统一管理，.env 不再存真实值）----
  if (method === 'GET' && pathname === '/api/spotify') {
    const live = await internalCall('/api/spotify/status');
    return sendJson(res, 200, {
      config: store.get().spotify,
      serviceRunning: Boolean(service.activePort()),
      service: live && live.ok ? live.data : null
    });
  }
  // 发起授权：向服务要 PKCE 地址，再用默认浏览器打开 Spotify 登录页
  if (method === 'POST' && pathname === '/api/spotify/auth') {
    const live = await internalCall('/api/spotify/auth');
    if (!live) return sendError(res, 409, msg('spotify.serviceRequired'));
    if (!live.ok) return sendError(res, live.status || 400, (live.data && live.data.error) || msg('spotify.authFailed'));
    log.line('launcher', msg('spotify.authStarted', { url: live.data.url }));
    if (!process.argv.includes('--no-open')) openExternal(live.data.url);
    return sendJson(res, 200, live.data);
  }
  // 授权完成后，把服务端拿到的 token 收回面板配置（config.json 才是授权的持久来源）
  if (method === 'POST' && pathname === '/api/spotify/import') {
    const live = await internalCall('/internal/spotify/export');
    if (!live || !live.ok) return sendError(res, 409, msg('spotify.serviceRequired'));
    if (!live.data || !live.data.refreshToken) return sendError(res, 400, msg('spotify.notAuthorized'));
    store.save({ spotify: { refreshToken: live.data.refreshToken, scope: live.data.scope || '' } });
    log.line('launcher', msg('spotify.imported'));
    broadcast();
    return sendJson(res, 200, { spotify: store.get().spotify });
  }
  // 退出账号：清服务端 token 文件 + 面板里存的 refreshToken
  if (method === 'POST' && pathname === '/api/spotify/clear') {
    await internalCall('/internal/spotify/clear', { method: 'POST' });
    store.save({ spotify: { refreshToken: '', scope: '' } });
    log.line('launcher', msg('spotify.cleared'));
    broadcast();
    return sendJson(res, 200, { spotify: store.get().spotify });
  }

  // ---- 运行环境（Python / 模型缓存 / 二进制）----
  if (method === 'GET' && pathname === '/api/env') {
    // 只做存在性检查，不遍历目录 —— 打开弹窗必须秒开
    return sendJson(res, 200, environment.status(ROOT, store.get()));
  }
  if (method === 'GET' && pathname === '/api/env/sizes') {
    // 体积统计比较慢（venv 近 3 万文件），前端单独请求，不阻塞弹窗
    try {
      return sendJson(res, 200, await environment.sizes(ROOT, store.get()));
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }
  if (method === 'POST' && pathname === '/api/env/migrate') {
    if (busy) return sendError(res, 409, msg('main.busyRunning', { busy }));
    try {
      const result = environment.migrate(ROOT, store.get());
      log.line('launcher', msg('env.migrated'));
      broadcast();
      return sendJson(res, 200, result);
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }
  if (method === 'POST' && pathname === '/api/env/download') {
    try {
      const config = store.get();
      const body = await readBody(req);
      const target = String(body.target || '');
      let result;
      if (target === 'cloudflared') {
        result = await environment.downloadCloudflared(ROOT, config);
        tunnel.invalidateInfo();
        log.line('launcher', msg('env.downloaded', { path: result.path, mb: (result.bytes / 1048576).toFixed(1) }));
      } else if (target === 'ffmpeg') {
        result = await environment.downloadFfmpeg(ROOT, config);
        log.line('launcher', msg('env.downloaded', { path: result.paths.join(', '), mb: (result.bytes / 1048576).toFixed(1) }));
      } else {
        return sendError(res, 400, msg('env.downloadUnsupported'));
      }
      broadcast();
      return sendJson(res, 200, { ...result, status: environment.status(ROOT, config) });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }
  if (method === 'POST' && pathname === '/api/env/warm-models') {
    try {
      const result = await environment.warmModels(ROOT, store.get());
      log.line('launcher', msg('env.modelsReady'));
      broadcast();
      return sendJson(res, 200, { ...result, status: environment.status(ROOT, store.get()) });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }
  // 用系统对话框选一个环境目录（总目录 / python / cache / bin）。
  // 浏览器不会把本地路径交给网页，所以只能借 PowerShell 的文件夹对话框。
  if (method === 'POST' && pathname === '/api/env/pick-dir') {
    const body = await readBody(req);
    const target = String(body.target || 'dir');
    const fields = { dir: 'dir', python: 'pythonDir', cache: 'cacheDir', bin: 'binDir' };
    if (!fields[target]) return sendError(res, 400, msg('env.pickUnsupported'));

    const paths = environment.resolve(ROOT, store.get());
    const picked = await environment.pickDirectory(paths[fields[target]], msg('env.pickTitle'));
    if (!picked) return sendJson(res, 200, { picked: null });

    // 选完立刻规范化：在项目根内 → 相对路径（跟着项目走）；
    // 在项目根外 → 保留绝对路径（用户就是想放到别处）。
    const current = store.get().env;
    const value = environment.normalizeEnv(ROOT, { ...current, [target]: picked }).env[target];
    return sendJson(res, 200, { picked, value, outside: path.isAbsolute(value) });
  }
  if (method === 'POST' && pathname === '/api/env/setup-script') {
    try {
      const file = environment.setupScript(ROOT, store.get());
      log.line('launcher', msg('env.scriptWritten', { path: file }));
      return sendJson(res, 200, { path: file });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }
  if (method === 'POST' && pathname === '/api/env/open') {
    try {
      const envPaths = environment.resolve(ROOT, store.get());
      const body = await readBody(req);
      const target = body.target === 'python' ? envPaths.pythonDir
        : body.target === 'cache' ? envPaths.cacheDir
          : envPaths.dir;
      if (!fs.existsSync(target)) return sendError(res, 404, msg('env.dirMissing', { path: target }));
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
      return sendJson(res, 200, { opened: target });
    } catch (error) {
      return sendError(res, 500, error.message);
    }
  }

  // 切换模式：改 config → 停服务 → 换工程目录 → 重新启动（原来在跑才会重启）
  if (method === 'POST' && pathname === '/api/mode') {
    const body = await readBody(req);
    const key = body && body.mode === 'A' ? 'A' : body && body.mode === 'B' ? 'B' : null;
    if (!key) return sendError(res, 400, msg('main.badRequest') || 'bad mode');
    const target = modeRoot(key);
    if (!target.ok) return sendError(res, 400, msg('mode.noServer', { key, dir: target.dir }));
    if (busy) return sendError(res, 409, msg('main.busyRunning', { busy }));

    // 只记录选择，**不动正在跑的服务** —— 由用户自己按「重启服务」来生效。
    // 原因：切模式会换整个工程目录（不同的 data/、assets/），
    // 直接替用户重启容易在演唱会进行到一半时把现场断掉。
    const wasRunning = ['running', 'starting', 'restarting'].includes(service.state);
    store.save({ mode: { ...store.get().mode, active: key } });
    log.line('launcher', msg('mode.selected', { key, dir: target.dir }) + (wasRunning ? msg('mode.selectedPending') : ''));
    broadcast();
    return sendJson(res, 200, { ...buildStatus(), restartRequired: wasRunning, pendingMode: key });
  }

  if (method === 'PUT' && pathname === '/api/config') {
    const body = await readBody(req);
    // 环境目录一律按「相对项目根」存：存成绝对路径的话，整个项目复制到别处后
    // 环境面板还会指着旧位置。只有真的指向项目根之外时才保留绝对路径。
    if (body && body.env && typeof body.env === 'object') {
      const fixed = environment.normalizeEnv(ROOT, body.env);
      body.env = fixed.env;
      if (fixed.rebased) log.line('launcher', msg('env.rebased'));
    }
    const result = store.save(body);
    tunnel.invalidateInfo();
    log.line('launcher', msg('launcher.settingsSaved'));
    if (service.state === 'running') await syncServiceConfig();
    broadcast();
    return sendJson(res, 200, { ...result, status: buildStatus() });
  }

  // 打开大屏：优先用 Edge/Chrome 的独立 profile + 自动播放白名单参数。
  // 普通浏览器实例会忽略新传来的命令行参数，所以必须用独立 user-data-dir 起新进程。
  if (method === 'POST' && pathname === '/api/open-display') {
    try {
      return sendJson(res, 200, openDisplayWindow());
    } catch (error) {
      return sendError(res, error.statusCode || 500, error.message || String(error));
    }
  }

  if (method === 'POST' && operations[pathname]) {
    const operation = operations[pathname];
    // 必须兜住异常：run() 的 promise 一旦 reject 且没人 catch，
    // Node 会当成未处理的 promise rejection 直接结束整个控制面板进程
    // （表现就是点了「启动服务」页面直接连不上）。
    try {
      await run(operation.name, operation.run);
    } catch (error) {
      return sendError(res, error.statusCode || 500, error.message || String(error));
    }
    return sendJson(res, 200, buildStatus());
  }

  return sendError(res, 404, msg('main.notFound'));
}

function serveStatic(req, res, url) {
  const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  if (!['index.html', 'app.js', 'styles.css', 'ICON.png'].includes(name)) return sendError(res, 404, msg('main.notFound'));
  // 图标放在 launcher\ui 下，控制台不依赖任何具体工程的 public 目录
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
  const file = path.join(UI_DIR, name);
  if (!fs.existsSync(file)) return sendError(res, 404, msg('main.notFound'));
  res.writeHead(200, {
    'Content-Type': types[path.extname(file)] || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  if (name === 'index.html') {
    return res.end(fs.readFileSync(file, 'utf8').replace('__LAUNCHER_TOKEN__', TOKEN));
  }
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${LAUNCHER_PORT}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    if (!res.headersSent) sendError(res, error.statusCode || 500, error.message || msg('main.operationFailed'));
  }
});

/** 找本机可用的 Chromium 浏览器（Edge 优先）。 */
function findBrowser() {
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return candidates.find(candidate => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || null;
}

function openWindow() {
  const url = `http://127.0.0.1:${LAUNCHER_PORT}/`;
  const browser = findBrowser();
  if (browser) {
    spawn(browser, [`--app=${url}`, '--window-size=1080,780'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/**
 * 打开大屏，并带上 Chromium 的自动播放白名单参数。
 *
 * 为什么要独立 profile：浏览器已经在运行时，新进程只是把 URL 转给现有实例，
 * 命令行里的 `--autoplay-policy` 会被忽略。用 `--user-data-dir` 起一个专用实例
 * 才能保证参数生效。这个 profile 只用于大屏，体积很小。
 */
function openDisplayWindow() {
  const port = service.activePort();
  if (!port) {
    const error = new Error(msg('display.serviceRequired'));
    error.statusCode = 409;
    throw error;
  }
  const url = `http://127.0.0.1:${port}/display`;
  const browser = findBrowser();
  if (!browser) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log.line('launcher', msg('display.noBrowser'));
    return { ok: true, url, fallback: true, warning: msg('display.noBrowser') };
  }
  const profileDir = path.join(os.tmpdir(), 'karaduoke-display-browser');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* ignore */ }
  spawn(browser, [
    `--app=${url}`,
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1600,900'
  ], { detached: true, stdio: 'ignore' }).unref();
  log.line('launcher', msg('display.opened', { url }));
  return { ok: true, url };
}

/** 用系统默认浏览器打开外部链接（Spotify 授权页）。 */
function openExternal(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (error) {
    log.line('launcher', `openExternal failed: ${error.message}`);
  }
}

async function existingLauncher() {
  try {
    const response = await fetch(`http://127.0.0.1:${LAUNCHER_PORT}/api/ping`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data && data.app === 'karaoke-launcher');
  } catch {
    return false;
  }
}

server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    if (await existingLauncher()) {
      log.line('launcher', msg('launcher.alreadyRunning'));
      if (!process.argv.includes('--no-open')) openWindow();
      setTimeout(() => process.exit(0), 300);
      return;
    }
    console.error(msg('launcher.portBusy', { port: LAUNCHER_PORT }));
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

log.on('line', entry => {
  for (const client of sseClients) {
    try { client.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`); } catch {}
  }
});

setInterval(() => {
  for (const client of sseClients) {
    try { client.write(': ping\n\n'); } catch {}
  }
}, 15000).unref();

server.listen(LAUNCHER_PORT, '127.0.0.1', () => {
  log.line('launcher', msg('launcher.started', { url: `http://127.0.0.1:${LAUNCHER_PORT}` }));
  log.line('launcher', msg('launcher.configFile', { path: store.file }));
  const info = tunnel.info();
  log.line('launcher', info.available
    ? msg('launcher.cloudflaredFound', { path: info.executable })
    : msg('launcher.cloudflaredMissing'));
  console.log(`Karaoke console: http://127.0.0.1:${LAUNCHER_PORT}`);
  if (!process.argv.includes('--no-open')) openWindow();
});

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.line('launcher', msg('launcher.shuttingDown', { reason }));
  try { await tunnel.stop(); } catch {}
  try { await service.stop(); } catch {}
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  server.close();
  log.close();
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => shutdown('Ctrl+C'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  service.killSync();
  tunnel.killSync();
});
