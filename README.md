# Karaduoke · 卡拉OK 现场系统

双模式卡拉OK系统，两个版本**完全独立**，可各自单独使用，也可由统一控制面板切换。

控制面板（启动器）在**项目根**，一份配置同时管理 A、B 两个模式。

```
Karaduoke\
├─ 启动卡拉OK.cmd        双击这里启动控制面板
├─ launcher\             控制面板（端口 8787）：启动器 + UI + 穿透
├─ main.js               统一服务入口：按当前模式加载对应工程
├─ config\config.json    控制面板配置（端口、DJ 密码、API Key、当前模式）
├─ logs\                 控制面板运行日志
├─ version.json          控制面板版本号
├─ docs\                 文档（原 karaoke_spo\docs 已合并到这里）
├─ karaoke_ytb\          模式 A · YouTube 在线版（工程）
├─ karaoke_spo\          模式 B · 本地曲库版（工程）
└─ rubbish\              整理时移出的文件，确认后可整个删除
```

---

## 快速开始

双击项目根的 **`启动卡拉OK.cmd`**，控制面板会打开：**http://127.0.0.1:8787**

在面板里选择模式（下拉框左上角），点「启动服务」：

| 模式 | 页面 | 地址 |
| --- | --- | --- |
| B · 本地曲库（默认） | 大屏 / DJ 控制台 / 点歌 / 曲库管理 | http://localhost:3100/display ・`/admin` `/join` `/library` |
| A · YouTube 在线 | 大屏 / DJ 控制台 / 点歌 | http://localhost:3100/display ・`/admin` `/join` |

两个模式**互斥**，共用同一个端口（默认 3100），切换模式后点「重启服务」即可换工程。

控制面板上的 **「打开大屏」** 会用 Edge/Chrome 的独立窗口打开 `/display`，并带上
`--autoplay-policy=no-user-gesture-required`。大屏整个页面复用同一个 `AudioContext`：
浏览器如果仍要求手势，页面会明确提示「点一次」，解锁后本场后续切歌都不再需要点击；
手动用普通标签页打开时，第一次多半需要点一下。

默认 DJ 密码在 `config\config.json` 里，可在控制面板「设置」中修改（对两个模式同时生效）。

> 也可以直接在命令行运行 `node launcher\main.js`，效果与双击脚本相同。

---

## 两种模式的区别

| | 模式 A · karaoke_ytb | 模式 B · karaoke_spo |
| --- | --- | --- |
| 音源 | YouTube 在线播放 | 本地曲库（下载 + Demucs 分离） |
| 人声调节 | 不支持（音轨已混好） | **支持**：原曲 / 引导 / 伴奏 无级调节 |
| 逐字歌词 | 行级 | **逐字**（QQ QRC + 网易云 YRC） |
| 离线可用 | 否 | **是**（歌曲已存本地） |
| 播放画面 | YouTube 播放器 / 歌词 | **YouTube 官方 MV（静音）+ 两行歌词** / 仿 Apple Music |
| 磁盘占用 | ~55 MB | ~7 GB |
| 依赖 | 纯 Node，零 npm 依赖 | Node + Python(demucs/torch) |

**模式切换**：控制面板的「模式」下拉框会写 `config\config.json` 的 `mode.active`。
切换**不会自动重启**，点「重启服务」后才会从新模式的工程目录启动——避免演出中途被切换打断。

---

## 目录结构与文件位置

### 控制面板（项目根）

```
Karaduoke\
├─ 启动卡拉OK.cmd
├─ launcher\
│  ├─ main.js             控制台服务（127.0.0.1:8787）
│  ├─ config.js           配置读写（config\config.json）
│  ├─ service.js          启动/停止/探活服务进程
│  ├─ tunnel.js           cloudflared 内网穿透
│  ├─ logs.js             日志收集
│  ├─ i18n.js             界面文案（en / zh / de）
│  └─ ui\                 控制台页面
├─ main.js                统一服务入口
├─ config\config.json     port / djPassword / youtubeApiKey / tunnel / mode.active
├─ logs\launcher-*.log
└─ version.json
```

`main.js` 是唯一入口：控制台启动服务时执行 `node <项目根>\main.js`，
并把工作目录设为当前模式的工程目录；`main.js` 再加载该工程自己的入口。

### 模式 B（karaoke_spo）

