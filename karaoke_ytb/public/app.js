const mode = location.pathname.startsWith('/admin') ? 'admin' : location.pathname.startsWith('/display') ? 'display' : 'join';
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let toastTimer;
let playbackConfirmTimer = null;
let playbackConfirmButton = null;
let playbackConfirmAction = null;
let interfaceDefaults = { language: 'zh', theme: 'system' };
let displayCurrentSong = null;
let joinEvents = null;
let joinConfig = null;
let displayQrRefresh = null;
let serverVersionWarned = false;
const REQUIRED_API_VERSION = 7;

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
function clientBrowserId() {
  if (mode !== 'join') return '';
  let value = localStorage.getItem('karaoke_browser_id');
  if (!value) {
    value = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('karaoke_browser_id', value);
  }
  return value;
}
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const browserId = clientBrowserId();
  if (browserId && !headers['x-browser-id']) headers['x-browser-id'] = browserId;
  const response = await fetch(path, { ...options, headers, credentials: options.credentials || 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(serverErrorMessage(data) || localeText('requestFailed', '请求失败')); error.status = response.status; error.code = data.code; throw error; }
  return data;
}
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
function timeAgo(iso) { const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return seconds < 60 ? localeText('secondsAgo', '{n} 秒前').replace('{n}', Math.round(seconds)) : localeText('minutesAgo', '{n} 分钟前').replace('{n}', Math.round(seconds / 60)); }
function renderShell(inner, opts = {}) {
  document.body.className = opts.dark ? 'display-page' : '';
  const brandTitle = mode === 'admin' ? 'LC AACHEN Karaoke Console' : 'LC AACHEN Karaoke';
  app.innerHTML = opts.dark ? inner : `<div class="app-shell"><header class="topbar"><div class="brand"><img class="brand-mark" src="/ICON.png" alt="EESTEC LC AACHEN"><span>${brandTitle}</span></div><div class="top-actions">${opts.actions || ''}</div></header>${inner}</div>`;
  if (mode === 'join') { ensureUserAppearancePanel(); applyLocale(); }
  else if (mode === 'display') applyLocale();
  else if (!document.getElementById('admin-content')) applyAdminLanguage();
}
function connectEvents(onState) {
  const events = new EventSource('/events');
  events.addEventListener('state', event => { const state = JSON.parse(event.data); syncLiveInterfaceSettings(state.settings, state); onState(state); });
  events.onerror = () => {};
  return events;
}

const adminI18n = {
  zh: { title:'现场控制台', intro:'一处管理播放、队列、参与者和现场信息。所有变更会实时同步到大屏与手机。', display:'打开大屏 ↗', logout:'退出', status:'当前状态', queue:'等待歌曲', users:'在线会话', volume:'当前音量', nowPlaying:'正在播放', nowPlayingEmpty:'队列为空时大屏显示待机画面', queueTitle:'等待队列', queueDesc:'置顶歌曲优先；可直接调整、删除和切换优先级。', normalBroadcast:'普通广播', normalBroadcastDesc:'显示在播放器之外，不会打断当前音乐。', importantBroadcast:'重要广播', importantDesc:'单独控制现场口播：暂停音乐并覆盖大屏。', settings:'活动设置', settingsDesc:'变更会立即作用于新请求', participants:'参与者', participantsDesc:'按临时会话识别点歌归属', appearance:'界面设置', appearanceDesc:'这里设置现场默认，用户可在自己的设备上单独覆盖', songFilters:'点歌过滤', onlyKaraoke:'仅允许 Karaoke 歌曲', onlyKaraokeHint:'视频标题必须包含 karaoke（不区分大小写）', blacklistKeywords:'黑名单关键字', blacklistPlaceholder:'多个关键字用逗号或换行分隔', blacklistHint:'标题命中任一关键字时禁止添加', language:'语言', theme:'配色模式', save:'保存设置', send:'发送', languageSaved:'语言已切换', themeSaved:'配色已切换', pause:'暂停播放', resume:'恢复播放', importantStart:'开始重要广播', importantStop:'停止重要广播', importantOnAir:'重要广播中', importantCountdown:'恢复倒计时中', skip:'切歌', stop:'停止' },
  en: { title:'DJ Control Desk', intro:'Manage playback, queue, guests, and live announcements from one place. Changes sync to the display and phones.', display:'Open Display ↗', logout:'Log out', status:'Status', queue:'Waiting Songs', users:'Guest Sessions', volume:'Volume', nowPlaying:'Now Playing', nowPlayingEmpty:'The display is idle while the queue is empty.', queueTitle:'Waiting Queue', queueDesc:'Pinned songs play first. Reorder, pin, or remove songs here.', normalBroadcast:'Regular Broadcast', normalBroadcastDesc:'Shown outside the player without interrupting music.', importantBroadcast:'Important Broadcast', importantDesc:'Pause music and cover the display while the DJ speaks live.', settings:'Event Settings', settingsDesc:'Changes apply to new requests immediately.', participants:'Guests', participantsDesc:'Song ownership is tracked by temporary session.', appearance:'Interface Settings', appearanceDesc:'Set the room default; users can override it on their own devices.', songFilters:'Song Filters', onlyKaraoke:'Karaoke songs only', onlyKaraokeHint:'The video title must contain karaoke (case-insensitive)', blacklistKeywords:'Blocked keywords', blacklistPlaceholder:'Separate keywords with commas or new lines', blacklistHint:'Titles containing any keyword cannot be added', language:'Language', theme:'Theme', save:'Save Settings', send:'Send', languageSaved:'Language changed', themeSaved:'Theme changed', pause:'Pause', resume:'Resume', importantStart:'Start Important Broadcast', importantStop:'Stop Important Broadcast', importantOnAir:'Important Broadcast On Air', importantCountdown:'Recovery countdown', skip:'Skip', stop:'Stop' },
  de: { title:'DJ Steuerzentrale', intro:'Wiedergabe, Warteschlange, Gäste und Durchsagen zentral verwalten. Änderungen werden synchronisiert.', display:'Anzeige öffnen ↗', logout:'Abmelden', status:'Status', queue:'Wartende Songs', users:'Gäste', volume:'Lautstärke', nowPlaying:'Aktuelle Wiedergabe', nowPlayingEmpty:'Bei leerer Warteschlange zeigt die Anzeige den Standby-Bildschirm.', queueTitle:'Warteschlange', queueDesc:'Angepinnte Songs werden zuerst gespielt. Hier verwalten und entfernen.', normalBroadcast:'Normale Durchsage', normalBroadcastDesc:'Außerhalb des Players angezeigt, ohne die Musik zu unterbrechen.', importantBroadcast:'Wichtige Durchsage', importantDesc:'Musik pausieren und Anzeige überblenden, während der DJ spricht.', settings:'Event-Einstellungen', settingsDesc:'Änderungen gelten sofort für neue Anfragen.', participants:'Gäste', participantsDesc:'Die Zuordnung erfolgt über eine temporäre Sitzung.', appearance:'Oberfläche', appearanceDesc:'Hier den Raumstandard festlegen; Gäste können ihn auf ihren Geräten überschreiben.', songFilters:'Song-Filter', onlyKaraoke:'Nur Karaoke-Songs', onlyKaraokeHint:'Der Videotitel muss „karaoke“ enthalten (Groß-/Kleinschreibung egal)', blacklistKeywords:'Gesperrte Stichwörter', blacklistPlaceholder:'Mit Kommas oder Zeilenumbrüchen trennen', blacklistHint:'Titel mit einem dieser Stichwörter können nicht hinzugefügt werden', language:'Sprache', theme:'Design', save:'Einstellungen speichern', send:'Senden', languageSaved:'Sprache geändert', themeSaved:'Design geändert', pause:'Pause', resume:'Fortsetzen', importantStart:'Wichtige Durchsage starten', importantStop:'Wichtige Durchsage beenden', importantOnAir:'Wichtige Durchsage läuft', importantCountdown:'Wiederaufnahme läuft', skip:'Überspringen', stop:'Stopp' }
};
Object.assign(adminI18n.zh, { pin:'置顶', unpin:'取消置顶', remove:'删除', queueEmpty:'等待参与者点歌', usersEmpty:'还没有参与者', online:'在线活动', songUnit:'首', newSession:'开启新会话', newSessionConfirm:'开启新会话会清空所有用户、队列、播放记录和广播，只保留活动设置。确定继续吗？', newSessionDone:'新会话已开启' });
Object.assign(adminI18n.en, { pin:'Pin', unpin:'Unpin', remove:'Remove', queueEmpty:'Waiting for guests to choose songs', usersEmpty:'No guests yet', online:'Active', songUnit:'songs', newSession:'Start New Session', newSessionConfirm:'Starting a new session clears all guests, queues, playback history, and broadcasts while keeping event settings. Continue?', newSessionDone:'New session started' });
Object.assign(adminI18n.de, { pin:'Anheften', unpin:'Lösen', remove:'Entfernen', queueEmpty:'Warten auf die Songauswahl der Gäste', usersEmpty:'Noch keine Gäste', online:'Aktiv', songUnit:'Songs', newSession:'Neue Sitzung starten', newSessionConfirm:'Eine neue Sitzung löscht alle Gäste, Warteschlangen, Wiedergabeverläufe und Durchsagen, die Event-Einstellungen bleiben erhalten. Fortfahren?', newSessionDone:'Neue Sitzung gestartet' });
Object.assign(adminI18n.zh, { publicUrl:'公网地址', publicUrlPlaceholder:'例如：https://karaoke.example.com', publicUrlHint:'二维码会指向此地址的 /join；留空则使用当前访问地址' });
Object.assign(adminI18n.en, { publicUrl:'Public URL', publicUrlPlaceholder:'e.g. https://karaoke.example.com', publicUrlHint:'The QR code points to this address plus /join. Leave blank to use the current address.' });
Object.assign(adminI18n.de, { publicUrl:'Öffentliche URL', publicUrlPlaceholder:'z. B. https://karaoke.example.com', publicUrlHint:'Der QR-Code verweist auf diese Adresse plus /join. Leer lassen für die aktuelle Adresse.' });
Object.assign(adminI18n.zh, { guestTimeout:'Guest 超时（分钟）', guestTimeoutHint:'超过该时间没有点歌且没有排队歌曲时自动移除；有活动歌曲不会清理。', manageBlocklist:'管理黑名单', blockGuest:'拉黑', blockGuestConfirm:'确定拉黑这个 Guest 吗？当前会话会立即失效，但其已点歌曲不会删除。', blocklistTitle:'Guest 黑名单', blocklistEmpty:'黑名单为空', unblock:'移除拉黑', browserLocked:'已锁定浏览器' });
Object.assign(adminI18n.en, { guestTimeout:'Guest inactivity (minutes)', guestTimeoutHint:'Remove after this time without a new song, only when no songs are queued or playing.', manageBlocklist:'Manage Blocklist', blockGuest:'Block', blockGuestConfirm:'Block this Guest? Their session will end immediately, but their songs will not be deleted.', blocklistTitle:'Guest Blocklist', blocklistEmpty:'The blocklist is empty', unblock:'Unblock', browserLocked:'Browser locked' });
Object.assign(adminI18n.de, { guestTimeout:'Guest-Inaktivität (Minuten)', guestTimeoutHint:'Nach dieser Zeit ohne neuen Song entfernen, sofern keine Songs warten oder laufen.', manageBlocklist:'Sperrliste verwalten', blockGuest:'Sperren', blockGuestConfirm:'Diesen Guest sperren? Die Sitzung endet sofort, Songs werden nicht gelöscht.', blocklistTitle:'Guest-Sperrliste', blocklistEmpty:'Die Sperrliste ist leer', unblock:'Entsperren', browserLocked:'Browser gesperrt' });
Object.assign(adminI18n.zh, { confirmRemove:'从等待队列移除这首歌？', confirmAgain:'再次确认', settingsSaved:'设置已保存', broadcastSent:'广播已发送', importantStarted:'重要广播已开始，大屏已暂停', importantStopped:'重要广播已停止，大屏开始三秒恢复倒计时', requestedBy:'{singer} 点播 · {channel}' });
Object.assign(adminI18n.en, { confirmRemove:'Remove this song from the queue?', confirmAgain:'Confirm again', settingsSaved:'Settings saved', broadcastSent:'Broadcast sent', importantStarted:'Important broadcast started; the display is paused', importantStopped:'Important broadcast stopped; the display resumes in 3 seconds', requestedBy:'Requested by {singer} · {channel}' });
Object.assign(adminI18n.de, { confirmRemove:'Diesen Song aus der Warteschlange entfernen?', confirmAgain:'Erneut bestätigen', settingsSaved:'Einstellungen gespeichert', broadcastSent:'Durchsage gesendet', importantStarted:'Wichtige Durchsage gestartet; die Anzeige ist pausiert', importantStopped:'Wichtige Durchsage beendet; die Anzeige setzt in 3 Sekunden fort', requestedBy:'Gewünscht von {singer} · {channel}' });
function adminLabel(key) {
  return (adminI18n[currentAdminLanguage()] || adminI18n.zh)[key] || key;
}
function nowPlayingMeta(song) {
  if (!song) return '';
  return adminLabel('requestedBy').replace('{singer}', song.singerName || '').replace('{channel}', song.channelTitle || '');
}
function displayHref() {
  const host = location.hostname;
  if (host === 'localhost') return '/display';
  return `http://localhost:${location.port || '3000'}/display`;
}
const commonI18n = {
  zh: { joinEyebrow:'加入现场', joinDesc:'扫描大屏二维码后，在这里输入你的昵称。无需注册，浏览器会记住本次点歌会话。', nickname:'演唱者昵称', nicknamePlaceholder:'例如：小林', joinRoom:'进入点歌台 →', sessionTip:'Guest 名称不能重复，歌曲归属由临时会话识别。', controller:'手机点歌', changeName:'更换昵称', searchTitle:'搜索 YouTube', searchDesc:'支持搜索歌名，也可以直接粘贴 YouTube 链接。', searchPlaceholder:'搜索歌名，或粘贴 YouTube 链接', search:'搜索', searchStart:'输入关键词或粘贴链接开始', myQueue:'我的等待队列', quota:'每人最多', publicQueue:'公开后续队列', publicDesc:'所有参与者看到的播放顺序', syncing:'同步中', waiting:'等待播放', realtime:'实时同步', addSong:'点歌', noResults:'没有找到匹配歌曲', searching:'搜索中…', queueEmpty:'队列为空，来唱第一首吧', noSongs:'你还没有点歌', remove:'删除', currentEmpty:'当前还没有播放歌曲，点歌后会自动开始。', currentPlaying:'正在播放：', paused:'已暂停', preparing:'准备播放', playing:'播放中', added:'已加入等待队列', removed:'已从队列移除', duplicateSong:'你已经点过这首歌了', namePrompt:'请输入新的演唱者昵称', nameChanged:'昵称已更新，歌曲归属不变', notYou:'你不是', restartSession:'点击这里重新开始', scan:'扫码点歌', joinDisplay:'加入现场', scanDesc:'用手机扫描二维码，搜索并加入你的歌曲。', upNext:'接下来', welcome:'欢迎来到歌唱现场，扫描二维码点歌。', displayFooter:'播放器区域保持独立，不覆盖 YouTube 控件。DJ 可在控制台暂停、恢复、切歌与调节音量。', ready:'准备开始', idleTitle:'等你来唱', idleDesc:'点歌后，歌曲会自动出现在这里。', noNext:'暂无后续歌曲', playerFail:'播放器连接失败', playerFailDesc:'请检查展示台的网络连接，再由 DJ 手动切歌。', djBroadcast:'DJ 正在广播中', listenNotice:'请听取现场通知', resumeSoon:'即将恢复播放', resumeHint:'音乐将在倒计时结束后继续', queueNumber:'首', fullscreen:'全屏', exitFullscreen:'退出全屏', fullscreenFailed:'无法进入全屏' },
  en: { joinEyebrow:'JOIN THE ROOM', joinDesc:'Scan the display QR code and enter your name. No registration or app is required.', nickname:'Singer Name', nicknamePlaceholder:'e.g. Lin', joinRoom:'Enter Controller →', sessionTip:'Guest names must be unique; song ownership is tied to your temporary session.', controller:'GUEST CONTROLLER', changeName:'Change Name', searchTitle:'Search YouTube', searchDesc:'Search by song or paste a YouTube link directly.', searchPlaceholder:'Search a song or paste a YouTube link', search:'Search', searchStart:'Type a keyword or paste a link to start', myQueue:'My Waiting Queue', quota:'Max per guest', publicQueue:'Public Queue', publicDesc:'The playback order visible to everyone', syncing:'Syncing', waiting:'Waiting', realtime:'Live sync', addSong:'Add Song', noResults:'No matching songs found', searching:'Searching…', queueEmpty:'The queue is empty. Be the first to sing.', noSongs:'You have not added a song yet', remove:'Remove', currentEmpty:'Nothing is playing. Add a song to start.', currentPlaying:'Now playing:', paused:'Paused', preparing:'Preparing', playing:'Playing', added:'Added to the queue', removed:'Removed from the queue', duplicateSong:'You have already chosen this song', namePrompt:'Enter a new singer name', nameChanged:'Name updated; your song ownership is unchanged', notYou:'Not', restartSession:'click here to start over', scan:'SCAN TO SING', joinDisplay:'Join the Room', scanDesc:'Scan with your phone to search and join a song.', upNext:'UP NEXT', welcome:'Welcome. Scan the QR code to choose a song.', displayFooter:'The player stays independent so YouTube controls remain visible. DJ controls playback from the console.', ready:'READY WHEN YOU ARE', idleTitle:'Your turn to sing', idleDesc:'Choose a song and it will appear here.', noNext:'No songs coming up', playerFail:'Player connection failed', playerFailDesc:'Check the display network, then let the DJ skip the song.', djBroadcast:'DJ IS BROADCASTING', listenNotice:'Please listen to the live announcement', resumeSoon:'Playback resumes soon', resumeHint:'Music will continue after the countdown', queueNumber:'songs', fullscreen:'Fullscreen', exitFullscreen:'Exit Fullscreen', fullscreenFailed:'Fullscreen is not available' },
  de: { joinEyebrow:'BEITRETEN', joinDesc:'QR-Code auf der Anzeige scannen und Namen eingeben. Keine Registrierung und keine App nötig.', nickname:'Sängername', nicknamePlaceholder:'z. B. Lin', joinRoom:'Zur Steuerung →', sessionTip:'Guest-Namen müssen eindeutig sein; die Zuordnung erfolgt über die temporäre Sitzung.', controller:'GÄSTE-STEUERUNG', changeName:'Namen ändern', searchTitle:'YouTube durchsuchen', searchDesc:'Nach Songs suchen oder direkt einen YouTube-Link einfügen.', searchPlaceholder:'Song suchen oder YouTube-Link einfügen', search:'Suchen', searchStart:'Suchbegriff oder Link eingeben', syncing:'Synchronisierung', waiting:'Warten', realtime:'Live-Synchronisierung', addSong:'Hinzufügen', noResults:'Keine passenden Songs gefunden', searching:'Suche läuft…', queueEmpty:'Die Warteschlange ist leer. Singe den ersten Song.', noSongs:'Noch kein Song ausgewählt', remove:'Entfernen', currentEmpty:'Keine Wiedergabe. Füge einen Song hinzu.', currentPlaying:'Aktuelle Wiedergabe:', paused:'Pausiert', preparing:'Wird vorbereitet', playing:'Läuft', added:'Zur Warteschlange hinzugefügt', removed:'Aus der Warteschlange entfernt', duplicateSong:'Du hast diesen Song bereits ausgewählt', namePrompt:'Neuen Sängernamen eingeben', nameChanged:'Name geändert; deine Songzuordnung bleibt erhalten', notYou:'Nicht', restartSession:'hier klicken, um neu zu beginnen', scan:'ZUM SINGEN SCANNEN', joinDisplay:'Beitreten', scanDesc:'Mit dem Handy scannen, Song suchen und beitreten.', upNext:'ALS NÄCHSTES', welcome:'Willkommen. QR-Code scannen und Song auswählen.', displayFooter:'Der Player bleibt unabhängig, damit YouTube-Steuerelemente sichtbar bleiben. Der DJ steuert die Wiedergabe.', ready:'BEREIT', idleTitle:'Du bist dran', idleDesc:'Wähle einen Song, dann erscheint er hier.', noNext:'Keine weiteren Songs', playerFail:'Player-Verbindung fehlgeschlagen', playerFailDesc:'Netzwerk der Anzeige prüfen und den Song vom DJ überspringen lassen.', djBroadcast:'DJ SPRICHT', listenNotice:'Bitte der Live-Durchsage zuhören', resumeSoon:'Wiedergabe startet gleich', resumeHint:'Die Musik läuft nach dem Countdown weiter', queueNumber:'Songs', fullscreen:'Vollbild', exitFullscreen:'Vollbild verlassen', fullscreenFailed:'Vollbild ist nicht verfügbar' }
};
Object.assign(commonI18n.zh, { karaokeSearch:'搜索 Karaoke 版本', moveUp:'上移', moveDown:'下移', quotaStatus:'{n} 首 · 每人最多 {max} 首', serverOutdated:'服务端版本过旧，请关闭控制台重新打开后再试', secondsAgo:'{n} 秒前', minutesAgo:'{n} 分钟前', requestFailed:'请求失败' });
Object.assign(commonI18n.en, { karaokeSearch:'Search for Karaoke Version', moveUp:'Move up', moveDown:'Move down', quotaStatus:'{n} songs · max {max} per guest', serverOutdated:'The server is running an older version. Close and reopen the console, then try again.', secondsAgo:'{n}s ago', minutesAgo:'{n} min ago', requestFailed:'Request failed' });
Object.assign(commonI18n.de, { karaokeSearch:'Nach Karaoke-Version suchen', moveUp:'Nach oben', moveDown:'Nach unten', quotaStatus:'{n} Songs · max. {max} pro Gast', serverOutdated:'Der Server läuft mit einer älteren Version. Konsole schließen, neu öffnen und erneut versuchen.', secondsAgo:'vor {n} s', minutesAgo:'vor {n} Min.', requestFailed:'Anfrage fehlgeschlagen' });
Object.assign(commonI18n.zh, { notEmbeddable:'这个视频不允许嵌入播放，请换一个', unplayable:'这首歌无法嵌入播放', unplayableDesc:'正在跳到下一首…' });
Object.assign(commonI18n.en, { notEmbeddable:'This video does not allow embedding. Please pick another one.', unplayable:'This video cannot be embedded', unplayableDesc:'Skipping to the next song…' });
Object.assign(commonI18n.de, { notEmbeddable:'Dieses Video erlaubt kein Einbetten. Bitte ein anderes wählen.', unplayable:'Dieses Video lässt sich nicht einbetten', unplayableDesc:'Nächster Song wird geladen…' });
const SERVER_ERROR_I18N = {
  en: {
    SESSION_REQUIRED: 'Please start a song session first',
    SESSION_EXPIRED: 'Your session expired. Please rejoin.',
    DISPLAY_NAME_REQUIRED: 'Please enter a singer name',
    DISPLAY_NAME_TAKEN: 'That Guest name is already in use',
    BROWSER_BLOCKED: 'This browser has been blocked by the DJ',
    SESSION_BLOCKED: 'This session cannot add songs right now',
    QUEUE_LIMIT: 'Limit reached: {current} songs now, max {max}',
    DUPLICATE_SESSION_SONG: 'You have already chosen this song',
    DUPLICATE_VIDEO: 'This song is already in the queue',
    SONG_NOT_KARAOKE: 'Only songs whose title contains “karaoke” can be added',
    SONG_BLACKLISTED: 'This song title contains a blocked keyword: {keyword}',
    SONG_INCOMPLETE: 'Song information is incomplete',
    SONG_NOT_QUEUED: 'This song is not in the waiting queue',
    NOT_YOUR_SONG: 'You can only change your own songs',
    STALE_PLAYBACK: 'The playback request has changed',
    BAD_PASSWORD: 'Wrong DJ password',
    ADMIN_REQUIRED: 'DJ permission required',
    GUEST_NOT_FOUND: 'Guest not found or already gone',
    BLOCKED_GUEST_NOT_FOUND: 'Blocklist entry not found',
    INVALID_PUBLIC_URL: 'The public URL must be a valid http:// or https:// address',
    EMPTY_BROADCAST: 'The broadcast message cannot be empty',
    BROADCAST_NOT_FOUND: 'Broadcast not found',
    BAD_ANIMATION: 'Unsupported animation',
    INVALID_IMPORTANT_ACTION: 'Invalid important broadcast action',
    YOUTUBE_SEARCH_FAILED: 'YouTube search failed. Check the API key and quota.',
    NOT_FOUND: 'Interface not found. The server may need a restart or update.',
    SERVER_ERROR: 'Server error'
  },
  zh: {
    SESSION_REQUIRED: '请先建立点歌会话',
    SESSION_EXPIRED: '会话已失效，请重新进入',
    DISPLAY_NAME_REQUIRED: '请输入演唱者昵称',
    DISPLAY_NAME_TAKEN: '这个 Guest 名称已经被使用',
    BROWSER_BLOCKED: '此浏览器已被 DJ 拉黑',
    SESSION_BLOCKED: '当前会话暂时不能点歌',
    QUEUE_LIMIT: '已达到上限：当前 {current} 首，最多 {max} 首',
    DUPLICATE_SESSION_SONG: '你已经点过这首歌',
    DUPLICATE_VIDEO: '这首歌已经在等待队列中',
    SONG_NOT_KARAOKE: '仅允许视频标题含 Karaoke 的歌曲',
    SONG_BLACKLISTED: '视频标题含黑名单关键字：{keyword}',
    SONG_INCOMPLETE: '歌曲信息不完整',
    SONG_NOT_QUEUED: '歌曲不在等待队列中',
    NOT_YOUR_SONG: '只能调整自己点的歌',
    STALE_PLAYBACK: '播放请求已变化',
    BAD_PASSWORD: 'DJ 密码不正确',
    ADMIN_REQUIRED: '需要 DJ 权限',
    GUEST_NOT_FOUND: 'Guest 不存在或已离开',
    BLOCKED_GUEST_NOT_FOUND: '黑名单记录不存在',
    INVALID_PUBLIC_URL: '公网地址必须是有效的 http 或 https 地址',
    EMPTY_BROADCAST: '广播内容不能为空',
    BROADCAST_NOT_FOUND: '广播不存在',
    BAD_ANIMATION: '不支持的动画',
    INVALID_IMPORTANT_ACTION: '重要广播操作无效',
    YOUTUBE_SEARCH_FAILED: 'YouTube 搜索失败，请检查 API Key 和配额',
    NOT_FOUND: '接口不存在，服务端可能需要重启或升级',
    SERVER_ERROR: '服务器错误'
  },
  de: {
    SESSION_REQUIRED: 'Bitte zuerst eine Sitzung starten',
    SESSION_EXPIRED: 'Die Sitzung ist abgelaufen. Bitte erneut beitreten.',
    DISPLAY_NAME_REQUIRED: 'Bitte einen Sängernamen eingeben',
    DISPLAY_NAME_TAKEN: 'Dieser Guest-Name wird bereits verwendet',
    BROWSER_BLOCKED: 'Dieser Browser wurde vom DJ gesperrt',
    SESSION_BLOCKED: 'Diese Sitzung kann gerade keine Songs hinzufügen',
    QUEUE_LIMIT: 'Limit erreicht: {current} Songs, maximal {max}',
    DUPLICATE_SESSION_SONG: 'Du hast diesen Song bereits gewählt',
    DUPLICATE_VIDEO: 'Dieser Song ist bereits in der Warteschlange',
    SONG_NOT_KARAOKE: 'Nur Songs mit „karaoke“ im Titel können hinzugefügt werden',
    SONG_BLACKLISTED: 'Der Songtitel enthält ein gesperrtes Stichwort: {keyword}',
    SONG_INCOMPLETE: 'Songinformationen unvollständig',
    SONG_NOT_QUEUED: 'Dieser Song ist nicht in der Warteschlange',
    NOT_YOUR_SONG: 'Du kannst nur deine eigenen Songs ändern',
    STALE_PLAYBACK: 'Die Wiedergabeanfrage hat sich geändert',
    BAD_PASSWORD: 'Falsches DJ-Passwort',
    ADMIN_REQUIRED: 'DJ-Berechtigung erforderlich',
    GUEST_NOT_FOUND: 'Guest nicht gefunden oder bereits gegangen',
    BLOCKED_GUEST_NOT_FOUND: 'Sperrlisteneintrag nicht gefunden',
    INVALID_PUBLIC_URL: 'Die öffentliche URL muss eine gültige http://- oder https://-Adresse sein',
    EMPTY_BROADCAST: 'Die Durchsage darf nicht leer sein',
    BROADCAST_NOT_FOUND: 'Durchsage nicht gefunden',
    BAD_ANIMATION: 'Nicht unterstützte Animation',
    INVALID_IMPORTANT_ACTION: 'Ungültige Aktion für wichtige Durchsage',
    YOUTUBE_SEARCH_FAILED: 'YouTube-Suche fehlgeschlagen. API-Key und Kontingent prüfen.',
    NOT_FOUND: 'Schnittstelle nicht gefunden. Server muss eventuell neu gestartet oder aktualisiert werden.',
    SERVER_ERROR: 'Serverfehler'
  }
};

