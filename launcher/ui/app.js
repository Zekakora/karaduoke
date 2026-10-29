'use strict';

const token = document.querySelector('meta[name="launcher-token"]').content;

const I18N = {
  en: {
    'app.title': 'LC AACHEN Karaoke Console',
    'app.heading': 'LC AACHEN Karaoke Console',
    'app.version': 'Console v{version}',
    'app.language': 'Language',
    'app.running': 'running',
    'button.start': 'Start service',
    'button.restart': 'Restart service',
    'button.stop': 'Stop service',
    'button.display': 'Open display',
    'button.tunnelStart': 'Enable tunnel',
    'button.tunnelStop': 'Disable tunnel',
    'button.tunnelConnecting': 'Connecting…',
    'button.tunnelRetry': 'Retry tunnel',
    'button.settings': 'Settings',
    'button.env': 'Environment',
    'env.title': 'Environment',
    'env.desc': 'Python runtime, model cache and binary tools. Everything defaults to the env folder in the project root.',
    'env.dir': 'Environment folder',
    'env.dirHint': 'Relative to the project root. Leave empty to use env\\.',
    'env.paths': 'Sub folders',
    'env.python': 'Python',
    'env.cache': 'Model cache',
    'env.bin': 'Binaries',
    'env.status': 'Status',
    'env.migrate': 'Move existing setup',
    'env.download': 'Download cloudflared',
    'env.open': 'Open folder',
    'env.label.python': 'Python interpreter',
    'env.label.ffmpeg': 'ffmpeg',
    'env.label.ffprobe': 'ffprobe',
    'env.label.cloudflared': 'cloudflared',
    'env.label.models': 'Model cache size',
    'env.label.pending': 'Left in the old location',
    'env.present': 'ready',
    'env.absent': 'missing',
    'env.none': 'nothing',
    'env.migrating': 'Moving…',
    'env.migrateDone': 'Done. Check the status list below.',
    'env.downloading': 'Downloading…',
    'env.saved': 'Environment settings saved.',
    'env.installAll': 'Install missing',
    'env.allReady': 'Everything is already installed.',
    'env.refresh': 'Refresh',
    'env.sizeLoading': 'measuring…',
    'env.downloadFfmpeg': 'Download ffmpeg',
    'env.installPython': 'Create install script',
    'env.warmModels': 'Preload models',
    'env.warming': 'Loading models…',
    'env.modelsReady': 'Model weights are ready',
    'env.scriptWritten': 'Created {path} — double-click it to install the Python environment',
    'env.needService': 'Start the service first',
    'button.copy': 'Copy',
    'button.clear': 'Clear',
    'button.cancel': 'Cancel',
    'button.save': 'Save',
    'button.restartNow': 'Restart now',
    'button.show': 'Show',
    'button.hide': 'Hide',
    'chip.service.running': 'Service · Running',
    'chip.service.starting': 'Service · Starting',
    'chip.service.stopping': 'Service · Stopping',
    'chip.service.stopped': 'Service · Stopped',
    'chip.service.failed': 'Service · Failed',
    'chip.tunnel.on': 'Tunnel · On',
    'chip.tunnel.connecting': 'Tunnel · Connecting',
    'chip.tunnel.stopping': 'Tunnel · Closing',
    'chip.tunnel.off': 'Tunnel · Off',
    'chip.tunnel.failed': 'Tunnel · Failed',
    'address.local': 'Local',
    'address.lan': 'LAN',
    'address.public': 'Public',
    'address.notDetected': 'No LAN address detected',
    'address.publicConnecting': 'Assigning a public address…',
    'address.publicOff': 'Off',
    'log.title': 'Runtime log',
    'settings.title': 'Settings',
    'settings.desc': 'Port and DJ password take effect after a service restart. These settings apply to both modes.',
    'settings.port': 'Service port',
    'settings.portHint': 'Guests and the DJ console use this port (default 3000). Both modes share it.',
    'settings.password': 'DJ password',
    'settings.passwordHint': 'Generated on first launch; change it to something easy to type.',
    'settings.apiKey': 'YouTube API key (optional)',
    'settings.apiKeyHint': 'Applies immediately; leave empty to use the built-in demo catalog.',
    'settings.cloudflared': 'cloudflared path (optional)',
    'settings.cloudflaredHint': 'Empty: bin\\cloudflared.exe (project root, then karaoke_spo\\bin) or the system PATH is used.',
    'settings.cloudflaredFound': 'Found: {path}',
    'settings.cloudflaredMissing': 'cloudflared not found — put it in bin\\cloudflared.exe.',
    'settings.fixedUrl': 'Fixed public URL (optional)',
    'settings.fixedUrlHint': 'For your own domain or a named tunnel; quick tunnels override it.',
    'settings.autoStart': 'Open the tunnel automatically when the service starts',
    'settings.spotifyTitle': 'Spotify',
    'settings.spotifyHint': 'Stored in this console config, not in the project files — published copies carry no secrets.',
    'settings.spotifyClientId': 'Client ID',
    'settings.spotifyClientSecret': 'Client Secret',
    'settings.spotifyRedirect': 'Redirect URI',
    'settings.spotifyRedirectHint': 'Register this exact value in the Spotify app dashboard.',
    'settings.spotifyToken': 'Refresh token',
    'settings.spotifyTokenHint': 'Paste a token, or sign in below and then import it from the service.',
    'settings.spotifyLogin': 'Sign in with Spotify',
    'settings.spotifyImport': 'Import from service',
    'settings.spotifyLogout': 'Sign out',
    'spotify.serviceOff': 'Start the service to manage the Spotify account.',
    'spotify.stateAuthorized': 'Authorized — the service can use your Spotify account.',
    'spotify.stateConfigured': 'Credentials saved, but no account is authorized yet.',
    'spotify.stateNotConfigured': 'Not configured yet — fill in the Client ID, Secret and Redirect URI.',
    'spotify.loginOpened': 'Sign-in page opened. Finish in the browser, then click “Import from service”.',
    'spotify.imported': 'Authorization imported into the console config.',
    'spotify.loggedOut': 'Signed out of Spotify.',
    'notice.restartRequired': 'Settings changed — restart the service to apply.',
    'notice.saved': 'Saved.',
    'notice.savedRestart': 'Saved. Restart the service to apply.',
    'notice.copied': 'Address copied.',
    'notice.displayFallback': 'Opened in the default browser. Autoplay may still need one click; install Edge or Chrome for unattended playback.',
    'notice.copyFailed': 'Copy failed — please select the address manually.',
    'confirm.stopWithTunnel': 'Stopping the service will also close the tunnel and invalidate the public address. Continue?',
    'confirm.switchMode': 'Switch to mode {mode}? The service keeps running the current mode until you restart it.',
    'notice.modeSwitched': 'Switched to mode {mode}. Please restart the service.',
    'notice.modePending': 'Mode {mode} selected — restart the service to apply it.',
    'mode.hint': 'Switch which project the service runs. Takes effect after a restart.',
    'mode.missing': '(project not found)',
    'mode.restartHint': 'Mode changed — restart the service to apply.',
    'title.startFirst': 'Start the service first',
    'error.request': 'Request failed ({status})'
  },

  zh: {
    'app.title': 'LC AACHEN Karaoke 控制台',
    'app.heading': 'LC AACHEN Karaoke 控制台',
    'app.version': '控制台 v{version}',
    'app.language': '语言',
    'app.running': '运行中',
    'button.start': '开启服务',
    'button.restart': '重启服务',
    'button.stop': '关闭服务',
    'button.display': '打开大屏',
    'button.tunnelStart': '开启穿透',
    'button.tunnelStop': '关闭穿透',
    'button.tunnelConnecting': '连接中…',
    'button.tunnelRetry': '重试穿透',
    'button.settings': '环境设置',
    'button.env': '环境配置',
    'env.title': '环境配置',
    'env.desc': 'Python 运行环境、模型缓存和二进制工具。默认都放在项目根的 env 目录下。',
    'env.dir': '环境目录',
    'env.dirHint': '相对项目根。留空则使用 env\\。',
    'env.paths': '子目录',
    'env.python': 'Python',
    'env.cache': '模型缓存',
    'env.bin': '二进制工具',
    'env.status': '当前状态',
    'env.migrate': '迁移现有环境',
    'env.download': '下载 cloudflared',
    'env.open': '打开目录',
    'env.label.python': 'Python 解释器',
    'env.label.ffmpeg': 'ffmpeg',
    'env.label.ffprobe': 'ffprobe',
    'env.label.cloudflared': 'cloudflared',
    'env.label.models': '模型缓存占用',
    'env.label.pending': '旧位置待迁移',
    'env.present': '就绪',
    'env.absent': '缺失',
    'env.none': '无',
    'env.migrating': '正在迁移…',
    'env.migrateDone': '完成，请看下面的状态列表。',
    'env.downloading': '正在下载…',
    'env.saved': '环境设置已保存。',
    'env.installAll': '一键安装缺失项',
    'env.allReady': '所有组件都已就绪。',
    'env.refresh': '刷新状态',
    'env.sizeLoading': '统计中…',
    'env.downloadFfmpeg': '下载 ffmpeg',
    'env.installPython': '生成安装脚本',
    'env.warmModels': '预热模型',
    'env.warming': '正在加载模型…',
    'env.modelsReady': '模型权重已就绪',
    'env.scriptWritten': '已生成 {path}，双击运行即可安装 Python 环境',
    'env.needService': '请先启动服务',
    'button.copy': '复制',
    'button.clear': '清屏',
    'button.cancel': '取消',
    'button.save': '保存',
    'button.restartNow': '立即重启',
    'button.show': '显示',
    'button.hide': '隐藏',
    'chip.service.running': '服务 · 运行中',
    'chip.service.starting': '服务 · 启动中',
    'chip.service.stopping': '服务 · 停止中',
    'chip.service.stopped': '服务 · 已停止',
    'chip.service.failed': '服务 · 异常',
    'chip.tunnel.on': '穿透 · 已开启',
    'chip.tunnel.connecting': '穿透 · 连接中',
    'chip.tunnel.stopping': '穿透 · 关闭中',
    'chip.tunnel.off': '穿透 · 未开启',
    'chip.tunnel.failed': '穿透 · 异常',
    'address.local': '本机',
    'address.lan': '局域网',
    'address.public': '公网',
    'address.notDetected': '未检测到局域网地址',
    'address.publicConnecting': '正在分配公网地址…',
    'address.publicOff': '未开启',
    'log.title': '运行日志',
    'settings.title': '环境设置',
    'settings.desc': '端口和 DJ 密码修改后需要重启服务；API Key 保存后立即生效。这些设置对两个模式同时生效。',
    'settings.port': '服务端口',
    'settings.portHint': '观众点歌和 DJ 控制台都通过这个端口访问，默认 3000。两个模式共用同一个端口。',
    'settings.password': 'DJ 密码',
    'settings.passwordHint': '首次使用时自动生成，可以改成现场好输入的密码。',
    'settings.apiKey': 'YouTube API Key（可选）',
    'settings.apiKeyHint': '保存后立即生效；留空则使用内置演示曲库。',
    'settings.cloudflared': 'cloudflared 路径（可选）',
    'settings.cloudflaredHint': '留空则依次使用 bin\\cloudflared.exe（项目根、karaoke_spo\\bin）或系统 PATH 中的版本。',
    'settings.cloudflaredFound': '已找到：{path}',
    'settings.cloudflaredMissing': '未找到 cloudflared，请把它放到 bin\\cloudflared.exe。',
    'settings.fixedUrl': '固定公网地址（可选）',
    'settings.fixedUrlHint': '使用自己的域名或命名隧道时填写；快速隧道的地址会自动覆盖它。',
    'settings.autoStart': '开启服务后自动开启穿透',
    'settings.spotifyTitle': 'Spotify',
    'settings.spotifyHint': '凭证只保存在控制面板配置里，不写进工程文件，发布出去的项目不含任何密钥。',
    'settings.spotifyClientId': 'Client ID',
    'settings.spotifyClientSecret': 'Client Secret',
    'settings.spotifyRedirect': '回调地址',
    'settings.spotifyRedirectHint': '要原样填进 Spotify 应用后台的 Redirect URI。',
    'settings.spotifyToken': 'Refresh Token',
    'settings.spotifyTokenHint': '可以直接粘贴，也可以用下面的「登录 Spotify」再「从服务导入」。',
    'settings.spotifyLogin': '登录 Spotify',
    'settings.spotifyImport': '从服务导入',
    'settings.spotifyLogout': '退出账号',
    'spotify.serviceOff': '请先启动服务，才能管理 Spotify 账号。',
    'spotify.stateAuthorized': '已授权 — 服务可以使用你的 Spotify 账号。',
    'spotify.stateConfigured': '凭证已保存，但还没有授权账号。',
    'spotify.stateNotConfigured': '尚未配置 — 请填写 Client ID、Secret 和回调地址。',
    'spotify.loginOpened': '已打开登录页，在浏览器里完成后点「从服务导入」。',
    'spotify.imported': '授权已保存到控制面板配置。',
    'spotify.loggedOut': '已退出 Spotify 账号。',
    'notice.restartRequired': '设置已修改，重启服务后生效。',
    'notice.saved': '设置已保存。',
    'notice.savedRestart': '设置已保存，重启服务后生效。',
    'notice.copied': '地址已复制。',
    'notice.displayFallback': '已用默认浏览器打开。自动播放可能仍需点一下；安装 Edge 或 Chrome 可无人值守播放。',
    'notice.copyFailed': '复制失败，请手动选中地址。',
    'confirm.stopWithTunnel': '关闭服务会同时关闭穿透，公网地址将失效。确定吗？',
    'confirm.switchMode': '切换到模式 {mode}？服务仍会运行当前模式，重启服务后才会切换。',
    'notice.modeSwitched': '已切换到模式 {mode}，请重启服务。',
    'notice.modePending': '已选择模式 {mode}，点「重启服务」后生效。',
    'mode.hint': '切换服务运行哪个工程；重启服务后生效。',
    'mode.missing': '（未找到工程）',
    'mode.restartHint': '模式已更改，重启服务后生效。',
    'title.startFirst': '请先开启服务',
    'error.request': '请求失败（{status}）'
  },

  de: {
    'app.title': 'LC AACHEN Karaoke-Konsole',
    'app.heading': 'LC AACHEN Karaoke-Konsole',
    'app.version': 'Konsole v{version}',
    'app.language': 'Sprache',
    'app.running': 'läuft',
    'button.start': 'Dienst starten',
    'button.restart': 'Neu starten',
    'button.stop': 'Dienst stoppen',
    'button.display': 'Anzeige öffnen',
    'button.tunnelStart': 'Tunnel starten',
    'button.tunnelStop': 'Tunnel beenden',
    'button.tunnelConnecting': 'Verbinde…',
    'button.tunnelRetry': 'Tunnel erneut',
    'button.settings': 'Einstellungen',
    'button.env': 'Umgebung',
    'env.title': 'Umgebung',
    'env.desc': 'Python-Laufzeit, Modell-Cache und Binärwerkzeuge. Standardmäßig alles im Ordner env im Projektstamm.',
    'env.dir': 'Umgebungsordner',
    'env.dirHint': 'Relativ zum Projektstamm. Leer lassen für env\\.',
    'env.paths': 'Unterordner',
    'env.python': 'Python',
    'env.cache': 'Modell-Cache',
    'env.bin': 'Binärdateien',
    'env.status': 'Status',
    'env.migrate': 'Bestehende Umgebung verschieben',
    'env.download': 'cloudflared herunterladen',
    'env.open': 'Ordner öffnen',
    'env.label.python': 'Python-Interpreter',
    'env.label.ffmpeg': 'ffmpeg',
    'env.label.ffprobe': 'ffprobe',
    'env.label.cloudflared': 'cloudflared',
    'env.label.models': 'Größe des Modell-Caches',
    'env.label.pending': 'Noch am alten Ort',
    'env.present': 'bereit',
    'env.absent': 'fehlt',
    'env.none': 'nichts',
    'env.migrating': 'Wird verschoben…',
    'env.migrateDone': 'Fertig. Siehe Statusliste unten.',
    'env.downloading': 'Wird heruntergeladen…',
    'env.saved': 'Umgebungseinstellungen gespeichert.',
    'env.installAll': 'Fehlendes installieren',
    'env.allReady': 'Alles ist bereits installiert.',
    'env.refresh': 'Aktualisieren',
    'env.sizeLoading': 'wird gemessen…',
    'env.downloadFfmpeg': 'ffmpeg herunterladen',
    'env.installPython': 'Installationsskript erzeugen',
    'env.warmModels': 'Modelle vorladen',
    'env.warming': 'Modelle werden geladen…',
    'env.modelsReady': 'Modellgewichte sind bereit',
    'env.scriptWritten': '{path} erstellt — zum Installieren doppelklicken',
    'env.needService': 'Bitte zuerst den Dienst starten',
    'button.copy': 'Kopieren',
    'button.clear': 'Leeren',
    'button.cancel': 'Abbrechen',
    'button.save': 'Speichern',
    'button.restartNow': 'Jetzt neu starten',
    'button.show': 'Anzeigen',
    'button.hide': 'Verbergen',
    'chip.service.running': 'Dienst · Läuft',
    'chip.service.starting': 'Dienst · Startet',
    'chip.service.stopping': 'Dienst · Stoppt',
    'chip.service.stopped': 'Dienst · Gestoppt',
    'chip.service.failed': 'Dienst · Fehler',
    'chip.tunnel.on': 'Tunnel · Aktiv',
    'chip.tunnel.connecting': 'Tunnel · Verbindet',
    'chip.tunnel.stopping': 'Tunnel · Schließt',
    'chip.tunnel.off': 'Tunnel · Aus',
    'chip.tunnel.failed': 'Tunnel · Fehler',
    'address.local': 'Lokal',
    'address.lan': 'Netzwerk',
    'address.public': 'Öffentlich',
    'address.notDetected': 'Keine Netzwerkadresse gefunden',
    'address.publicConnecting': 'Öffentliche Adresse wird zugewiesen…',
    'address.publicOff': 'Aus',
    'log.title': 'Laufendes Protokoll',
    'settings.title': 'Einstellungen',
    'settings.desc': 'Port und DJ-Passwort werden nach einem Neustart des Dienstes übernommen. Diese Einstellungen gelten für beide Modi.',
    'settings.port': 'Dienstport',
    'settings.portHint': 'Gäste und DJ-Konsole erreichen die Seite über diesen Port (Standard 3000). Beide Modi nutzen ihn gemeinsam.',
    'settings.password': 'DJ-Passwort',
    'settings.passwordHint': 'Wird beim ersten Start erzeugt; gern auf etwas leicht Tippbares ändern.',
    'settings.apiKey': 'YouTube API-Key (optional)',
    'settings.apiKeyHint': 'Wird sofort übernommen; leer lassen für den Demo-Katalog.',
    'settings.cloudflared': 'cloudflared-Pfad (optional)',
    'settings.cloudflaredHint': 'Leer: bin\\cloudflared.exe (Projektwurzel, dann karaoke_spo\\bin) oder der System-PATH wird verwendet.',
    'settings.cloudflaredFound': 'Gefunden: {path}',
    'settings.cloudflaredMissing': 'cloudflared nicht gefunden – unter bin\\cloudflared.exe ablegen.',
    'settings.fixedUrl': 'Feste öffentliche URL (optional)',
    'settings.fixedUrlHint': 'Für eigene Domain oder benannten Tunnel; Schnell-Tunnel hat Vorrang.',
    'settings.autoStart': 'Tunnel beim Dienststart automatisch öffnen',
    'settings.spotifyTitle': 'Spotify',
    'settings.spotifyHint': 'Wird nur in dieser Konsolen-Konfiguration gespeichert, nicht in den Projektdateien — veröffentlichte Kopien enthalten keine Geheimnisse.',
    'settings.spotifyClientId': 'Client-ID',
    'settings.spotifyClientSecret': 'Client-Secret',
    'settings.spotifyRedirect': 'Redirect-URI',
    'settings.spotifyRedirectHint': 'Genau diesen Wert im Spotify-Dashboard eintragen.',
    'settings.spotifyToken': 'Refresh-Token',
    'settings.spotifyTokenHint': 'Token einfügen oder unten anmelden und danach aus dem Dienst importieren.',
    'settings.spotifyLogin': 'Bei Spotify anmelden',
    'settings.spotifyImport': 'Aus dem Dienst importieren',
    'settings.spotifyLogout': 'Abmelden',
    'spotify.serviceOff': 'Bitte zuerst den Dienst starten, um das Spotify-Konto zu verwalten.',
    'spotify.stateAuthorized': 'Autorisiert — der Dienst kann dein Spotify-Konto nutzen.',
    'spotify.stateConfigured': 'Zugangsdaten gespeichert, aber noch kein Konto autorisiert.',
    'spotify.stateNotConfigured': 'Noch nicht konfiguriert — Client-ID, Secret und Redirect-URI eintragen.',
    'spotify.loginOpened': 'Anmeldeseite geöffnet. Im Browser abschließen und dann „Aus dem Dienst importieren“ klicken.',
    'spotify.imported': 'Autorisierung in der Konsolen-Konfiguration gespeichert.',
    'spotify.loggedOut': 'Von Spotify abgemeldet.',
    'notice.restartRequired': 'Einstellungen geändert – Dienst neu starten.',
    'notice.saved': 'Gespeichert.',
    'notice.savedRestart': 'Gespeichert. Dienst neu starten, damit es wirkt.',
    'notice.copied': 'Adresse kopiert.',
    'notice.displayFallback': 'Im Standardbrowser geöffnet. Autoplay braucht evtl. einen Klick; mit Edge oder Chrome läuft es ohne Eingriff.',
    'notice.copyFailed': 'Kopieren fehlgeschlagen – bitte manuell markieren.',
    'confirm.stopWithTunnel': 'Der Tunnel wird ebenfalls geschlossen und die öffentliche Adresse ungültig. Fortfahren?',
    'confirm.switchMode': 'Zu Modus {mode} wechseln? Der Dienst läuft weiter im aktuellen Modus, bis du ihn neu startest.',
    'notice.modeSwitched': 'Zu Modus {mode} gewechselt. Bitte den Dienst neu starten.',
    'notice.modePending': 'Modus {mode} gewählt – Dienst neu starten, um ihn anzuwenden.',
    'mode.hint': 'Legt fest, welches Projekt der Dienst ausführt. Wirkt nach einem Neustart.',
    'mode.missing': '(Projekt nicht gefunden)',
    'mode.restartHint': 'Modus geändert – Dienst neu starten.',
    'title.startFirst': 'Zuerst den Dienst starten',
    'error.request': 'Anfrage fehlgeschlagen ({status})'
  }
};

