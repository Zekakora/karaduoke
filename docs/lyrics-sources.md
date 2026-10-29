# 歌词源与播放问题修复（2026-10-29 下午）

## 一、为什么 library 总显示 lrclib

两层原因：

1. **流水线只查 lrclib** —— `scripts/fetch_lyrics.py` 里只有 `BASE = "https://lrclib.net/api"`，一行 QQ 都没有。
2. **QQ 逐字只在播放时临时查，从不落库** —— `server.js` 的 QQ 逻辑是播放页实时调用的；「改词重搜」写的是 `data/lyrics-overrides.json`。而 library 表格读的是数据库。

## 二、现在的歌词源顺序

```
① data/lyrics-overrides.json   ← DJ 手动重搜的结果（最高优先）
② 数据库 lyrics 表              ← 流水线抓的，不联网
③ QQ 逐字（QRC）                ← 最好，但限流凶
④ 网易云                        ← 中文歌兜底
⑤ lrclib                       ← 最后
```

流水线侧（`fetch_lyrics.py`）同样：

```python
provider='auto'  # QQ → 网易云 → lrclib
```

实测（QQ 限流期间）：`auto => netease / lrc / 1471 字符`；QQ 恢复后：`qqmusic / qrc / 50 行`。

## 三、QRC 解析的三个 bug（都修了）

### bug 1：字符错位，每行第一个字被吃掉

QRC 的排布是**文字在前、时间戳在后**：

```
[0,2250]晴(0,160)天(160,160) (320,160)
         ↑ 晴 是第一个字，(0,160) 是它的时间
```

原来的实现取「时间戳**后面**到下一个时间戳之间」，整体错位一格：

```
'this the real life'      ← 应该是 "Is this the real life"
'this just fantasy'       ← 应该是 "Is this just fantasy"
'in a landslide...'       ← 应该是 "Caught in a landslide..."
```

### bug 2：有两份独立实现，都有同样的错

`server.js` 和 `lib/qq-lyrics.js` 各写了一份 `parseQrc`，都错。抽成 `lib/qrc-parse.js`，**只留一份**。

### bug 3：QQ 把制作信息塞进正文

```
'Bohemian Rhapsody - Queen (皇后乐队)'
'by：Freddie Mercury'
'合声编写：周杰伦'
'录音工程：杨瑞代（Alfa Studio）'
'鼓：陈柏州'
```

过滤规则（按实际数据设计，Lyricify 仓库只有文档没源码）：

```js
// 短前缀 + 冒号，且前缀含署名关键词
// 不能要求关键词紧跟冒号：'合声编写：' '录音工程：' 都是关键词+子类
const CREDIT_ROLE_ANYWHERE = /作词|作曲|编曲|制作|监制|混音|母带|和声|合声|录音|.../i;
// 单字只允许整个前缀就是它，避免误杀「曲终人散：…」
const CREDIT_ROLE_EXACT = /^(词|曲|鼓|琴|by|op|sp)$/i;
```

真实数据：晴天 **54 行 → 50 行**，首行从「合声编写：周杰伦」变成「故事的小黄花」。

同一套过滤也用在 `parseLrcText`（网易云的 LRC 同样带 `[00:00.000] 作词 : xxx`）。

## 四、网易云接入

接口（2026-10 实测）：

| 用途 | 接口 | 备注 |
| --- | --- | --- |
| 搜索 | `GET /api/cloudsearch/pc?s=&type=1&limit=&offset=0` | **只能用这个** |
| 歌词 | `GET /api/song/lyric?id=&lv=1&kv=1&tv=-1` | `tv=-1` 带翻译 |

两个都要 `Referer: https://music.163.com/`。

**踩到的坑**：
- `/api/search/get/web` 返回 `code:200` 但 **0 条**
- `/api/search/pc` 返回 `code:-462`（风控）
- `cloudsearch` 才正常

**候选选择**：逐个试前 4 个候选直到拿到歌词（网易云搜索首位常是翻唱/钢琴版，且没歌词）。对「钢琴/纯音乐/伴奏/remix/live/女声」等改编版降权 15 分。

**已知限制**：未登录的 cloudsearch 对部分歌曲**只返回翻唱**（周杰伦《晴天》原版不在结果里）。歌词内容仍是同一首歌的，作为兜底可用，但不是原版条目。

## 五、重启后播放/暂停没反应

**根因：浏览器自动播放策略**，不是服务端 bug。

