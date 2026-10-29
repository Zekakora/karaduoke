'use strict';
// QQ 音乐 QRC（逐字歌词）解密：QQ 私有的“魔改 3DES” + zlib。
//
// 数据链路（实测通过）：
//   POST https://u.y.qq.com/cgi-bin/musicu.fcg
//   module: music.musichallSong.PlayLyricInfo
//   method: GetPlayLyricInfo
//   param : { crypt: 1, qrc: 1, type: 1, trans: 1, ... }   ← 关键：必须带 crypt:1
//   响应    data.lyric 是【hex 字符串】(不是 base64!)
//   处理    hex 解码 → 3DES-ECB(魔改变体) → zlib inflate → QRC XML 明文
//
// 为什么之前用 node:crypto 解不开：
//   1) 这是「魔改 3DES」：密钥扩展的 PC-2 后半段用 `KEY_COMPRESSION[j] - 27`
//      （标准实现是 -28，因为 C/D 各 28 位）。标准 des-ede3/des-ecb 对不上。
//   2) 字段是 hex 不是 base64。9808 个 hex 字符 → 4904 字节（本来就是 8 的倍数）。
//   3) 不需要任何“去掉前 N 字节头”的操作。
//
// 参考实现：WXRIW/QQMusicDecoder (Decrypter.cs / DESHelper.cs)、
//           chongya369/qqmusic-api-py (tripledes.py)。本文件按 DESHelper.cs 逐位移植。
// 密钥：QRC_KEY = "!@#)(*$%123ZXC!@!@#)(NHL"（客户端内置，公开）。

const zlib = require('zlib');

const SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7, 0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8, 4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0, 15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10, 3,13,4,7,15,2,8,15,12,0,1,10,6,9,11,5, 0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15, 13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8, 13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1, 13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7, 1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15, 13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9, 10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4, 3,15,0,6,10,10,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9, 14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6, 4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14, 11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11, 10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8, 9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6, 4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1, 13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6, 1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2, 6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7, 1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2, 7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8, 2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

const KEY_PERM_C = [56,48,40,32,24,16,8,0,57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35];
const KEY_PERM_D = [62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,60,52,44,36,28,20,12,4,27,19,11,3];
// 标准 PC-2 表；取值时后半段偏移 -27（见 keySchedule，QQ 变体的 bug）
const KEY_COMPRESSION = [13,16,10,23,0,4,2,27,14,5,20,9,22,18,11,3,25,7,15,6,26,19,12,1,
  40,51,30,36,46,54,29,39,50,44,32,47,43,48,38,55,33,52,45,41,49,35,28,31];
const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1];

const MODE_ENCRYPT = 1;
const MODE_DECRYPT = 0;

const QRC_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL', 'ascii');

const _bitnum = (a, b, c) => ((a[((b / 32) | 0) * 4 + 3 - (((b % 32) / 8) | 0)] >> (7 - (b % 8))) & 1) << c;
const _bitnumIntr = (a, b, c) => ((a >>> (31 - b)) & 1) << c;
const _bitnumIntl = (a, b, c) => (((a << b) & 0x80000000) >>> c) >>> 0;
const _sboxBit = (a) => (a & 0x20) | ((a & 0x1f) >> 1) | ((a & 0x01) << 4);

const keySchedule = (key, mode) => {
  const sched = Array.from({ length: 16 }, () => [0, 0, 0, 0, 0, 0]);
  let C = 0;
  let D = 0;
  for (let i = 0, j = 31; i < 28; ++i, --j) C |= _bitnum(key, KEY_PERM_C[i], j);
  for (let i = 0, j = 31; i < 28; ++i, --j) D |= _bitnum(key, KEY_PERM_D[i], j);
  C >>>= 0;
  D >>>= 0;
  for (let i = 0; i < 16; ++i) {
    const sh = SHIFTS[i];
    C = (((C << sh) | (C >>> (28 - sh))) & 0xfffffff0) >>> 0;
    D = (((D << sh) | (D >>> (28 - sh))) & 0xfffffff0) >>> 0;
    const toGen = mode === MODE_DECRYPT ? 15 - i : i;
    for (let q = 0; q < 6; ++q) sched[toGen][q] = 0;
    for (let j = 0; j < 24; ++j) sched[toGen][(j / 8) | 0] |= _bitnumIntr(C, KEY_COMPRESSION[j], 7 - (j % 8));
    // QQ 变体：-27（标准为 -28）
    for (let j = 24; j < 48; ++j) sched[toGen][(j / 8) | 0] |= _bitnumIntr(D, KEY_COMPRESSION[j] - 27, 7 - (j % 8));
  }
  return sched;
};