const el = {
  version: document.getElementById('version'),
  chipService: document.getElementById('chip-service'),
  chipTunnel: document.getElementById('chip-tunnel'),
  modeSelect: document.getElementById('mode-select'),
  language: document.getElementById('language-select'),
  btnStart: document.getElementById('btn-start'),
  btnRestart: document.getElementById('btn-restart'),
  btnStop: document.getElementById('btn-stop'),
  btnDisplay: document.getElementById('btn-display'),
  btnTunnel: document.getElementById('btn-tunnel'),
  btnSettings: document.getElementById('btn-settings'),
  btnEnv: document.getElementById('btn-env'),
  envDialog: document.getElementById('env-dialog'),
  envForm: document.getElementById('env-form'),
  envStatus: document.getElementById('env-status'),
  envHint: document.getElementById('env-hint'),
  addrLocal: document.getElementById('addr-local'),
  addrLan: document.getElementById('addr-lan'),
  addrPublic: document.getElementById('addr-public'),
  notice: document.getElementById('notice'),
  log: document.getElementById('log'),
  logFile: document.getElementById('log-file'),
  clearLog: document.getElementById('btn-clear-log'),
  dialog: document.getElementById('settings-dialog'),
  form: document.getElementById('settings-form'),
  settingsCancel: document.getElementById('btn-settings-cancel'),
  settingsPath: document.getElementById('settings-path'),
  cloudflaredHint: document.getElementById('cloudflared-hint'),
  reveal: document.getElementById('btn-reveal')
};

