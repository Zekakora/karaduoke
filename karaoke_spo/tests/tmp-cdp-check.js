'use strict';
// 临时诊断脚本：用 Edge CDP 打开大屏，检查歌词视图是否挂载/有行。
(async () => {
  const wsUrl = process.env.CDP_WS;
  if (!wsUrl) throw new Error('CDP_WS missing');
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    } else if (['Runtime.exceptionThrown', 'Runtime.consoleAPICalled', 'Log.entryAdded'].includes(m.method)) {
      events.push({ method: m.method, params: m.params });
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((res) => { ws.onopen = res; });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:3100/display' });
  await new Promise((r) => setTimeout(r, 14000));
  const expr = `(() => {
    const p = document.querySelector('#player');
    const lv = document.querySelector('#lyrics-host');
    return {
      href: location.href,
      hasRender: typeof window.__displayRender,
      playerClass: p ? p.className : null,
      playerText: p ? p.innerText.slice(0, 300) : null,
      hasLyricsHost: !!lv,
      hasVideoHost: !!document.querySelector('#video-host'),
      lvLines: document.querySelectorAll('.lv-line').length,
      lvActive: document.querySelectorAll('.lv-line.active').length,
      lyricsHtmlLen: lv ? lv.innerHTML.length : 0,
      bodyText: document.body.innerText.slice(0, 300)
    };
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log(JSON.stringify(r.result.value, null, 2));
  console.log('EVENTS:', JSON.stringify(events.slice(0, 12), null, 2).slice(0, 5000));
  ws.close();
})().catch((e) => { console.error('DIAG FAIL', e); process.exitCode = 1; });