function serverErrorMessage(data) {
  if (!data) return '';
  if (!data.code) return data.error || '';
  const language = currentAdminLanguage();
  const templates = SERVER_ERROR_I18N[language] || SERVER_ERROR_I18N.en;
  const template = templates[data.code] || SERVER_ERROR_I18N.en[data.code];
  if (!template) return data.error || '';
  return template.replace(/\{(\w+)\}/g, (match, key) => (data.params?.[key] === undefined ? match : String(data.params[key])));
}

function localeText(key, fallback = '') { return commonI18n[currentAdminLanguage()]?.[key] || fallback; }
function setInterfaceDefaults(config = {}) { interfaceDefaults = { language: config.interfaceLanguage || config.settings?.interfaceLanguage || 'zh', theme: config.interfaceTheme || config.settings?.interfaceTheme || 'system' }; }
function currentAdminLanguage() { if (mode === 'join') return localStorage.getItem('karaoke_user_language') || interfaceDefaults.language; if (mode === 'display') return interfaceDefaults.language; return localStorage.getItem('karaoke_language') || interfaceDefaults.language; }
function currentThemePreference() { if (mode === 'join') return localStorage.getItem('karaoke_user_theme') || interfaceDefaults.theme; if (mode === 'display') return interfaceDefaults.theme; return localStorage.getItem('karaoke_theme') || interfaceDefaults.theme; }
function applyTheme(preference = currentThemePreference()) {
  const actual = preference === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'night' : 'day') : preference;
  document.documentElement.dataset.theme = actual;
}
function syncLiveInterfaceSettings(settings, state = null) {
  if (!settings) return;
  const languageChanged = settings.interfaceLanguage && settings.interfaceLanguage !== interfaceDefaults.language;
  const themeChanged = settings.interfaceTheme && settings.interfaceTheme !== interfaceDefaults.theme;
  setInterfaceDefaults(settings);
  if (mode === 'join') {
    if (joinConfig) { if (settings.roomName) joinConfig.roomName = settings.roomName; if (settings.maxQueuedSongsPerGuest) joinConfig.maxQueuedSongsPerGuest = settings.maxQueuedSongsPerGuest; if (settings.onlyKaraokeSongs !== undefined) joinConfig.onlyKaraokeSongs = Boolean(settings.onlyKaraokeSongs); }
    if (themeChanged && !localStorage.getItem('karaoke_user_theme')) applyTheme();
    if (languageChanged && !localStorage.getItem('karaoke_user_language')) applyLocale();
    const page = document.querySelector('.page:not(.compact)');
    const roomName = page?.querySelector('.hero h1');
    if (roomName && settings.roomName) roomName.textContent = settings.roomName;
    const quotaNote = document.getElementById('quota-note');
    if (quotaNote && settings.maxQueuedSongsPerGuest) quotaNote.dataset.max = settings.maxQueuedSongsPerGuest;
    if (languageChanged || (quotaNote && settings.maxQueuedSongsPerGuest) || settings.onlyKaraokeSongs !== undefined) applyJoinLanguage();
  } else if (mode === 'display') {
    displayQrRefresh?.(state?.publicBase || settings.publicUrl || '');
    if (themeChanged) applyTheme();
    if (languageChanged) applyDisplayLanguage();
  }
}
function applyAdminLanguage(language = currentAdminLanguage()) {
  const t = adminI18n[language] || adminI18n.zh;
  localStorage.setItem('karaoke_language', language);
  document.documentElement.lang = language === 'de' ? 'de' : language === 'en' ? 'en' : 'zh-CN';
  const login = document.querySelector('.login-card');
  if (login && !document.getElementById('admin-content')) {
    const copy = language === 'de' ? { eyebrow:'DJ KONSOLE', title:'Steuerzentrale', desc:'Wiedergabe, Warteschlange, Event-Einstellungen und Anzeige verwalten.', label:'DJ-Passwort', placeholder:'Passwort eingeben', submit:'Konsole öffnen →', helper:'Demo-Passwort: karaok-admin. Für den Einsatz bitte DJ_PASSWORD setzen.' } : language === 'en' ? { eyebrow:'DJ CONSOLE', title:'Control Desk', desc:'Manage playback, queue, event settings, and the display.', label:'DJ Password', placeholder:'Enter the DJ password', submit:'Open Console →', helper:'Demo password: karaok-admin. Set DJ_PASSWORD for real use.' } : { eyebrow:'DJ 控制台', title:'现场控制台', desc:'登录后管理播放状态、等待队列、活动设置和大屏。', label:'DJ 密码', placeholder:'输入现场密码', submit:'进入控制台 →', helper:'本地演示默认密码：karaok-admin。生产环境请通过 DJ_PASSWORD 设置。' };
    login.querySelector('.eyebrow').textContent = copy.eyebrow; login.querySelector('h1').textContent = copy.title; login.querySelector('p').textContent = copy.desc; login.querySelector('label').textContent = copy.label; login.querySelector('input').placeholder = copy.placeholder; login.querySelector('button').textContent = copy.submit; login.querySelector('.helper').textContent = copy.helper; return;
  }
  const hero = document.querySelector('.page.compact .hero');
  if (hero) { hero.querySelector('.eyebrow').textContent = language === 'de' ? 'DJ STEUERZENTRALE' : language === 'en' ? 'DJ CONTROL DESK' : 'DJ 控制台'; hero.querySelector('h1').textContent = t.title; hero.querySelector('p').textContent = t.intro; hero.querySelector('.btn.soft').textContent = t.display; document.getElementById('admin-logout').textContent = t.logout; }
  const statLabels = document.querySelectorAll('#admin-content .stat .label');
  [t.status, t.queue, t.users, t.volume].forEach((label, index) => { if (statLabels[index]) statLabels[index].textContent = label; });
  const statValues = document.querySelectorAll('#admin-content .stat .value');
  if (statValues[0]) { const status = statValues[0].textContent; statValues[0].textContent = status === '待机' ? (language === 'de' ? 'Standby' : language === 'en' ? 'Idle' : '待机') : status === '切歌中' ? (language === 'de' ? 'Übergang' : language === 'en' ? 'Transition' : '切歌中') : status === '已暂停' ? (language === 'de' ? 'Pausiert' : language === 'en' ? 'Paused' : '已暂停') : status === '播放中' ? (language === 'de' ? 'Läuft' : language === 'en' ? 'Playing' : '播放中') : status; }
  const headings = [...document.querySelectorAll('#admin-content .card h2')];
  [t.nowPlaying, t.queueTitle, t.normalBroadcast, t.importantBroadcast, t.settings, t.participants].forEach((label, index) => { if (headings[index]) headings[index].textContent = label; });
  const descriptions = [...document.querySelectorAll('#admin-content .card .section-head p')];
  [t.nowPlayingEmpty, t.queueDesc, t.normalBroadcastDesc, t.importantDesc, t.settingsDesc, t.participantsDesc].forEach((label, index) => { if (descriptions[index]) descriptions[index].textContent = label; });
  const adminCurrentPanel = document.querySelector('#admin-content .admin-layout > section > .card.panel');
  if (adminCurrentPanel && adminCurrentPanel.querySelector('.section-head .tag')?.textContent === 'IDLE') { const meta = adminCurrentPanel.querySelector('.section-head p'); const notice = adminCurrentPanel.querySelector('.notice'); if (meta) meta.textContent = t.nowPlayingEmpty; if (notice) notice.textContent = localeText('currentEmpty', '当前还没有播放歌曲，点歌后会自动开始。'); }
  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) { settingsForm.querySelectorAll('label')[0].textContent = t.settings === '活动设置' ? '活动名称' : language === 'de' ? 'Eventname' : language === 'en' ? 'Event Name' : '活动名称'; settingsForm.querySelectorAll('label')[1].textContent = language === 'de' ? 'Maximale wartende Songs pro Gast' : language === 'en' ? 'Max waiting songs per guest' : '每人最多等待歌曲'; const duplicateLabel = settingsForm.querySelector('input[name="allowDuplicatePerSession"]')?.parentElement; if (duplicateLabel) duplicateLabel.lastChild.textContent = language === 'de' ? ' Dieselbe Session darf denselben Song wiederholen' : language === 'en' ? ' Allow this session to repeat the same song' : ' 允许同一会话重复点同一首'; settingsForm.querySelector('button:not(#new-session)').textContent = t.save; }
  const newSessionButton = document.getElementById('new-session'); if (newSessionButton) newSessionButton.textContent = t.newSession;
  const publicUrlField = document.querySelector('#settings-form [data-role="public-url-field"]'); if (publicUrlField) { publicUrlField.querySelector('[data-role="public-url-label"]').textContent = t.publicUrl; publicUrlField.querySelector('input').placeholder = t.publicUrlPlaceholder; publicUrlField.querySelector('[data-role="public-url-hint"]').textContent = t.publicUrlHint; }
  const broadcastForm = document.getElementById('broadcast-form'); if (broadcastForm) { broadcastForm.querySelector('input').placeholder = language === 'de' ? 'z. B. Nächster Song von Lin' : language === 'en' ? 'e.g. Next song by Lin' : '例如：下一首由小林演唱'; broadcastForm.querySelector('button').textContent = extraText('add'); }
  // 重要广播时播放按钮是 disabled 的，但文案仍要跟语言走。
  // 以前这里用 `!disabled` 跳过更新，切到 en/de 后按钮会一直停在中文「重要广播中」。
  const playbackToggle = document.querySelector('.playback-toggle'); if (playbackToggle) playbackToggle.textContent = playbackToggle.dataset.action === '' ? t.importantOnAir : playbackToggle.dataset.action === 'resume' ? t.resume : t.pause;
  const importantToggle = document.querySelector('.important-control-card .important-toggle'); if (importantToggle) importantToggle.textContent = importantToggle.disabled ? t.importantCountdown : importantToggle.dataset.action === 'stop' ? t.importantStop : t.importantStart;
  document.querySelectorAll('.playback[data-action="skip"]').forEach(button => { if (!button.classList.contains('armed')) button.textContent = t.skip; });
  document.querySelectorAll('.playback[data-action="stop"]').forEach(button => { if (!button.classList.contains('armed')) button.textContent = t.stop; });
  document.querySelectorAll('.pin-action').forEach(button => {
    const pinned = button.dataset.action === 'unpin';
    button.textContent = pinned ? t.unpin : t.pin;
    // 只换文字，橙色高亮（pin-on）要跟着按钮的置顶状态保持一致
    button.classList.toggle('pin-on', pinned);
    button.classList.toggle('soft', !pinned);
  });
  document.querySelectorAll('.admin-remove').forEach(button => { button.textContent = t.remove; });
  const queueEmpty = document.querySelector('.queue-table .empty'); if (queueEmpty) queueEmpty.textContent = t.queueEmpty;
  const usersEmpty = document.querySelector('.participants-card .empty'); if (usersEmpty) usersEmpty.textContent = t.usersEmpty;
  document.querySelectorAll('.participants-card .user-row .tag').forEach(tag => { tag.textContent = t.online; });
  const manageBlocklistButton = document.getElementById('manage-blocklist'); if (manageBlocklistButton) manageBlocklistButton.textContent = t.manageBlocklist;
  document.querySelectorAll('.block-guest').forEach(button => { button.textContent = t.blockGuest; });
  const volumeLabel = document.querySelector('.volume .muted'); if (volumeLabel) volumeLabel.textContent = t.volume;
  const queueCount = document.querySelector('.queue-table')?.closest('.card')?.querySelector('.section-head .tag'); if (queueCount) { const number = queueCount.textContent.match(/\d+/)?.[0] || '0'; queueCount.textContent = `${number} ${t.songUnit}`; }
  const settingsButton = document.getElementById('interface-settings-button'); if (settingsButton) settingsButton.textContent = language === 'de' ? 'Einstellungen' : language === 'en' ? 'Settings' : '设置';
  const modal = document.getElementById('interface-settings-modal'); if (modal) { modal.querySelector('[data-role="settings-title"]').textContent = t.appearance; modal.querySelector('[data-role="settings-desc"]').textContent = t.appearanceDesc; modal.querySelector('[data-role="language-label"]').textContent = t.language; modal.querySelector('[data-role="theme-label"]').textContent = t.theme; modal.querySelector('[data-role="settings-close"]').textContent = language === 'de' ? 'Schließen' : language === 'en' ? 'Close' : '关闭'; const themeOptions = modal.querySelector('#admin-theme').options; themeOptions[0].textContent = language === 'de' ? 'System folgen' : language === 'en' ? 'Follow system' : '跟随系统'; themeOptions[1].textContent = language === 'de' ? 'Hell' : language === 'en' ? 'Light' : '白天'; themeOptions[2].textContent = language === 'de' ? 'Dunkel' : language === 'en' ? 'Dark' : '夜间'; const songFiltersLabel = modal.querySelector('[data-role="song-filters-label"]'); if (songFiltersLabel) songFiltersLabel.textContent = t.songFilters; const onlyKaraokeLabel = modal.querySelector('[data-role="only-karaoke-label"]'); if (onlyKaraokeLabel) onlyKaraokeLabel.textContent = t.onlyKaraoke; const onlyKaraokeHint = modal.querySelector('[data-role="only-karaoke-hint"]'); if (onlyKaraokeHint) onlyKaraokeHint.textContent = t.onlyKaraokeHint; const blacklistLabel = modal.querySelector('[data-role="blacklist-label"]'); if (blacklistLabel) blacklistLabel.textContent = t.blacklistKeywords; const blacklistInput = modal.querySelector('#admin-blacklist-keywords'); if (blacklistInput) blacklistInput.placeholder = t.blacklistPlaceholder; const blacklistHint = modal.querySelector('[data-role="blacklist-hint"]'); if (blacklistHint) blacklistHint.textContent = t.blacklistHint; const guestTimeoutLabel = modal.querySelector('[data-role="guest-timeout-label"]'); if (guestTimeoutLabel) guestTimeoutLabel.textContent = t.guestTimeout; const guestTimeoutHint = modal.querySelector('[data-role="guest-timeout-hint"]'); if (guestTimeoutHint) guestTimeoutHint.textContent = t.guestTimeoutHint; const timingLabel = modal.querySelector('[data-role="timing-label"]'); if (timingLabel) timingLabel.textContent = extraText('timing'); ['broadcastDuration', 'broadcastInterval', 'drinkDuration', 'drinkInterval'].forEach(key => { const node = modal.querySelector(`[data-role="timing-${key}"]`); if (node) node.textContent = extraText(key); }); }
}
function ensureAppearancePanel(token, state) {
  const topActions = document.querySelector('.topbar .top-actions');
  if (!topActions) return;
  let button = document.getElementById('interface-settings-button');
  if (!button) {
    button = document.createElement('button');
    button.id = 'interface-settings-button';
    button.className = 'btn ghost';
    button.textContent = '设置';
    topActions.appendChild(button);
  }
  let modal = document.getElementById('interface-settings-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'interface-settings-modal';
    modal.className = 'settings-modal-backdrop';
    modal.innerHTML = `<section class="settings-modal card"><div class="section-head"><div><h2 data-role="settings-title">界面设置</h2><p data-role="settings-desc">这里设置现场默认，用户可在自己的设备上单独覆盖</p></div><button class="btn ghost small" data-role="settings-close">关闭</button></div><div class="grid"><div class="field"><label data-role="language-label">语言</label><select class="select" id="admin-language"><option value="zh">中文</option><option value="en">English</option><option value="de">Deutsch</option></select></div><div class="field"><label data-role="theme-label">配色模式</label><select class="select" id="admin-theme"><option value="system">跟随系统</option><option value="day">白天</option><option value="night">夜间</option></select></div></div><div class="filter-block"><div class="eyebrow" data-role="song-filters-label">点歌过滤</div><label class="toggle-row"><input id="admin-only-karaoke" type="checkbox"><span><strong data-role="only-karaoke-label">仅允许 Karaoke 歌曲</strong><small data-role="only-karaoke-hint">视频标题必须包含 karaoke（不区分大小写）</small></span></label><div class="field"><label data-role="blacklist-label">黑名单关键字</label><textarea class="input" id="admin-blacklist-keywords" rows="2" placeholder="多个关键字用逗号或换行分隔"></textarea><p class="helper" data-role="blacklist-hint">标题命中任一关键字时禁止添加</p></div><div class="field"><label data-role="guest-timeout-label">Guest 超时（分钟）</label><input class="input" id="admin-guest-timeout" type="number" min="5" max="10080" step="1" value="60"><p class="helper" data-role="guest-timeout-hint">超过该时间没有点歌且没有排队歌曲时自动移除；有活动歌曲不会清理。</p></div></div><div class="timing-block"><div class="eyebrow" data-role="timing-label">Timing</div><div class="grid timing-grid"><div class="field"><label data-role="timing-broadcastDuration"></label><input class="input" id="admin-broadcast-duration" type="number" min="3" max="30" /></div><div class="field"><label data-role="timing-broadcastInterval"></label><input class="input" id="admin-broadcast-interval" type="number" min="0" max="60" /></div><div class="field"><label data-role="timing-drinkDuration"></label><input class="input" id="admin-drink-duration" type="number" min="3" max="120" /></div><div class="field"><label data-role="timing-drinkInterval"></label><input class="input" id="admin-drink-interval" type="number" min="0" max="60" /></div></div><p class="helper timing-warning" data-role="timing-warning" hidden></p></div></section>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { if (event.target === modal || event.target.closest('[data-role="settings-close"]')) modal.classList.remove('open'); });
    modal.querySelector('#admin-language').onchange = async event => { const value = event.target.value; localStorage.setItem('karaoke_language', value); applyAdminLanguage(value); try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({interfaceLanguage:value})}); interfaceDefaults.language = value; } catch (error) { toast(error.message); } toast(adminI18n[value].languageSaved); };
    modal.querySelector('#admin-theme').onchange = async event => { const value = event.target.value; localStorage.setItem('karaoke_theme', value); applyTheme(value); try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({interfaceTheme:value})}); interfaceDefaults.theme = value; } catch (error) { toast(error.message); } toast(adminI18n[currentAdminLanguage()].themeSaved); };
     modal.querySelector('#admin-only-karaoke').onchange = async event => { try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({onlyKaraokeSongs:event.target.checked})}); } catch (error) { event.target.checked = !event.target.checked; toast(error.message); } };
     modal.querySelector('#admin-blacklist-keywords').onchange = async event => { try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({blacklistKeywords:event.target.value})}); } catch (error) { toast(error.message); } };
     modal.querySelector('#admin-guest-timeout').onchange = async event => { const value = Math.min(10080, Math.max(5, Number(event.target.value) || 60)); event.target.value = value; try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({guestInactivityMinutes:value})}); } catch (error) { toast(error.message); } };
  }
  button.onclick = () => modal.classList.add('open');
  modal.querySelector('#admin-language').value = currentAdminLanguage();
  modal.querySelector('#admin-theme').value = currentThemePreference();
  const onlyKaraokeInput = modal.querySelector('#admin-only-karaoke');
  if (onlyKaraokeInput) onlyKaraokeInput.checked = Boolean(state?.settings?.onlyKaraokeSongs);
  const blacklistInput = modal.querySelector('#admin-blacklist-keywords');
  if (blacklistInput && document.activeElement !== blacklistInput) blacklistInput.value = Array.isArray(state?.settings?.blacklistKeywords) ? state.settings.blacklistKeywords.join('\n') : String(state?.settings?.blacklistKeywords || '');
  const guestTimeoutInput = modal.querySelector('#admin-guest-timeout');
  if (guestTimeoutInput && document.activeElement !== guestTimeoutInput) guestTimeoutInput.value = Number(state?.settings?.guestInactivityMinutes) || 60;
  const timingLabel = modal.querySelector('[data-role="timing-label"]');
  if (timingLabel) timingLabel.textContent = extraText('timing');
  const timingWarning = modal.querySelector('[data-role="timing-warning"]');
  const timingMissing = Boolean(state?.settings) && ['broadcastInterval', 'drinkDuration', 'drinkInterval'].some(key => state.settings[key] === undefined);
  if (timingWarning) {
    timingWarning.hidden = !timingMissing;
    timingWarning.textContent = timingMissing ? extraText('timingStale') : '';
  }
  const timingDefaults = { broadcastDuration: 8, broadcastInterval: 4, drinkDuration: 8, drinkInterval: 4 };
  const timingFields = [
    ['#admin-broadcast-duration', 'broadcastDuration', 3, 30],
    ['#admin-broadcast-interval', 'broadcastInterval', 0, 60],
    ['#admin-drink-duration', 'drinkDuration', 3, 120],
    ['#admin-drink-interval', 'drinkInterval', 0, 60]
  ];
  for (const [selector, key] of timingFields) {
    const input = modal.querySelector(selector);
    if (!input) continue;
    const label = modal.querySelector(`[data-role="timing-${key}"]`);
    if (label) label.textContent = extraText(key);
    if (document.activeElement !== input) {
      const numeric = Number(state?.settings?.[key]);
      input.value = Number.isFinite(numeric) ? numeric : timingDefaults[key];
    }
    input.onchange = async () => {
      // 一次提交四个值：即使服务端是旧版本/缺字段，也不会把其他项显示成 0。
      const payload = {};
      for (const [fieldSelector, fieldKey, fieldMin, fieldMax] of timingFields) {
        const field = modal.querySelector(fieldSelector);
        const raw = String(field?.value ?? '').trim();
        const numeric = raw === '' ? NaN : Number(raw);
        payload[fieldKey] = Math.min(fieldMax, Math.max(fieldMin, Number.isFinite(numeric) ? numeric : timingDefaults[fieldKey]));
        if (field) field.value = payload[fieldKey];
      }
      try { await api('/api/admin/settings', { method: 'PATCH', headers: { 'x-admin-token': token }, body: JSON.stringify(payload) }); }
      catch (error) { toast(error.message); }
    };
  }
}
function ensureUserAppearancePanel() {
  const topActions = document.querySelector('.topbar .top-actions');
  if (!topActions) return;
  let button = document.getElementById('user-interface-settings-button');
  if (!button) { button = document.createElement('button'); button.id = 'user-interface-settings-button'; button.className = 'btn ghost'; button.textContent = '设置'; topActions.appendChild(button); }
  let modal = document.getElementById('user-interface-settings-modal');
  if (!modal) {
    modal = document.createElement('div'); modal.id = 'user-interface-settings-modal'; modal.className = 'settings-modal-backdrop';
    modal.innerHTML = `<section class="settings-modal card"><div class="section-head"><div><h2 data-role="settings-title">界面设置</h2><p data-role="settings-desc">用户设置只保存在本浏览器</p></div><button class="btn ghost small" data-role="settings-close">关闭</button></div><div class="grid"><div class="field"><label data-role="language-label">语言</label><select class="select" id="user-language"><option value="zh">中文</option><option value="en">English</option><option value="de">Deutsch</option></select></div><div class="field"><label data-role="theme-label">配色模式</label><select class="select" id="user-theme"><option value="system">跟随系统</option><option value="day">白天</option><option value="night">夜间</option></select></div></div></section>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { if (event.target === modal || event.target.closest('[data-role="settings-close"]')) modal.classList.remove('open'); });
    modal.querySelector('#user-language').onchange = event => { const value = event.target.value; localStorage.setItem('karaoke_user_language', value); applyLocale(); toast(value === 'de' ? 'Sprache geändert' : value === 'en' ? 'Language changed' : '语言已切换'); };
    modal.querySelector('#user-theme').onchange = event => { const value = event.target.value; localStorage.setItem('karaoke_user_theme', value); applyTheme(value); toast(currentAdminLanguage() === 'de' ? 'Design geändert' : currentAdminLanguage() === 'en' ? 'Theme changed' : '配色已切换'); };
  }
  button.onclick = () => modal.classList.add('open');
  modal.querySelector('#user-language').value = currentAdminLanguage();
  modal.querySelector('#user-theme').value = currentThemePreference();
  applyJoinLanguage();
}