const state = {
  status: null,
  language: 'en',
  languagePending: false,
  localBusy: false,
  lastError: '',
  stickyNotice: false,
  noticeTimer: null,
  envInfo: null,
  envSizes: null
};

const MAX_LOG_LINES = 800;

function t(key, params = {}) {
  const dict = I18N[state.language] || I18N.en;
  const template = dict[key] || I18N.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    params[name] === undefined || params[name] === null ? match : String(params[name])
  ));
}

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString(state.language === 'zh' ? 'zh-CN' : state.language, { hour12: false });
  } catch {
    return '';
  }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  headers['x-launcher-token'] = token;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t('error.request', { status: response.status }));
  return data;
}

function applyStatic() {
  document.documentElement.lang = state.language === 'zh' ? 'zh-CN' : state.language;
  el.language.value = state.language;
  el.language.setAttribute('aria-label', t('app.language'));
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  el.reveal.textContent = el.form.elements.djPassword.type === 'password' ? t('button.show') : t('button.hide');
}

function setChip(element, label, tone) {
  element.className = `chip ${tone}`;
  element.textContent = '';
  element.append(document.createElement('i'), document.createTextNode(label));
}

function hideNotice() {
  el.notice.hidden = true;
  el.notice.className = 'notice';
  state.stickyNotice = false;
}

