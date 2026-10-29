# 模式 A · YouTube 在线版（karaoke_ytb）

> 本工程已并入 `D:\Projects\Karaduoke` 双模式项目。
> **启动入口在项目根**：双击 `Karaduoke\启动卡拉OK.cmd`，控制面板在 `http://127.0.0.1:8787`，
> 在面板左上角把模式切到「A · YouTube 在线」，再点「启动服务」。
> 本目录不再有自己的 `启动卡拉OK.cmd` / `launcher\`（已移入 `rubbish\`）。

单房间卡拉OK服务端：手机点歌、DJ 控制台、大屏展示、统一队列、SSE 实时同步和 JSON 持久化。面板支持 **English（默认）/ 中文 / Deutsch**，右上角切换，选择会保存。

## 端口

A、B 两个模式**互斥**，共用同一个端口。端口由项目根 `config\config.json` 统一管理，默认 **3100**。
（本工程早期的文档写的是 3000，那是它作为独立项目时的默认值。）

| 按钮 | 作用 |
| --- | --- |
| Start service | 启动 HTTP 服务（默认 3000 端口），健康检查通过才算完成 |
| Restart service | 关闭再启动，队列和设置保存在 `data/state.json`，不会丢；穿透保持在线 |
| Stop service | 先关穿透再关服务，避免留下指向空服务的公网地址 |
| Enable tunnel | 用 cloudflared 快速隧道暴露到公网，地址自动识别并显示 |
| Settings | 改端口、DJ 密码、YouTube API Key、cloudflared 路径、固定公网地址、自动开穿透 |

服务启动后打开（端口以控制面板显示的为准，默认 3100）：

- `http://localhost:3100/join`：手机点歌端
- `http://localhost:3100/admin`：DJ 控制台
- `http://localhost:3100/display`：电视/投影大屏

## 语言

- 启动器：英文 / 中文 / 德文，默认英文；启动器自己产生的日志、错误和提示都会跟着切换。
- 点歌端、大屏和 DJ 控制台：各自沿用 `data/state.json` 里的界面语言（新安装默认英文），DJ 可以在控制台里改；手机端用户可以只改自己的浏览器语言。
- 服务端和 cloudflared 的原始输出属于技术日志，保持原样。

## 首次使用

1. `bin\cloudflared.exe` 已随工程提供，不用额外下载（控制台也会自动找到它）。
2. 打开 Settings 确认 DJ 密码。首次运行会自动生成随机密码并写进项目根 `config\config.json`。
3. 点 Start service，在投影仪上打开 `/display` 并全屏。
4. 场地网络和电脑不在同一网段时，点 Enable tunnel，把面板上的公网地址发给观众；大屏二维码会自动跟着换。

勾选「开启服务后自动开启穿透」可以省掉第 4 步。重启服务不需要重启穿透：cloudflared 指向本机端口，服务重启期间隧道自动断线重连，地址不变。

## 大屏酒水单、动画和循环广播

- **时间设置**：DJ 面板右上角 Settings → Timing 里分别设置「广播显示时长 / 广播间隔」「酒水显示时长 / 酒水间隔」。间隔期间大屏不显示任何内容。- **酒水单**：DJ 面板的「酒水」卡片里按名称/价格添加，最多 40 条。大屏在播放列表下方用两栏气泡显示，高度不超过侧栏的 30%；内容过长时表头固定、列表缓慢上下滚动，并按设置的时长/间隔淡出淡入。
- **大屏动画**：DJ 面板的「大屏动画」卡片有烟花、庆祝、爱心、星光、迪斯科五个预设，点一下就在大屏播放约 7 秒的 emoji 粒子动画，不打断音乐。
- **普通广播**：按钮从 Send 改为 Add，可以一次添加多条，每条以字块显示、X 紧贴右侧可删除；大屏按设置的显示时长和间隔淡出淡入循环展示。重要广播仍然是独立的暂停+全屏遮罩。

## 点歌、排序和二维码

- 队列空着时添加第一首会自动开始播放，即使之前点过停止或暂停。
- 手机「我的等待队列」里可以用 ↑/↓ 交换自己歌曲的位置，只交换自己的槽位，其他用户歌曲的位置不受影响。
- 二维码地址优先级：隧道地址 > 固定公网地址 > 局域网 IP。没开穿透时用局域网地址（例如 `http://192.168.1.23:3000/join`），不会指向 `localhost`。
- **大屏页面必须用 `http://localhost:<端口>/display` 或主机名打开，不能用 IP**（默认端口 3100）。YouTube 会拒绝在 IP 地址来源的页面里嵌入播放，表现为 Song Unavailable / 错误 150；`127.0.0.1` 也会被拒绝（0.3.8 起会自动跳转到 localhost）。手机扫码进 `/join` 用 IP 不受影响。大屏在另一台电脑时，用电脑名（如 `http://DJ-PC:3100/display`）而不是 `192.168.x.x`。

## 公网地址

- 快速隧道每次启动都会分配 `https://*.trycloudflare.com` 随机地址。启动器解析 cloudflared 输出，再通过带随机令牌、只接受回环请求的内部接口写进服务运行时状态，大屏二维码实时刷新。
- 优先级：隧道地址 > 固定公网地址 > 当前访问地址。关闭隧道后临时地址会被清掉，不会留下打不开的二维码。
- 自己的域名或命名隧道：在 Settings 里填 `https://karaoke.example.com`；快速隧道开启时优先用隧道地址。