```
karaoke_spo\
├─ main.js / server.js   服务本体（共用端口 3100）
├─ lib\                  歌词源、曲库 DAL、制作队列
├─ scripts\              Python 流水线（下载/分离/歌词/成品）
├─ python\.venv-xpu\     Python 环境（torch 2.13+xpu、demucs、yt-dlp）
├─ public\               前端（app.js / 样式 / 播放器）
├─ assets\
│  ├─ output\library\<spotifyId>\   每首歌的产物
│  │  ├─ accompaniment.mp3   伴奏
│  │  ├─ vocals.mp3          人声（用于原唱/引导开关）
│  │  ├─ guide.mp3           引导（人声压低）
│  │  ├─ original.mp3        原声
│  │                            （视频画面不存本地：YouTube 官方 MV 静音在线播放）
│  ├─ covers\<spotifyId>.jpg        专辑封面
│  └─ lyrics\                       歌词文件
├─ data\
│  ├─ library.db         曲库数据库（SQLite，元数据）
│  ├─ lyrics-overrides.json   DJ 手动重匹配的歌词
│  ├─ state.json         现场状态（队列/播放/设置）
│  └─ bin\               二进制工具（ffmpeg 等）
└─ .cache\               torch / huggingface 模型缓存
```

### 模式 A（karaoke_ytb）

```
karaoke_ytb\
├─ main.js / server.js
├─ public\               前端
├─ lib\
├─ data\state.json       现场状态
└─ bin\                  二进制工具
```

---

## 歌词源优先级

模式 B 的歌词按以下顺序获取，前一级失败才降级：

```
① DJ 手动重匹配的结果（data/lyrics-overrides.json）
② 库内已存歌词（不联网）
③ QQ 音乐 QRC（逐字，最好）    —— 走 soso 搜索 + musicu 取加密 QRC
④ 网易云 YRC（逐字）           —— eapi 加密接口
⑤ lrclib（行级）
```

- **QQ**：搜索接口 `musicu.fcg` 已被风控（code=2001），改走 `c.y.qq.com/soso` 搜索，
  歌词接口 `GetPlayLyricInfo` 仍正常。返回的 QRC 是加密的，`lib/qrc-decrypt.js` 解密。
- **网易云**：YRC 逐字需要 eapi 加密 + 匿名 token；拿不到就退行级 LRC。
- **lrclib**：只有行级时间轴。

歌词库里若只有行级版本，而请求要逐字，会在**后台**联网升级一次（不阻塞当前播放，
先把库里那份返回）；拿到逐字且行数合理（≥8 行）才替换，避免错误匹配把好歌词覆盖掉。
升级成功后写入覆盖表并刷新缓存，下次播放自动使用逐字版。

---

## 常见问题

**Q：点歌后一直显示「处理中」？**
新歌需要下载 + Demucs 分离，一首约 1–4 分钟（取决于时长和硬件）。
大屏会显示「处理中…」，完成后自动开始播放。可在 DJ 控制台或曲库管理看详细进度。

**Q：人声滑块没反应？**
只有**本地曲目**（模式 B 的曲库歌）能调人声。YouTube 音轨是混好的，拆不开，
所以模式 A 和 YouTube 曲目下这个滑块不显示。

**Q：逐字歌词不生效？**
检查那首歌的歌词源。右下角曲库管理里「歌词」列会显示 `逐字` 或 `行级`。
网易云/lrclib 只有行级时间轴，不是所有歌都有逐字。
DJ 控制台里「歌词逐字」按钮在这类歌上会置灰并提示。

**Q：改了设置后播放回到原声？**
人声强度现在会写回服务端并持久化，切歌/切画面/改设置都会保留。
如果仍复现，硬刷新大屏页面（`Ctrl+Shift+R`）。

**Q：控制面板点「启动服务」报错？**
检查端口是否被占用。两个模式共用 3100，可在控制面板「设置」里改。

**Q：YouTube 搜索失败（模式 A）？**
检查 `config\config.json` 里的 `youtubeApiKey`，或配额是否用完。