function showNotice(message, kind = 'info', sticky = false, action = null) {
  el.notice.textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn tiny notice-action';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    el.notice.append(button);
  }
  el.notice.className = `notice ${kind}`;
  el.notice.hidden = false;
  state.stickyNotice = sticky;
  clearTimeout(state.noticeTimer);
  if (!sticky) {
    state.noticeTimer = setTimeout(() => {
      if (!state.stickyNotice) hideNotice();
    }, 7000);
  }
}

function render(status) {
  if (!status) return;
  state.status = status;

  if (status.language && !state.languagePending && status.language !== state.language) {
    state.language = status.language;
    applyStatic();
    state.lastError = '';
  }

  const service = status.service || {};
  const tunnel = status.tunnel || {};
  const busy = Boolean(status.busy) || state.localBusy;
  const running = service.state === 'running';

  el.version.textContent = t('app.version', { version: status.version || '0.0.0' });
  // 模式选择器：显示当前生效模式，切换会重启服务
  renderModeSelect(status);
  document.title = running
    ? `${t('app.title')} · ${t('app.running')}${status.mode ? ' · ' + status.mode.MODE_LABEL : ''}`
    : `${t('app.title')}${status.mode ? ' · ' + status.mode.MODE_LABEL : ''}`;

  const serviceTones = { running: 'on', starting: 'busy', stopping: 'busy', stopped: 'off', failed: 'error' };
  setChip(el.chipService, t(`chip.service.${serviceTones[service.state] ? service.state : 'stopped'}`), serviceTones[service.state] || 'off');

  const tunnelTones = { on: 'on', connecting: 'busy', stopping: 'busy', off: 'off', failed: 'error' };
  setChip(el.chipTunnel, t(`chip.tunnel.${tunnelTones[tunnel.state] ? tunnel.state : 'off'}`), tunnelTones[tunnel.state] || 'off');

  const port = service.port || service.configuredPort || 3000;
  el.addrLocal.textContent = `http://127.0.0.1:${port}`;
  el.addrLan.textContent = status.lanUrl || t('address.notDetected');
  if (tunnel.state === 'connecting') el.addrPublic.textContent = t('address.publicConnecting');
  else if (status.publicUrl) el.addrPublic.textContent = status.publicUrl;
  else el.addrPublic.textContent = t('address.publicOff');

  el.btnStart.disabled = busy || !['stopped', 'failed'].includes(service.state);
  el.btnRestart.disabled = busy || !running;
  el.btnStop.disabled = busy || !['running', 'starting'].includes(service.state);
  if (el.btnDisplay) {
    el.btnDisplay.disabled = busy || !running;
    el.btnDisplay.title = !running ? t('title.startFirst') : '';
  }
  el.btnSettings.disabled = busy;

  const tunnelOn = tunnel.state === 'on';
  el.btnTunnel.textContent = tunnel.state === 'connecting' ? t('button.tunnelConnecting')
    : tunnelOn ? t('button.tunnelStop')
      : tunnel.state === 'failed' ? t('button.tunnelRetry')
        : t('button.tunnelStart');
  el.btnTunnel.disabled = busy
    || tunnel.state === 'connecting'
    || tunnel.state === 'stopping'
    || (!tunnelOn && !running);
  el.btnTunnel.title = !tunnelOn && !running ? t('title.startFirst') : '';

  const errorText = service.error || tunnel.error || '';
  if (errorText && errorText !== state.lastError) showNotice(errorText, 'error', true);
  if (!errorText && state.stickyNotice && el.notice.classList.contains('error')) hideNotice();
  state.lastError = errorText;

  if (!errorText && service.restartRequired && !state.stickyNotice) {
    showNotice(t('notice.restartRequired'), 'info', true, {
      label: t('button.restartNow'),
      onClick: () => act('/api/service/restart')
    });
  }
  if (!errorText && !service.restartRequired && state.stickyNotice && el.notice.classList.contains('info')) hideNotice();

  if (status.logFile) el.logFile.textContent = String(status.logFile).split(/[\\/]/).pop();
}

