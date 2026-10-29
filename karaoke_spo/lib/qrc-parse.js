'use strict';
/**
 * QQ QRC（逐字歌词）解析 —— 唯一实现，server.js 和 lib/qq-lyrics.js 共用。
 *
 * 为什么抽出来：之前有两份独立实现，都写成「取时间戳**后面**那段文字」，
 * 而 QRC 的实际排布是**文字在前、时间戳在后**：
 *
 *     [0,2250]晴(0,160)天(160,160) (320,160)
 *              ↑「晴」是第一个字，(0,160) 是它的时间
 *
 * 结果每行第一个字被吃掉、末尾多一个空字
 * （"Is this the real life" 变成 "this the real life"）。
 * 只留一份实现，避免以后再漂移。
 */

/**
 * 从 QRC XML 里取出 LyricContent 属性值。
 *
 * ⚠️ 这里曾经用懒惰匹配 `/LyricContent="([\s\S]*?)"/`，会**在歌词正文里出现的第一个
 * 英文引号处截断** —— 比如 Ariana Grande「thank u, next」里那句
 * `"Thank you" to Malcolm`，整首歌 114 行只剩 9 行、21 秒之后就没歌词了。
 *
 * 属性值以 `"/>`（或 `" />`）收尾，所以必须贪婪匹配到 **标签结束**，
 * 而不是匹配到任意一个引号。
 */
function extractLyricContent(xml) {
  const text = String(xml || '');
  const marker = 'LyricContent="';
  const start = text.indexOf(marker);
  if (start < 0) return text; // 不是 XML 包裹的裸文本
  const from = start + marker.length;
  // 找最后一个 `"` + 可选空白 + 可选的 / + >，这就是属性值的真正结尾
  const endRe = /"\s*\/?>/g;
  endRe.lastIndex = from;
  let end = -1;
  let m;
  while ((m = endRe.exec(text)) !== null) end = m.index;
  if (end < 0) end = text.lastIndexOf('"');
  if (end <= from) return text.slice(from);
  return text.slice(from, end);
}

/**
 * 解析 QRC XML → [{ startMs, endMs, text, chars: [{ text, startMs, endMs }] }]
 *
 * 行格式：`[行开始ms,行时长ms]字(字开始ms,字时长ms)字(字开始ms,字时长ms)...`
 * 注意字的时间戳是**两段式**（start,dur），个别数据会有第三段（QtRC 标记），忽略。
 */
function parseQrcXml(xml) {
  const content = extractLyricContent(xml);
  const lines = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || /^\[(ti|ar|al|by|offset|kana):/.test(line)) continue;
    const head = /^\[(\d+),(\d+)\]/.exec(line);
    if (!head) continue;
    const startMs = Number(head[1]);
    const rest = line.slice(head[0].length);
    const chars = [];
    const re = /\((\d+),(\d+)(?:,-?\d+)?\)/g;
    let mm;
    let lastEnd = 0;
    let text = '';
    // 每个 (start,dur) 对应的是**它前面**那段文字
    let cursor = 0;
    while ((mm = re.exec(rest)) !== null) {
      const ch = rest.slice(cursor, mm.index);
      cursor = mm.index + mm[0].length;
      const start = Number(mm[1]);
      const dur = Number(mm[2]);
      chars.push({ text: ch, startMs: start, endMs: start + dur });
      text += ch;
      lastEnd = Math.max(lastEnd, start + dur);
    }
    // 最后一个时间戳之后若还有残留文字（不规范数据），并到最后一个字里
    const tail = rest.slice(cursor);
    if (tail) {
      text += tail;
      if (chars.length) chars[chars.length - 1].text += tail;
      else chars.push({ text: tail, startMs, endMs: startMs + Number(head[2]) });
    }
    if (!text) continue;
    lines.push({
      startMs,
      // 行 dur 不可靠（不覆盖末字），用最后一字的结束时间
      endMs: lastEnd || startMs + Number(head[2]),
      text,
      chars,
    });
  }
  const cleaned = dropCreditLines(lines);
  return { lines: cleaned, plainText: cleaned.map((l) => l.text).join('\n') };
}

/**
 * 丢 QQ QRC 里的「制作信息」行。
 *
 * QQ 会把标题和词曲编配等署名放进歌词正文：
 *   'Bohemian Rhapsody - Queen (皇后乐队)'
 *   'by：Freddie Mercury'
 *   '合声编写：周杰伦'
 *   '录音工程：杨瑞代（Alfa Studio）'
 *   '鼓：陈柏州'
 * 规则：短前缀 + 冒号，且前缀里含署名类关键词。
 * 不能要求关键词紧跟冒号（"合声编写：" "录音工程：" 都是关键词+子类）。
 */
const CREDIT_ROLE_ANYWHERE = /作词|作曲|编曲|制作|监制|混音|母带|和声|合声|录音|出品|发行|演唱|原唱|翻唱|配唱|弦乐|钢琴|架子鼓|吉他|贝斯|键盘|编写|工程|助理|工作室|lyrics|music|composed|arranged|produced|written/i;
// 单字/极短关键词只允许「整个前缀就是它」，避免误杀「曲终人散：…」这类歌词
const CREDIT_ROLE_EXACT = /^(词|曲|鼓|琴|by|op|sp|词曲|吉他|贝斯|键盘)$/i;

function isCreditLine(text) {
  const t = String(text || '').trim();
  const m = /^([^:：]{1,12})\s*[:：]/.exec(t);
  if (!m) return false;
  const prefix = m[1].trim();
  if (!prefix) return false;
  if (CREDIT_ROLE_EXACT.test(prefix)) return true;
  return CREDIT_ROLE_ANYWHERE.test(prefix);
}

function dropCreditLines(lines) {
  if (!lines.length) return lines;
  // 1) 去掉署名行
  let kept = lines.filter((l) => {
    const t = String(l.text || '').trim();
    return t && !isCreditLine(t);
  });
  // 2) 去掉开头两行里的「歌名 - 歌手」标题行
  //    例如 QQ 的 `thank u, next (Explicit) - Ariana Grande (爱莉安娜·格兰德)`：
  //    歌名里带逗号，所以判定不能因为逗号就放过它 —— 只把「句末标点」当作歌词特征。
  const out = [];
  for (let i = 0; i < kept.length; i += 1) {
    const t = String(kept[i].text || '').trim();
    const looksLikeTitle = / [-\u2013\u2014] /.test(t)
      && !/[。！？.!?]/.test(t)          // 句末标点 → 更像歌词
      && t.length <= 80;                 // 标题行不会太长
    if (i < 2 && looksLikeTitle) continue;
    out.push(kept[i]);
  }
  kept = out;
  // 全被删掉就退回原样，宁可多显示也不要空
  return kept.length ? kept : lines;
}

module.exports = { parseQrcXml, dropCreditLines, isCreditLine };