## 配置

`config/config.json`（现位于**项目根**），由面板读写，不建议手改：

```json
{
  "language": "en",
  "service": { "port": 3100, "host": "0.0.0.0" },
  "djPassword": "…",
  "youtubeApiKey": "",
  "tunnel": {
    "cloudflaredPath": "",
    "fixedPublicUrl": "",
    "autoStart": false
  }
}
```

端口和 DJ 密码修改后需要重启服务（面板会显示「立即重启」按钮）；YouTube API Key 保存后立即生效，不需要重启。`npm start` 会读取项目根 `config/config.json` 里的端口、DJ 密码和 API Key，`.env`（如果存在）优先。

## 本地开发

```powershell
npm start
```

控制台里的服务正在运行时，端口会被占用，`npm start` 会提示端口冲突。换一个端口测试：

```powershell
$env:PORT=3200; npm start
```

或者先在面板里关闭服务。`npm start` 读不到 `.env` 时会自动回退到项目根 `config/config.json`，所以测试环境和现场使用同一份密码/Key。

## 日志

面板下方是服务、穿透和启动器的输出，格式 `[时间] [来源] 内容`；完整日志写到项目根 `logs\launcher-YYYYMMDD-HHMMSS.log`。服务异常退出、端口被占用、cloudflared 缺失或网络不通都会给出当前语言的说明。

## 搜索排错

- 没填 API Key 时只搜索内置演示曲库，热门歌名以外大多查不到结果，这是正常的降级行为。
- API Key 是启动时注入的；0.2.0 及更早版本保存 Key 后必须重启服务，否则仍在用旧值。0.2.1 起保存即生效。
- 搜索报 `YouTube 搜索失败（400/403）` 说明 Key 被拒绝：检查 Key 是否启用了 YouTube Data API v3、是否设置了 HTTP 来源限制（服务端调用没有 Referer）、配额是否用完。

## 大屏显示 Song Unavailable

这是 YouTube 播放器自己的提示，对应 IFrame API 错误 101/150：视频所有者禁止嵌入、视频在所在地区不可用，或者大屏浏览器/网络启用了 YouTube 受限模式（校园网很常见）。服务端无法绕过。

已经做的处理：

- 搜索接口加了 `videoEmbeddable=true`，只向 YouTube 要允许嵌入的结果。
- 直接粘贴链接时查 `status.embeddable`，明确不可嵌入的视频会在点歌时被拒绝，并提示换一个。
- 播放失败时大屏显示「无法嵌入播放，正在跳到下一首」，服务端把这首标记为失败并自动切下一首，不会卡住队列。

仍然频繁出现时：换一个官方或 Karaoke 版本；用 `http://localhost:3100/display`（而不是公网地址）打开大屏；检查网络是否开启 YouTube Restricted Mode。`data/state.json` 和日志里会保留 `YouTube error 150` 以便排查。

## 打包交付

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-package.ps1
```

生成 `dist\Karaoke-<版本>-win-x64.zip`，解压即用，**不需要安装 Node.js**：包里带 `runtime\node.exe` 和 `bin\cloudflared.exe`。

```text
Karaoke-<版本>-win-x64/
  Start Karaoke.cmd        双击启动
  runtime/node.exe         内置运行时
  launcher/                控制面板与服务代码（已上移到项目根，打包脚本未更新）
  public/                  前端页面
  bin/cloudflared.exe      穿透组件
  config/                  首次运行生成配置
  data/                    现场数据
  logs/                    运行日志
  README.txt               英/德/中快速上手
```

升级时替换代码目录、保留 `config/` 与 `data/` 即可。打包脚本不会带上 `.env`、`config/config.json` 和 `data/state.json`，所以不会泄露 DJ 密码、API Key 或上一场活动的数据；新包第一次启动会生成新的随机密码，YouTube API Key 需要在 Settings 里重新填。

## 已实现的 MVP 闭环

- 临时访客会话与昵称、按会话的点歌上限
- 真实/演示 YouTube 搜索、缩略图、点歌与删除自己的等待歌曲
- 搜索框支持直接粘贴 YouTube `watch`、`youtu.be`、`shorts`、`embed` 和 `live` 链接
- 服务端队列唯一事实来源，置顶、删除、暂停、恢复、切歌、停止、音量控制
- 大屏独立 YouTube IFrame 播放区、待机画面、后续队列、普通广播、重要广播遮罩和三秒恢复倒计时
- 大屏酒水价格气泡（两栏、间隔淡入淡出、超长固定表头缓慢滚动）与五种 emoji 动画
- 普通广播支持多条添加、循环轮播和逐条删除
- Server-Sent Events 实时同步所有终端
- `data/state.json` 持久化活动设置、会话、队列和播放历史

首版为现场原型，尚未包含 SQLite、Socket.IO、拖拽排序 UI、完整访问限流、管理员多账户和播放器断点恢复。上线前还应按场地确认 YouTube API 政策、嵌入限制和公开播放许可。

## 安全提醒

穿透打开后，`/admin` 同样在公网上，目前只有一道 DJ 密码。现场请使用面板生成或自己设置的密码；点歌链接只需要发 `/join`。快速隧道没有 SLA，主机名是临时的，活动结束记得关闭穿透。