async function act(path) {
  if (state.localBusy) return;
  state.localBusy = true;
  render(state.status);
  try {
    await api(path, { method: 'POST' });
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    state.localBusy = false;
    if (state.status) render(state.status);
  }
}

/**
 * 模式选择器：列出 A/B 两个工程，标出哪个可用。
 * 切换 = 改配置 + 重启服务（两个工程各有自己的 server.js / data，不能热切）。
 */
let modeSelectReady = false;
function renderModeSelect(status) {
  if (!el.modeSelect) return;
  const info = status.modes;
  if (!info || !Array.isArray(info.modes)) { el.modeSelect.disabled = true; return; }

  // 只在首次、模式清单变化或界面语言变化时重建 option，避免用户展开下拉时被刷掉。
  // label 由后端按控制台语言生成，所以语言切换后 signature 会变，自动重建。
  const signature = [state.language, ...info.modes.map((m) => `${m.key}:${m.available ? 1 : 0}:${m.label}`)].join('|');
  if (!modeSelectReady || el.modeSelect.dataset.signature !== signature) {
    el.modeSelect.dataset.signature = signature;
    el.modeSelect.innerHTML = info.modes.map((m) => {
      const text = m.label + (m.available ? '' : t('mode.missing'));
      return `<option value="${m.key}"${m.available ? '' : ' data-missing="1"'}>${text}</option>`;
    }).join('');
    modeSelectReady = true;
  }
  el.modeSelect.value = info.active;
  // 已选但未生效（服务还在跑旧模式）→ 下拉加个标记
  el.modeSelect.classList.toggle('pending', Boolean(status.restartRequired));
  el.modeSelect.title = status.restartRequired
    ? t('mode.restartHint')
    : t('mode.hint');
  const busy = Boolean(status.busy) || state.localBusy;
  el.modeSelect.disabled = busy;
}

async function switchMode(key) {
  if (!el.modeSelect || state.localBusy) return;
  const prev = el.modeSelect.dataset.active || el.modeSelect.value;
  const confirmText = t('confirm.switchMode', { mode: key });
  if (!window.confirm(confirmText)) { el.modeSelect.value = prev; return; }
  state.localBusy = true;
  render(state.status);
  try {
    const result = await api('/api/mode', { method: 'POST', body: JSON.stringify({ mode: key }) });
    // 不会自动重启：服务还在跑旧模式时，明确告诉用户去点「重启服务」
    if (result && result.restartRequired) {
      showNotice(t('notice.modePending', { mode: key }), 'info', true, null);
    } else {
      showNotice(t('notice.modeSwitched', { mode: key }), 'ok');
    }
  } catch (error) {
    el.modeSelect.value = prev;
    showNotice(error.message, 'error');
  } finally {
    state.localBusy = false;
    if (state.status) render(state.status);
  }
}