const initialPermutation = (state, input) => {
  state[0] = (_bitnum(input,57,31)|_bitnum(input,49,30)|_bitnum(input,41,29)|_bitnum(input,33,28)|_bitnum(input,25,27)|_bitnum(input,17,26)|_bitnum(input,9,25)|_bitnum(input,1,24)|_bitnum(input,59,23)|_bitnum(input,51,22)|_bitnum(input,43,21)|_bitnum(input,35,20)|_bitnum(input,27,19)|_bitnum(input,19,18)|_bitnum(input,11,17)|_bitnum(input,3,16)|_bitnum(input,61,15)|_bitnum(input,53,14)|_bitnum(input,45,13)|_bitnum(input,37,12)|_bitnum(input,29,11)|_bitnum(input,21,10)|_bitnum(input,13,9)|_bitnum(input,5,8)|_bitnum(input,63,7)|_bitnum(input,55,6)|_bitnum(input,47,5)|_bitnum(input,39,4)|_bitnum(input,31,3)|_bitnum(input,23,2)|_bitnum(input,15,1)|_bitnum(input,7,0))>>>0;
  state[1] = (_bitnum(input,56,31)|_bitnum(input,48,30)|_bitnum(input,40,29)|_bitnum(input,32,28)|_bitnum(input,24,27)|_bitnum(input,16,26)|_bitnum(input,8,25)|_bitnum(input,0,24)|_bitnum(input,58,23)|_bitnum(input,50,22)|_bitnum(input,42,21)|_bitnum(input,34,20)|_bitnum(input,26,19)|_bitnum(input,18,18)|_bitnum(input,10,17)|_bitnum(input,2,16)|_bitnum(input,60,15)|_bitnum(input,52,14)|_bitnum(input,44,13)|_bitnum(input,36,12)|_bitnum(input,28,11)|_bitnum(input,20,10)|_bitnum(input,12,9)|_bitnum(input,4,8)|_bitnum(input,62,7)|_bitnum(input,54,6)|_bitnum(input,46,5)|_bitnum(input,38,4)|_bitnum(input,30,3)|_bitnum(input,22,2)|_bitnum(input,14,1)|_bitnum(input,6,0))>>>0;
};

const inverseIP = (state, out) => {
  out[3] = (_bitnumIntr(state[1],7,7)|_bitnumIntr(state[0],7,6)|_bitnumIntr(state[1],15,5)|_bitnumIntr(state[0],15,4)|_bitnumIntr(state[1],23,3)|_bitnumIntr(state[0],23,2)|_bitnumIntr(state[1],31,1)|_bitnumIntr(state[0],31,0)) & 0xff;
  out[2] = (_bitnumIntr(state[1],6,7)|_bitnumIntr(state[0],6,6)|_bitnumIntr(state[1],14,5)|_bitnumIntr(state[0],14,4)|_bitnumIntr(state[1],22,3)|_bitnumIntr(state[0],22,2)|_bitnumIntr(state[1],30,1)|_bitnumIntr(state[0],30,0)) & 0xff;
  out[1] = (_bitnumIntr(state[1],5,7)|_bitnumIntr(state[0],5,6)|_bitnumIntr(state[1],13,5)|_bitnumIntr(state[0],13,4)|_bitnumIntr(state[1],21,3)|_bitnumIntr(state[0],21,2)|_bitnumIntr(state[1],29,1)|_bitnumIntr(state[0],29,0)) & 0xff;
  out[0] = (_bitnumIntr(state[1],4,7)|_bitnumIntr(state[0],4,6)|_bitnumIntr(state[1],12,5)|_bitnumIntr(state[0],12,4)|_bitnumIntr(state[1],20,3)|_bitnumIntr(state[0],20,2)|_bitnumIntr(state[1],28,1)|_bitnumIntr(state[0],28,0)) & 0xff;
  out[7] = (_bitnumIntr(state[1],3,7)|_bitnumIntr(state[0],3,6)|_bitnumIntr(state[1],11,5)|_bitnumIntr(state[0],11,4)|_bitnumIntr(state[1],19,3)|_bitnumIntr(state[0],19,2)|_bitnumIntr(state[1],27,1)|_bitnumIntr(state[0],27,0)) & 0xff;
  out[6] = (_bitnumIntr(state[1],2,7)|_bitnumIntr(state[0],2,6)|_bitnumIntr(state[1],10,5)|_bitnumIntr(state[0],10,4)|_bitnumIntr(state[1],18,3)|_bitnumIntr(state[0],18,2)|_bitnumIntr(state[1],26,1)|_bitnumIntr(state[0],26,0)) & 0xff;
  out[5] = (_bitnumIntr(state[1],1,7)|_bitnumIntr(state[0],1,6)|_bitnumIntr(state[1],9,5)|_bitnumIntr(state[0],9,4)|_bitnumIntr(state[1],17,3)|_bitnumIntr(state[0],17,2)|_bitnumIntr(state[1],25,1)|_bitnumIntr(state[0],25,0)) & 0xff;
  out[4] = (_bitnumIntr(state[1],0,7)|_bitnumIntr(state[0],0,6)|_bitnumIntr(state[1],8,5)|_bitnumIntr(state[0],8,4)|_bitnumIntr(state[1],16,3)|_bitnumIntr(state[0],16,2)|_bitnumIntr(state[1],24,1)|_bitnumIntr(state[0],24,0)) & 0xff;
};

