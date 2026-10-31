import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const lib = require('../lib/library-db.js');

const cases = [
  { id: '4ml4WlnHDEpOK8HRVYTCWf', title: 'drivers license', artists: ['Olivia Rodrigo'], durationMs: 242013 },
  { id: '7lPN2DXiMsVn7XUKtOW1CS', title: 'drivers license', artists: ['Olivia Rodrigo'], durationMs: 242013 },
  { id: '3ucQ4DLpH8RgyzqYBMnDpj', title: 'deja vu', artists: ['Olivia Rodrigo'], durationMs: 215506 },
  { id: '0zrdcAW4qB1hMGmRKZMZ1f', title: 'Super Sage', artists: ['Carly Rae Jepsen'], durationMs: 241620 },
  { id: '77JxSDvDcZVXNptwJOTX3m', title: 'the cure', artists: ['Olivia Rodrigo'], durationMs: 297127 },
  { id: '6P4d1NWBCNIYZjzF9k1mVN', title: 'good 4 u', artists: ['Olivia Rodrigo'], durationMs: 178146 },
  { id: '6iOYHY38sIZ1JzLkIC4YkT', title: '1 step forward, 3 steps back', artists: ['Olivia Rodrigo'], durationMs: 163586 },
];
for (const c of cases) {
  const found = lib.findExistingSong({ title: c.title, artists: c.artists, durationMs: c.durationMs });
  const own = lib.getTrack(c.id);
  console.log(
    `${c.id} ${c.title}`.padEnd(48),
    `own.ready=${own && own.ready}`.padEnd(14),
    `pick=${found && found.spotifyId}`.padEnd(30),
    `ready=${found && found.ready} primary=${found && found.canonicalId === found.spotifyId}`,
  );
}
// 不该命中的反例：同名不同歌手 / 时长差太多
const neg1 = lib.findExistingSong({ title: 'the cure', artists: ['Lady Gaga'], durationMs: 297000 });
const neg2 = lib.findExistingSong({ title: 'deja vu', artists: ['Olivia Rodrigo'], durationMs: 300000 });
console.log('neg different-artist ->', neg1 && neg1.spotifyId);
console.log('neg duration-diff   ->', neg2 && neg2.spotifyId);