function appendLog(entry) {
  const atBottom = el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 48;
  const line = document.createElement('div');
  line.className = `log-line ${entry.source || 'launcher'}`;

  const time = document.createElement('span');
  time.className = 't';
  time.textContent = formatTime(entry.at);
  const source = document.createElement('span');
  source.className = 'src';
  source.textContent = entry.source || '';
  const message = document.createElement('span');
  message.className = 'msg';
  message.textContent = entry.text || '';

  line.append(time, source, message);
  el.log.append(line);
  while (el.log.childElementCount > MAX_LOG_LINES) el.log.firstElementChild.remove();
  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
}

async function loadLogs() {
  try {
    const data = await api('/api/logs');
    el.log.textContent = '';
    for (const entry of data.lines || []) appendLog(entry);
    el.log.scrollTop = el.log.scrollHeight;
  } catch {}
}

function connectEvents() {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.addEventListener('status', event => {
    try { render(JSON.parse(event.data)); } catch {}
  });
  source.addEventListener('log', event => {
    try { appendLog(JSON.parse(event.data)); } catch {}
  });
}

async function changeLanguage(language) {
  if (!I18N[language] || language === state.language) return;
  state.language = language;
  state.languagePending = true;
  state.lastError = '';
  hideNotice();
  applyStatic();
  if (state.status) render(state.status);
  try {
    const result = await api('/api/config', { method: 'PUT', body: JSON.stringify({ language }) });
    if (result.status) render(result.status);
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    state.languagePending = false;
  }
}

async function openSettings() {
  try {
    const config = await api('/api/config');
    const form = el.form;
    // 端口按当前选中的模式显示；保存时只改这个模式的端口
    form.elements.port.value = config.service.port;
    form.elements.djPassword.value = config.djPassword;
    form.elements.djPassword.type = 'password';
    el.reveal.textContent = t('button.show');
    form.elements.youtubeApiKey.value = config.youtubeApiKey || '';
    form.elements.cloudflaredPath.value = config.tunnel.cloudflaredPath || '';
    form.elements.fixedPublicUrl.value = config.tunnel.fixedPublicUrl || '';
    form.elements.autoStart.checked = Boolean(config.tunnel.autoStart);

    // Spotify：凭证与授权状态都由控制面板托管
    const spotify = config.spotify || {};
    form.elements.spotifyClientId.value = spotify.clientId || '';
    form.elements.spotifyClientSecret.value = spotify.clientSecret || '';
    form.elements.spotifyClientSecret.type = 'password';
    document.getElementById('btn-reveal-spotify').textContent = t('button.show');
    form.elements.spotifyRedirectUri.value = spotify.redirectUri || suggestRedirectUri(config);
    form.elements.spotifyRefreshToken.value = spotify.refreshToken || '';

    if (config.cloudflared && config.cloudflared.available) {
      el.cloudflaredHint.textContent = t('settings.cloudflaredFound', { path: config.cloudflared.executable });
      el.cloudflaredHint.classList.remove('warn');
    } else {
      el.cloudflaredHint.textContent = t('settings.cloudflaredMissing');
      el.cloudflaredHint.classList.add('warn');
    }
    el.settingsPath.textContent = config.configPath || '';
    bindSpotifyActions();
    refreshSpotifyStatus();
    el.dialog.showModal();
  } catch (error) {
    showNotice(error.message, 'error');
  }
}

/** 回调地址的推荐值：本机服务端口 + /api/spotify/callback */
function suggestRedirectUri(config) {
  const port = (config.service && config.service.port) || 3100;
  return `http://127.0.0.1:${port}/api/spotify/callback`;
}

/** 把服务端返回的授权状态翻译成一句话显示在弹窗里 */
async function refreshSpotifyStatus() {
  const node = document.getElementById('spotify-status');
  if (!node) return;
  try {
    const info = await api('/api/spotify');
    const live = info.service;
    if (!info.serviceRunning) {
      node.textContent = t('spotify.serviceOff');
      node.className = 'muted warn';
      return;
    }
    const configured = live ? live.configured : Boolean(info.config && info.config.clientId);
    const authorized = Boolean(live && live.authorized);
    if (authorized) {
      node.textContent = t('spotify.stateAuthorized');
      node.className = 'muted ok';
    } else if (configured) {
      node.textContent = t('spotify.stateConfigured');
      node.className = 'muted warn';
    } else {
      node.textContent = t('spotify.stateNotConfigured');
      node.className = 'muted warn';
    }
  } catch {
    node.textContent = '';
  }
}

/** 登录 / 导入 / 退出 三个按钮（每次打开弹窗重新绑定，绑定前先解绑） */
let spotifyPollTimer = null;
function stopSpotifyPolling() {
  if (spotifyPollTimer) { clearInterval(spotifyPollTimer); spotifyPollTimer = null; }
}
function bindSpotifyActions() {
  stopSpotifyPolling();

  const reveal = document.getElementById('btn-reveal-spotify');
  if (reveal) {
    reveal.onclick = () => {
      const input = el.form.elements.spotifyClientSecret;
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      reveal.textContent = hidden ? t('button.hide') : t('button.show');
    };
  }

  const login = document.getElementById('btn-spotify-login');
  if (login) {
    login.onclick = async () => {
      try {
        // 先把当前表单里的凭证存进配置，否则服务端拿到的还是旧值
        await saveSpotifyCredsFromForm();
        await api('/api/spotify/auth', { method: 'POST' });
        showNotice(t('spotify.loginOpened'), 'info', true);
        // 授权在浏览器里完成，这边轮询服务状态，拿到 token 就自动导入
        let ticks = 0;
        spotifyPollTimer = setInterval(async () => {
          ticks += 1;
          if (ticks > 90) { stopSpotifyPolling(); return; }
          try {
            const info = await api('/api/spotify');
            if (info.service && info.service.authorized) {
              stopSpotifyPolling();
              await api('/api/spotify/import', { method: 'POST' });
              el.form.elements.spotifyRefreshToken.value = (info.config && info.config.refreshToken) || '';
              showNotice(t('spotify.imported'), 'info');
              refreshSpotifyStatus();
            }
          } catch { /* 继续轮询 */ }
        }, 2000);
      } catch (error) {
        showNotice(error.message, 'error');
      }
    };
  }

  const importBtn = document.getElementById('btn-spotify-import');
  if (importBtn) {
    importBtn.onclick = async () => {
      try {
        const result = await api('/api/spotify/import', { method: 'POST' });
        el.form.elements.spotifyRefreshToken.value = (result.spotify && result.spotify.refreshToken) || '';
        showNotice(t('spotify.imported'), 'info');
        refreshSpotifyStatus();
      } catch (error) {
        showNotice(error.message, 'error');
      }
    };
  }

  const logout = document.getElementById('btn-spotify-logout');
  if (logout) {
    logout.onclick = async () => {
      try {
        await api('/api/spotify/clear', { method: 'POST' });
        el.form.elements.spotifyRefreshToken.value = '';
        showNotice(t('spotify.loggedOut'), 'info');
        refreshSpotifyStatus();
      } catch (error) {
        showNotice(error.message, 'error');
      }
    };
  }
}