function applyJoinLanguage() {
  const t = commonI18n[currentAdminLanguage()];
  const settingsButton = document.getElementById('user-interface-settings-button');
  if (settingsButton) settingsButton.textContent = currentAdminLanguage() === 'de' ? 'Einstellungen' : currentAdminLanguage() === 'en' ? 'Settings' : '设置';
  const settingsModal = document.getElementById('user-interface-settings-modal');
  if (settingsModal) {
    settingsModal.querySelector('[data-role="settings-title"]').textContent = currentAdminLanguage() === 'de' ? 'Oberfläche' : currentAdminLanguage() === 'en' ? 'Interface Settings' : '界面设置';
    settingsModal.querySelector('[data-role="settings-desc"]').textContent = currentAdminLanguage() === 'de' ? 'Diese Einstellungen gelten nur für diesen Browser' : currentAdminLanguage() === 'en' ? 'These settings apply only to this browser' : '这些设置只作用于当前浏览器';
    settingsModal.querySelector('[data-role="language-label"]').textContent = currentAdminLanguage() === 'de' ? 'Sprache' : currentAdminLanguage() === 'en' ? 'Language' : '语言';
    settingsModal.querySelector('[data-role="theme-label"]').textContent = currentAdminLanguage() === 'de' ? 'Design' : currentAdminLanguage() === 'en' ? 'Theme' : '配色模式';
    settingsModal.querySelector('[data-role="settings-close"]').textContent = currentAdminLanguage() === 'de' ? 'Schließen' : currentAdminLanguage() === 'en' ? 'Close' : '关闭';
    const themeOptions = settingsModal.querySelector('#user-theme').options;
    themeOptions[0].textContent = currentAdminLanguage() === 'de' ? 'System folgen' : currentAdminLanguage() === 'en' ? 'Follow system' : '跟随系统';
    themeOptions[1].textContent = currentAdminLanguage() === 'de' ? 'Hell' : currentAdminLanguage() === 'en' ? 'Light' : '白天';
    themeOptions[2].textContent = currentAdminLanguage() === 'de' ? 'Dunkel' : currentAdminLanguage() === 'en' ? 'Dark' : '夜间';
  }
  const login = document.querySelector('.login-card');
  if (login) {
    login.querySelector('.eyebrow').textContent = t.joinEyebrow;
    login.querySelector('p').textContent = t.joinDesc;
    login.querySelector('label').textContent = t.nickname;
    login.querySelector('input').placeholder = t.nicknamePlaceholder;
    login.querySelector('button').textContent = t.joinRoom;
    login.querySelector('.helper').textContent = t.sessionTip;
  }
  const page = document.querySelector('.page:not(.compact)');
  if (!page) return;
  const hero = page.querySelector('.hero');
  if (hero) {
    hero.querySelector('.eyebrow').textContent = t.controller;
    const session = JSON.parse(localStorage.getItem('karaoke_session') || 'null');
    if (session?.session?.displayName) {
      hero.querySelector('p').textContent = `${currentAdminLanguage() === 'zh' ? '你好，' : currentAdminLanguage() === 'de' ? 'Hallo, ' : 'Hi, '}${session.session.displayName}。${currentAdminLanguage() === 'zh' ? '搜索一首想唱的歌，加入现场队列。' : currentAdminLanguage() === 'de' ? 'Suche einen Song und füge ihn hinzu.' : 'Search for a song and add it to the queue.'}`;
      let switchLine = hero.querySelector('.session-switch');
      if (!switchLine) {
        switchLine = document.createElement('div');
        switchLine.className = 'session-switch';
        switchLine.innerHTML = '<span data-role="not-you"></span> <strong data-role="session-name"></strong><span data-role="session-question">?</span> <button class="text-link" id="restart-session" type="button"></button>';
        hero.firstElementChild.appendChild(switchLine);
      }
      switchLine.querySelector('[data-role="not-you"]').textContent = t.notYou;
      switchLine.querySelector('[data-role="session-name"]').textContent = session.session.displayName;
      switchLine.querySelector('[data-role="session-question"]').textContent = currentAdminLanguage() === 'zh' ? '？' : '?';
      switchLine.querySelector('#restart-session').textContent = t.restartSession;
      switchLine.querySelector('#restart-session').onclick = () => { localStorage.removeItem('karaoke_session'); joinEvents?.close(); renderJoinLogin(joinConfig || {roomName: document.querySelector('.page:not(.compact) h1')?.textContent || ''}); };
    }
  }
  const changeName = document.getElementById('change-name'); if (changeName) changeName.textContent = t.changeName;
  const searchForm = document.getElementById('search-form');
  if (searchForm && !document.getElementById('karaoke-version')) { const option = document.createElement('label'); option.className = 'karaoke-option'; option.innerHTML = '<input id="karaoke-version" type="checkbox" checked><span></span>'; searchForm.insertAdjacentElement('afterend', option); }
  const karaokeInput = document.getElementById('karaoke-version');
  if (karaokeInput) { const onlyKaraoke = Boolean(joinConfig?.onlyKaraokeSongs); karaokeInput.disabled = onlyKaraoke; if (onlyKaraoke) karaokeInput.checked = true; }
  const karaokeOption = document.querySelector('.karaoke-option span'); if (karaokeOption) karaokeOption.textContent = t.karaokeSearch;
  const cards = page.querySelectorAll('.grid.two > .card');
  const searchCard = cards[0]; const queueCard = cards[1];
  if (searchCard) { searchCard.querySelector('h2').textContent = t.searchTitle; searchCard.querySelector('.section-head p').textContent = t.searchDesc; searchCard.querySelector('input').placeholder = t.searchPlaceholder; searchCard.querySelector('form button').textContent = t.search; const initial = searchCard.querySelector('#results .empty'); if (initial && !initial.textContent.includes('搜索中') && !initial.textContent.includes('Searching') && !initial.textContent.includes('Suche')) initial.textContent = t.searchStart; searchCard.querySelectorAll('.add-song').forEach(button => button.textContent = t.addSong); }
  if (queueCard) { const heads = queueCard.querySelectorAll('.section-head'); if (heads[0]) { const quotaNote = document.getElementById('quota-note'); const maxSongs = quotaNote?.dataset.max || quotaNote?.textContent.match(/\d+$/)?.[0] || '3'; heads[0].querySelector('h2').textContent = t.myQueue; heads[0].querySelector('p').textContent = `${t.quota} ${maxSongs} ${t.queueNumber}`; } if (heads[1]) { heads[1].querySelector('h2').textContent = t.publicQueue; heads[1].querySelector('p').textContent = t.publicDesc; } queueCard.querySelectorAll('.remove-own').forEach(button => button.textContent = t.remove); }
  document.querySelectorAll('#public-queue .remove-own, #own-queue .remove-own').forEach(button => button.textContent = t.remove);
}
function updateFullscreenButton(button) {
  if (!button) return;
  const fullscreen = Boolean(document.fullscreenElement);
  const label = localeText(fullscreen ? 'exitFullscreen' : 'fullscreen', fullscreen ? '退出全屏' : '全屏');
  button.innerHTML = fullscreen
    ? '<svg class="fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3H3v6M3 3l7 7M15 21h6v-6M21 21l-7-7"></path></svg>'
    : '<svg class="fullscreen-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M3 3l6 6M16 3h5v5M21 3l-6 6M8 21H3v-5M3 21l6-6M16 21h5v-5M21 21l-6-6"></path></svg>';
  button.setAttribute('aria-label', label);
  button.title = label;
}
function ensureDisplayCurrentRow() {
  const queue = document.getElementById('display-queue');
  if (!queue || !displayCurrentSong || queue.querySelector('.queue-current')) return;
  const current = displayCurrentSong;
  const row = document.createElement('div');
  row.className = 'display-song queue-current';
  row.innerHTML = `<div class="number current-rank" aria-label="${esc(localeText('playing', '播放中'))}">▶</div><div class="copy"><div class="title">${esc(current.title)}</div><div class="meta">${esc(current.singerName)} · ${esc(current.channelTitle)} · ${localeText('playing', '播放中')}</div></div>`;
  queue.prepend(row);
}
function applyDisplayLanguage() {
  const t = commonI18n[currentAdminLanguage()];
  const live = document.querySelector('.live-dot'); if (live) live.innerHTML = `<i></i> ${currentAdminLanguage() === 'de' ? 'LIVE-RAUM' : currentAdminLanguage() === 'en' ? 'LIVE ROOM' : '现场直播'}`;
  const side = document.querySelector('.display-side');
  if (side) { side.querySelector('.eyebrow').textContent = t.scan; side.querySelector('h1').textContent = t.joinDisplay; side.querySelector('p').textContent = t.scanDesc; side.querySelector('.side-title').innerHTML = `${t.upNext} · <span id="queue-count">${document.getElementById('queue-count')?.textContent || 0}</span>`; const footer = side.querySelector('.display-footer'); const footerCopy = footer?.querySelector('[data-role="display-footer-copy"]'); if (footerCopy) footerCopy.textContent = t.displayFooter; updateFullscreenButton(footer?.querySelector('#display-fullscreen')); }
  const banner = document.getElementById('display-broadcast'); if (banner) { banner.querySelector('strong').textContent = currentAdminLanguage() === 'zh' ? '现场消息' : currentAdminLanguage() === 'de' ? 'LIVE-MELDUNG' : 'LIVE MESSAGE'; if (!banner.querySelector('span').textContent || banner.querySelector('span').textContent.includes('欢迎') || banner.querySelector('span').textContent.includes('Welcome') || banner.querySelector('span').textContent.includes('Willkommen')) banner.querySelector('span').textContent = t.welcome; }
  const idle = document.querySelector('.display-idle'); if (idle) { const eyebrow = idle.querySelector('.eyebrow'); const bigNote = idle.querySelector('.big-note'); const copy = idle.querySelector('p'); if (eyebrow) eyebrow.textContent = t.ready; if (bigNote) bigNote.textContent = t.idleTitle; if (copy) copy.textContent = t.idleDesc; }
  ensureDisplayCurrentRow();
}
function applyLocale() {
  if (mode === 'admin') applyAdminLanguage();
  if (mode === 'join') applyJoinLanguage();
  if (mode === 'display') applyDisplayLanguage();
}