const roundF = (state, key) => {
  const t1 = _bitnumIntl(state,31,0)|((state & 0xf0000000)>>>1)|_bitnumIntl(state,4,5)|_bitnumIntl(state,3,6)|((state & 0x0f000000)>>>3)|_bitnumIntl(state,8,11)|_bitnumIntl(state,7,12)|((state & 0x00f00000)>>>5)|_bitnumIntl(state,12,17)|_bitnumIntl(state,11,18)|((state & 0x000f0000)>>>7)|_bitnumIntl(state,16,23);
  const t2 = _bitnumIntl(state,15,0)|((state & 0x0000f000)<<15)|_bitnumIntl(state,20,5)|_bitnumIntl(state,19,6)|((state & 0x00000f00)<<13)|_bitnumIntl(state,24,11)|_bitnumIntl(state,23,12)|((state & 0x000000f0)<<11)|_bitnumIntl(state,28,17)|_bitnumIntl(state,27,18)|((state & 0x0000000f)<<9)|_bitnumIntl(state,0,23);
  const ls = [(t1>>>24)&0xff, (t1>>>16)&0xff, (t1>>>8)&0xff, (t2>>>24)&0xff, (t2>>>16)&0xff, (t2>>>8)&0xff];
  for (let i = 0; i < 6; i++) ls[i] ^= key[i];
  const s = ((SBOX[0][_sboxBit(ls[0] >> 2)] << 28)|(SBOX[1][_sboxBit(((ls[0] & 0x03) << 4) | (ls[1] >> 4))] << 24)|(SBOX[2][_sboxBit(((ls[1] & 0x0f) << 2) | (ls[2] >> 6))] << 20)|(SBOX[3][_sboxBit(ls[2] & 0x3f)] << 16)|(SBOX[4][_sboxBit(ls[3] >> 2)] << 12)|(SBOX[5][_sboxBit(((ls[3] & 0x03) << 4) | (ls[4] >> 4))] << 8)|(SBOX[6][_sboxBit(((ls[4] & 0x0f) << 2) | (ls[5] >> 6))] << 4)|SBOX[7][_sboxBit(ls[5] & 0x3f)]) >>> 0;
  return (_bitnumIntl(s,15,0)|_bitnumIntl(s,6,1)|_bitnumIntl(s,19,2)|_bitnumIntl(s,20,3)|_bitnumIntl(s,28,4)|_bitnumIntl(s,11,5)|_bitnumIntl(s,27,6)|_bitnumIntl(s,16,7)|_bitnumIntl(s,0,8)|_bitnumIntl(s,14,9)|_bitnumIntl(s,22,10)|_bitnumIntl(s,25,11)|_bitnumIntl(s,4,12)|_bitnumIntl(s,17,13)|_bitnumIntl(s,30,14)|_bitnumIntl(s,9,15)|_bitnumIntl(s,1,16)|_bitnumIntl(s,7,17)|_bitnumIntl(s,23,18)|_bitnumIntl(s,13,19)|_bitnumIntl(s,31,20)|_bitnumIntl(s,26,21)|_bitnumIntl(s,2,22)|_bitnumIntl(s,8,23)|_bitnumIntl(s,18,24)|_bitnumIntl(s,12,25)|_bitnumIntl(s,29,26)|_bitnumIntl(s,5,27)|_bitnumIntl(s,21,28)|_bitnumIntl(s,10,29)|_bitnumIntl(s,3,30)|_bitnumIntl(s,24,31)) >>> 0;
};

const desBlock = (input, key) => {
  const state = [0, 0];
  initialPermutation(state, input);
  for (let i = 0; i < 15; ++i) {
    const t = state[1];
    state[1] = (roundF(state[1], key[i]) ^ state[0]) >>> 0;
    state[0] = t;
  }
  state[0] = (roundF(state[1], key[15]) ^ state[0]) >>> 0;
  const out = Buffer.alloc(8);
  inverseIP(state, out);
  return out;
};

const setup3des = (key, mode) => (
  mode === MODE_ENCRYPT
    ? [keySchedule(key.subarray(0), MODE_ENCRYPT), keySchedule(key.subarray(8), MODE_DECRYPT), keySchedule(key.subarray(16), MODE_ENCRYPT)]
    : [keySchedule(key.subarray(16), MODE_DECRYPT), keySchedule(key.subarray(8), MODE_ENCRYPT), keySchedule(key.subarray(0), MODE_DECRYPT)]
);

const decrypt3des = (buf, key = QRC_KEY) => {
  if (buf.length === 0 || buf.length % 8 !== 0) {
    throw new Error('QRC ciphertext length ' + buf.length + ' is not a multiple of 8');
  }
  const sched = setup3des(key, MODE_DECRYPT);
  const parts = [];
  for (let i = 0; i < buf.length; i += 8) {
    let blk = buf.subarray(i, i + 8);
    for (let r = 0; r < 3; r++) blk = desBlock(blk, sched[r]);
    parts.push(blk);
  }
  return Buffer.concat(parts);
};

/** hex 密文 → 解压后的 QRC XML 明文 */
const decryptQrc = (hexString) => zlib.inflateSync(decrypt3des(Buffer.from(hexString, 'hex'))).toString('utf8');

module.exports = { decryptQrc, decrypt3des, setup3des, desBlock, QRC_KEY };