/** 只保存 Spotify 凭证（登录前调用），不动其它字段 */
async function saveSpotifyCredsFromForm() {
  const form = el.form;
  await api('/api/config', {
    method: 'PUT',
    body: JSON.stringify({
      spotify: {
        clientId: form.elements.spotifyClientId.value.trim(),
        clientSecret: form.elements.spotifyClientSecret.value.trim(),
        redirectUri: form.elements.spotifyRedirectUri.value.trim()
      }
    })
  });
}

// ---------------------------------------------------------------- 环境配置
function formatMb(bytes) {
  const mb = (Number(bytes) || 0) / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function renderEnvStatus(info, sizes) {
  if (!el.envStatus || !info) return;
  state.envSizes = sizes || state.envSizes || null;

  const action = (label, handler) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn tiny ghost action';
    button.textContent = label;
    button.addEventListener('click', () => handler(button));
    return button;
  };
  const row = (name, ok, detail, tone, actionButton) => {
    const li = document.createElement('li');
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = name;
    const valueEl = document.createElement('span');
    valueEl.className = `value ${tone || (ok ? 'ok' : 'bad')}`;
    valueEl.textContent = detail;
    li.append(nameEl, valueEl, actionButton || document.createElement('span'));
    return li;
  };

  const present = t('env.present');
  const absent = t('env.absent');
  const rows = [];

  rows.push(row(t('env.label.python'), info.ready.python,
    info.ready.python ? present : absent, '',
    info.ready.python ? null : action(t('env.installPython'), makeSetupScript)));

  const ffmpegOk = info.ready.ffmpeg && info.ready.ffprobe;
  rows.push(row(`${t('env.label.ffmpeg')} / ${t('env.label.ffprobe')}`, ffmpegOk,
    ffmpegOk ? present : absent, '',
    ffmpegOk ? null : action(t('env.downloadFfmpeg'), (b) => downloadEnvTool('ffmpeg', b))));

  rows.push(row(t('env.label.cloudflared'), info.ready.cloudflared,
    info.ready.cloudflared ? present : absent, '',
    info.ready.cloudflared ? null : action(t('env.download'), (b) => downloadEnvTool('cloudflared', b))));

  // 模型缓存：体积单独异步统计，先占位
  const modelSize = state.envSizes ? formatMb(state.envSizes.cache) : t('env.sizeLoading');
  rows.push(row(t('env.label.models'), true, modelSize, '', action(t('env.warmModels'), warmModels)));

  const pending = [];
  if (info.pendingMigration.python) pending.push(info.pendingMigration.python);
  if (info.pendingMigration.cache) pending.push(info.pendingMigration.cache);
  for (const item of info.pendingMigration.bin || []) pending.push(item);
  rows.push(row(t('env.label.pending'), pending.length === 0,
    pending.length ? pending.join(' · ') : t('env.none'),
    pending.length ? 'warn' : '',
    pending.length ? action(t('env.migrate'), migrateEnv) : null));

  el.envStatus.replaceChildren(...rows);
  if (el.envHint) el.envHint.textContent = (info.paths && info.paths.dir) || '';
}

/** 体积统计单独跑，别阻塞弹窗 */
async function loadEnvSizes() {
  try {
    const sizes = await api('/api/env/sizes');
    state.envSizes = sizes;
    if (el.envStatus) renderEnvStatus(state.envInfo, sizes);
  } catch { /* 统计失败就保持「统计中」 */ }
}

async function refreshEnv() {
  try {
    const info = await api('/api/env');
    state.envInfo = info;
    renderEnvStatus(info, state.envSizes);
    loadEnvSizes();
  } catch { /* 状态拿不到就先不显示 */ }
}

async function openEnv() {
  try {
    // 先弹窗（快），再异步补状态和体积，避免打开时卡一下
    el.envDialog.showModal();
    el.envStatus.replaceChildren();
    const config = await api('/api/config');
    const env = config.env || {};
    el.envForm.elements.envDir.value = env.dir || '';
    el.envForm.elements.envPython.value = env.python || '';
    el.envForm.elements.envCache.value = env.cache || '';
    el.envForm.elements.envBin.value = env.bin || '';
    state.envInfo = null;
    state.envSizes = null;
    await refreshEnv();
  } catch (error) {
    showNotice(error.message, 'error');
  }
}

async function saveEnv(event) {
  event.preventDefault();
  try {
    await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        env: {
          dir: el.envForm.elements.envDir.value.trim(),
          python: el.envForm.elements.envPython.value.trim(),
          cache: el.envForm.elements.envCache.value.trim(),
          bin: el.envForm.elements.envBin.value.trim()
        }
      })
    });
    showNotice(t('env.saved'), 'info');
    state.envSizes = null;
    await refreshEnv();
  } catch (error) {
    showNotice(error.message, 'error');
  }
}

