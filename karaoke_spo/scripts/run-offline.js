'use strict';
/** 直接驱动 python/worker.py 跑一次离线分离，用于阶段性验证与 RTF 基准。 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PY = path.join(ROOT, 'python', '.venv', 'Scripts', 'python.exe');
const input = process.argv[2] || path.join(ROOT, 'assets', 'audio', 'hs_30s.wav');
const model = process.argv[3] || 'htdemucs';
const segment = process.argv[4] || '7.8';

const outDir = path.join(ROOT, 'assets', 'output', `${path.basename(input, '.wav')}-${model}-${Date.now()}`);
fs.mkdirSync(outDir, { recursive: true });

const startedAt = Date.now();
const child = spawn(PY, [path.join(ROOT, 'python', 'worker.py')], {
  env: { ...process.env, DEMUCS_MODEL: model, PYTHONIOENCODING: 'utf-8', TMP: path.join(ROOT, '.tmp'), TEMP: path.join(ROOT, '.tmp') },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (b) => process.stderr.write(b));

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error('[non-json]', line); continue; }
    const t = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (msg.type === 'ready') {
      console.log(`[${t}s] ready model=${msg.model} device=${msg.device} torch=${msg.torch} threads=${msg.torchThreads} initMs=${msg.initMs}`);
      child.stdin.write(JSON.stringify({ id: 'job-1', type: 'job', input, outputDir: outDir, segment: Number(segment) }) + '\n');
    } else if (msg.type === 'log') {
      console.log(`[${t}s] log: ${msg.message}`);
    } else if (msg.type === 'done') {
      console.log(`[${t}s] DONE`, JSON.stringify(msg, null, 2));
    } else if (msg.type === 'error') {
      console.error(`[${t}s] ERROR`, msg.code, msg.message);
      if (msg.trace) console.error(msg.trace);
      child.kill();
      process.exitCode = 1;
    }
  }
});

child.on('exit', (code) => console.log(`worker exited code=${code} totalMs=${Date.now() - startedAt}`));
setTimeout(() => { try { child.stdin.write(JSON.stringify({ id: 'quit', type: 'quit' }) + '\n'); } catch {} }, 120000);
