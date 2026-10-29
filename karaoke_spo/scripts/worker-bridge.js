'use strict';
/**
 * HTTP 桥（可选）：当主服务无法创建管道子进程（受限环境 spawn EPERM）时，
 * 由 launcher 以继承 stdio 的方式单独拉起本进程，主服务改用 HTTP 与 Worker 通信。
 *
 * 启动: node scripts/worker-bridge.js [port]
 *   - 自动在 8701..8720 内找空端口，并写入 data/worker-bridge.json（供主服务读取）
 *   - 接口: GET /health  POST /jobs  GET /jobs/:id
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PY = path.join(ROOT, 'python', '.venv', 'Scripts', 'python.exe');
const STATE_FILE = path.join(ROOT, 'data', 'worker-bridge.json');
const START_PORT = Number(process.argv[2] || 8701);

const jobs = new Map();
let worker = null;
let buf = '';
const pending = new Map();
let state = { status: 'stopped', model: null, device: null, torch: null, initMs: null, lastError: null };

function log(level, message) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, scope: 'bridge', message });
  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.appendFile(path.join(ROOT, 'logs', `bridge-${new Date().toISOString().slice(0, 10)}.jsonl`), `${line}\n`, () => {});
  console.log(line);
}

function startWorker() {
  if (worker) return;
  state = { ...state, status: 'starting', lastError: null };
  try {
    worker = spawn(PY, [path.join(ROOT, 'python', 'run_worker.py')], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', DEMUCS_MODEL: process.env.DEMUCS_MODEL || 'htdemucs' },
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
  } catch (e) {
    state = { ...state, status: 'spawn-failed', lastError: String(e.message) };
    log('error', `spawn failed: ${e.message}`);
    return;
  }
  worker.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { log('warn', `non-json: ${line.slice(0, 200)}`); continue; }
      if (msg.type === 'ready') {
        state = { ...state, status: 'ready', model: msg.model, device: msg.device, torch: msg.torch, initMs: msg.initMs };
        log('info', `ready ${msg.model}/${msg.device} init=${msg.initMs}ms`);
      } else if (msg.type === 'done' || msg.type === 'error') {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          msg.type === 'done' ? p.resolve(msg) : p.reject(Object.assign(new Error(msg.message), { code: msg.code }));
        }
      }
    }
  });
  worker.on('exit', (code) => {
    worker = null;
    state = { ...state, status: 'stopped' };
    log('warn', `worker exited code=${code}`);
    for (const [, p] of pending) p.reject(new Error(`worker exited ${code}`));
    pending.clear();
  });
  worker.on('error', (e) => {
    state = { ...state, status: 'spawn-failed', lastError: String(e.message) };
    log('error', `worker error: ${e.message}`);
  });
}

function send(obj) {
  if (!worker) throw new Error('worker not running');
  worker.stdin.write(`${JSON.stringify(obj)}\n`);
}

function runJob(job) {
  return new Promise((resolve, reject) => {
    pending.set(job.id, { resolve, reject });
    send({ id: job.id, type: 'job', input: job.input, outputDir: job.outputDir, segment: job.segment });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/health') return json(200, { ...state, pid: process.pid });
  if (url.pathname === '/jobs' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const req2 = JSON.parse(body || '{}');
    const job = { id: req2.id, input: req2.input, outputDir: req2.outputDir, segment: req2.segment || null, status: 'processing' };
    jobs.set(job.id, job);
    if (state.status !== 'ready') {
      startWorker();
      job.status = 'failed';
      job.error = { code: 'WORKER_NOT_READY', message: `worker 状态 ${state.status}` };
      return json(409, job);
    }
    try {
      const result = await runJob(job);
      Object.assign(job, { status: 'completed', result });
      return json(200, job);
    } catch (e) {
      Object.assign(job, { status: 'failed', error: { code: e.code || 'FAILED', message: e.message } });
      return json(200, job);
    }
  }
  const m = /^\/jobs\/([\w-]+)$/.exec(url.pathname);
  if (m && req.method === 'GET') {
    const job = jobs.get(m[1]);
    return job ? json(200, job) : json(404, { error: 'not found' });
  }
  return json(404, { error: 'not found' });
}

function listen(port, attempt = 0) {
  const server = http.createServer((req, res) => handle(req, res).catch((e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }));
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 20) return listen(port + 1, attempt + 1);
    log('error', `listen failed: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ port, pid: process.pid, at: new Date().toISOString() }));
    log('info', `bridge listening on 127.0.0.1:${port}`);
    startWorker();
  });
}

listen(START_PORT);