async function migrateEnv(button) {
  button.disabled = true;
  showNotice(t('env.migrating'), 'info', true);
  try {
    const result = await api('/api/env/migrate', { method: 'POST' });
    state.envSizes = null;
    await refreshEnv();
    showNotice(t('env.migrateDone'), 'info');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/** 生成「重建 Python 环境」的批处理，避免几 GB 的 pip 下载拖住控制面板 */
async function makeSetupScript(button) {
  button.disabled = true;
  try {
    const result = await api('/api/env/setup-script', { method: 'POST' });
    showNotice(t('env.scriptWritten', { path: result.path }), 'info');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/** 预热模型：让 demucs 把权重下载到 env\cache */
async function warmModels(button) {
  button.disabled = true;
  showNotice(t('env.warming'), 'info', true);
  try {
    await api('/api/env/warm-models', { method: 'POST' });
    state.envSizes = null;
    await refreshEnv();
    showNotice(t('env.modelsReady'), 'info');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/** 一键处理所有缺失项：二进制直接下载，Python 生成安装脚本 */
async function installMissing(button) {
  button.disabled = true;
  try {
    const info = state.envInfo || await api('/api/env');
    const targets = [];
    if (!info.ready.ffmpeg || !info.ready.ffprobe) targets.push('ffmpeg');
    if (!info.ready.cloudflared) targets.push('cloudflared');

    if (!info.ready.python) {
      // Python 环境要下载几 GB 的 pip 包，不在面板里跑，生成脚本让用户自己双击
      const result = await api('/api/env/setup-script', { method: 'POST' });
      showNotice(t('env.scriptWritten', { path: result.path }), 'info', true);
    }

    if (!targets.length) {
      if (info.ready.python) showNotice(t('env.allReady'), 'info');
      return;
    }

    for (const target of targets) {
      showNotice(t('env.downloading'), 'info', true);
      await api('/api/env/download', { method: 'POST', body: JSON.stringify({ target }) });
    }
    state.envSizes = null;
    await refreshEnv();
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function downloadEnvTool(target, button) {
  button.disabled = true;
  showNotice(t('env.downloading'), 'info', true);
  try {
    const result = await api('/api/env/download', { method: 'POST', body: JSON.stringify({ target }) });
    state.envSizes = null;
    await refreshEnv();
    const label = result.path || (result.paths || []).join(', ');
    showNotice(t('env.downloaded', { path: label, mb: (result.bytes / 1048576).toFixed(1) }), 'info');
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = el.form;
  const payload = {
    service: { port: Number(form.elements.port.value) },
    djPassword: form.elements.djPassword.value,
    youtubeApiKey: form.elements.youtubeApiKey.value.trim(),
    spotify: {
      clientId: form.elements.spotifyClientId.value.trim(),
      clientSecret: form.elements.spotifyClientSecret.value.trim(),
      redirectUri: form.elements.spotifyRedirectUri.value.trim(),
      refreshToken: form.elements.spotifyRefreshToken.value.trim()
    },
    tunnel: {
      cloudflaredPath: form.elements.cloudflaredPath.value.trim(),
      fixedPublicUrl: form.elements.fixedPublicUrl.value.trim(),
      autoStart: form.elements.autoStart.checked
    }
  };
  try {
    const result = await api('/api/config', { method: 'PUT', body: JSON.stringify(payload) });
    el.dialog.close();
    showNotice(result.requiresRestart ? t('notice.savedRestart') : t('notice.saved'), 'info');
    if (result.status) render(result.status);
  } catch (error) {
    showNotice(error.message, 'error');
  }
}

async function copyAddress(button) {
  const target = document.getElementById(button.dataset.copy);
  const text = target ? target.textContent.trim() : '';
  if (!/^https?:\/\//i.test(text)) return;
  try {
    await navigator.clipboard.writeText(text);
    showNotice(t('notice.copied'), 'info');
  } catch {
    showNotice(t('notice.copyFailed'), 'error');
  }
}

el.btnStart.addEventListener('click', () => act('/api/service/start'));
el.btnRestart.addEventListener('click', () => act('/api/service/restart'));
el.btnStop.addEventListener('click', () => {
  const tunnelOn = state.status && state.status.tunnel && state.status.tunnel.state === 'on';
  if (tunnelOn && !window.confirm(t('confirm.stopWithTunnel'))) return;
  act('/api/service/stop');
});
if (el.btnDisplay) el.btnDisplay.addEventListener('click', async () => {
  if (state.localBusy) return;
  state.localBusy = true;
  render(state.status);
  try {
    const result = await api('/api/open-display', { method: 'POST' });
    const warning = result && (result.warning || (result.fallback ? t('notice.displayFallback') : ''));
    if (warning) showNotice(warning, 'info', true);
  } catch (error) {
    showNotice(error.message, 'error');
  } finally {
    state.localBusy = false;
    render(state.status);
  }
});
el.btnTunnel.addEventListener('click', () => {
  const tunnelOn = state.status && state.status.tunnel && state.status.tunnel.state === 'on';
  act(tunnelOn ? '/api/tunnel/stop' : '/api/tunnel/start');
});
el.btnSettings.addEventListener('click', openSettings);
el.form.addEventListener('submit', saveSettings);

// 环境配置弹窗
if (el.btnEnv) el.btnEnv.addEventListener('click', openEnv);
if (el.envForm) el.envForm.addEventListener('submit', saveEnv);
{
  const envCancel = document.getElementById('btn-env-cancel');
  if (envCancel) envCancel.addEventListener('click', () => el.envDialog.close());
  const envMigrate = document.getElementById('btn-env-migrate');
  if (envMigrate) envMigrate.addEventListener('click', () => migrateEnv(envMigrate));
  const envInstall = document.getElementById('btn-env-install');
  if (envInstall) envInstall.addEventListener('click', () => installMissing(envInstall));
  const envRefresh = document.getElementById('btn-env-refresh');
  if (envRefresh) {
    envRefresh.addEventListener('click', async () => {
      state.envSizes = null;
      await refreshEnv();
    });
  }
  const envOpen = document.getElementById('btn-env-open');
  if (envOpen) {
    envOpen.addEventListener('click', async () => {
      try { await api('/api/env/open', { method: 'POST', body: JSON.stringify({ target: 'dir' }) }); }
      catch (error) { showNotice(error.message, 'error'); }
    });
  }
}
el.settingsCancel.addEventListener('click', () => el.dialog.close());
el.reveal.addEventListener('click', () => {
  const input = el.form.elements.djPassword;
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  el.reveal.textContent = hidden ? t('button.hide') : t('button.show');
});
el.clearLog.addEventListener('click', () => { el.log.textContent = ''; });
el.language.addEventListener('change', event => changeLanguage(event.target.value));
if (el.modeSelect) {
  el.modeSelect.addEventListener('change', event => switchMode(event.target.value));
}
for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', () => copyAddress(button));
}

applyStatic();
connectEvents();
loadLogs();
api('/api/status').then(render).catch(() => {});
setInterval(() => {
  api('/api/status').then(render).catch(() => {});
}, 5000);
