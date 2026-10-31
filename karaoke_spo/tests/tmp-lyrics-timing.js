'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-lyrics-diag-'));
process.env.PORT = '3815';
process.env.HOST = '127.0.0.1';
process.env.KARAOKE_DATA_DIR = TMP;
process.env.KARAOKE_PREPARE_DISABLE_SPAWN = '1';
process.env.LIBRARY_DB = path.join(__dirname, '..', 'data', 'library.db');
process.env.DJ_PASSWORD = 'diag';

const app = require(path.join(__dirname, '..', 'server.js'));
const BASE = 'http://127.0.0.1:3815';

(async () => {
  const server = app.start();
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const cases = [
    ['honeybee', '407LgLkk1uM3wMO6jVRe0a', 'Olivia Rodrigo', 223],
    ['petal', '70pVCVMGjmIWPbWXDwf11e', 'Ariana Grande', 193],
  ];
  for (const [title, spotifyId, artist, duration] of cases) {
    const qs = new URLSearchParams({
      videoId: `local:${spotifyId}`, wordLevel: '1', songTitle: title, artist, duration: String(duration),
    });
    const started = Date.now();
    try {
      const res = await fetch(`${BASE}/api/lyrics/lookup?${qs}`);
      const body = await res.json();
      console.log(JSON.stringify({
        title,
        ms: Date.now() - started,
        found: body.found,
        lines: (body.lines || []).length,
        provider: body.provider,
        format: body.format,
        wordLevel: body.wordLevel,
        fromLibrary: body.fromLibrary,
        upgraded: body.upgraded,
        error: body.error,
      }));
    } catch (e) {
      console.log(JSON.stringify({ title, ms: Date.now() - started, error: e.message }));
    }
  }
  await new Promise((r) => server.close(r));
  try { require(path.join(__dirname, '..', 'lib', 'library-db.js')).close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
})();