async function initJoin() {
  const session = JSON.parse(localStorage.getItem('karaoke_session') || 'null');
  const config = await api('/api/config');
  joinConfig = config;
  setInterfaceDefaults(config);
  applyTheme();
  if (!session) return renderJoinLogin(config);
  try {
    const current = await api('/api/my-queue', { headers:{'x-session-token':session.token} });
    session.session = current.session;
    localStorage.setItem('karaoke_session', JSON.stringify(session));
    renderJoinApp(config, session);
  } catch {
    localStorage.removeItem('karaoke_session');
    renderJoinLogin(config);
  }
}
function renderJoinLogin(config) {
  joinConfig = config;
  renderShell(`<main class="login-wrap"><section class="card login-card"><div class="eyebrow">JOIN THE ROOM</div><h1>${esc(config.roomName)}</h1><p>扫描大屏二维码后，在这里输入你的昵称。无需注册，浏览器会记住本次点歌会话。</p><form id="join-form"><div class="field"><label>演唱者昵称</label><input class="input" name="displayName" maxlength="24" placeholder="例如：小林" autofocus required /></div><button class="btn primary" type="submit">进入点歌台 →</button><div class="helper">你的昵称可以重复，但歌曲归属由临时会话识别。</div></form></section></main>`);
  joinEvents?.close();
  joinEvents = connectEvents(state => { syncLiveInterfaceSettings(state.settings); const title = document.querySelector('.login-card h1'); if (title && state.settings?.roomName) title.textContent = state.settings.roomName; });
  document.getElementById('join-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { const data = await api('/api/sessions', { method:'POST', body:JSON.stringify({ displayName:event.target.displayName.value }) }); localStorage.setItem('karaoke_session', JSON.stringify(data)); renderJoinApp(config, data); }
    catch (error) { toast(error.message); }
  });
}
function renderJoinApp(config, session) {
  renderShell(`<main class="page"><div class="hero"><div><div class="eyebrow">GUEST CONTROLLER</div><h1>${esc(config.roomName)}</h1><p>你好，${esc(session.session.displayName)}。搜索一首想唱的歌，加入现场队列。</p></div><button class="btn ghost" id="change-name">更换昵称</button></div><div id="now-playing" class="notice" style="margin-bottom:18px">当前还没有播放歌曲，点歌后会自动开始。</div><div class="grid two"><section class="card panel"><div class="section-head"><div><h2>搜索 YouTube</h2><p>支持搜索歌名，也可以直接粘贴 YouTube 链接。</p></div></div><form class="search-row" id="search-form"><input class="input" name="q" placeholder="搜索歌名，或粘贴 YouTube 链接" /><button class="btn primary">搜索</button></form><div id="results" class="results"><div class="empty">输入关键词或粘贴链接开始</div></div></section><section class="card panel"><div class="section-head"><div><h2>我的等待队列</h2><p id="quota-note" data-max="${config.maxQueuedSongsPerGuest}">每人最多 ${config.maxQueuedSongsPerGuest} 首</p></div><span class="tag" id="live-status">同步中</span></div><div id="own-queue" class="list"></div><div class="section-head" style="margin-top:25px"><div><h2>公开后续队列</h2><p>所有参与者看到的播放顺序</p></div></div><div id="public-queue" class="list"></div></section></div></main>`);
  document.getElementById('change-name').onclick = async () => { const displayName = prompt(localeText('namePrompt', '请输入新的演唱者昵称'), session.session.displayName); if (!displayName || displayName.trim() === session.session.displayName) return; try { const data = await api('/api/sessions', { method:'PATCH', headers:{'x-session-token':session.token}, body:JSON.stringify({displayName}) }); session.session = data.session; localStorage.setItem('karaoke_session', JSON.stringify(session)); renderJoinApp(config, session); toast(localeText('nameChanged', '昵称已更新，歌曲归属不变')); } catch (error) { toast(error.message); } };
   document.getElementById('search-form').addEventListener('submit', async event => { event.preventDefault(); const rawQuery = event.target.q.value.trim(); if (!rawQuery) return; const result = document.getElementById('results'); result.innerHTML = `<div class="empty">${localeText('searching', '搜索中…')}</div>`; try { const items = await searchSongs(rawQuery); result.innerHTML = items.length ? items.map((item, index) => renderResult(item, index)).join('') : `<div class="empty">${localeText('noResults', '没有找到匹配歌曲')}</div>`; result.querySelectorAll('.add-song').forEach(button => button.onclick = () => addSong(items[Number(button.dataset.index)], session)); applyJoinLanguage(); } catch (error) { result.innerHTML = `<div class="notice">${esc(error.message)}</div>`; } });
  joinEvents?.close();
  joinEvents = connectEvents(state => { updateJoinState(state, session); });
  api('/api/state').then(state => updateJoinState(state, session));
  
}
async function addSong(song, session) {
  if (song && song.embeddable === false) { toast(localeText('notEmbeddable', '这个视频不允许嵌入播放，请换一个')); return; }
  try {
    const data = await api('/api/queue', { method:'POST', headers:{ 'x-session-token':session.token }, body:JSON.stringify(song) });
    updateJoinState(data.state, session);
    toast(localeText('added', '已加入等待队列'));
  } catch (error) {
    toast(error.message === '你已经点过这首歌' ? localeText('duplicateSong', error.message) : error.message);
  }
}

