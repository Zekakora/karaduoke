'use strict';
/** LRC / Lyricify Lines / QRC 解析。只做纯函数，方便单测（前端与 Node 服务端共用同一份文件）。 */

const TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_RE = /^\[([a-zA-Z]+):(.*)\]$/;
const LINES_RE = /^\[(\d+),(\d+)\](.*)$/;
// QRC 行头：[start,duration] 毫秒整数
const QRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
// QRC 逐字：`<start,duration>字` / `(start,duration)字`，部分导出还会再套一层 `[start,duration]字`
const QRC_SYLLABLE_RE = /[[<(](\d+),(\d+)[\]>)]\s*([^[<(]*)/g;

function parseTimestamp(min, sec, frac) {
  const fraction = frac ? Number(`0.${frac.padEnd(3, '0')}`) : 0;
  return Number(min) * 60000 + Number(sec) * 1000 + Math.round(fraction * 1000);
}

/**
 * @param {string} text
 * @returns {{meta: object, lines: Array<{startMs:number,endMs:number|null,text:string,syllables?:Array<{text:string,startMs:number,endMs:number}>}>, format: string, warnings: string[]}}
 */
function parseLrc(text) {
  const meta = {};
  const lines = [];
  const warnings = [];
  const raw = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);

  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const metaMatch = META_RE.exec(trimmed);
    if (metaMatch && !/^\d/.test(metaMatch[1])) {
      meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
      continue;
    }

    // Lyricify Lines: [start,end]text（毫秒整数）
    const lyrLines = LINES_RE.exec(trimmed);
    if (meta.type && /lyricifylines/i.test(meta.type) && lyrLines) {
      lines.push({ startMs: Number(lyrLines[1]), endMs: Number(lyrLines[2]), text: lyrLines[3].trim() });
      continue;
    }

    // 标准 LRC：[mm:ss.xx][mm:ss.xx]text —— 允许多时间戳与乱序
    const stamps = [];
    TAG_RE.lastIndex = 0;
    let m;
    let consumed = 0;
    while ((m = TAG_RE.exec(trimmed)) !== null) {
      if (m.index !== consumed) break;
      stamps.push(parseTimestamp(m[1], m[2], m[3]));
      consumed = TAG_RE.lastIndex;
    }
    if (!stamps.length) {
      warnings.push(`无法解析的行: ${trimmed.slice(0, 60)}`);
      continue;
    }
    const content = trimmed.slice(consumed).trim();
    for (const startMs of stamps) {
      lines.push({ startMs, endMs: null, text: content });
    }
  }

  const offset = Number(meta.offset || 0);
  for (const l of lines) {
    if (offset) l.startMs = Math.max(0, l.startMs + offset);
  }

  lines.sort((a, b) => a.startMs - b.startMs || 0);

  // 补 endMs：下一行开始时间；空行（呼吸点）不参与文本显示但保留时间点
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].endMs == null) {
      lines[i].endMs = i + 1 < lines.length ? lines[i + 1].startMs : lines[i].startMs + 5000;
    }
  }

  const isLines = lines.every((l) => l.endMs != null) && /lyricifylines/i.test(meta.type || '');
  return { meta, lines, format: isLines ? 'lyricify-lines' : 'lrc', warnings };
}

/**
 * 解析一行 QRC 内容，得到逐字片段。没有逐字标记时返回空数组（调用方退化到整行高亮）。
 * @returns {Array<{text:string,startMs:number,endMs:number}>}
 */
function parseQrcSyllables(content, lineStartMs, lineEndMs) {
  const out = [];
  QRC_SYLLABLE_RE.lastIndex = 0;
  let m;
  while ((m = QRC_SYLLABLE_RE.exec(content)) !== null) {
    const startMs = Number(m[1]);
    const text = m[3];
    if (!text) continue; // 空片段直接跳过
    out.push({ text, startMs, endMs: startMs + Number(m[2]) });
  }
  if (!out.length) return [];
  // 兜底：起止时间缺失/越界时用行时间夹紧，保证单调，便于前端做进度计算
  out.sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < out.length; i += 1) {
    if (!Number.isFinite(out[i].startMs)) out[i].startMs = lineStartMs;
    if (out[i].endMs <= out[i].startMs) out[i].endMs = out[i].startMs + 1;
    if (i > 0 && out[i].startMs < out[i - 1].endMs) out[i].startMs = out[i - 1].endMs;
  }
  if (Number.isFinite(lineEndMs) && lineEndMs > out[out.length - 1].endMs) {
    // 行尾余量归到最后一片，避免进度在最后一片“提前满格后停住”
    out[out.length - 1].endMs = lineEndMs;
  }
  return out;
}

/**
 * QRC（QQ 音乐逐字歌词）：
 *   [start,duration]字<start,duration>字<start,duration>
 * 也接受 `(start,duration)` 包裹的字（部分导出工具用圆括号），时间均为毫秒整数。
 * 注意：标准 LRC 的 [mm:ss.xx] 里含冒号，不会被行头正则误吞。
 * @returns {{meta: object, lines: Array<{startMs:number,endMs:number,text:string,syllables:Array<{text:string,startMs:number,endMs:number}>}>, format: string, warnings: string[]}}
 */