服务端和 SSE 都验证正常：

```
点 pause  → SSE 收到 {"status":"paused","current":"Houdini"}
点 resume → SSE 收到 {"status":"playing","current":"Houdini"}
```

问题是：服务重启后大屏重新加载、还没人点过页面，`mixer.play()` 被浏览器拒绝。之后 DJ 点暂停/恢复，`play()` 依然被拒——表现就是「没反应」。原代码只 `console.warn`，界面毫无提示。

更隐蔽的是：页面完全没有用户手势时，`AudioContext.resume()` 返回的 Promise 可能**一直 pending**（不是 reject）。旧代码直接 `await`，`mixer.play()` 永远不结束，于是既没有声音、也不会走到 catch 去显示提示——看起来就是「处理完了不自动播放」。

**修复**：
1. **整个页面只用一个 `AudioContext`**（`KaraokeMixer` 内部共享）。以前每切一首歌都
   `close()` 再 `new`，每次都会重新触发自动播放策略 —— 这就是“刚点过、下一首又要
   点一下”的原因。现在一次手势解锁对后续所有歌曲都有效。
2. `mixer.play()` 给 `ctx.resume()` 加 1.2 秒超时，没解锁就抛 `AUTOPLAY_BLOCKED`；
3. 页面加载时先自动 `resume()` 一次：带自动播放参数启动就直接成功；被拦才在
   1.5 秒后盖一层「点击任意位置开始播放」，接住第一次手势；
4. 手势后真正 `await mixer.play()` 成功才上报 `playing`。

`pointerdown` / `keydown` 都会触发，提示层自动消失。点过一次之后，本页面后续所有
歌曲都会自动播放，不用每首再点。

如果大屏要完全无人值守，`--autoplay-policy=no-user-gesture-required` 不保证在所有
Edge 版本/已有浏览器实例上生效；官方可靠的做法是给 Edge 配置 `AutoplayAllowed`
或 `AutoplayAllowlist` 策略（控制面板的「打开大屏」会带这个启动参数，但能否绕过
仍取决于本机 Edge）。

## 六、Houdini 的 Video ID 是空的

本地曲目 `videoId` 就是 `null`（音源是本地的，没有 YouTube 视频）。原来面板无脑打印 `Video ID: ` 导致空白。

改成按来源显示：

```
本地曲目 → 本地曲库 · 6D8y7Bck8h11byRY88Pt2z
YouTube  → Video ID: fJ9rUzIMcZQ
```

显示歌曲标题和来源这两处都改了。

## 七、歌词来源的三级读取（避免打爆 QQ）

`/api/lyrics/lookup` 现在的顺序：

```
override（手动重搜） → 数据库（流水线抓的，不联网） → 联网（QQ → 网易云 → lrclib）
```

实测：主掉 Bohemian 的覆盖后，返回 `provider=lrclib fromLibrary=true` —— **直接读库，没联网**。

> 库里只有行级、而请求要逐字时，联网升级放在**后台**做：先把库里那份返回，
> 升级成功再写覆盖表并刷新缓存。不能在请求里等 QQ —— 它有 3.5s 串行间隔和
> 90s 限流冷却，冷启动一次升级要 ~40s，大屏会在这段时间里完全没有歌词。

> 另一个坑：旧流水线把网易云的 **YRC** 内容也标成 `format='lrc'`。按 format 走
> LRC 解析会得到 0 行，然后落到联网查询（又是一次几十秒）。`/api/lyrics/lookup`
> 现在会按内容识别 YRC（`[start,dur](...)` / `{"t":...}`）并用 `parseYrc` 解析；
> 新流水线也已经按真实 format 落库。

## 八、QQ 限流处理

实测连续请求几次就返回 `code: 2001`：

```
req_1.code: 2001
```

处理：
- 请求间隔 1s → **3.5s**
- 命中 2001 后**冷却 90 秒**，期间不打
- 拿不到就自动往下走（网易云 → lrclib），不报错

## 九、测试

```
playback-lyrics  15/15
library-mode     13/13
qrc-parse        15/15   ← 新增：手工构造 + 真实 QRC 双重验证
video-mode       15/15
prepare-queue    20/20
local-player     21/21
                 ─────
                 99 项全过
```

`qrc-parse.test.js` 的关键两条：

- **chars 拼接 == 行文本** —— 专门防错位 bug 回归
- **正常歌词不会被误杀** —— 防署名过滤过度
