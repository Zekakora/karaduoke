'use strict';
/**
 * 演示/测试用：以"逐行 JSON"方式运行 python/run_worker.py 的一个任务。
 * 说明：受限会话无法用 spawn 创建管道子进程，因此这里用本进程的 stdio 直接驱动 Worker。
 * 用法: node scripts/drive-worker.js <job-json-file>
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/drive-worker.js <job.json>');
  process.exit(1);
}
const job = JSON.parse(fs.readFileSync(file, 'utf8'));
const started = Date.now();
let ready = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = ((Date.now() - started) / 1000).toFixed(1);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  console.log(`[${t}s] ${msg.type} ${msg.code || ''} ${msg.message || ''}`.trim());
  if (msg.type === 'ready') {
    ready = true;
    process.stdout.write(`${JSON.stringify({ id: job.id, type: 'job', input: job.input, outputDir: job.outputDir, segment: job.segment })}\n`);
  }
  if (msg.type === 'done' || msg.type === 'error') {
    if (msg.type === 'done') console.log(JSON.stringify(msg, null, 2));
    process.stdout.write(`${JSON.stringify({ id: 'quit', type: 'quit' })}\n`);
  }
});
rl.on('close', () => process.exit(ready ? 0 : 1));