/**
 * 取搜索结果：本工程是模式 A（YouTube 在线），只走 YouTube Data API。
 */
async function searchSongs(rawQuery) {
  const isYoutubeUrl = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(rawQuery);
  const q = document.getElementById('karaoke-version')?.checked && !isYoutubeUrl ? `${rawQuery} karaoke` : rawQuery;
  const data = await api(`/api/youtube/search?q=${encodeURIComponent(q)}`);
  const items = joinConfig?.onlyKaraokeSongs ? data.items.filter((item) => /karaoke/i.test(item.title || '')) : data.items;
  return items.map((item) => ({ ...item, source: 'youtube' }));
}

function renderResult(item, index) {
  const title = `<a class="result-title" href="https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`;
  return `<article class="result"><img src="${esc(item.thumbnailUrl)}" alt=""><div class="result-copy">${title}<div class="result-meta">${esc(item.channelTitle)} · ${esc(item.duration)}</div></div><button class="btn teal small add-song" data-index="${index}">${localeText('addSong', '点歌')}</button></article>`;
}
function checkServerVersion(state) {
  if (serverVersionWarned || !state) return;
  if (state.apiVersion === undefined || Number(state.apiVersion) < REQUIRED_API_VERSION) {
    serverVersionWarned = true;
    toast(localeText('serverOutdated', '服务端版本过旧，请关闭控制台重新打开后再试'));
  }
}
function updateJoinState(state, session) {
  checkServerVersion(state);
  const ownEl = document.getElementById('own-queue'); const publicEl = document.getElementById('public-queue'); if (!ownEl || !publicEl) return;
  syncLiveInterfaceSettings(state.settings);
  document.getElementById('live-status').textContent = state.playback.status === 'idle' ? localeText('waiting', '等待播放') : localeText('realtime', '实时同步');
  const nowPlaying = document.getElementById('now-playing'); if (nowPlaying) nowPlaying.innerHTML = state.current ? `<strong>${localeText('currentPlaying', '正在播放：')}</strong> ${esc(state.current.title)} <span class="muted">· ${esc(state.current.singerName)} · ${state.playback.status === 'paused' ? localeText('paused', '已暂停') : state.playback.status === 'transition' ? localeText('preparing', '准备播放') : localeText('playing', '播放中')}</span>` : localeText('currentEmpty', '当前还没有播放歌曲，点歌后会自动开始。');
  const row = song => `<div class="song-row"><div class="song-rank">${song.queuePosition + 1}</div><img class="song-thumb" src="${esc(song.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(song.title)}</div><div class="song-meta">${esc(song.singerName)} · ${esc(song.channelTitle)}</div></div>${song.singerName === session.session.displayName ? `<button class="btn danger small remove-own" data-id="${song.id}">${localeText('remove', '删除')}</button>` : ''}</div>`;
  const currentRow = state.current ? `<div class="song-row queue-current"><div class="song-rank current-rank" aria-label="${esc(localeText('playing', '播放中'))}">▶</div><img class="song-thumb" src="${esc(state.current.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(state.current.title)}</div><div class="song-meta">${esc(state.current.singerName)} · ${esc(state.current.channelTitle)} · ${localeText('playing', '播放中')}</div></div></div>` : '';
  publicEl.innerHTML = currentRow + (state.queue.length ? state.queue.map(row).join('') : `<div class="empty">${localeText('queueEmpty', '队列为空，来唱第一首吧')}</div>`);
  refreshOwnQueue(session, state.current);
}
async function refreshOwnQueue(session, current = null) {
  const ownEl = document.getElementById('own-queue'); if (!ownEl) return;
  try {
    const data = await api('/api/my-queue', { headers:{'x-session-token':session.token} });
    const quotaNote = document.getElementById('quota-note'); const maxSongs = quotaNote.dataset.max || quotaNote.textContent.match(/\d+$/)?.[0] || '—'; quotaNote.dataset.max = maxSongs; quotaNote.textContent = localeText('quotaStatus', '{n} songs · max {max} per guest').replace('{n}', data.songs.length).replace('{max}', maxSongs);
    const row = (song, index) => `<div class="song-row"><div class="song-rank">${song.queuePosition + 1}</div><img class="song-thumb" src="${esc(song.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(song.title)}</div><div class="song-meta">${esc(song.singerName)} · ${esc(song.channelTitle)}</div></div><div class="own-actions">${data.songs.length > 1 ? `<button class="btn ghost small move-own" data-id="${song.id}" data-dir="-1" ${index === 0 ? 'disabled' : ''} aria-label="${esc(localeText('moveUp', '上移'))}">↑</button><button class="btn ghost small move-own" data-id="${song.id}" data-dir="1" ${index === data.songs.length - 1 ? 'disabled' : ''} aria-label="${esc(localeText('moveDown', '下移'))}">↓</button>` : ''}<button class="btn danger small remove-own" data-id="${song.id}">${localeText('remove', '删除')}</button></div></div>`;
    const currentRow = current && current.singerName === session.session.displayName ? `<div class="song-row queue-current"><div class="song-rank current-rank" aria-label="${esc(localeText('playing', '播放中'))}">▶</div><img class="song-thumb" src="${esc(current.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(current.title)}</div><div class="song-meta">${esc(current.singerName)} · ${esc(current.channelTitle)} · ${localeText('playing', '播放中')}</div></div></div>` : '';
    ownEl.innerHTML = currentRow + (data.songs.length ? data.songs.map((song, index) => row(song, index)).join('') : `<div class="empty">${localeText('noSongs', '你还没有点歌')}</div>`);
    ownEl.querySelectorAll('.remove-own').forEach(button => button.onclick = async () => { try { await api(`/api/queue/${button.dataset.id}`, { method:'DELETE', headers:{'x-session-token':session.token} }); toast(localeText('removed', '已从队列移除')); } catch (error) { toast(error.message); } });
    ownEl.querySelectorAll('.move-own').forEach(button => button.onclick = async () => {
      const index = data.songs.findIndex(song => song.id === button.dataset.id);
      const target = data.songs[index + Number(button.dataset.dir)];
      if (!target) return;
      try { await api('/api/queue/order', { method: 'PATCH', headers: { 'x-session-token': session.token }, body: JSON.stringify({ firstId: button.dataset.id, secondId: target.id }) }); }
      catch (error) { toast(error.status === 404 ? localeText('serverOutdated', '服务端版本过旧，请关闭控制台重新打开后再试') : error.message); }
    });
    applyJoinLanguage();
  } catch (error) { if (error.status === 401) { localStorage.removeItem('karaoke_session'); initJoin(); } }
}

