'use strict';
/**
 * 抓取 Spotify Web API 文档页面，去标签后 grep 与 2026 Dev Mode 变更相关的线索，
 * 并抽取 *all* 站内链接中以 documentation/web-api 开头、疑似迁移/dev-mode 的 slug。
 *
 * 用法: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/probe-docs-2026.js <url...>
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.tmp', 'docs-probe');

const URLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://developer.spotify.com/documentation/web-api/reference/',
      'https://developer.spotify.com/documentation/web-api/tutorials',
      'https://developer.spotify.com/documentation/web-api/concepts/quota-modes',
    ];

const GREP = /2026|development mode|dev mode|allow'?list|allow-?list|5 users|spog/gi;
const SLUG = /documentation\/web-api\/[a-z0-9\-\/]+/gi;

function strip(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function slugify(u) {
  return u.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summary = [];
  for (const url of URLS) {
    const rec = { url };
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 probe' } });
      const html = await res.text();
      rec.status = res.status;
      rec.finalUrl = res.url;
      rec.htmlLength = html.length;
      const text = strip(html);
      fs.writeFileSync(path.join(OUT_DIR, `${slugify(url)}.txt`), text, 'utf8');

      const hits = [];
      const re = new RegExp(GREP.source, 'gi');
      let m;
      while ((m = re.exec(text)) !== null) {
        const start = Math.max(0, m.index - 160);
        hits.push(text.slice(start, m.index + 220).replace(/\s+/g, ' ').trim());
        if (hits.length >= 25) break;
      }
      rec.hitCount = hits.length;
      rec.hits = hits.slice(0, 12);

      const links = [...new Set((html.match(SLUG) || []))].sort();
      rec.linkCount = links.length;
      rec.links = links;
      fs.writeFileSync(path.join(OUT_DIR, `${slugify(url)}.links.json`), JSON.stringify(links, null, 2), 'utf8');
    } catch (e) {
      rec.error = e.message;
    }
    summary.push(rec);
  }

  const all = [...new Set(summary.flatMap((r) => r.links || []))].sort();
  const susp = all.filter((l) => /migrat|dev-?mode|2026|changes|update|breaking|quota/i.test(l));
  const report = { at: new Date().toISOString(), urls: URLS, summary, suspiciousSlugs: susp, allSlugs: all };
  const out = path.join(OUT_DIR, 'probe-docs.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');

  for (const r of summary) {
    console.log(`\n=== ${r.url}`);
    console.log(`  status=${r.status} final=${r.finalUrl} htmlLen=${r.htmlLength} hits=${r.hitCount} links=${r.linkCount}${r.error ? ' ERROR=' + r.error : ''}`);
    for (const h of (r.hits || []).slice(0, 8)) console.log('  * ' + h.slice(0, 300));
  }
  console.log(`\n--- suspicious slugs (${susp.length}) ---`);
  for (const s of susp) console.log('  ' + s);
  console.log(`\n--- all documentation/web-api slugs (${all.length}) ---`);
  for (const s of all) console.log('  ' + s);
  console.log(`\nreport -> ${out}`);
})().catch((e) => { console.error('FATAL', e.stack || e.message); process.exit(1); });
