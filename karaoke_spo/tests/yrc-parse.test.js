'use strict';
/**
 * 网易云 YRC（逐字）解析测试 —— 离线，用真实样本，不联网。
 *
 * 覆盖的坑：
 *   1. YRC 的方向和 QQ 的 QRC **相反**：YRC 是「时间戳在前、文字在后」，
 *      QRC 是「文字在前、时间戳在后」。写反就会整行错位。
 *   2. 时间戳是三段式 (start, dur, 未知)，不能只匹配两段。
 *   3. 开头几行是 JSON 形式的署名（{"t":0,"c":[{"tx":"作词: "}]}），要过滤。
 *
 * 用法：node tests\yrc-parse.test.js
 */
const { parseYrc } = require('../lib/netease-lyrics.js');

let passed = 0; let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (e) { failed += 1; failures.push({ name, error: e }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// 真实网易云 YRC 片段（Talking to the Moon）
const REAL = [
  '{"t":0,"c":[{"tx":"作词: "},{"tx":"Bruno Mars"},{"tx":"/"},{"tx":"Jeff Bhasker"},{"tx":"/"},{"tx":"Philip Lawrence"}]}',
  '{"t":0,"c":[{"tx":"作曲: "},{"tx":"Bruno Mars"}]}',
  '[7490,2490](7490,210,0)I (7700,240,0)know (7940,180,0)you\'re (8120,480,0)somewhere (8600,360,0)out (8960,990,0)there',
  '[9980,3120](9980,780,0)Somewhere (10760,810,0)far (11570,1500,0)away',
  '[13100,3240](13100,180,0)I (13280,690,0)want (13970,150,0)you (14120,1770,0)back',
].join('\n');

test('文字在时间戳之后（和 QRC 方向相反）', () => {
  const lines = parseYrc(REAL);
  const l = lines[0];
  assert(l.text === "I know you're somewhere out there", `行文本不对：${JSON.stringify(l.text)}`);
  // 词尾的空格归到前一个词（"I " / "know "），这样逐字点亮时空格不会丢
  assert(l.chars[0].text === 'I ', `首字应为 "I "（词尾带空格），实际 ${JSON.stringify(l.chars[0].text)}`);
  assert(l.chars[1].text === 'know ', `第二段应为 "know "，实际 ${JSON.stringify(l.chars[1].text)}`);
  assert(l.chars[0].text.trim() === 'I', '去掉空格后应是 I');
});

test('三段式时间戳能正确取到 start/dur', () => {
  const lines = parseYrc(REAL);
  const l = lines[0];
  assert(l.startMs === 7490, `行起点应为 7490，实际 ${l.startMs}`);
  assert(l.chars[0].startMs === 7490, `首字起点应为 7490，实际 ${l.chars[0].startMs}`);
  assert(l.chars[0].endMs === 7700, `首字终点应为 7700，实际 ${l.chars[0].endMs}`);
});

test('chars 拼接等于行文本', () => {
  for (const l of parseYrc(REAL)) {
    if (!l.chars.length) continue;
    const joined = l.chars.map((c) => c.text).join('');
    assert(joined === l.text, `「${l.text}」vs「${joined}」`);
  }
});

test('逐字时间戳单调递增', () => {
  for (const l of parseYrc(REAL)) {
    let prev = -1;
    for (const c of l.chars) { assert(c.startMs >= prev, `倒退：${c.startMs} < ${prev}`); prev = c.startMs; }
  }
});

test('JSON 署名行被过滤，正文保留', () => {
  const lines = parseYrc(REAL);
  assert(!lines.some((l) => /作词|作曲/.test(l.text)), '署名行没被过滤：' + JSON.stringify(lines.map((l) => l.text)));
  assert(lines.some((l) => /I know you're somewhere/.test(l.text)), '正文丢了');
});

test('行数是 3（两条署名被剔除）', () => {
  assert(parseYrc(REAL).length === 3, `期望 3 行，实际 ${parseYrc(REAL).length}`);
});

test('空输入不抛错', () => {
  assert(parseYrc('').length === 0);
  assert(parseYrc(null).length === 0);
  assert(parseYrc(undefined).length === 0);
});

test('只有署名时返回空而不是报错', () => {
  const only = '{"t":0,"c":[{"tx":"作词: "},{"tx":"某人"}]}';
  assert(parseYrc(only).length === 0);
});

test('畸形行被跳过', () => {
  const messy = ['[1234,567]', '不是时间戳的行', '{"broken":', '[100,200](100,50,0)好'].join('\n');
  const lines = parseYrc(messy);
  assert(lines.length === 1, `应只剩 1 行，实际 ${lines.length}：${JSON.stringify(lines.map((l) => l.text))}`);
  assert(lines[0].text === '好');
});

console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
if (failed) {
  process.exitCode = 1;
  for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
}