**Q：想让 cloudflared 穿透可用？**
把 `cloudflared.exe` 放在项目根 `bin\`（也认 `karaoke_spo\bin\`），或在「设置」里填路径。

---

## 硬件与依赖

| 项目 | 要求 |
| --- | --- |
| Node.js | ≥ 20（实测 v24.22.1） |
| Python | 已内置 `env\python`（3.12，torch 2.13+xpu） |
| 显卡 | Intel Arc（XPU）可用；无独显时 Demucs 走 CPU，慢 3–10 倍 |
| 磁盘 | 模式 A ~55 MB，模式 B ~7 GB（含曲目和 Python 环境） |

模型缓存在 `env\cache\`（torch 80 MB + huggingface 80 MB），首次运行分离时会用到。

---

## 运行环境目录（env）

Python、模型缓存和二进制工具统一放在项目根的 `env\`，由控制面板「环境配置」按钮管理：

```
env\
├─ python\     Python 虚拟环境（Scripts\python.exe + site-packages）
├─ cache\      torch / huggingface / yt-dlp 模型缓存
└─ bin\        ffmpeg.exe  ffprobe.exe  cloudflared.exe
```

控制面板 →「环境配置」可以：

- 查看 Python / ffmpeg / ffprobe / cloudflared 是否就绪，以及缓存占用
- 改目录位置（留空 = `env\`，也可以分别指定 python / cache / bin）
- **一键安装缺失项**：二进制直接下载；Python 缺失时生成安装脚本
- 单项下载：ffmpeg + ffprobe、cloudflared
- **预热模型**：跑一次 demucs 模型加载，把权重落到 `env\cache`
- **迁移现有环境**：把旧布局（`karaoke_spo\python\.venv-xpu`、`karaoke_spo\.cache`、
  `karaoke_spo\data\bin`、`karaoke_ytb\bin`）里的东西搬到 `env\`，只移动不删除
- 直接在资源管理器里打开目录

Python 环境体积很大（约 5 GB），不在控制面板里直接 pip 安装，而是生成项目根的
`setup-env.cmd`，双击即可创建 venv 并安装 torch（XPU）/ demucs / yt-dlp。

> 打开弹窗是瞬时的：`/api/env` 只做存在性检查（约 5 ms），目录体积由
> `/api/env/sizes` 异步统计并在前端后填，不会卡界面。

配置存在 `config\config.json` 的 `env` 段，启动服务时通过环境变量注入：

| 变量 | 作用 |
| --- | --- |
| `KARAOKE_ENV_DIR` | 环境根目录 |
| `KARAOKE_PYTHON` | Python 解释器 |
| `KARAOKE_BIN_DIR` / `KARAOKE_FFMPEG` / `KARAOKE_FFPROBE` | 二进制工具 |
| `TORCH_HOME` / `HF_HOME` | 模型缓存 |

`env\` 已在 `.gitignore` 里，不会进版本库。

---

## Spotify 凭证与发布脱敏

Spotify 的 **Client ID / Client Secret / Redirect URI / Refresh Token** 全部由控制面板管理，
存在 `config\config.json` 的 `spotify` 段里；**不再写进 `karaoke_spo\.env`**。

### 配置步骤

1. 控制面板 →「设置」→ Spotify 区，填 Client ID / Secret / Redirect URI
2. 回调地址必须和 Spotify 后台完全一致，推荐
   `http://127.0.0.1:3100/api/spotify/callback`
   （也兼容旧的 `/api/spotify/auth/callback`）
3. 点「登录 Spotify」→ 浏览器完成授权 → 面板会自动检测并导入授权
4. 也可以直接粘贴 Refresh Token，或点「从服务导入」把已有授权收回面板

凭证在服务启动时通过环境变量注入，运行中保存设置会立即推送，不需要重启。

### 发布前检查

`config\`、`data\`、`.env` 都在 `.gitignore` 里，所以正常 git 发布不会带出去。
如果要打包整个目录，删掉这些即可，项目本身不含任何密钥：

```
config\config.json              控制面板配置（含 Spotify 凭证、DJ 密码）
karaoke_spo\.env                Spotify 凭证（现已清空）
karaoke_spo\data\spotify-token.json   Spotify 授权 token
karaoke_spo\config\              旧配置（应已移入 rubbish\）
```

发布出去的副本第一次启动会生成新的 DJ 密码，Spotify 需要使用者填自己的凭证。

---

## 文档

`docs\` 里是关键技术文档：

- `architecture.md` / `architecture-modes.md` — 整体与双模式架构设计
- `library.md` — 曲库数据模型
- `lyrics-sources.md` — 歌词源实现细节
- `lyrics-yrc-qq-fix.md` — QQ/YRC 逐字歌词修复记录
- `background-download.md` — 后台下载与制作队列
- `playback-dual-mode.md` / `playback-modes.md` — 视频 / Apple Music 两种播放画面
- `official-mv.md` — 官方 MV（visualVideoId）的匹配算法、数据库字段、管理接口与回退逻辑
- `player-ui-spec.md` — 播放器界面规格
- `pipeline-mode-b.md` — 下载与分离流水线
- `vocal-mix.md` — 人声混音原理
