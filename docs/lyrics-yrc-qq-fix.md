# 歌词源修复 + 网易云 YRC 逐字（2026-10-29）

## 一、QQ 音乐为什么"总是没结果"

**结论：歌词接口是好的，坏的是搜索接口。**

实测三种搜索方式：

| 方式 | 结果 |
| --- | --- |
| `musicu.fcg` + `DoSearchForQQMusicDesktop`（comm.ct=6） | `req_1.code = 2001`，0 条 |
| `musicu.fcg` + `comm.ct=19`（桌面客户端身份） | `req_1.code = 2001`，0 条 |
| **`c.y.qq.com/soso/fcgi-bin/client_search_cp`** | ✅ `code: 0`，8 条 |

`code 2001` = 风控拦截。QQ 把未登录的 `musicu.fcg` 搜索封了，
而 `GetPlayLyricInfo`（取歌词）**仍然完全正常** —— 用 soso 搜到的 mid 去取：

```
歌词接口 HTTP 200 | code = 0
  解密后长度: 8661
  行数: 50 | 逐字时间戳: 494
  首行: "故事的小黄花"
```

所以之前"每次都落到网易云"不是歌词源不行，是**搜索这一步就断了**，
`lookupLyricsQq` 拿不到 mid，遂整个 QQ 分支返回 null。

### 改动

1. `lib/qq-lyrics.js` 的 `searchSongs` 改走 soso：

```js
https://c.y.qq.com/soso/fcgi-bin/client_search_cp
  ?w=<query>&format=json&n=8&p=1&cr=1&t=0&aggr=1&lossless=0&flag_qc=0
```

返回 `{ mid, id, name, singers[], album, intervalS }`，`interval` 统一成**秒**
（soso 本来就是秒，musicu 是毫秒）。

2. `server.js` 的 `lookupLyricsQq` 不再自己维护一套搜索，直接
`require('./lib/qq-lyrics.js').findBestMatch()` —— 避免两份实现再次漂移
（这次就是服务端那份还停在旧接口上，所以改完 lib 仍然无效）。

## 二、网易云 YRC（逐字）

### 接口

YRC 只对**匿名登录 token** 开放，且必须走 eapi 加密接口：

```
POST https://interface3.music.163.com/eapi/song/lyric/v1
Content-Type: application/x-www-form-urlencoded
Cookie: MUSIC_A=<匿名token>; os=pc; appver=8.9.70
body: params=<AES-128-ECB 加密串>
```

签名算法（`e82ckenh8dichen8` 作 key）：

```js
text   = JSON.stringify(payload)
digest = md5(`nobody${url}use${text}md5forencrypt`)
data   = `${url}-36cd479b6b5-${text}-36cd479b6b5-${digest}`
params = AES-128-ECB(data, key).toString('hex').toUpperCase()
```

**响应是明文 JSON**（只有请求要加密）。字段：`lrc / yrc / tlyric / klyric / romalrc`。

匿名 token 写死在 `lib/netease-lyrics.js` 的 `ANON_TOKEN`，
来源是上游项目 ESLyric-LyricsSource —— 网易云一旦轮换就会失效，
届时 YRC 自动退化成行级 LRC，不会报错。

### 格式：和 QRC **方向相反**

```
QRC:  [0,2250]晴(0,160)天(160,160)            ← 文字在时间戳**前面**
YRC:  [7490,2490](7490,210,0)I (7700,240,0)know  ← 文字在时间戳**后面**
```

- YRC 时间戳是**三段式** `(start, dur, 未知)`
- 词尾空格归前一个词（`"I "` / `"know "`），这样逐字点亮时空格不会丢
- 开头几行常是 JSON 形式的署名：`{"t":0,"c":[{"tx":"作词: "},...]}`，要过滤

### 两轮策略

```
第一轮：在候选 1..3 里横扫 YRC（逐字）
第二轮：都没有，才退行级 LRC
```

为什么要两轮：搜索首位常是翻唱/钢琴版，**没有逐字**；原版在后面。
只试第一个候选的话，明明有 YRC 用不上。

## 三、库里的老歌怎么升级到逐字

之前 `/api/lyrics/lookup` 是「数据库优先」，而库里的歌词是流水线早期用
lrclib 抓的行级版本 —— **QQ/YRC 根本没机会被用到**。

现在的逻辑：

```
请求要逐字（wordLevel=1）+ 库里这份没有 chars
  → 立刻返回库里那份行级歌词（大屏马上有歌词）
  → 同时后台联网试一次 QQ → 网易云 YRC
  → 拿到逐字且行数合理（≥ 8 行）
      → 写进 data/lyrics-overrides.json（下次直接命中，不再联网）
      → 刷新歌词缓存，下次播放使用逐字版
  → 没拿到 / 行数可疑
      → 继续用库里那份（不为了逐字把好歌词弄丢）
```

> 早期版本是在请求里 `await` 升级。QQ 搜索有 3.5s 串行间隔 + 限流冷却，
> 一次升级实测要 ~40s，这段时间大屏一行歌词都没有，看起来就像「新歌没歌词」。
> 现在升级完全放到后台，任何情况下都不会拖住播放。

**行数合理性校验**是必须的：自动升级曾把 "Blinding Lights" 换成 2 行的
错误匹配、把 "drop dead" 换成 3 行。真实歌词不可能只有两三行。

## 四、效果

修复前后（16 首）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 有逐字的歌 | 2 / 16 | **12 / 16** |

当前分布：

```
House Tour              qqmusic  qrc  41 行  37 逐字 ✓
what's wrong with me    qqmusic  qrc  53 行  53 逐字 ✓
the cure                qqmusic  qrc  65 行  64 逐字 ✓
Talking to the Moon     qqmusic  qrc  39 行  36 逐字 ✓
Houdini                 qqmusic  qrc  50 行  49 逐字 ✓
Peaches                 qqmusic  qrc  87 行  85 逐字 ✓
STAY                    qqmusic  qrc  55 行  50 逐字 ✓
Shape of You            qqmusic  qrc  88 行  88 逐字 ✓
Mr. Brightside          qqmusic  qrc  58 行  58 逐字 ✓
Bohemian Rhapsody       qqmusic  qrc  59 行  54 逐字 ✓
drop dead (第一首)       netease  lrc  55 行   0      ← QQ 搜不到
Levitating              netease  lrc  93 行   0      ← QQ 搜不到
Blinding Lights         lrclib   lrc  39 行   0      ← 自动升级被行数校验挡住
Happy                   lrclib   lrc  72 行   0
```

剩下 4 首是 QQ 搜不到或匹配被拒，会继续走网易云/lrclib 的行级歌词。

## 五、测试

新增 `tests/yrc-parse.test.js`（9 项），覆盖：

- 文字在时间戳之后（和 QRC 方向相反）
- 三段式时间戳解析
- chars 拼接 == 行文本
- 逐字时间戳单调递增
- JSON 署名行过滤
- 空输入 / 只有署名 / 畸形行都不抛错

全量：

```
playback-lyrics 15/15 · library-mode 12/12 · qrc-parse 15/15
yrc-parse 9/9 · lyrics-centering 9/9 · video-mode 15/15
prepare-queue 20/20 · local-player 21/21
               共 116 项全过
```
