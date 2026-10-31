'use strict';
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/library.db', { readOnly: true });
const rows = db.prepare(`
  SELECT t.spotify_id, t.title, t.status, l.provider, l.format, l.synced,
         length(l.content) AS clen, length(l.plain) AS plen,
         substr(l.content, 1, 100) AS head, l.fetched_at
    FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id
   ORDER BY t.id DESC LIMIT 15`).all();
console.log(JSON.stringify(rows, null, 2));
const stems = db.prepare(`SELECT t.spotify_id, s.model, s.vocals_path, s.no_vocals_path FROM tracks t LEFT JOIN stems s ON s.track_id = t.id ORDER BY t.id DESC LIMIT 15`).all();
console.log(JSON.stringify(stems, null, 2));
db.close();
