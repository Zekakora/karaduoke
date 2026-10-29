'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function stamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

class LogHub extends EventEmitter {
  constructor(dir, limit = 1500) {
    super();
    this.limit = limit;
    this.lines = [];
    this.seq = 0;
    this.partials = new Map();
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `launcher-${stamp()}.log`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.stream.on('error', () => {});
  }

  // 子进程输出按行合并：一段 chunk 可能只有半行，留到下一段再拼。
  append(source, chunk) {
    const text = String(chunk).replace(ANSI, '');
    const buffer = (this.partials.get(source) || '') + text;
    const parts = buffer.split(/\r?\n/);
    this.partials.set(source, parts.pop());
    for (const line of parts) this.add(source, line);
  }

  line(source, message) {
    for (const part of String(message).split(/\r?\n/)) this.add(source, part);
  }

  add(source, text) {
    if (!text || !String(text).trim()) return;
    const entry = { seq: ++this.seq, at: new Date().toISOString(), source, text: String(text) };
    this.lines.push(entry);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    this.stream.write(`${entry.at} [${source}] ${entry.text}\n`);
    this.emit('line', entry);
  }

  recent(limit = 400) {
    return this.lines.slice(-limit);
  }

  close() {
    this.stream.end();
  }
}

module.exports = { LogHub };
