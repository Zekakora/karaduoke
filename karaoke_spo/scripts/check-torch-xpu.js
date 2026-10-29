'use strict';
// 检查 PyTorch XPU（Intel GPU）在 Windows 各 Python 版本下是否有可用 wheel
const targets = [
  { index: 'xpu', url: 'https://download.pytorch.org/whl/xpu/torch/' },
  { index: 'cpu', url: 'https://download.pytorch.org/whl/cpu/torch/' },
];

(async () => {
  for (const t of targets) {
    try {
      const res = await fetch(t.url);
      const html = await res.text();
      const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      const wheels = links.filter((l) => l.endsWith('.whl'));
      const byCp = {};
      for (const w of wheels) {
        const m = /cp(\d{2,3})-/.exec(w);
        const isWin = /win_amd64/.test(w);
        if (!isWin) continue;
        const key = m ? `cp${m[1]}` : 'other';
        byCp[key] = byCp[key] || [];
        byCp[key].push(w);
      }
      console.log(`\n[${t.index}] status=${res.status} wheels=${wheels.length} winWheels=${wheels.filter((w) => /win_amd64/.test(w)).length}`);
      for (const [k, v] of Object.entries(byCp)) {
        const latest = v.sort().slice(-2);
        console.log(`  ${k}: ${latest.join(' | ')}`);
      }
      if (!wheels.length) {
        console.log('  RAW HEAD:', html.slice(0, 400).replace(/\s+/g, ' '));
      }
    } catch (e) {
      console.log(`[${t.index}] ERR ${e.message}`);
    }
  }
})();