async function initAdmin() {
  const token = localStorage.getItem('karaoke_admin_token');
  try { const config = await api('/api/config'); setInterfaceDefaults(config); applyTheme(); } catch {}
  if (!token) return renderAdminLogin();
  try { const data = await api('/api/admin/state', { headers:{ 'x-admin-token':token } }); renderAdminApp(token, data); } catch { localStorage.removeItem('karaoke_admin_token'); renderAdminLogin(); }
}
function renderAdminLogin() {
  renderShell(`<main class="login-wrap"><section class="card login-card"><div class="eyebrow">DJ CONSOLE</div><h1>现场控制台</h1><p>登录后管理播放状态、等待队列、活动参数和大屏广播。</p><form id="admin-form"><div class="field"><label>DJ 密码</label><input class="input" name="password" type="password" placeholder="输入现场密码" autofocus required /></div><button class="btn primary">进入控制台 →</button><div class="helper">本地演示默认密码：karaok-admin。生产环境请通过 DJ_PASSWORD 环境变量设置。</div></form></section></main>`);
  document.getElementById('admin-form').addEventListener('submit', async event => { event.preventDefault(); try { const data = await api('/api/admin/auth', { method:'POST', body:JSON.stringify({password:event.target.password.value}) }); localStorage.setItem('karaoke_admin_token', data.token); renderAdminApp(data.token, data.state); } catch (error) { toast(error.message); } });
  applyAdminLanguage(currentAdminLanguage());
}
function renderAdminApp(token, initial) {
  setInterfaceDefaults(initial.settings);
  applyTheme();
  renderShell(`<main class="page compact"><div class="hero"><div><div class="eyebrow">DJ CONTROL DESK</div><h1>现场控制台</h1><p>一处管理播放、队列、参与者和现场信息。所有变更会实时同步到大屏与手机。</p></div><div class="top-actions"><a class="btn soft" href="${displayHref()}" target="_blank">打开大屏 ↗</a><button class="btn ghost" id="admin-logout">退出</button></div></div><div id="admin-content"></div></main>`);
  document.getElementById('admin-logout').onclick = () => { localStorage.removeItem('karaoke_admin_token'); initAdmin(); };
  const render = state => { const adminCopy = adminI18n[currentAdminLanguage()] || adminI18n.zh; const current = state.current; document.getElementById('admin-content').innerHTML = `<div class="stat-row"><div class="card stat"><div class="label">当前状态</div><div class="value">${state.playback.status === 'idle' ? '待机' : state.playback.status === 'transition' ? '切歌中' : state.playback.status === 'paused' ? '已暂停' : '播放中'}</div></div><div class="card stat"><div class="label">等待歌曲</div><div class="value">${state.queue.length}</div></div><div class="card stat"><div class="label">在线会话</div><div class="value">${state.users.length}</div></div><div class="card stat"><div class="label">当前音量</div><div class="value">${state.playback.volume}%</div></div></div><div class="admin-layout"><section class="grid"><div class="card panel"><div class="section-head"><div><h2>正在播放</h2><p>${current ? esc(nowPlayingMeta(current)) : '队列为空时大屏显示待机画面'}</p></div><span class="tag ${current ? 'pin' : ''}">${current ? esc(current.duration) : 'IDLE'}</span></div><div class="notice" style="margin-bottom:17px">${current ? `<strong>${esc(current.title)}</strong><br><span class="muted">Video ID: ${esc(current.videoId)}</span>` : '还没有当前歌曲。手机点歌后，队列会自动开始。'}</div><div class="control-strip"><button class="btn primary playback" data-action="pause">暂停</button><button class="btn soft playback" data-action="resume">恢复</button><button class="btn ghost playback" data-action="skip">切歌</button><button class="btn danger playback" data-action="stop">停止</button><div class="volume"><span class="muted">音量</span><input id="volume" type="range" min="0" max="100" value="${state.playback.volume}"><b>${state.playback.volume}%</b></div></div></div><div class="card panel"><div class="section-head"><div><h2>等待队列</h2><p>置顶歌曲优先；可直接调整、删除和切换优先级。</p></div><span class="tag">${state.queue.length} ${adminCopy.songUnit}</span></div><div class="queue-table">${state.queue.length ? state.queue.map((song, index) => `<div class="queue-item${song.isPinned ? ' is-pinned' : ''}" data-id="${song.id}"><div class="drag">⠿</div><div class="song-rank">${index + 1}</div><img class="song-thumb" src="${esc(song.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(song.title)}</div><div class="song-meta">${esc(song.singerName)} · ${esc(song.channelTitle)} · ${timeAgo(song.createdAt)}</div></div><div class="queue-actions"><button class="btn small ${song.isPinned ? 'pin-on' : 'soft'} pin-action" data-id="${song.id}" data-action="${song.isPinned ? 'unpin' : 'pin'}">${esc(song.isPinned ? adminLabel('unpin') : adminLabel('pin'))}</button><button class="btn small danger admin-remove" data-id="${song.id}">${esc(adminLabel('remove'))}</button></div></div>`).join('') : '<div class="empty">等待参与者点歌</div>'}</div></div></section><aside class="grid"><div class="card panel"><div class="section-head"><div><h2>现场广播</h2><p>普通广播显示在播放器之外；重要广播会暂停播放并覆盖大屏。</p></div></div><form class="broadcast" id="broadcast-form"><input class="input" name="message" maxlength="120" placeholder="例如：下一首由小林演唱" /><button class="btn teal">发送</button></form><label class="helper important-choice"><input name="important" type="checkbox"> 重要广播：暂停播放并覆盖大屏</label>${state.importantBroadcast ? `<div class="important-state"><span class="tag pin">${state.importantBroadcast.status === 'countdown' ? '恢复倒计时中' : 'DJ 广播中'}</span><button class="btn small danger" id="stop-important">停止重要广播</button></div>` : ''}</div><div class="card panel"><div class="section-head"><div><h2>活动设置</h2><p>变更会立即作用于新请求</p></div></div><form id="settings-form" class="grid"><div class="field"><label>活动名称</label><input class="input" name="roomName" value="${esc(state.settings.roomName)}" /></div><div class="field"><label>每人最多等待歌曲</label><input class="input" name="maxQueuedSongsPerGuest" type="number" min="1" max="10" value="${state.settings.maxQueuedSongsPerGuest}" /></div><label class="helper"><input name="allowDuplicatePerSession" type="checkbox" ${state.settings.allowDuplicatePerSession ? 'checked' : ''}> 允许同一会话重复点同一首</label><button class="btn primary">保存设置</button></form></div><div class="card panel"><div class="section-head"><div><h2>参与者</h2><p>按临时会话识别点歌归属</p></div></div>${state.users.length ? state.users.map(user => `<div class="user-row"><div class="avatar">${esc(user.displayName.slice(0,1))}</div><div class="user-copy"><div class="user-name">${esc(user.displayName)}</div><div class="user-meta">${currentAdminLanguage() === 'de' ? 'Warten' : currentAdminLanguage() === 'en' ? 'Waiting' : '等待'} ${user.songCount} ${adminCopy.songUnit} · ${timeAgo(user.lastSeenAt)}</div></div><span class="tag">${adminCopy.online}</span></div>`).join('') : `<div class="empty">${adminCopy.usersEmpty}</div>`}</div></aside></div>`; linkAdminQueueTitles(document.getElementById('admin-content'), state.queue, current); bindAdminEvents(token, state); };
  // 队列行每次刷新都会整体重建 innerHTML，逐按钮绑定容易在重建后丢失。
  // 在 #admin-content 上做一次事件委托，重建多少次都不会失效。
  const adminContent = document.getElementById('admin-content');
  if (adminContent && !adminContent.dataset.queueDelegated) {
    adminContent.dataset.queueDelegated = '1';
    adminContent.addEventListener('click', async event => {
      const pinButton = event.target.closest?.('.pin-action');
      const removeButton = pinButton ? null : event.target.closest?.('.admin-remove');
      try {
        if (pinButton) {
          await api(`/api/admin/queue/${pinButton.dataset.id}`, { method: 'PATCH', headers: { 'x-admin-token': token }, body: JSON.stringify({ action: pinButton.dataset.action }) });
          return;
        }
        if (removeButton && confirm(adminLabel('confirmRemove'))) {
          await api(`/api/admin/queue/${removeButton.dataset.id}`, { method: 'DELETE', headers: { 'x-admin-token': token } });
        }
      } catch (error) { toast(error.message); }
    });
  }
  render(initial); connectEvents(() => { api('/api/admin/state', {headers:{'x-admin-token':token}}).then(freshState => updateAdminContent(token, freshState)).catch(error => { if (error.status === 401) { localStorage.removeItem('karaoke_admin_token'); initAdmin(); } }); });
}
function renderAdminCurrent(current) {
  if (!current) return '';
  return `<div class="queue-item queue-current"><div class="drag"></div><div class="song-rank current-rank" aria-label="${esc(localeText('playing', '播放中'))}">▶</div><img class="song-thumb" src="${esc(current.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(current.title)}</div><div class="song-meta">${esc(current.singerName)} · ${esc(current.channelTitle)} · ${localeText('playing', '播放中')}</div></div><div class="queue-actions queue-actions-placeholder" aria-hidden="true"><button class="btn small soft" tabindex="-1">${esc(adminLabel('pin'))}</button><button class="btn small danger" tabindex="-1">${esc(adminLabel('remove'))}</button></div></div>`;
}
function renderAdminQueue(songs, current = null) {
  const currentRow = renderAdminCurrent(current);
  // 置顶状态只由按钮自身表达（文字 + 橙色高亮），不再额外挂「置顶」徽章，
  // 否则按钮写着"取消置顶"、旁边又挂一个"置顶"，自相矛盾。
  const queuedRows = songs.length ? songs.map((song, index) => `<div class="queue-item${song.isPinned ? ' is-pinned' : ''}" data-id="${song.id}"><div class="drag">⠿</div><div class="song-rank">${index + 1}</div><img class="song-thumb" src="${esc(song.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(song.title)}</div><div class="song-meta">${esc(song.singerName)} · ${esc(song.channelTitle)} · ${timeAgo(song.createdAt)}</div></div><div class="queue-actions"><button class="btn small ${song.isPinned ? 'pin-on' : 'soft'} pin-action" data-id="${song.id}" data-action="${song.isPinned ? 'unpin' : 'pin'}">${esc(song.isPinned ? adminLabel('unpin') : adminLabel('pin'))}</button><button class="btn small danger admin-remove" data-id="${song.id}">${esc(adminLabel('remove'))}</button></div></div>`).join('') : `<div class="empty">${esc(adminLabel('queueEmpty'))}</div>`;
  return currentRow + queuedRows;
}
function linkAdminQueueTitles(container, songs, current) {
  container?.querySelectorAll('.queue-item .song-title').forEach(title => {
    if (title.tagName === 'A') return;
    const row = title.closest('.queue-item');
    const song = row?.classList.contains('queue-current') ? current : songs.find(item => item.id === row?.dataset.id);
    if (!song?.videoId) return;
    const link = document.createElement('a');
    link.className = `${title.className} is-link`;
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(song.videoId)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = title.textContent;
    title.replaceWith(link);
  });
}
function renderAdminUsers(users) {
  const unit = adminI18n[currentAdminLanguage()]?.songUnit || '首';
  const waiting = currentAdminLanguage() === 'de' ? 'Warten' : currentAdminLanguage() === 'en' ? 'Waiting' : '等待';
  return users.length ? users.map(user => `<div class="user-row" data-user-id="${esc(user.id)}"><div class="avatar">${esc(user.displayName.slice(0,1))}</div><div class="user-copy"><div class="user-name">${esc(user.displayName)}</div><div class="user-meta">${waiting} ${user.songCount} ${unit} · ${timeAgo(user.lastSeenAt)}</div></div><span class="tag">${adminI18n[currentAdminLanguage()]?.online || '在线活动'}</span><button class="btn small danger block-guest" data-session-id="${esc(user.id)}">${adminI18n[currentAdminLanguage()]?.blockGuest || '拉黑'}</button></div>`).join('') : `<div class="empty">${adminI18n[currentAdminLanguage()]?.usersEmpty || '还没有参与者'}</div>`;
}

function ensureGuestManagementPanel(token, state) {
  const participantsCard = [...document.querySelectorAll('#admin-content .card.panel')].find(card => card.classList.contains('participants-card') || card.querySelector('.section-head h2')?.textContent === '参与者' || card.querySelector('.user-row'));
  if (!participantsCard) return;
  participantsCard.classList.add('participants-card');
  const heading = participantsCard.querySelector('.section-head');
  if (heading && !heading.querySelector('#manage-blocklist')) {
    const button = document.createElement('button');
    button.id = 'manage-blocklist';
    button.type = 'button';
    button.className = 'btn ghost small';
    heading.append(button);
  }
  const rows = participantsCard.querySelectorAll('.user-row');
  state.users.forEach((user, index) => {
    const row = rows[index];
    if (!row) return;
    row.dataset.userId = user.id;
    let button = row.querySelector('.block-guest');
    if (!button) {
      button = document.createElement('button');
      button.className = 'btn small danger block-guest';
      row.append(button);
    }
    button.dataset.sessionId = user.id;
    button.textContent = adminLabel('blockGuest');
  });
  let modal = document.getElementById('guest-blocklist-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'guest-blocklist-modal';
    modal.className = 'settings-modal-backdrop';
    modal.innerHTML = `<section class="settings-modal card blocklist-modal"><div class="section-head"><div><h2 data-role="blocklist-title"></h2><p data-role="blocklist-desc"></p></div><button class="btn ghost small" data-role="blocklist-close">关闭</button></div><div id="blocked-guests-list" class="blocked-guests-list"></div></section>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { if (event.target === modal || event.target.closest('[data-role="blocklist-close"]')) modal.classList.remove('open'); });
  }
  const manageButton = document.getElementById('manage-blocklist');
  if (manageButton) manageButton.onclick = () => modal.classList.add('open');
  modal.querySelector('[data-role="blocklist-title"]').textContent = adminLabel('blocklistTitle');
  modal.querySelector('[data-role="blocklist-desc"]').textContent = adminLabel('manageBlocklist');
  modal.querySelector('[data-role="blocklist-close"]').textContent = currentAdminLanguage() === 'de' ? 'Schließen' : currentAdminLanguage() === 'en' ? 'Close' : '关闭';
  const list = modal.querySelector('#blocked-guests-list');
  const blocked = Array.isArray(state.blockedGuests) ? state.blockedGuests : [];
  list.innerHTML = blocked.length ? blocked.map(item => `<div class="blocked-guest-row"><div><strong>${esc(item.displayName)}</strong><small>${timeAgo(item.blockedAt)}${item.browserLocked ? ` · ${adminLabel('browserLocked')}` : ''}</small></div><button class="btn small soft unblock-guest" data-id="${esc(item.id)}">${adminLabel('unblock')}</button></div>`).join('') : `<div class="empty">${adminLabel('blocklistEmpty')}</div>`;
  list.querySelectorAll('.unblock-guest').forEach(button => button.onclick = async () => {
    try { const next = await api(`/api/admin/guests/blocked/${encodeURIComponent(button.dataset.id)}`, { method:'DELETE', headers:{'x-admin-token':token} }); updateAdminContent(token, next); }
    catch (error) { toast(error.message); }
  });
  participantsCard.querySelectorAll('.block-guest').forEach(button => button.onclick = async () => {
    if (!confirm(adminLabel('blockGuestConfirm'))) return;
    try { const next = await api('/api/admin/guests/block', { method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({sessionId:button.dataset.sessionId}) }); updateAdminContent(token, next); }
    catch (error) { toast(error.message); }
  });
}

function updateAdminContent(token, state) {
  checkServerVersion(state);
  const content = document.getElementById('admin-content');
  if (!content) return;
  const statValues = content.querySelectorAll('.stat .value');
  if (statValues[0]) statValues[0].textContent = state.playback.status === 'idle' ? '待机' : state.playback.status === 'transition' ? '切歌中' : state.playback.status === 'paused' ? '已暂停' : '播放中';
  if (statValues[1]) statValues[1].textContent = state.queue.length;
  if (statValues[2]) statValues[2].textContent = state.users.length;
  if (statValues[3]) statValues[3].textContent = `${state.playback.volume}%`;
  const currentPanel = content.querySelector('.admin-layout > section > .card.panel');
  if (currentPanel) {
    const current = state.current;
    const currentMeta = currentPanel.querySelector('.section-head p');
    const currentTag = currentPanel.querySelector('.section-head .tag');
    const currentNotice = currentPanel.querySelector('.notice');
    if (currentMeta) currentMeta.textContent = current ? nowPlayingMeta(current) : '队列为空时大屏显示待机画面';
    if (currentTag) currentTag.textContent = current ? current.duration : 'IDLE';
    if (currentNotice) currentNotice.innerHTML = current ? `<strong>${esc(current.title)}</strong><br><span class="muted">Video ID: ${esc(current.videoId)}</span>` : '还没有当前歌曲。手机点歌后，队列会自动开始。';
  }
  const queueTable = content.querySelector('.queue-table');
  if (queueTable) { queueTable.innerHTML = renderAdminQueue(state.queue, state.current); linkAdminQueueTitles(content, state.queue, state.current); }
  const queueCount = content.querySelector('.queue-table')?.closest('.card')?.querySelector('.section-head .tag');
  if (queueCount) queueCount.textContent = `${state.queue.length} ${adminI18n[currentAdminLanguage()]?.songUnit || '首'}`;
  const usersCard = content.querySelector('.participants-card');
  if (usersCard) { const header = usersCard.querySelector('.section-head'); usersCard.innerHTML = ''; usersCard.append(header); usersCard.insertAdjacentHTML('beforeend', renderAdminUsers(state.users)); }
  const settings = document.getElementById('settings-form');
  if (settings) { settings.roomName.value = state.settings.roomName; settings.maxQueuedSongsPerGuest.value = state.settings.maxQueuedSongsPerGuest; settings.allowDuplicatePerSession.checked = state.settings.allowDuplicatePerSession; }
  const volume = document.getElementById('volume'); if (volume) volume.value = state.playback.volume;
  const volumeText = content.querySelector('.volume b'); if (volumeText) volumeText.textContent = `${state.playback.volume}%`;
  bindAdminEvents(token, state);
}
function bindAdminEvents(token, state) {
  if (!state) {
    api('/api/admin/state', {headers:{'x-admin-token':token}}).then(freshState => bindAdminEvents(token, freshState)).catch(() => {});
    return;
  }
  ensureAppearancePanel(token, state);
  const queueTable = document.querySelector('.queue-table');
  if (queueTable && state.current && !queueTable.querySelector('.queue-current')) queueTable.insertAdjacentHTML('afterbegin', renderAdminCurrent(state.current));
  linkAdminQueueTitles(queueTable, state.queue, state.current);
  const participantsCard = [...document.querySelectorAll('#admin-content .card.panel')].find(card => card.classList.contains('participants-card') || card.querySelector('.section-head h2')?.textContent === '参与者' || card.querySelector('.user-row'));
  participantsCard?.classList.add('participants-card');
  ensureGuestManagementPanel(token, state);
  const normalBroadcast = document.getElementById('broadcast-form');
  if (normalBroadcast) {
    const broadcastCard = normalBroadcast.closest('.card');
    const legacyChoice = broadcastCard?.querySelector('.important-choice');
    const legacyState = broadcastCard?.querySelector('#stop-important')?.closest('.important-state');
    if (broadcastCard && !broadcastCard.parentElement.querySelector('.important-control-card')) {
      const normalHeading = broadcastCard.querySelector('h2');
      const normalDescription = broadcastCard.querySelector('.section-head p');
      if (normalHeading) normalHeading.textContent = '普通广播';
      if (normalDescription) normalDescription.textContent = '显示在播放器之外，不会打断当前音乐。';
      const importantCard = document.createElement('div');
      importantCard.className = 'card panel important-control-card';
      const isActive = Boolean(legacyState);
      const isCountdown = legacyState?.textContent.includes('恢复倒计时中');
      const toggleLabel = isCountdown ? '恢复倒计时中' : isActive ? '停止重要广播' : '开始重要广播';
      const toggleAction = isActive ? 'stop' : 'start';
      importantCard.innerHTML = `<div class="section-head"><div><h2>重要广播</h2><p>单独控制现场口播：暂停音乐并覆盖大屏。</p></div></div><button class="btn danger important-toggle" data-action="${toggleAction}" ${isCountdown ? 'disabled' : ''}>${toggleLabel}</button>`;
      legacyChoice?.remove();
      legacyState?.remove();
      broadcastCard.insertAdjacentElement('afterend', importantCard);
    }
  }
  if (playbackConfirmTimer) clearInterval(playbackConfirmTimer);
  if (playbackConfirmButton) { playbackConfirmButton.textContent = playbackConfirmAction === 'skip' ? '切歌' : '停止'; playbackConfirmButton.classList.remove('armed'); }
  playbackConfirmTimer = null; playbackConfirmButton = null; playbackConfirmAction = null;
  document.querySelectorAll('.queue-item').forEach(item => {
    const actions = item.querySelector('.queue-actions');
    const thumbnail = item.querySelector('.song-thumb');
    if (actions && thumbnail) thumbnail.before(actions);
  });
  const pauseButton = document.querySelector('.playback[data-action="pause"]');
  const resumeButton = document.querySelector('.playback[data-action="resume"]');
  const existingToggle = document.querySelector('.playback-toggle');
  if (existingToggle) {
    existingToggle.dataset.action = state.importantBroadcast ? '' : state.playback.status === 'paused' ? 'resume' : 'pause';
    existingToggle.textContent = state.importantBroadcast ? adminLabel('importantOnAir') : state.playback.status === 'paused' ? adminLabel('resume') : adminLabel('pause');
    existingToggle.disabled = !state.current || Boolean(state.importantBroadcast);
  } else if (pauseButton && resumeButton) {
    const toggleButton = document.createElement('button');
    toggleButton.className = 'btn primary playback-toggle';
    toggleButton.dataset.action = state.importantBroadcast ? '' : state.playback.status === 'paused' ? 'resume' : 'pause';
    toggleButton.textContent = state.importantBroadcast ? adminLabel('importantOnAir') : state.playback.status === 'paused' ? adminLabel('resume') : adminLabel('pause');
    toggleButton.disabled = !state.current || Boolean(state.importantBroadcast);
    pauseButton.remove();
    resumeButton.replaceWith(toggleButton);
  }
  const importantButton = document.querySelector('.important-control-card .important-toggle');
  if (importantButton) {
    const countdown = state.importantBroadcast?.status === 'countdown';
    importantButton.dataset.action = state.importantBroadcast ? 'stop' : 'start';
    importantButton.textContent = countdown ? '恢复倒计时中' : state.importantBroadcast ? '停止重要广播' : '开始重要广播';
    importantButton.disabled = countdown;
  }
  const playbackToggle = document.querySelector('.playback-toggle');
  if (playbackToggle) playbackToggle.onclick = async () => { try { await api('/api/admin/playback', { method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({action:playbackToggle.dataset.action}) }); } catch (error) { toast(error.message); } };
  document.querySelectorAll('.playback[data-action="skip"], .playback[data-action="stop"]').forEach(button => button.onclick = async () => {
    const action = button.dataset.action;
    const label = action === 'skip' ? adminLabel('skip') : adminLabel('stop');
    if (playbackConfirmButton === button && playbackConfirmAction === action) {
      if (playbackConfirmTimer) clearInterval(playbackConfirmTimer);
      playbackConfirmTimer = null; playbackConfirmButton = null; playbackConfirmAction = null;
      button.textContent = label;
      button.classList.remove('armed');
      try { await api('/api/admin/playback', { method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({action}) }); } catch (error) { toast(error.message); }
      return;
    }
    if (playbackConfirmTimer) clearInterval(playbackConfirmTimer);
    if (playbackConfirmButton) { playbackConfirmButton.textContent = playbackConfirmAction === 'skip' ? '切歌' : '停止'; playbackConfirmButton.classList.remove('armed'); }
    playbackConfirmButton = button; playbackConfirmAction = action; button.classList.add('armed');
    let remaining = 3;
    button.textContent = `${adminLabel('confirmAgain')} (${remaining})`;
    playbackConfirmTimer = setInterval(() => { remaining -= 1; if (remaining <= 0) { clearInterval(playbackConfirmTimer); playbackConfirmTimer = null; button.textContent = label; button.classList.remove('armed'); playbackConfirmButton = null; playbackConfirmAction = null; } else button.textContent = `${adminLabel('confirmAgain')} (${remaining})`; }, 1000);
  });
  const volume = document.getElementById('volume'); if (volume) volume.onchange = async () => { try { await api('/api/admin/playback', { method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({action:'volume',volume:Number(volume.value)}) }); } catch (error) { toast(error.message); } };
  // 置顶 / 删除的点击统一由 renderAdminApp 里的 #admin-content 事件委托处理，
  // 这里不再逐按钮绑定（队列行会整体重建，逐按钮绑定容易丢）。
  const broadcast = document.getElementById('broadcast-form'); if (broadcast) broadcast.onsubmit = async event => { event.preventDefault(); try { await api('/api/admin/broadcast', {method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({message:broadcast.message.value})}); broadcast.reset(); toast(adminLabel('broadcastSent')); } catch (error) { toast(error.message); } };
  const importantToggle = document.getElementById('start-important') || document.getElementById('stop-important') || document.querySelector('.important-toggle'); if (importantToggle) importantToggle.onclick = async () => { try { const action = importantToggle.dataset.action; await api('/api/admin/important-broadcast', {method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({action})}); toast(action === 'start' ? adminLabel('importantStarted') : adminLabel('importantStopped')); } catch (error) { toast(error.message); } };
  const settings = document.getElementById('settings-form'); if (settings) settings.onsubmit = async event => { event.preventDefault(); try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({roomName:settings.roomName.value,maxQueuedSongsPerGuest:Number(settings.maxQueuedSongsPerGuest.value),allowDuplicatePerSession:settings.allowDuplicatePerSession.checked,publicUrl:settings.publicUrl?.value.trim() || ''})}); toast(adminLabel('settingsSaved')); } catch (error) { toast(error.message); } };
  const settingsFormElement = document.getElementById('settings-form');
  let publicUrlField = settingsFormElement?.querySelector('[data-role="public-url-field"]');
  if (settingsFormElement && !publicUrlField) {
    publicUrlField = document.createElement('div');
    publicUrlField.dataset.role = 'public-url-field';
    publicUrlField.className = 'field';
    publicUrlField.innerHTML = '<label data-role="public-url-label"></label><input class="input" name="publicUrl" type="url"><p class="helper" data-role="public-url-hint"></p>';
    const saveButton = settingsFormElement.querySelector('button:not(#new-session)');
    if (saveButton) settingsFormElement.insertBefore(publicUrlField, saveButton); else settingsFormElement.appendChild(publicUrlField);
  }
  const publicUrlInput = settingsFormElement?.querySelector('input[name="publicUrl"]');
  if (publicUrlInput) publicUrlInput.value = state.settings.publicUrl || '';
  if (publicUrlField) { const saveButton = settingsFormElement.querySelector('button:not(#new-session)'); if (saveButton && publicUrlField.nextElementSibling !== saveButton) settingsFormElement.insertBefore(publicUrlField, saveButton); }
  let newSessionButton = document.getElementById('new-session');
  if (settingsFormElement && !newSessionButton) {
    newSessionButton = document.createElement('button');
    newSessionButton.id = 'new-session';
    newSessionButton.type = 'button';
    newSessionButton.className = 'btn danger';
    settingsFormElement.appendChild(newSessionButton);
  }
  if (newSessionButton) {
    newSessionButton.onclick = async () => {
      const t = adminI18n[currentAdminLanguage()] || adminI18n.zh;
      if (!confirm(t.newSessionConfirm)) return;
      try { await api('/api/admin/new-session', {method:'POST', headers:{'x-admin-token':token}}); toast(t.newSessionDone); } catch (error) { toast(error.message); }
    };
  }
  applyAdminLanguage(currentAdminLanguage());
  ensureAdminExtras(token, state);
}

const extraCopy = {
  zh: {
    drinks: '酒水单', drinksHint: '显示在大屏播放列表下方，两栏布局；过长时固定标题并缓慢滚动。',
    addRow: '添加一行', interval: '出现间隔（秒）', saveDrinks: '保存酒水', saved: '已保存',
    name: '名称', price: '价格', drinksTitle: '酒水',
    animations: '大屏动画', animationsHint: '点击后立即在大屏播放约 7 秒。',
    fireworks: '烟花', confetti: '庆祝', hearts: '爱心', sparkles: '星光', disco: '迪斯科', balloons: '气球派对', petals: '花瓣雨', bubbles: '梦幻泡泡', neon: '霓虹脉冲', aurora: '极光流光', shootingStars: '流星雨',
    noBroadcasts: '还没有添加广播', broadcastAdded: '已添加，会循环播放', add: '添加', broadcastInterval: '广播间隔（秒）',
    timing: '显示时间', broadcastDuration: '广播显示时长（秒）', drinkDuration: '酒水显示时长（秒）', drinkInterval: '酒水间隔（秒）', timingStale: '服务端还是旧版本，重启控制台后这些时间才会完整保存。',
    ipWarning: 'YouTube 不允许在 IP 地址下嵌入播放。请在本机用 {url} 打开大屏，或用电脑名代替 IP；手机扫码用 IP 不受影响。'
  },
  en: {
    drinks: 'Drinks', drinksHint: 'Two-column price list under the queue; long lists keep the header and scroll slowly.',
    addRow: 'Add row', interval: 'Show interval (s)', saveDrinks: 'Save drinks', saved: 'Saved',
    name: 'Name', price: 'Price', drinksTitle: 'Bar',
    animations: 'Display animations', animationsHint: 'Plays on the display for about 7 seconds.',
    fireworks: 'Fireworks', confetti: 'Celebrate', hearts: 'Hearts', sparkles: 'Sparkles', disco: 'Disco', balloons: 'Balloon Party', petals: 'Petal Rain', bubbles: 'Dreamy Bubbles', neon: 'Neon Pulse', aurora: 'Aurora Glow', shootingStars: 'Meteor Shower',
    noBroadcasts: 'No broadcasts yet', broadcastAdded: 'Added — it now loops on the display', add: 'Add', broadcastInterval: 'Broadcast gap (s)',
    timing: 'Timing', broadcastDuration: 'Broadcast visible (s)', drinkDuration: 'Drinks visible (s)', drinkInterval: 'Drinks gap (s)', timingStale: 'The service is still running an older version. Restart the console so all timing values are saved.',
    ipWarning: 'YouTube does not allow embeds on IP addresses. Open the display at {url} on this PC, or use the PC name instead of the IP. Phone QR codes can still use the IP.'
  },
  de: {
    drinks: 'Getränke', drinksHint: 'Zweispaltige Preisliste unter der Warteschlange; lange Listen behalten die Kopfzeile und scrollen langsam.',
    addRow: 'Zeile hinzufügen', interval: 'Anzeigeintervall (s)', saveDrinks: 'Getränke speichern', saved: 'Gespeichert',
    name: 'Name', price: 'Preis', drinksTitle: 'Bar',
    animations: 'Display-Animationen', animationsHint: 'Läuft etwa 7 Sekunden auf der Anzeige.',
    fireworks: 'Feuerwerk', confetti: 'Feiern', hearts: 'Herzen', sparkles: 'Funkeln', disco: 'Disco', balloons: 'Ballonparty', petals: 'Blütenregen', bubbles: 'Traumblasen', neon: 'Neon-Puls', aurora: 'Polarlicht', shootingStars: 'Sternschnuppen',
    noBroadcasts: 'Noch keine Durchsagen', broadcastAdded: 'Hinzugefügt – läuft jetzt im Wechsel', add: 'Hinzufügen', broadcastInterval: 'Durchsage-Pause (s)',
    timing: 'Zeiten', broadcastDuration: 'Durchsage sichtbar (s)', drinkDuration: 'Getränke sichtbar (s)', drinkInterval: 'Getränke-Pause (s)', timingStale: 'Der Dienst läuft noch mit einer älteren Version. Konsole neu starten, damit alle Zeiten gespeichert werden.',
    ipWarning: 'YouTube erlaubt keine Einbettung über IP-Adressen. Öffne die Anzeige auf diesem PC unter {url} oder nutze den PC-Namen statt der IP. QR-Codes für Handys können die IP weiterhin verwenden.'
  }
};

function extraText(key) {
  const language = currentAdminLanguage();
  return (extraCopy[language] || extraCopy.en)[key] || extraCopy.en[key] || key;
}

let drinksSignature = '';
let drinksShowTimer = null;
let drinksHideTimer = null;
let broadcastSignature = '';
let broadcastShowTimer = null;
let broadcastHideTimer = null;
let broadcastIndex = 0;
let animationSignature = '';
let animationHideTimer = null;

function restartDrinksScroll(track) {
  if (!track || !track.classList.contains('is-scrolling')) return;
  const duration = track.dataset.duration || '20';
  track.style.animation = 'none';
  void track.offsetWidth;
  track.style.animation = `drinksScroll ${duration}s ease-in-out infinite alternate`;
}

function updateDrinks(settings) {
  const card = document.getElementById('drinks-card');
  if (!card) return;
  const drinks = Array.isArray(settings?.drinks) ? settings.drinks : [];
  const duration = Math.max(3, Number(settings?.drinkDuration) || 8);
  const interval = Math.max(0, Number(settings?.drinkInterval) || 0);
  const title = extraText('drinksTitle');
  const signature = `${JSON.stringify(drinks)}|${duration}|${interval}|${title}`;
  if (signature === drinksSignature) return;
  drinksSignature = signature;
  clearTimeout(drinksShowTimer);
  clearTimeout(drinksHideTimer);
  drinksShowTimer = null;
  drinksHideTimer = null;

  if (!drinks.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  card.classList.remove('is-hidden');
  card.querySelector('[data-drinks-title]').textContent = title;
  const track = card.querySelector('#drinks-track');
  track.classList.remove('is-scrolling');
  track.style.animation = '';
  track.innerHTML = drinks.map(item => `<div class="drink-item"><span class="drink-name">${esc(item.name || '')}</span><span class="drink-dots"></span><span class="drink-price">${esc(item.price || '')}</span></div>`).join('');

  const side = card.closest('.display-side');
  if (side) card.style.maxHeight = `${Math.max(90, Math.round(side.clientHeight * 0.3))}px`;

  requestAnimationFrame(() => {
    const viewport = card.querySelector('.drinks-viewport');
    if (!viewport) return;
    const overflow = Math.max(0, track.scrollHeight - viewport.clientHeight);
    if (overflow > 4) {
      const scrollDuration = Math.max(12, Math.round(overflow / 10));
      track.dataset.duration = String(scrollDuration);
      track.style.setProperty('--drinks-distance', `-${overflow}px`);
      track.classList.add('is-scrolling');
      restartDrinksScroll(track);
    }
  });

  const cycle = () => {
    if (!document.getElementById('drinks-card')) return;
    card.classList.remove('is-hidden');
    restartDrinksScroll(card.querySelector('#drinks-track'));
    drinksShowTimer = setTimeout(() => {
      card.classList.add('is-hidden');
      drinksHideTimer = setTimeout(cycle, interval * 1000);
    }, duration * 1000);
  };
  cycle();
}

function updateBroadcastBanner(state) {
  const banner = document.getElementById('display-broadcast');
  if (!banner) return;
  const span = banner.querySelector('span');
  const broadcasts = Array.isArray(state.broadcasts) ? state.broadcasts : (state.broadcast ? [state.broadcast] : []);
  const duration = Math.max(3, Number(state.settings?.broadcastDuration) || 8);
  const interval = Math.max(0, Number(state.settings?.broadcastInterval) || 0);
  const signature = `${JSON.stringify(broadcasts.map(item => item.id))}|${duration}|${interval}`;
  if (signature === broadcastSignature) return;
  broadcastSignature = signature;
  clearTimeout(broadcastShowTimer);
  clearTimeout(broadcastHideTimer);
  broadcastShowTimer = null;
  broadcastHideTimer = null;
  broadcastIndex = 0;

  if (!broadcasts.length) {
    if (span) span.textContent = localeText('welcome', '欢迎来到歌唱现场，扫描二维码点歌。');
    banner.classList.remove('banner-fade');
    return;
  }

  const show = index => {
    if (!span) return;
    span.textContent = broadcasts[index % broadcasts.length].message;
    banner.classList.remove('banner-fade');
    broadcastShowTimer = setTimeout(() => {
      banner.classList.add('banner-fade');
      broadcastHideTimer = setTimeout(() => {
        broadcastIndex = (broadcastIndex + 1) % broadcasts.length;
        show(broadcastIndex);
      }, Math.max(450, interval * 1000));
    }, duration * 1000);
  };
  show(0);
}

const ANIMATION_EMOJIS = {
  fireworks: ['🎆', '✨', '🎇', '💥'],
  confetti: ['🎉', '🎊', '🥳', '✨'],
  hearts: ['❤️', '💖', '💕', '💘'],
  sparkles: ['✨', '⭐', '🌟', '💫'],
  disco: ['🪩', '🕺', '💃', '✨'],
  balloons: ['🎈', '🎈', '🎀', '✨'],
  petals: ['🌸', '🌺', '🌷', '🍃'],
  bubbles: ['◌', '○', '◦', '✦'],
  neon: [],
  aurora: [],
  shootingStars: []
};

const ANIMATION_CONFIG = {
  fireworks: { count: 40 }, confetti: { count: 64 }, hearts: { count: 40 }, sparkles: { count: 40 }, disco: { count: 40 },
  balloons: { count: 28 }, petals: { count: 46 }, bubbles: { count: 30 }, neon: { count: 18 }, aurora: { count: 9 }, shootingStars: { count: 14 }
};

function updateDisplayAnimation(animation) {
  const layer = document.getElementById('animation-layer');
  if (!layer) return;
  if (!animation || !animation.id || animation.id === animationSignature) return;
  const startedAt = new Date(animation.startedAt).getTime();
  const duration = Number(animation.durationMs) || 7000;
  if (Number.isFinite(startedAt) && Date.now() - startedAt > duration) return;

  animationSignature = animation.id;
  const type = ANIMATION_EMOJIS[animation.type] ? animation.type : 'confetti';
  const emojis = ANIMATION_EMOJIS[type];
  layer.className = `animation-layer ${type}`;
  layer.innerHTML = '';
  const count = ANIMATION_CONFIG[type]?.count || 40;
  for (let index = 0; index < count; index += 1) {
    const particle = document.createElement('span');
    particle.className = 'animation-particle';
    particle.textContent = emojis.length ? emojis[index % emojis.length] : '';
    particle.style.left = `${Math.random() * 96}%`;
    particle.style.fontSize = `${18 + Math.random() * 30}px`;
    particle.style.animationDelay = `${Math.random() * 1.4}s`;
    particle.style.animationDuration = `${2.4 + Math.random() * 2.8}s`;
    if (type === 'shootingStars' || type === 'neon') particle.style.top = `${10 + Math.random() * 68}%`;
    if (type === 'aurora') particle.style.left = `${Math.random() * 82 - 10}%`;
    layer.append(particle);
  }
  layer.classList.add('visible');
  clearTimeout(animationHideTimer);
  animationHideTimer = setTimeout(() => {
    layer.classList.remove('visible');
    setTimeout(() => { layer.innerHTML = ''; }, 700);
  }, duration);
}

function drinkEditorRow(item = {}) {
  return `<div class="drink-edit-row"><input class="input" data-role="name" maxlength="40" placeholder="${esc(extraText('name'))}" value="${esc(item.name || '')}" /><input class="input" data-role="price" maxlength="20" placeholder="${esc(extraText('price'))}" value="${esc(item.price || '')}" /><button type="button" class="btn small danger" data-role="remove" aria-label="remove">×</button></div>`;
}

function renderDrinksEditor(card, state) {
  const drinks = Array.isArray(state.settings?.drinks) ? state.settings.drinks : [];
  const signature = `${JSON.stringify(drinks)}|${currentAdminLanguage()}`;
  if (card.dataset.signature === signature) return;
  if (card.dataset.dirty === '1' && card.dataset.signature) return;
  card.dataset.signature = signature;
  card.innerHTML = `<div class="section-head"><div><h2>${extraText('drinks')}</h2><p>${extraText('drinksHint')}</p></div></div>
    <div class="drinks-editor-rows" data-role="rows">${drinks.map(drinkEditorRow).join('')}</div>
    <div class="drinks-editor-actions">
      <button type="button" class="btn ghost small" data-role="add">${extraText('addRow')}</button>
      <button type="button" class="btn primary small" data-role="save">${extraText('saveDrinks')}</button>
    </div>`;
}

function renderAnimationCard(card) {
  const signature = currentAdminLanguage();
  if (card.dataset.signature === signature) return;
  card.dataset.signature = signature;
  card.innerHTML = `<div class="section-head"><div><h2>${extraText('animations')}</h2><p>${extraText('animationsHint')}</p></div></div>
    <div class="animation-buttons">${Object.keys(ANIMATION_EMOJIS).map(type => `<button type="button" class="btn soft small" data-animation="${type}">${extraText(type)}</button>`).join('')}</div>`;
}

function renderBroadcastList(token, state) {
  const form = document.getElementById('broadcast-form');
  const card = form?.closest('.card');
  if (!form || !card) return;
  let list = card.querySelector('#broadcast-list');
  if (!list) {
    list = document.createElement('div');
    list.id = 'broadcast-list';
    list.className = 'broadcast-list';
    form.after(list);
  }
  let intervalField = card.querySelector('[data-role="broadcast-interval-field"]');
  if (intervalField) intervalField.remove();
  const broadcasts = Array.isArray(state.broadcasts) ? state.broadcasts : (state.broadcast ? [state.broadcast] : []);
  const signature = `${JSON.stringify(broadcasts.map(item => [item.id, item.message]))}|${currentAdminLanguage()}`;
  if (list.dataset.signature !== signature) {
    list.dataset.signature = signature;
    list.innerHTML = broadcasts.length
      ? broadcasts.map(item => `<div class="broadcast-item"><span>${esc(item.message)}</span><button type="button" data-broadcast-id="${item.id}" aria-label="delete">×</button></div>`).join('')
      : `<div class="empty">${extraText('noBroadcasts')}</div>`;
  }
  list.onclick = async event => {
    const button = event.target.closest('[data-broadcast-id]');
    if (!button) return;
    try { await api(`/api/admin/broadcast/${button.dataset.broadcastId}`, { method: 'DELETE', headers: { 'x-admin-token': token } }); }
    catch (error) { toast(error.message); }
  };
  const submit = form.querySelector('button');
  if (submit) submit.textContent = extraText('add');
  form.onsubmit = async event => {
    event.preventDefault();
    const input = form.querySelector('input[name="message"]');
    const message = String(input?.value || '').trim();
    if (!message) return;
    try {
      await api('/api/admin/broadcast', { method: 'POST', headers: { 'x-admin-token': token }, body: JSON.stringify({ message }) });
      if (input) input.value = '';
      toast(extraText('broadcastAdded'));
    } catch (error) { toast(error.message); }
  };
}

function ensureAdminExtras(token, state) {
  const aside = document.querySelector('#admin-content aside.grid');
  if (!aside) return;

  let drinksCard = document.getElementById('drinks-editor-card');
  if (!drinksCard) {
    drinksCard = document.createElement('div');
    drinksCard.id = 'drinks-editor-card';
    drinksCard.className = 'card panel';
    aside.append(drinksCard);
  }
  renderDrinksEditor(drinksCard, state);
  drinksCard.oninput = () => { drinksCard.dataset.dirty = '1'; };
  drinksCard.onclick = async event => {
    const rows = drinksCard.querySelector('[data-role="rows"]');
    if (event.target.closest('[data-role="add"]')) {
      rows.insertAdjacentHTML('beforeend', drinkEditorRow());
      drinksCard.dataset.dirty = '1';
      return;
    }
    const remove = event.target.closest('[data-role="remove"]');
    if (remove) {
      remove.closest('.drink-edit-row').remove();
      drinksCard.dataset.dirty = '1';
      return;
    }
    if (event.target.closest('[data-role="save"]')) {
      const items = [...drinksCard.querySelectorAll('.drink-edit-row')].map(row => ({
        name: row.querySelector('[data-role="name"]').value,
        price: row.querySelector('[data-role="price"]').value
      }));
      try {
        await api('/api/admin/drinks', { method: 'PATCH', headers: { 'x-admin-token': token }, body: JSON.stringify({ items }) });
        drinksCard.dataset.dirty = '0';
        drinksCard.dataset.signature = '';
        toast(extraText('saved'));
      } catch (error) { toast(error.message); }
    }
  };

  let animationCard = document.getElementById('animation-card');
  if (!animationCard) {
    animationCard = document.createElement('div');
    animationCard.id = 'animation-card';
    animationCard.className = 'card panel';
    aside.append(animationCard);
  }
  renderAnimationCard(animationCard);
  animationCard.onclick = async event => {
    const button = event.target.closest('[data-animation]');
    if (!button) return;
    try { await api('/api/admin/animation', { method: 'POST', headers: { 'x-admin-token': token }, body: JSON.stringify({ type: button.dataset.animation }) }); }
    catch (error) { toast(error.message); }
  };

  renderBroadcastList(token, state);
}

window.addEventListener('resize', () => {
  const card = document.getElementById('drinks-card');
  const side = card?.closest('.display-side');
  if (!card || !side || card.hidden) return;
  card.style.maxHeight = `${Math.max(90, Math.round(side.clientHeight * 0.3))}px`;
});

let youtubeApiPromise;
function loadYoutubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (youtubeApiPromise) return youtubeApiPromise;
  youtubeApiPromise = new Promise(resolve => { const previous = window.onYouTubeIframeAPIReady; window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); }; const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(script); });
  return youtubeApiPromise;
}
async function initDisplay() {
  const hostname = location.hostname;
  if (hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    location.replace(`http://localhost:${location.port || '3000'}/display`);
    return;
  }
  const config = await api('/api/config');
  setInterfaceDefaults(config);
  applyTheme();
  renderShell(`<div class="display-shell"><main class="display-main"><div class="display-brand"><div class="brand"><img class="brand-mark" src="/ICON.png" alt="EESTEC LC AACHEN"><span>${esc(config.roomName)} - EESTEC LC AACHEN</span></div><div class="live-dot"><i></i> LIVE ROOM</div></div><div id="player" class="player-frame"></div><div id="display-broadcast" class="broadcast-banner"><strong>现场消息</strong><span>欢迎来到歌唱现场，扫描二维码点歌。</span></div></main><aside class="display-side"><div class="eyebrow">SCAN TO SING</div><h1>加入现场</h1><p>用手机扫描二维码，搜索并加入你的歌曲。</p><div class="qr-box"><img id="qr" alt="点歌二维码"></div><div class="side-title">UP NEXT · <span id="queue-count">0</span></div><div id="display-queue" class="display-queue"></div><section id="drinks-card" class="drinks-card" hidden><div class="drinks-head"><span data-drinks-title>Bar</span><span>€</span></div><div class="drinks-viewport"><div id="drinks-track" class="drinks-track"></div></div></section><div class="display-footer"><span data-role="display-footer-copy">播放器区域保持独立，不覆盖 YouTube 控件。DJ 可在控制台暂停、恢复、切歌与调节音量。</span><button class="btn ghost small" id="display-fullscreen" type="button" aria-label="全屏" title="全屏"></button></div></aside><div id="animation-layer" class="animation-layer"></div><div id="important-overlay" class="important-overlay" aria-live="assertive"></div></div>`, {dark:true});
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(location.hostname) || location.hostname.includes(':')) {
    const localUrl = `http://localhost:${location.port || '3000'}/display`;
    const warning = document.createElement('div');
    warning.className = 'display-origin-warning';
    warning.innerHTML = esc(extraText('ipWarning')).replace('{url}', `<a href="${esc(localUrl)}">${esc(localUrl)}</a>`);
    document.querySelector('.display-main')?.prepend(warning);
  }
  const fullscreenButton = document.getElementById('display-fullscreen');
  if (fullscreenButton) {
    fullscreenButton.onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { toast(localeText('fullscreenFailed', '无法进入全屏')); } };
    document.addEventListener('fullscreenchange', applyDisplayLanguage);
  }
  let currentPublicUrl = config.publicUrl || '';
  const refreshQr = async publicUrl => { const nextPublicUrl = publicUrl || ''; if (nextPublicUrl === currentPublicUrl) return; currentPublicUrl = nextPublicUrl; const joinUrl = `${(currentPublicUrl || location.origin).replace(/\/+$/, '')}/join`; try { const qr = await api(`/api/qr?text=${encodeURIComponent(joinUrl)}`); const image = document.getElementById('qr'); if (image) image.src = qr.dataUrl; } catch {} };
  displayQrRefresh = refreshQr;
  const qr = await api(`/api/qr?text=${encodeURIComponent(config.joinUrl)}`); document.getElementById('qr').src = qr.dataUrl;
  let playerInstance = null; let currentRequestId = null; let lastState = null; let countdownTimer = null;
  const renderImportant = important => { const overlay = document.getElementById('important-overlay'); if (!overlay) return; clearInterval(countdownTimer); countdownTimer = null; if (!important) { overlay.classList.remove('visible'); overlay.innerHTML = ''; return; } overlay.classList.add('visible'); const speakerIcon = '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M12 48h25l47-29v81L37 71H12z"></path><path d="M38 74l10 29h15L52 70"></path><path d="M97 39c9 11 9 31 0 42"></path><path d="M106 28c17 17 17 47 0 64"></path></svg>'; const update = () => { if (important.status !== 'countdown') { overlay.innerHTML = `<div class="important-card"><div class="speaker-icon">${speakerIcon}</div><div class="important-message">${localeText('djBroadcast', 'DJ 正在广播中')}</div><div class="important-subtitle">${localeText('listenNotice', '请听取现场通知')}</div></div>`; return; } const remaining = Math.max(0, Math.ceil((new Date(important.countdownEndsAt).getTime() - Date.now()) / 1000)); overlay.innerHTML = `<div class="important-card"><div class="speaker-icon countdown-speaker">${speakerIcon}</div><div class="important-message">${localeText('resumeSoon', '即将恢复播放')}</div><div class="important-countdown">${remaining || 1}</div><div class="important-subtitle">${localeText('resumeHint', '音乐将在倒计时结束后继续')}</div></div>`; if (remaining <= 0) clearInterval(countdownTimer); }; update(); if (important.status === 'countdown') countdownTimer = setInterval(update, 100); };
  const report = (requestId, event, detail) => api('/api/display/event', {method:'POST', body:JSON.stringify({requestId,event,detail})}).catch(() => {});
  const mountPlayer = async state => { const player = document.getElementById('player'); player.innerHTML = '<div id="yt-player" style="width:100%;height:100%;min-height:420px"></div>'; try { const YT = await loadYoutubeApi(); if (!state.current || state.current.id !== currentRequestId) return; playerInstance = new YT.Player('yt-player', { videoId: state.current.videoId, playerVars:{autoplay:1,controls:1,rel:0,playsinline:1,origin:location.origin}, events:{ onReady:event => { event.target.setVolume(state.playback.volume); if (state.importantBroadcast || state.playback.status === 'paused') event.target.pauseVideo(); else { event.target.playVideo(); report(state.current.id, 'playing'); } }, onStateChange:event => { if (event.data === 0) report(state.current.id, 'ended'); if (event.data === 1) report(state.current.id, 'playing'); if (event.data === 2) report(state.current.id, 'paused'); }, onError:event => { const playerEl = document.getElementById('player'); if (playerEl) playerEl.innerHTML = `<div class="display-idle"><div class="big-note">${esc(localeText('unplayable', '这首歌无法嵌入播放'))}</div><p>${esc(localeText('unplayableDesc', '正在跳到下一首…'))}</p></div>`; report(state.current.id, 'error', `YouTube error ${event.data}`); } } }); } catch { player.innerHTML = `<div class="display-idle"><div class="big-note">${localeText('playerFail', '播放器连接失败')}</div><p>${localeText('playerFailDesc', '请检查展示台的网络连接，再由 DJ 手动切歌。')}</p></div>`; } };
  const render = state => { displayCurrentSong = state.current; const nextLanguage = state.settings?.interfaceLanguage || interfaceDefaults.language; const nextTheme = state.settings?.interfaceTheme || interfaceDefaults.theme; if (nextLanguage !== interfaceDefaults.language || nextTheme !== interfaceDefaults.theme) { setInterfaceDefaults(state.settings); applyTheme(); } const roomName = document.querySelector('.display-brand .brand span:last-child'); if (roomName && state.settings?.roomName) roomName.textContent = `${state.settings.roomName} - EESTEC LC AACHEN`; renderImportant(state.importantBroadcast); updateDrinks(state.settings); updateBroadcastBanner(state); updateDisplayAnimation(state.animation); document.getElementById('queue-count').textContent = state.queue.length; document.getElementById('display-queue').innerHTML = state.queue.length ? state.queue.slice(0, 8).map((song, i) => `<div class="display-song"><div class="number">${String(i+1).padStart(2,'0')}</div><div class="copy"><div class="title">${esc(song.title)}</div><div class="meta">${esc(song.singerName)}${song.isPinned ? ` · ${currentAdminLanguage() === 'de' ? 'Angepinnt' : currentAdminLanguage() === 'en' ? 'Pinned' : '置顶'}` : ''}</div></div></div>`).join('') : `<div class="empty">${localeText('noNext', '暂无后续歌曲')}</div>`; const banner = document.getElementById('display-broadcast'); const player = document.getElementById('player'); if (!state.current) { playerInstance?.destroy?.(); playerInstance = null; currentRequestId = null; player.innerHTML = `<div class="display-idle"><div class="eyebrow">${localeText('ready', 'READY WHEN YOU ARE')}</div><div class="big-note">${localeText('idleTitle', '等你来唱')}</div><p>${localeText('idleDesc', '点歌后，歌曲会自动出现在这里。')}</p></div>`; applyDisplayLanguage(); lastState = state; return; } if (currentRequestId !== state.current.id) { playerInstance?.destroy?.(); playerInstance = null; currentRequestId = state.current.id; mountPlayer(state); } else if (playerInstance) { if (state.playback.status === 'paused') playerInstance.pauseVideo?.(); if (state.playback.status === 'playing') playerInstance.playVideo?.(); playerInstance.setVolume?.(state.playback.volume); } applyDisplayLanguage(); lastState = state; }; render(await api('/api/state')); connectEvents(render); }

applyTheme();
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (currentThemePreference() === 'system') applyTheme('system'); });
window.addEventListener('storage', event => { if (event.key === 'karaoke_language' || event.key === 'karaoke_user_language') applyLocale(); if (event.key === 'karaoke_theme' || event.key === 'karaoke_user_theme') applyTheme(currentThemePreference()); });
(mode === 'admin' ? initAdmin : mode === 'display' ? initDisplay : initJoin)().catch(error => { app.innerHTML = `<main class="login-wrap"><section class="card login-card"><div class="eyebrow">SYSTEM ERROR</div><h1>无法连接服务</h1><p>${esc(error.message)}</p><button class="btn primary" onclick="location.reload()">重新加载</button></section></main>`; });
