'use strict';
/**
 * QQ QRC 解析测试（离线，不联网）
 *
 * 被测对象：lib/qrc-parse.js —— server.js 和 lib/qq-lyrics.js 共用的唯一实现。
 *
 * 覆盖两个真实修过的 bug：
 *   1. 字符错位：QRC 是「文字在前、时间戳在后」，早先写成取时间戳之后，
 *      导致每行第一个字被吃掉、末尾多出空字
 *      （"Is this the real life" 变成 "this the real life"）。
 *   2. 制作信息未过滤：QQ 把标题、作词、作曲、录音工程等署名放进歌词正文。
 *
 * 用法：node tests\qrc-parse.test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseQrcXml, isCreditLine } = require('../lib/qrc-parse.js');

const ROOT = path.join(__dirname, '..');

let passed = 0; let failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; failures.push({ name, error }); console.log(`  ✗ ${name}\n      ${error.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------------------------------------------------------- 手工构造
const SIMPLE = `<?xml version="1.0" encoding="utf-8"?>
<QrcInfos><QrcHeadInfo SaveTime="0" Version="100"/>
<LyricInfo LyricCount="1">
<Lyric_1 LyricType="1" LyricContent="[ti:测试]
[0,2250]晴(0,160)天(160,160) (320,160)
[2250,2000]词(2250,450)：(2700,450)周(3150,450)杰(3600,450)伦(4050,450)
[5000,2000]故(5000,300)事(5300,300)的(5600,300)小(5900,300)黄(6200,300)花(6500,300)"/>
</LyricInfo></QrcInfos>`;

// ---------------------------------------------------------------- 引号截断回归
// 真实事故：Ariana Grande「thank u, next」里有一句 `"Thank you" to Malcolm`，
// 歌词正文里出现英文引号，把「懒惰匹配到第一个引号」的属性提取提前截断，
// 114 行只剩 9 行、21 秒之后完全没歌词。
const WITH_QUOTES = `<?xml version="1.0" encoding="utf-8"?>
<QrcInfos><QrcHeadInfo SaveTime="207" Version="100"/>
<LyricInfo LyricCount="1">
<Lyric_1 LyricType="1" LyricContent="[ti:Thank U, Next]
[0,2000]One(0,200) (200,200)two(400,200)
[2000,2000]"Thank (2000,200)you" (2200,200)to (2400,200)me (2600,200)
[4000,2000]last(4000,200)line(4200,200)here(4400,200)"/>
</LyricInfo></QrcInfos>`;

test('正文含英文引号时不被截断（属性提取必须贪婪到标签结束）', () => {
  const lines = parseQrcXml(WITH_QUOTES).lines;
  assert(lines.length === 3, `期望 3 行，实际 ${lines.length}（引号把内容截断了）`);
  assert(lines[2].text.includes('last'), `最后一行丢了：${JSON.stringify(lines.map((l) => l.text))}`);
});

test('引号那一行的字符与文字都完整', () => {
  const lines = parseQrcXml(WITH_QUOTES).lines;
  const quoted = lines.find((l) => l.text.includes('Thank'));
  assert(quoted, '找不到带引号的那一行');
  // QRC 的排版是「文字在前、时间戳在后」，词尾空格归前一词，所以对比时 trim
  assert(quoted.text.trim() === '"Thank you" to me', `行文本不对：${JSON.stringify(quoted.text)}`);
  assert(quoted.chars.map((c) => c.text).join('') === quoted.text, 'chars 拼接与行文本不一致');
});

test('标题行（含逗号）也会被过滤', () => {
  const xml = '<Lyric_1 LyricContent="thank u, next (Explicit) - Ariana Grande (爱莉安娜)\n[100,1000]real(100,200)lyric(300,200)\n[2000,1000]second(2000,200)line(2200,200)"/>';
  const lines = parseQrcXml(xml).lines;
  assert(lines.every((l) => !l.text.includes('Ariana Grande')), `标题行没被过滤：${JSON.stringify(lines.map((l) => l.text))}`);
  assert(lines.length === 2, `期望 2 行，实际 ${lines.length}`);
});

test('手工 QRC：首字不丢', () => {
  const l = parseQrcXml(SIMPLE).lines[0];  assert(l.text === '晴天 ', `期望「晴天 」，实际「${l.text}」`);
  assert(l.chars[0].text === '晴', `首字应为「晴」，实际「${l.chars[0].text}」`);
});

test('手工 QRC：chars 拼接等于行文本', () => {
  for (const l of parseQrcXml(SIMPLE).lines) {
    const joined = l.chars.map((c) => c.text).join('');
    assert(joined === l.text, `「${l.text}」vs「${joined}」`);
  }
});

test('手工 QRC：没有空字', () => {
  for (const l of parseQrcXml(SIMPLE).lines) {
    for (const c of l.chars) assert(String(c.text).length > 0, `行「${l.text}」出现空字`);
  }
});

test('手工 QRC：署名行被过滤（词：周杰伦），歌词保留', () => {
  const texts = parseQrcXml(SIMPLE).lines.map((l) => l.text);
  assert(!texts.some((t) => /^词\s*[:：]/.test(t)), `「词：…」应被过滤，实际 ${JSON.stringify(texts)}`);
  assert(texts.includes('故事的小黄花'), `正常歌词应保留，实际 ${JSON.stringify(texts)}`);
});

test('手工 QRC：[ti:] 头标签不作为歌词', () => {
  assert(!parseQrcXml(SIMPLE).lines.some((l) => /^\[ti:/.test(l.text)), '头部标签混进歌词了');
});

test('手工 QRC：三段时间戳（QtRC 标记）也能解析', () => {
  const xml = '<Lyric_1 LyricContent="[0,1000]你(0,100,0)好(100,100,5)"/>';
  const l = parseQrcXml(xml).lines[0];
  assert(l.text === '你好', `期望「你好」，实际「${l.text}」`);
  assert(l.chars.length === 2, `期望 2 个字，实际 ${l.chars.length}`);
});

test('署名判定：典型署名行都能识别', () => {
  for (const t of ['by：Freddie Mercury', '词：周杰伦', '合声编写：周杰伦', '录音助理：刘勇志',
    '录音工程：杨瑞代（Alfa Studio）', '混音工程：杨大纬（杨大纬录音工作室）', '鼓：陈柏州',
    '制作人：周杰伦', '编曲：钟兴民', 'OP：JVR Music']) {
    assert(isCreditLine(t), `「${t}」应判为署名行`);
  }
});

test('署名判定：正常歌词不会被误杀', () => {
  for (const t of ['故事的小黄花', '等到放晴的那天也许我会比较好一点', 'Is this the real life?',
    '曲终人散：我说的', '我说：你好', '我一直在想你']) {
    assert(!isCreditLine(t), `「${t}」被误判为署名行`);
  }
});

// ---------------------------------------------------------------- 真实数据
const realPath = path.join(ROOT, 'assets', 'lyrics', 'qq-0039MnYb0qxYhV.qrc');
if (fs.existsSync(realPath)) {
  const out = parseQrcXml(fs.readFileSync(realPath, 'utf8'));

  test('真实 QRC（晴天）：行数合理', () => {
    assert(out.lines.length > 40, `行数 ${out.lines.length} 太少`);
  });
  test('真实 QRC：首行是歌词而不是署名', () => {
    const first = String(out.lines[0].text).trim();
    assert(!isCreditLine(first), `首行仍是署名：${first}`);
  });
  test('真实 QRC：全文无 "by：" 行', () => {
    assert(!/^\s*by\s*[:：]/im.test(out.lines.map((l) => l.text).join('\n')), '仍有 by：行');
  });
  test('真实 QRC：逐字时间戳单调递增', () => {
    for (const l of out.lines) {
      let prev = -1;
      for (const c of l.chars) {
        assert(c.startMs >= prev, `行「${l.text}」时间戳倒退：${c.startMs} < ${prev}`);
        prev = c.startMs;
      }
    }
  });
  test('真实 QRC：chars 拼接等于行文本（错位 bug 回归）', () => {
    for (const l of out.lines) {
      const joined = l.chars.map((c) => c.text).join('');
      assert(joined === l.text, `「${l.text}」vs「${joined}」`);
    }
  });
  test('真实 QRC：含完整歌词行「故事的小黄花」', () => {
    assert(out.lines.some((l) => l.text === '故事的小黄花'), '找不到完整歌词行，可能首字仍被吃');
  });
} else {
  console.log('  (跳过真实 QRC 用例：assets/lyrics/qq-0039MnYb0qxYhV.qrc 不存在)');
}

// ---------------------------------------------------------------- 共用性
test('server.js 与 qq-lyrics.js 都使用同一个实现', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const qq = fs.readFileSync(path.join(ROOT, 'lib', 'qq-lyrics.js'), 'utf8');
  assert(server.includes("require('./lib/qrc-parse.js')"), 'server.js 没有引用 lib/qrc-parse.js');
  assert(qq.includes("require('./qrc-parse.js')"), 'qq-lyrics.js 没有引用 qrc-parse.js');
  assert(!/function parseQrcXml/.test(server), 'server.js 里还有一份 parseQrcXml，会再次漂移');
});

console.log(`\nPASS：${passed}/${passed + failed} 通过，${failed} 失败`);
if (failed) {
  process.exitCode = 1;
  for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
}