function parseQrc(text) {
  const meta = {};
  const warnings = [];
  const raw = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const collected = [];

  for (const line of raw) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const head = QRC_LINE_RE.exec(trimmed);
    if (head) {
      const startMs = Number(head[1]);
      const durationMs = Number(head[2]);
      const body = head[3] || '';
      collected.push({ startMs, endMs: startMs + durationMs, body });
      continue;
    }

    const metaMatch = META_RE.exec(trimmed);
    if (metaMatch && !/^\d/.test(metaMatch[1])) {
      meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
      continue;
    }
    warnings.push(`无法解析的行: ${trimmed.slice(0, 60)}`);
  }

  collected.sort((a, b) => a.startMs - b.startMs);
  const lines = [];
  for (const item of collected) {
    const syllables = parseQrcSyllables(item.body, item.startMs, item.endMs);
    // 纯文本优先：逐字片段去掉时间标记后拼起来；若行内没有逐字标记，取 `<`/`(` 之前的裸文本
    const text = syllables.length ? syllables.map((s) => s.text).join('') : item.body.replace(/[<(]\d+,\d+[>)]/g, '').trim();
    const entry = { startMs: item.startMs, endMs: item.endMs, text };
    if (syllables.length) entry.syllables = syllables;
    lines.push(entry);
  }

  // 行时间自洽：endMs 不大于下一行起点，最后一行至少 1s
  for (let i = 0; i < lines.length; i += 1) {
    const next = i + 1 < lines.length ? lines[i + 1].startMs : lines[i].startMs + Math.max(1000, lines[i].endMs - lines[i].startMs);
    if (!(lines[i].endMs > lines[i].startMs)) lines[i].endMs = lines[i].startMs + 1000;
    if (lines[i].endMs > next) lines[i].endMs = next;
  }

  return { meta, lines, format: 'qrc', warnings };
}

/**
 * 自动识别格式：带 [type:...] 或只有 [mm:ss.xx] 的走 LRC；带“行头 + 逐字标记”的走 QRC。
 * 两种都失败时仍返回 parseLrc 的结果（保留 warnings），绝不抛错。
 */
function parseLyrics(text) {
  const src = String(text || '');
  for (const line of src.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^\[[a-zA-Z]+:/.test(t)) continue; // 跳过空行与元信息
    const m = QRC_LINE_RE.exec(t);
    // 行头 [start,duration] 的数字量级足以与 [mm:ss] 区分；行内带任意方括号即视为 QRC 行
    if (m && (m[3].includes('<') || m[3].includes('(') || m[3].includes('[') || !m[3].trim())) return parseQrc(src);
    break; // 只看第一行有效内容，避免混合文件误判
  }
  return parseLrc(src);
}

/** 定位当前行：返回最后一条 startMs <= t 的行；空行表示"间隙"。 */
function findLineIndex(lines, t) {
  if (!lines.length) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 逐字高亮进度：返回当前行已经唱到第几个字（含小数部分）。
 * 例：syllables 共 3 片，t 落在第 2 片一半 → 1.5。
 * 没有逐字数据 / 非当前行时间窗 → 返回 null（调用方退化为整行高亮）。
 */
function syllableProgress(line, t) {
  const syl = line && line.syllables;
  if (!Array.isArray(syl) || !syl.length) return null;
  if (t <= syl[0].startMs) return 0;
  const last = syl[syl.length - 1];
  if (t >= last.endMs) return syl.length;
  for (let i = 0; i < syl.length; i += 1) {
    const s = syl[i];
    if (t < s.startMs) return i;
    if (t < s.endMs) {
      const span = Math.max(1, s.endMs - s.startMs);
      return i + (t - s.startMs) / span;
    }
  }
  return syl.length;
}

/**
 * 行内字符级高亮比例（0~1），用于 background-clip:text 的渐变填充。
 * 首尾的空白不占进度，避免“看起来已经唱完”。
 */
function lineFillRatio(line, t) {
  if (!line || !line.text) return 0;
  const prog = syllableProgress(line, t);
  if (prog == null) {
    // 无逐字：按行时间比例整行扫过（视觉上更像“唱到这里”）
    const span = Math.max(1, (line.endMs || line.startMs + 1000) - line.startMs);
    return Math.min(1, Math.max(0, (t - line.startMs) / span));
  }
  const chars = [...line.text];
  let total = 0;
  let done = 0;
  const syl = line.syllables;
  for (let i = 0; i < syl.length; i += 1) {
    const len = [...syl[i].text].length;
    total += len;
    if (i < Math.floor(prog)) done += len;
    else if (i === Math.floor(prog)) done += len * (prog - Math.floor(prog));
  }
  return total ? Math.min(1, Math.max(0, done / total)) : 0;
}

/**
 * 同步引擎的纯函数部分：给定播放位置与上次锚点，算出用于显示的插值位置。
 * anchor = {positionMs, wallMs, playing}；wallMs 用 performance.now()。
 */
function interpolate(anchor, wallNow, durationMs) {
  if (!anchor) return 0;
  if (!anchor.playing) return clamp(anchor.positionMs, durationMs);
  return clamp(anchor.positionMs + (wallNow - anchor.wallMs), durationMs);
}

function clamp(v, durationMs) {
  const max = durationMs && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(0, v), max);
}

const api = { parseLrc, parseQrc, parseQrcSyllables, parseLyrics, findLineIndex, syllableProgress, lineFillRatio, interpolate };

module.exports = api;
