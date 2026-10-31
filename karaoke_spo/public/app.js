const mode = location.pathname.startsWith('/admin') ? 'admin'
  : location.pathname.startsWith('/library') ? 'library'
  : location.pathname.startsWith('/display') ? 'display'
  : 'join';
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let toastTimer;
let playbackConfirmTimer = null;
let playbackConfirmButton = null;
let playbackConfirmAction = null;
// 按下「切歌/停止」时正在播的歌。后台制作每 250ms 推一次状态，
// 不能因为一次普通刷新就把「再次确认」清掉，否则准备期间永远点不完整。
let playbackConfirmSongId = null;
let interfaceDefaults = { language: 'zh', theme: 'system' };
let displayCurrentSong = null;
let joinEvents = null;
let joinConfig = null;
let displayQrRefresh = null;
let serverVersionWarned = false;
const REQUIRED_API_VERSION = 8;

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
  zh: { title:'现场控制台', intro:'一处管理播放、队列、参与者和现场信息。所有变更会实时同步到大屏与手机。', display:'打开大屏 ↗', logout:'退出', status:'当前状态', queue:'等待歌曲', users:'在线会话', volume:'当前音量', nowPlaying:'正在播放', nowPlayingEmpty:'队列为空时大屏显示待机画面', queueTitle:'等待队列', queueDesc:'置顶歌曲优先；可直接调整、删除和切换优先级。', normalBroadcast:'普通广播', normalBroadcastDesc:'显示在播放器之外，不会打断当前音乐。', importantBroadcast:'重要广播', importantDesc:'单独控制现场口播：暂停音乐并覆盖大屏。', settings:'活动设置', settingsDesc:'变更会立即作用于新请求', participants:'参与者', participantsDesc:'按临时会话识别点歌归属', appearance:'界面设置', appearanceDesc:'这里设置现场默认，用户可在自己的设备上单独覆盖', songFilters:'点歌过滤', onlyKaraoke:'仅允许 Karaoke 歌曲', onlyKaraokeHint:'视频标题必须包含 karaoke（不区分大小写）', blacklistKeywords:'黑名单关键字', blacklistPlaceholder:'多个关键字用逗号或换行分隔', blacklistHint:'标题命中任一关键字时禁止添加', language:'语言', theme:'配色模式', save:'保存设置', send:'发送', languageSaved:'语言已切换', themeSaved:'配色已切换', pause:'暂停播放', resume:'恢复播放', importantStart:'开始重要广播', importantStop:'停止重要广播', importantCountdown:'恢复倒计时中', skip:'切歌', stop:'停止' },
  en: { title:'DJ Control Desk', intro:'Manage playback, queue, guests, and live announcements from one place. Changes sync to the display and phones.', display:'Open Display ↗', logout:'Log out', status:'Status', queue:'Waiting Songs', users:'Guest Sessions', volume:'Volume', nowPlaying:'Now Playing', nowPlayingEmpty:'The display is idle while the queue is empty.', queueTitle:'Waiting Queue', queueDesc:'Pinned songs play first. Reorder, pin, or remove songs here.', normalBroadcast:'Regular Broadcast', normalBroadcastDesc:'Shown outside the player without interrupting music.', importantBroadcast:'Important Broadcast', importantDesc:'Pause music and cover the display while the DJ speaks live.', settings:'Event Settings', settingsDesc:'Changes apply to new requests immediately.', participants:'Guests', participantsDesc:'Song ownership is tracked by temporary session.', appearance:'Interface Settings', appearanceDesc:'Set the room default; users can override it on their own devices.', songFilters:'Song Filters', onlyKaraoke:'Karaoke songs only', onlyKaraokeHint:'The video title must contain karaoke (case-insensitive)', blacklistKeywords:'Blocked keywords', blacklistPlaceholder:'Separate keywords with commas or new lines', blacklistHint:'Titles containing any keyword cannot be added', language:'Language', theme:'Theme', save:'Save Settings', send:'Send', languageSaved:'Language changed', themeSaved:'Theme changed', pause:'Pause', resume:'Resume', importantStart:'Start Important Broadcast', importantStop:'Stop Important Broadcast', importantCountdown:'Recovery countdown', skip:'Skip', stop:'Stop' },
  de: { title:'DJ Steuerzentrale', intro:'Wiedergabe, Warteschlange, Gäste und Durchsagen zentral verwalten. Änderungen werden synchronisiert.', display:'Anzeige öffnen ↗', logout:'Abmelden', status:'Status', queue:'Wartende Songs', users:'Gäste', volume:'Lautstärke', nowPlaying:'Aktuelle Wiedergabe', nowPlayingEmpty:'Bei leerer Warteschlange zeigt die Anzeige den Standby-Bildschirm.', queueTitle:'Warteschlange', queueDesc:'Angepinnte Songs werden zuerst gespielt. Hier verwalten und entfernen.', normalBroadcast:'Normale Durchsage', normalBroadcastDesc:'Außerhalb des Players angezeigt, ohne die Musik zu unterbrechen.', importantBroadcast:'Wichtige Durchsage', importantDesc:'Musik pausieren und Anzeige überblenden, während der DJ spricht.', settings:'Event-Einstellungen', settingsDesc:'Änderungen gelten sofort für neue Anfragen.', participants:'Gäste', participantsDesc:'Die Zuordnung erfolgt über eine temporäre Sitzung.', appearance:'Oberfläche', appearanceDesc:'Hier den Raumstandard festlegen; Gäste können ihn auf ihren Geräten überschreiben.', songFilters:'Song-Filter', onlyKaraoke:'Nur Karaoke-Songs', onlyKaraokeHint:'Der Videotitel muss „karaoke“ enthalten (Groß-/Kleinschreibung egal)', blacklistKeywords:'Gesperrte Stichwörter', blacklistPlaceholder:'Mit Kommas oder Zeilenumbrüchen trennen', blacklistHint:'Titel mit einem dieser Stichwörter können nicht hinzugefügt werden', language:'Sprache', theme:'Design', save:'Einstellungen speichern', send:'Senden', languageSaved:'Sprache geändert', themeSaved:'Design geändert', pause:'Pause', resume:'Fortsetzen', importantStart:'Wichtige Durchsage starten', importantStop:'Wichtige Durchsage beenden', importantCountdown:'Wiederaufnahme läuft', skip:'Überspringen', stop:'Stopp' }
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

// ── Admin 控制台主体（renderAdminApp / renderAdminLiveHtml）里原先硬编码的中文文案 ──
Object.assign(adminI18n.zh, {
  openLibrary:'曲库管理 ↗', trackLibrary:'本地曲库', idle:'待机', transitioning:'切歌中', paused:'已暂停', playing:'播放中',
  nowPlayingDescEmpty:'队列为空时大屏显示待机画面', noCurrentSong:'还没有当前歌曲。手机点歌后，队列会自动开始。',
  vocal:'人声', vocalHint:'人声仅本地曲目有效；歌词开关同时作用于视频与歌词画面',
  vocalOriginal:'原唱', vocalGuide:'人声导唱', instrumental:'伴奏',
  lyricsWord:'歌词逐字', lyricsLine:'歌词逐行', lyricsWordTitle:'当前行按字逐个点亮', lyricsLineTitle:'当前行整行点亮',
  videoScreen:'视频画面', videoLyricsOn:'视频歌词：开', videoLyricsOff:'视频歌词：关', videoLyricsHint:'关掉后视频画面只放视频，不叠歌词',
  broadcastTitle:'现场广播', broadcastDesc:'普通广播显示在播放器之外；重要广播会暂停播放并覆盖大屏。',
  broadcastPlaceholder:'例如：下一首由小林演唱', importantChoice:'重要广播：暂停播放并覆盖大屏',
  recovering:'恢复倒计时中', djOnAir:'DJ 广播中', stopImportant:'停止重要广播',
  settingsTitle:'活动设置', settingsDescShort:'变更会立即作用于新请求', maxQueuedSongs:'每人最多等待歌曲',
  allowDuplicate:'允许同一会话重复点同一首', saveSettings:'保存设置',
  participantsDescShort:'按临时会话识别点歌归属', waiting:'等待', eventName:'活动名称',
  // 界面设置弹窗（admin 与 guest 共用）
  adminSettingsTitle:'界面设置', adminSettingsDesc:'这里设置现场默认，用户可在自己的设备上单独覆盖',
  close:'关闭', language:'语言', theme:'配色模式',
  userSettingsTitle:'界面设置', userSettingsDesc:'用户设置只保存在本浏览器',
  themeSystem:'跟随系统', themeLight:'白天', themeDark:'夜间'
});
Object.assign(adminI18n.en, {
  openLibrary:'Song Library ↗', trackLibrary:'Local library', idle:'Idle', transitioning:'Switching', paused:'Paused', playing:'Playing',
  nowPlayingDescEmpty:'The display shows the standby screen while the queue is empty.', noCurrentSong:'No song is playing yet. Once a guest adds one, the queue starts automatically.',
  vocal:'Vocal', vocalHint:'Vocals only apply to local tracks; the lyrics switch affects both the video and lyrics views.',
  vocalOriginal:'Original', vocalGuide:'Vocal guide', instrumental:'Backing',
  lyricsWord:'Word-level lyrics', lyricsLine:'Line-level lyrics', lyricsWordTitle:'Highlight the current line word by word', lyricsLineTitle:'Highlight the current line as a whole',
  videoScreen:'Video view', videoLyricsOn:'Video lyrics: On', videoLyricsOff:'Video lyrics: Off', videoLyricsHint:'When off, the video plays without lyrics overlay.',
  broadcastTitle:'Live Broadcast', broadcastDesc:'Normal broadcasts appear outside the player; important ones pause playback and cover the display.',
  broadcastPlaceholder:'e.g. Next up: Anna', importantChoice:'Important broadcast: pause playback and cover the display',
  recovering:'Resuming shortly', djOnAir:'DJ on air', stopImportant:'Stop important broadcast',
  settingsTitle:'Event Settings', settingsDescShort:'Changes apply immediately to new requests', maxQueuedSongs:'Max waiting songs per guest',
  allowDuplicate:'Allow the same guest to request the same song twice', saveSettings:'Save Settings',
  participantsDescShort:'Guests are tracked by temporary session', waiting:'Waiting', eventName:'Event Name',
  adminSettingsTitle:'Interface Settings', adminSettingsDesc:'These are the venue defaults; users can override them on their own device.',
  close:'Close', language:'Language', theme:'Theme',
  userSettingsTitle:'Interface Settings', userSettingsDesc:'User settings are stored only in this browser.',
  themeSystem:'Follow system', themeLight:'Light', themeDark:'Dark'
});
Object.assign(adminI18n.de, {
  openLibrary:'Songbibliothek ↗', trackLibrary:'Lokale Bibliothek', idle:'Standby', transitioning:'Wechselt', paused:'Pausiert', playing:'Läuft',
  nowPlayingDescEmpty:'Bei leerer Warteschlange zeigt die Anzeige den Standby-Bildschirm.', noCurrentSong:'Noch kein Song aktiv. Sobald ein Gast einen wählt, startet die Warteschlange automatisch.',
  vocal:'Gesang', vocalHint:'Gesang gilt nur für lokale Titel; der Liedtext-Schalter wirkt auf Video und Textansicht.',
  vocalOriginal:'Original', vocalGuide:'Vocal guide', instrumental:'Playback',
  lyricsWord:'Wortgenauer Text', lyricsLine:'Zeilenweiser Text', lyricsWordTitle:'Aktuelle Zeile Wort für Wort hervorheben', lyricsLineTitle:'Aktuelle Zeile als Ganzes hervorheben',
  videoScreen:'Videoansicht', videoLyricsOn:'Video-Text: Ein', videoLyricsOff:'Video-Text: Aus', videoLyricsHint:'Aus: Das Video läuft ohne Textüberlagerung.',
  broadcastTitle:'Live-Durchsage', broadcastDesc:'Normale Durchsagen erscheinen neben dem Player; wichtige pausieren die Wiedergabe und überdecken die Anzeige.',
  broadcastPlaceholder:'z. B. Als Nächstes: Anna', importantChoice:'Wichtige Durchsage: Wiedergabe pausieren und Anzeige überdecken',
  recovering:'Setzt gleich fort', djOnAir:'DJ auf Sendung', stopImportant:'Wichtige Durchsage beenden',
  settingsTitle:'Event-Einstellungen', settingsDescShort:'Änderungen gelten sofort für neue Anfragen', maxQueuedSongs:'Max. wartende Songs pro Gast',
  allowDuplicate:'Demselben Gast erlauben, denselben Song erneut zu wünschen', saveSettings:'Einstellungen speichern',
  participantsDescShort:'Gäste werden über temporäre Sitzungen erkannt', waiting:'Wartet', eventName:'Eventname',
  adminSettingsTitle:'Oberfläche', adminSettingsDesc:'Dies sind die Voreinstellungen für den Abend; Nutzer können sie am eigenen Gerät überschreiben.',
  close:'Schließen', language:'Sprache', theme:'Design',
  userSettingsTitle:'Oberfläche', userSettingsDesc:'Diese Einstellungen gelten nur in diesem Browser.',
  themeSystem:'System folgen', themeLight:'Hell', themeDark:'Dunkel'
});
function adminLabel(key) {
  return (adminI18n[currentAdminLanguage()] || adminI18n.zh)[key] || key;
}
function nowPlayingMeta(song) {
  if (!song) return '';
  return adminLabel('requestedBy').replace('{singer}', song.singerName || '').replace('{channel}', song.channelTitle || '');
}
function displayHref() {
  // 大屏固定用 localhost —— 它只在跑服务的那台机器上打开。
  // 这样做的好处：大屏页面的 origin 永远是 localhost，后面的 /api/display/*
  // 都是同源请求，不会因为 127.0.0.1 / 局域网 IP 混用而被浏览器当成跨域。
  // 手机点歌用二维码地址（/join），跟这里无关。
  const port = location.port || '3000';
  return `http://localhost:${port}/display`;
}
const commonI18n = {
  zh: { joinEyebrow:'加入现场', joinDesc:'扫描大屏二维码后，在这里输入你的昵称。无需注册，浏览器会记住本次点歌会话。', nickname:'演唱者昵称', nicknamePlaceholder:'例如：小林', joinRoom:'进入点歌台 →', sessionTip:'Guest 名称不能重复，歌曲归属由临时会话识别。', controller:'手机点歌', changeName:'更换昵称', searchTitle:'搜索 YouTube', searchDesc:'支持搜索歌名，也可以直接粘贴 YouTube 链接。', searchPlaceholder:'搜索歌名，或粘贴 YouTube 链接', search:'搜索', searchStart:'输入关键词或粘贴链接开始', myQueue:'我的等待队列', quota:'每人最多', publicQueue:'公开后续队列', publicDesc:'所有参与者看到的播放顺序', syncing:'同步中', waiting:'等待播放', realtime:'实时同步', addSong:'点歌', noResults:'没有找到匹配歌曲', searching:'搜索中…', queueEmpty:'队列为空，来唱第一首吧', noSongs:'你还没有点歌', remove:'删除', currentEmpty:'当前还没有播放歌曲，点歌后会自动开始。', currentPlaying:'正在播放：', paused:'已暂停', preparing:'准备播放', playing:'播放中', added:'已加入等待队列', removed:'已从队列移除', duplicateSong:'你已经点过这首歌了', namePrompt:'请输入新的演唱者昵称', nameChanged:'昵称已更新，歌曲归属不变', notYou:'你不是', restartSession:'点击这里重新开始', scan:'扫码点歌', joinDisplay:'加入现场', scanDesc:'用手机扫描二维码，搜索并加入你的歌曲。', upNext:'接下来', welcome:'欢迎来到歌唱现场，扫描二维码点歌。', displayFooter:'播放器区域保持独立，不覆盖 YouTube 控件。DJ 可在控制台暂停、恢复、切歌与调节音量。', ready:'准备开始', idleTitle:'等你来唱', idleDesc:'点歌后，歌曲会自动出现在这里。', preparingEyebrow:'请稍等', preparingTitle:'处理中…', preparingDesc:'完成后会自动开始播放。', noNext:'暂无后续歌曲', playerFail:'播放器连接失败', playerFailDesc:'请检查展示台的网络连接，再由 DJ 手动切歌。', djBroadcast:'DJ 正在广播中', listenNotice:'请听取现场通知', resumeSoon:'即将恢复播放', resumeHint:'音乐将在倒计时结束后继续', queueNumber:'首', fullscreen:'全屏', exitFullscreen:'退出全屏', fullscreenFailed:'无法进入全屏' },
  en: { joinEyebrow:'JOIN THE ROOM', joinDesc:'Scan the display QR code and enter your name. No registration or app is required.', nickname:'Singer Name', nicknamePlaceholder:'e.g. Lin', joinRoom:'Enter Controller →', sessionTip:'Guest names must be unique; song ownership is tied to your temporary session.', controller:'GUEST CONTROLLER', changeName:'Change Name', searchTitle:'Search YouTube', searchDesc:'Search by song or paste a YouTube link directly.', searchPlaceholder:'Search a song or paste a YouTube link', search:'Search', searchStart:'Type a keyword or paste a link to start', myQueue:'My Waiting Queue', quota:'Max per guest', publicQueue:'Public Queue', publicDesc:'The playback order visible to everyone', syncing:'Syncing', waiting:'Waiting', realtime:'Live sync', addSong:'Add Song', noResults:'No matching songs found', searching:'Searching…', queueEmpty:'The queue is empty. Be the first to sing.', noSongs:'You have not added a song yet', remove:'Remove', currentEmpty:'Nothing is playing. Add a song to start.', currentPlaying:'Now playing:', paused:'Paused', preparing:'Preparing', playing:'Playing', added:'Added to the queue', removed:'Removed from the queue', duplicateSong:'You have already chosen this song', myQueue:'My Waiting Queue', quota:'Max per guest', publicQueue:'Public Queue', publicDesc:'The playback order visible to everyone', namePrompt:'Enter a new singer name', nameChanged:'Name updated; your song ownership is unchanged', notYou:'Not', restartSession:'click here to start over', scan:'SCAN TO SING', joinDisplay:'Join the Room', scanDesc:'Scan with your phone to search and join a song.', prepareFailed:'Preparation failed', prepareFailedDesc:'This local track could not be prepared. Please ask the DJ to skip it or re-import it.', unplayable:'This video cannot be embedded', unplayableDesc:'Skipping to the next song…', trackMissing:'This song is not in the local library', trackMissingDesc:'Please ask the DJ to import it again, or skip to the next song.', vocal:'Vocal', vocalLevel:'Vocal level', vocalOriginal:'Original', vocalGuide:'Guide vocal', instrumental:'Instrumental', vocalOriginalTitle:'Original track: vocals at 100%', vocalGuideTitle:'Guide vocal: vocals at 25%', instrumentalTitle:'Instrumental: no vocals', lyricsModeSwitchTitle:'Switch lyric display (word by word / line by line)', lyricsModeSwitchHint:'Switch lyric display (word by word / line by line)', lyricsToLine:'Switch to line-by-line', lyricsToWord:'Switch to word-by-word', lyricsNowWord:'Word-by-word highlighting is on — tap for line-by-line', lyricsNowLine:'Line-by-line highlighting is on — tap for word-by-word', tapToStart:'Tap anywhere to start playback', connectionFailed:'Cannot reach the service', reload:'Reload', upNext:'UP NEXT', welcome:'Welcome to the show! Scan the QR code to pick a song.', displayFooter:'The player area stays independent and never covers the YouTube controls. The DJ can pause, resume, skip, and adjust the volume from the console.', ready:'READY WHEN YOU ARE', idleTitle:'Your turn to sing', idleDesc:'Choose a song and it will appear here.', preparingEyebrow:'PLEASE WAIT', preparingTitle:'Preparing…', preparingDesc:'Playback starts automatically when it is ready.', noNext:'No songs coming up', playerFail:'Player connection failed', playerFailDesc:'Check the display network, then let the DJ skip the song.', djBroadcast:'DJ IS BROADCASTING', listenNotice:'Please listen to the live announcement', resumeSoon:'Playback resumes soon', resumeHint:'Music will continue after the countdown', queueNumber:'songs', fullscreen:'Fullscreen', exitFullscreen:'Exit Fullscreen', fullscreenFailed:'Fullscreen is not available' },
  de: { joinEyebrow:'BEITRETEN', joinDesc:'QR-Code auf der Anzeige scannen und Namen eingeben. Keine Registrierung und keine App nötig.', nickname:'Sängername', nicknamePlaceholder:'z. B. Lin', joinRoom:'Zur Steuerung →', sessionTip:'Guest-Namen müssen eindeutig sein; die Zuordnung erfolgt über die temporäre Sitzung.', controller:'GÄSTE-STEUERUNG', changeName:'Namen ändern', myQueue:'Meine Warteschlange', quota:'Max. pro Gast', publicQueue:'Öffentliche Warteschlange', publicDesc:'Die für alle sichtbare Wiedergabereihenfolge', searchTitle:'YouTube durchsuchen', searchDesc:'Nach Songs suchen oder direkt einen YouTube-Link einfügen.', searchPlaceholder:'Song suchen oder YouTube-Link einfügen', search:'Suchen', searchStart:'Suchbegriff oder Link eingeben', syncing:'Synchronisierung', waiting:'Warten', realtime:'Live-Synchronisierung', addSong:'Hinzufügen', noResults:'Keine passenden Songs gefunden', searching:'Suche läuft…', queueEmpty:'Die Warteschlange ist leer. Singe den ersten Song.', noSongs:'Noch kein Song ausgewählt', remove:'Entfernen', currentEmpty:'Keine Wiedergabe. Füge einen Song hinzu.', currentPlaying:'Aktuelle Wiedergabe:', paused:'Pausiert', preparing:'Wird vorbereitet', playing:'Läuft', added:'Zur Warteschlange hinzugefügt', removed:'Aus der Warteschlange entfernt', duplicateSong:'Du hast diesen Song bereits ausgewählt', myQueue:'Meine Warteschlange', quota:'Max. pro Gast', publicQueue:'Öffentliche Warteschlange', publicDesc:'Die für alle sichtbare Wiedergabereihenfolge', namePrompt:'Neuen Sängernamen eingeben', nameChanged:'Name geändert; deine Songzuordnung bleibt erhalten', notYou:'Nicht', restartSession:'hier klicken, um neu zu beginnen', scan:'ZUM SINGEN SCANNEN', joinDisplay:'Beitreten', scanDesc:'Mit dem Handy scannen, Song suchen und beitreten.', prepareFailed:'Vorbereitung fehlgeschlagen', prepareFailedDesc:'Dieser lokale Titel konnte nicht vorbereitet werden. Bitte den DJ überspringen oder neu importieren lassen.', unplayable:'Dieses Video lässt sich nicht einbetten', unplayableDesc:'Nächster Song wird geladen…', trackMissing:'Dieser Song fehlt in der lokalen Bibliothek', trackMissingDesc:'Bitte den DJ den Titel neu importieren lassen oder zum nächsten Song springen.', vocal:'Gesang', vocalLevel:'Gesangsanteil', vocalOriginal:'Original', vocalGuide:'Führung', instrumental:'Instrumental', vocalOriginalTitle:'Original: Gesang 100 %', vocalGuideTitle:'Führung: Gesang 25 %', instrumentalTitle:'Instrumental: Gesang 0 %', lyricsModeSwitchTitle:'Lyrik-Anzeige umschalten (Wort für Wort / Zeile für Zeile)', lyricsModeSwitchHint:'Lyrik-Anzeige umschalten (Wort für Wort / Zeile für Zeile)', lyricsToLine:'Zu Zeile für Zeile', lyricsToWord:'Zu Wort für Wort', lyricsNowWord:'Wort für Wort ist markiert – tippen für Zeile für Zeile', lyricsNowLine:'Zeile für Zeile ist markiert – tippen für Wort für Wort', tapToStart:'Tippe irgendwo, um die Wiedergabe zu starten', connectionFailed:'Keine Verbindung zum Dienst', reload:'Neu laden', upNext:'ALS NÄCHSTES', welcome:'Willkommen. QR-Code scannen und Song auswählen.', displayFooter:'Der Player bleibt unabhängig, damit YouTube-Steuerelemente sichtbar bleiben. Der DJ steuert die Wiedergabe.', ready:'BEREIT', idleTitle:'Du bist dran', idleDesc:'Wähle einen Song, dann erscheint er hier.', preparingEyebrow:'BITTE WARTEN', preparingTitle:'Wird vorbereitet…', preparingDesc:'Die Wiedergabe startet automatisch, sobald er fertig ist.', noNext:'Keine weiteren Songs', playerFail:'Player-Verbindung fehlgeschlagen', playerFailDesc:'Netzwerk der Anzeige prüfen und den Song vom DJ überspringen lassen.', djBroadcast:'DJ SPRICHT', listenNotice:'Bitte der Live-Durchsage zuhören', resumeSoon:'Wiedergabe startet gleich', resumeHint:'Die Musik läuft nach dem Countdown weiter', queueNumber:'Songs', fullscreen:'Vollbild', exitFullscreen:'Vollbild verlassen', fullscreenFailed:'Vollbild ist nicht verfügbar' }
};
Object.assign(commonI18n.zh, { karaokeSearch:'搜索 Karaoke 版本', moveUp:'上移', moveDown:'下移', moveNotQueued:'这首歌已经不在等待队列中（可能刚开始播放），刷新后再试', quotaStatus:'{n} 首 · 每人最多 {max} 首', serverOutdated:'服务端版本过旧，请让 DJ 重启服务后再试', secondsAgo:'{n} 秒前', minutesAgo:'{n} 分钟前', requestFailed:'请求失败', searchTitleLocal:'搜索歌曲（Spotify）', searchDescLocal:'搜索 Spotify 曲库，点歌后自动准备伴奏（未下载的会自动下载并分离）。', searchPlaceholderLocal:'搜索歌名，例如：晴天 周杰伦', searchStartLocal:'输入关键词开始搜索', greeting:'你好，{name}。搜索一首想唱的歌，加入现场队列。', addedPreparing:'已加入，正在后台制作', spotifyUnavailable:'Spotify 搜索不可用：{reason}', spotifyUnavailableShort:'Spotify 搜索不可用', queueStatusPreparing:'准备中', queueStatusPrepareFailed:'准备失败', queueStatusReady:'已就绪', prepareFailed:'制作失败', adminLoginTitle:'现场控制台', adminLoginDesc:'登录后管理播放状态、等待队列、活动参数和大屏广播。', djPassword:'DJ 密码', adminPasswordPlaceholder:'输入现场密码', enterConsole:'进入控制台 →', adminDemoPassword:'本地演示默认密码：karaok-admin。生产环境请通过 DJ_PASSWORD 环境变量设置。', libraryTitle:'曲库管理', libraryLoginDesc:'需要 DJ 权限才能查看和处理曲库。', enterLibrary:'进入曲库 →', backToConsole:'返回控制台' });
Object.assign(commonI18n.en, { karaokeSearch:'Search for Karaoke Version', moveUp:'Move up', moveDown:'Move down', moveNotQueued:'This song is no longer in the waiting queue (it may have started playing). Refresh and try again.', quotaStatus:'{n} songs · max {max} per guest', serverOutdated:'The server is running an older version. Please ask the DJ to restart the service.', secondsAgo:'{n}s ago', minutesAgo:'{n} min ago', requestFailed:'Request failed', searchTitleLocal:'Search Songs (Spotify)', searchDescLocal:'Search the Spotify catalog. We prepare the backing track automatically and download plus separate anything that is missing.', searchPlaceholderLocal:'Search a song, e.g. Umbrella Rihanna', searchStartLocal:'Type a keyword to start searching', greeting:'Hi {name}. Search for a song you want to sing and add it to the queue.', addedPreparing:'Added — preparing your track in the background', spotifyUnavailable:'Spotify search is unavailable: {reason}', spotifyUnavailableShort:'Spotify search is unavailable', queueStatusPreparing:'Preparing', queueStatusPrepareFailed:'Preparation failed', queueStatusReady:'Ready', prepareFailed:'Preparation failed', adminLoginTitle:'Control Desk', adminLoginDesc:'Sign in to manage playback, the waiting queue, event settings, and display broadcasts.', djPassword:'DJ Password', adminPasswordPlaceholder:'Enter the DJ password', enterConsole:'Open Console →', adminDemoPassword:'Demo password: karaok-admin. Set DJ_PASSWORD for real use.', libraryTitle:'Library', libraryLoginDesc:'DJ permissions are required to view and manage the library.', enterLibrary:'Open Library →', backToConsole:'Back to Console' });
Object.assign(commonI18n.de, { karaokeSearch:'Nach Karaoke-Version suchen', moveUp:'Nach oben', moveDown:'Nach unten', moveNotQueued:'Dieser Song ist nicht mehr in der Warteschlange (evtl. schon gestartet). Bitte neu laden.', quotaStatus:'{n} Songs · max. {max} pro Gast', serverOutdated:'Der Server läuft mit einer älteren Version. Bitte den DJ den Dienst neu starten lassen.', secondsAgo:'vor {n} s', minutesAgo:'vor {n} Min.', requestFailed:'Anfrage fehlgeschlagen', searchTitleLocal:'Songs suchen (Spotify)', searchDescLocal:'Spotify-Katalog durchsuchen. Die Playback-Spur wird automatisch vorbereitet; fehlende Titel werden heruntergeladen und getrennt.', searchPlaceholderLocal:'Song suchen, z. B. Umbrella Rihanna', searchStartLocal:'Suchbegriff eingeben, um die Suche zu starten', greeting:'Hallo {name}. Suche einen Song, den du singen möchtest, und füge ihn zur Warteschlange hinzu.', addedPreparing:'Hinzugefügt – dein Track wird im Hintergrund vorbereitet', spotifyUnavailable:'Spotify-Suche nicht verfügbar: {reason}', spotifyUnavailableShort:'Spotify-Suche nicht verfügbar', queueStatusPreparing:'Wird vorbereitet', queueStatusPrepareFailed:'Vorbereitung fehlgeschlagen', queueStatusReady:'Bereit', prepareFailed:'Erstellung fehlgeschlagen', adminLoginTitle:'Steuerzentrale', adminLoginDesc:'Anmelden, um Wiedergabe, Warteschlange, Event-Einstellungen und Anzeige-Durchsagen zu verwalten.', djPassword:'DJ-Passwort', adminPasswordPlaceholder:'DJ-Passwort eingeben', enterConsole:'Konsole öffnen →', adminDemoPassword:'Demo-Passwort: karaok-admin. Für den Einsatz bitte DJ_PASSWORD setzen.', libraryTitle:'Bibliothek', libraryLoginDesc:'Zum Anzeigen und Verwalten der Bibliothek sind DJ-Rechte erforderlich.', enterLibrary:'Bibliothek öffnen →', backToConsole:'Zurück zur Konsole' });
Object.assign(commonI18n.zh, { prepareFailed:'制作失败', prepareFailedDesc:'这首本地曲目处理失败，请让 DJ 跳过或重新导入。', trackMissing:'本地曲库中没有这首歌', trackMissingDesc:'请让 DJ 重新导入，或跳到下一首。', vocal:'人声', vocalLevel:'人声强度', vocalOriginal:'原唱', vocalGuide:'人声导唱', instrumental:'伴奏', vocalOriginalTitle:'原唱：人声 100%', vocalGuideTitle:'人声导唱：人声 25%', instrumentalTitle:'伴奏：人声 0%', lyricsModeSwitchTitle:'切换歌词显示方式（逐字 / 逐行）', lyricsModeSwitchHint:'切换歌词显示方式（逐字 / 逐行）', lyricsToLine:'切到逐行', lyricsToWord:'切到逐字', lyricsNowWord:'当前逐字高亮，点击改为整行高亮', lyricsNowLine:'当前整行高亮，点击改为逐字高亮', tapToStart:'点击任意位置开始播放', connectionFailed:'无法连接服务', reload:'重新加载' });
Object.assign(commonI18n.zh, { notEmbeddable:'这个视频不允许嵌入播放，请换一个', unplayable:'这首歌无法嵌入播放', unplayableDesc:'正在跳到下一首…' });
Object.assign(commonI18n.en, { notEmbeddable:'This video does not allow embedding. Please pick another one.', unplayable:'This video cannot be embedded', unplayableDesc:'Skipping to the next song…' });
Object.assign(commonI18n.de, { notEmbeddable:'Dieses Video erlaubt kein Einbetten. Bitte ein anderes wählen.', unplayable:'Dieses Video lässt sich nicht einbetten', unplayableDesc:'Nächster Song wird geladen…' });
// Admin 设置弹窗里用到、但此前只存在于 adminI18n 的 key（localeText 查的是 commonI18n）
Object.assign(commonI18n.zh, { language:'语言', guestTimeout:'Guest 超时（分钟）', guestTimeoutHint:'超过该时间没有点歌且没有排队歌曲时自动移除；有活动歌曲不会清理。' });
Object.assign(commonI18n.en, { language:'Language', guestTimeout:'Guest inactivity (minutes)', guestTimeoutHint:'Remove after this time without a new song, only when no songs are queued or playing.' });
Object.assign(commonI18n.de, { language:'Sprache', guestTimeout:'Guest-Inaktivität (Minuten)', guestTimeoutHint:'Nach dieser Zeit ohne neuen Song entfernen, sofern keine Songs warten oder laufen.' });
Object.assign(commonI18n.zh, { eventName:'活动名称', standby:'待机', transition:'切歌中', localLibrary:'本地曲库', importantOnAir:'重要广播中', settingsButton:'设置', adminSettingsTitle:'界面设置', adminSettingsDesc:'这里设置现场默认，用户可在自己的设备上单独覆盖', close:'关闭', themeSystem:'跟随系统', themeDay:'白天', themeNight:'夜间', playbackScreen:'播放画面', playbackModeVideo:'视频（YouTube）', playbackModeLyrics:'歌词（仿 Apple Music）', playbackScreenHint:'视频：1080p 视频 + 两行歌词；歌词：仿 Apple Music 滚动歌词。切换后大屏会重新挂载播放器', showTranslation:'显示歌词翻译', showTranslationHint:'关闭后大屏只显示原文' , prepareFailedDesc: '这首本地曲目处理失败，请让 DJ 跳过或重新导入。', trackMissing: '本地曲库中没有这首歌', trackMissingDesc: '请让 DJ 重新导入，或跳到下一首。', vocal: '人声', vocalLevel: '人声强度', vocalOriginal: '原唱', vocalGuide: '人声导唱', instrumental: '伴奏', vocalOriginalTitle: '原唱：人声 100%', vocalGuideTitle: '人声导唱：人声 25%', instrumentalTitle: '伴奏：人声 0%', lyricsModeSwitchTitle: '切换歌词显示方式（逐字 / 逐行）', lyricsModeSwitchHint: '当前逐字高亮，点击改为整行高亮', lyricsToLine: '切到逐行', lyricsToWord: '切到逐字', lyricsNowWord: '当前逐字高亮，点击改为整行高亮', lyricsNowLine: '当前整行高亮，点击改为逐字高亮', tapToStart: '点击任意位置开始播放', connectionFailed: '无法连接服务', reload: '重新加载' });
Object.assign(commonI18n.en, { eventName:'Event Name', standby:'Idle', transition:'Switching', localLibrary:'Local Library', importantOnAir:'Important Broadcast On Air', settingsButton:'Settings', adminSettingsTitle:'Interface Settings', adminSettingsDesc:'These are the room defaults. Guests can override them on their own devices.', close:'Close', themeSystem:'Follow system', themeDay:'Light', themeNight:'Dark', playbackScreen:'Playback Screen', playbackModeVideo:'Video (YouTube)', playbackModeLyrics:'Lyrics (Apple Music style)', playbackScreenHint:'Video: 1080p with two lyric lines. Lyrics: Apple Music–style scrolling lyrics. Switching reloads the player on the display.', showTranslation:'Show lyric translations', showTranslationHint:'When off, the display shows the original lyrics only' });
Object.assign(commonI18n.de, { eventName:'Eventname', standby:'Standby', transition:'Übergang', localLibrary:'Lokale Bibliothek', importantOnAir:'Wichtige Durchsage läuft', settingsButton:'Einstellungen', adminSettingsTitle:'Oberfläche', adminSettingsDesc:'Hier den Raumstandard festlegen. Gäste können ihn auf ihren Geräten überschreiben.', close:'Schließen', themeSystem:'System folgen', themeDay:'Hell', themeNight:'Dunkel', playbackScreen:'Wiedergabebildschirm', playbackModeVideo:'Video (YouTube)', playbackModeLyrics:'Songtext (im Apple-Music-Stil)', playbackScreenHint:'Video: 1080p mit zwei Songtextzeilen. Songtext: mitlaufender Text im Apple-Music-Stil. Beim Wechsel lädt die Anzeige den Player neu.', showTranslation:'Übersetzungen der Songtexte anzeigen', showTranslationHint:'Wenn aus, zeigt die Anzeige nur den Originaltext' });
// ---------------------------------------------------------------- 曲库管理页（renderLibraryApp / 表格 / 歌词重匹配）
// ---------------------------------------------------------------- 曲库管理页文案
// 原先这里是一个独立的 libraryI18n 字典；为了不让 i18n 出现两套机制，
// 已把这些 key 并入 commonI18n（localeText 读的那份），libraryText 只作兼容包装。
Object.assign(commonI18n.zh, { libEyebrow:'LIBRARY · 模式 B', libIntro:'所有曲目的处理状态、耗时、文件大小与匹配分。点歌触发的下载与分离会在这里实时显示阶段。', libLoading:'正在读取曲库…', libOpenDisplay:'打开大屏 ↗', libRematchTitle:'重新匹配歌词', libClose:'关闭', libTrackTitle:'歌名', libTrackArtist:'歌手', libArtistsHint:'多个歌手用逗号分隔', libRematchHint:'改动只影响歌词搜索，不会改曲库里的曲目信息。', libRematchSearch:'搜索歌词', libCancel:'取消', libTitleRequired:'歌名不能为空', libSearchingLyrics:'搜索中…', libMatched:'✅ 匹配成功：{provider} · {kind} · {lines} 行', libLyricsUpdated:'歌词已更新，播放时立即生效', libNoLyricsFound:'❌ 没搜到歌词。试试把歌名改得更短、或换一种写法（比如去掉括号里的后缀）。', libRematchFailed:'❌ 失败：{error}', libUnknownError:'未知错误', libNoLyrics:'无歌词', libWordLevel:'逐字', libLineLevel:'行级', libPlainText:'纯文本', libStatusProcessed:'已处理', libStatusProcessing:'处理中', libStatusPending:'待处理', libStatusFailed:'处理失败', libStatusCanceled:'已取消', libQueued:'排队中', libUnavailable:'曲库不可用：', libHeading:'曲库管理', libDesc:'每首歌的处理状态、耗时、文件大小与匹配分。点歌触发的下载/分离会在这里显示实时阶段。', libSummary:'{total} 首 · 已处理 {processed} · 处理中 {processing} · 待处理 {pending} · 失败 {failed}', libFilterPlaceholder:'按歌名 / 歌手 / 专辑筛选', libRefresh:'刷新', libColTrack:'曲目', libColStatus:'状态', libColLyrics:'歌词', libColDuration:'耗时', libColSize:'大小', libColMatch:'匹配分', libColActions:'操作', libErrorReason:'原因：', libStop:'停止', libStopTitle:'中止后台制作（仅 DJ）', libRematchShort:'改词重搜', libRematchShortTitle:'改歌名/歌手后重新搜歌词', libDelete:'删除', libDeleteTitle:'从曲库删除（含产物文件）', libEmpty:'没有匹配的曲目', libDeleteConfirm:'从曲库删除「{title}」？会同时删除成品音频、视频、封面、歌词和原始下载文件。', libDeleted:'已删除', libDeleteOutdated:'服务端版本过旧，请重启服务后再试', libAbortConfirm:'中止这个后台制作任务？已生成的中间产物会保留，下次点歌会继续跑。', libAborted:'已中止', qrAlt: '点歌二维码', liveMessage: '现场消息', videoLyricsOn: '视频歌词：开', videoLyricsOff: '视频歌词：关', wordLevelTitle: '当前行按字逐个点亮', wordLevelUnavailable: '这首歌的歌词没有逐字数据（只有行级时间轴），切到逐字也不会有变化', libCleanup:'清理残留', libCleanupTitle:'清理残留文件', libCleanupDesc:'扫描曲库，找出已删除歌曲遗留的产物文件', libScanning:'扫描中…', libCleanupEmpty:'没有发现残留文件，曲库是干净的', libCleanupSummary:'发现 {count} 项残留，共 {size}', libCleanupHint:'只列出数据库里已无对应记录的产物。正在制作的歌曲不会出现在这里。', libCleanupSelectAll:'全选', libCleanupDeselectAll:'全不选', libCleanupConfirm:'确定删除选中的 {count} 项？共 {size}，删除后不可恢复。', libCleanupRunning:'清理中…', libCleanupDone:'已清理 {count} 项，释放 {size}', libCleanupPartial:'清理完成：成功 {removed} 项，跳过 {skipped} 项，失败 {failed} 项', libCleanupManifest:'删除清单已保存到 data/ 目录', libScanFailed:'扫描失败：{error}', libCleanupFailed:'清理失败：{error}', libGroupOutput:'成品音频 / 视频', libGroupCovers:'封面', libGroupLyrics:'歌词文件', libGroupUpstream:'原始下载', libGroupOverrides:'歌词覆盖', libCleanupActive:'有 {count} 首歌正在制作，其产物已自动排除', libCleanupGroupItems:'{count} 项 · {size}' });
Object.assign(commonI18n.zh, { libColMv:"MV", libMvShort:"MV", libMvShortTitle:"查看/更换官方 MV（视频模式背景）", libMvTitle:"官方 MV（背景画面）", libMvHint:"官方 MV 只在视频模式里作为静音背景在线播放（YouTube IFrame），不会下载，也不影响本地 MP3 音频。找不到或不可用时会自动换成模糊专辑封面。", libMvLoading:"读取中…", libMvSearch:"重新搜索", libMvSearching:"正在 YouTube 搜索官方 MV…", libMvScore:"评分", libMvPreview:"预览", libMvUse:"选用", libMvConfirm:"确认这个 MV", libMvClear:"清除", libMvClearConfirm:"清除这首歌的 MV？视频模式会改用模糊专辑封面。", libMvCleared:"已清除", libMvSaved:"✅ 已保存并标记为「已确认」", libMvNeedId:"请填写 YouTube videoId 或链接", libMvManualLabel:"手动指定 YouTube videoId", libMvSave:"保存", libMvCandidates:"候选视频", libMvCandidatesHint:"已自动选用最高分；想换就点「选用」，之后自动匹配不会再改动你的选择。", libMvNoCandidates:"还没有候选。点「重新搜索」从 YouTube 找官方 MV。", libMvNone:"没有 MV（播放时用专辑封面）", libMvNoKey:"没有配置 YouTube API Key：自动匹配被跳过，只能手动填 videoId。", libMvAuto:"自动匹配", libMvManual:"已确认", libMvPending:"待确认", libMvUnavailable:"不可用", libMvNotFound:"未找到", libMvAutoDone:"✅ 高置信度，已自动采用", libMvPendingDone:"✅ 已自动选用最高分（置信度一般，可在下面换）", libMvNotFoundDone:"没有找到可用的 MV（视频模式会用模糊专辑封面）" });
Object.assign(commonI18n.zh, { libMvFilterTitle:"只看某个 MV 状态的曲目", libMvFilterAll:"MV：全部" });
Object.assign(commonI18n.zh, { libMvSourceYtmTitle:"来自 YouTube Music（ytmusicapi），不消耗官方 API 配额" });
Object.assign(commonI18n.en, { libMvSourceYtmTitle:"From YouTube Music (ytmusicapi) — no official API quota used" });
Object.assign(commonI18n.de, { libMvSourceYtmTitle:"Von YouTube Music (ytmusicapi) — kein offizielles API-Kontingent" });
// ── 伴奏响度均衡（Admin Settings + 曲库页）──
Object.assign(commonI18n.zh, {
  loudnessSection:"伴奏响度均衡", loudnessAuto:"自动均衡伴奏响度",
  loudnessAutoHint:"按测得的 LUFS 实时补增益；关闭后所有歌都用原始电平",
  loudnessTarget:"目标响度（LUFS）", loudnessPeakCeiling:"真峰值上限（dBFS）",
  loudnessMaxGain:"最大增益（dB）", loudnessMaxCut:"最大衰减（dB）",
  loudnessHint:"只影响播放增益，不改动任何音频文件。没测过响度的歌保持原始电平。",
  loudnessMeasureBtn:"补测响度（缺 {n}）", loudnessMeasureTitle:"用 ffmpeg 测出缺失的伴奏 LUFS / 真峰值（串行跑，不影响播放）",
  loudnessMeasureStarted:"已开始补测 {n} 首伴奏响度", loudnessMeasureNothing:"没有需要补测的歌曲",
  loudnessMeasureUnavailable:"响度测量不可用：找不到 ffmpeg 或 Python",
  loudnessColTitle:"伴奏响度（LUFS / 真峰值 / 补偿）", loudnessNone:"未测",
});
Object.assign(commonI18n.en, {
  loudnessSection:"Accompaniment loudness", loudnessAuto:"Auto-normalize accompaniment loudness",
  loudnessAutoHint:"Applies gain from the measured LUFS in real time; off = original levels",
  loudnessTarget:"Target loudness (LUFS)", loudnessPeakCeiling:"True peak ceiling (dBFS)",
  loudnessMaxGain:"Max gain (dB)", loudnessMaxCut:"Max cut (dB)",
  loudnessHint:"Playback gain only — no audio file is modified. Tracks without a measurement keep their level.",
  loudnessMeasureBtn:"Loudness ({n} missing)", loudnessMeasureTitle:"Measure missing LUFS / true peak with ffmpeg (sequential, does not affect playback)",
  loudnessMeasureStarted:"Started measuring loudness for {n} tracks", loudnessMeasureNothing:"Nothing to measure",
  loudnessMeasureUnavailable:"Loudness measurement unavailable: ffmpeg or Python not found",
  loudnessColTitle:"Accompaniment loudness (LUFS / true peak / gain)", loudnessNone:"not measured",
});
Object.assign(commonI18n.de, {
  loudnessSection:"Lautst\u00e4rke der Begleitung", loudnessAuto:"Lautst\u00e4rke automatisch angleichen",
  loudnessAutoHint:"Gewinn wird live aus dem gemessenen LUFS berechnet; aus = Originalpegel",
  loudnessTarget:"Ziel-Lautst\u00e4rke (LUFS)", loudnessPeakCeiling:"True-Peak-Obergrenze (dBFS)",
  loudnessMaxGain:"Max. Verst\u00e4rkung (dB)", loudnessMaxCut:"Max. Absenkung (dB)",
  loudnessHint:"Nur Wiedergabe-Gewinn \u2013 keine Audiodatei wird ver\u00e4ndert. Nicht gemessene Titel bleiben unver\u00e4ndert.",
  loudnessMeasureBtn:"Lautst\u00e4rke ({n})", loudnessMeasureTitle:"Fehlende LUFS / True Peak mit ffmpeg messen (sequenziell, ohne Unterbrechung)",
  loudnessMeasureStarted:"Messung f\u00fcr {n} Titel gestartet", loudnessMeasureNothing:"Nichts zu messen",
  loudnessMeasureUnavailable:"Messung nicht verf\u00fcgbar: ffmpeg oder Python fehlt",
  loudnessColTitle:"Lautst\u00e4rke der Begleitung (LUFS / True Peak / Gewinn)", loudnessNone:"nicht gemessen",
});
Object.assign(commonI18n.zh, { libMvRateLimited:"⏳ YouTube 暂时限流（429），MV 搜索已暂停，稍后会自动恢复重试" });
Object.assign(commonI18n.zh, { libMatchStart:"一键匹配（缺 {mv} MV · {lyrics} 歌词）", libMatchTitle:"后台串行补齐缺失的官方 MV 与歌词（低并发，避免 YouTube 限流）", libMatchRunning:"正在后台匹配 {done}/{total}", libMatchOk:"成功", libMatchSkip:"跳过", libMatchFail:"失败", libMatchCancel:"停止", libMatchCanceled:"已停止后台匹配", libMatchStarted:"已开始后台匹配 {count} 首", libMatchNothing:"没有需要匹配的歌曲", libMatchBusy:"已经有一批匹配任务在跑了", libMatchLast:"上次", libMatchRateLimited:"YouTube 暂时限流，稍后再试" });
Object.assign(commonI18n.zh, { libMatchRateLimitedAt:"YouTube 限流中，{sec} 秒后自动恢复" });
Object.assign(commonI18n.zh, { libMatchQuotaOut:"今天 YouTube 搜索配额已用完，明天会自动恢复" });
// 配额/限流时的**二次确认**文案（红色按钮点下去之后弹的那个）
Object.assign(commonI18n.zh, {
  libMatchForceQuota:"YouTube 官方 API 今日配额已用完，继续匹配大概率会全部跳过。仍要强行重试？",
  libMatchForceQuotaYtm:"YouTube 官方 API 今日配额已用完。将改用 YouTube Music 源（无配额限制）继续匹配。是否继续？",
  libMatchForceRate:"YouTube 正在限流（{sec} 秒后自动恢复），现在匹配大概率会全部跳过。仍要强行重试？",
  libMatchForceRateYtm:"YouTube 正在限流（{sec} 秒后自动恢复）。将改用 YouTube Music 源（无配额限制）继续匹配。是否继续？",
  libMatchStillBlocked:"还是没能启动：YouTube 官方 API 仍然受限",
  libMatchQuotaHint:"配额受限",
});
Object.assign(commonI18n.en, { libEyebrow:'LIBRARY · MODE B', libIntro:'Processing status, processing time, file size, and match score for every track. Downloads and separations triggered by song requests update here in real time.', libLoading:'Loading library…', libOpenDisplay:'Open Display ↗', libRematchTitle:'Re-match Lyrics', libClose:'Close', libTrackTitle:'Song title', libTrackArtist:'Artist', libArtistsHint:'Separate multiple artists with commas', libRematchHint:'Only the lyrics search changes; the track details in the library stay as they are.', libRematchSearch:'Search Lyrics', libCancel:'Cancel', libTitleRequired:'Please enter a song title', libSearchingLyrics:'Searching…', libMatched:'✅ Match found: {provider} · {kind} · {lines} lines', libLyricsUpdated:'Lyrics updated and active for the next playback', libNoLyricsFound:'❌ No lyrics found. Try a shorter song title or a different spelling (for example, drop the text in brackets).', libRematchFailed:'❌ Failed: {error}', libUnknownError:'unknown error', libNoLyrics:'No lyrics', libWordLevel:'Word-level', libLineLevel:'Line-level', libPlainText:'Plain text', libStatusProcessed:'Processed', libStatusProcessing:'Processing', libStatusPending:'Pending', libStatusFailed:'Failed', libStatusCanceled:'Canceled', libQueued:'Queued', libUnavailable:'Library unavailable: ', libHeading:'Library Management', libDesc:'Processing status, processing time, file size, and match score for every song. Downloads and separations from song requests show their live stage here.', libSummary:'{total} tracks · Processed {processed} · Processing {processing} · Pending {pending} · Failed {failed}', libFilterPlaceholder:'Filter by title / artist / album', libRefresh:'Refresh', libColTrack:'Track', libColStatus:'Status', libColLyrics:'Lyrics', libColDuration:'Time', libColSize:'Size', libColMatch:'Match', libColActions:'Actions', libErrorReason:'Reason: ', libStop:'Stop', libStopTitle:'Cancel background processing (DJ only)', libRematchShort:'Re-search', libRematchShortTitle:'Edit title or artist and search for lyrics again', libDelete:'Delete', libDeleteTitle:'Delete from library (including generated files)', libEmpty:'No matching tracks', libDeleteConfirm:'Delete “{title}” from the library? This also removes the finished audio, video, cover, lyrics, and source download.', libDeleted:'Deleted', libDeleteOutdated:'The server is running an older version. Please restart the service and try again.', libAbortConfirm:'Cancel this background processing job? Intermediate files are kept and processing resumes the next time the song is requested.', libAborted:'Stopped', qrAlt: 'QR code to choose a song', liveMessage: 'Live message', videoLyricsOn: 'Video lyrics: on', videoLyricsOff: 'Video lyrics: off', wordLevelTitle: 'Current line lights up word by word', wordLevelUnavailable: 'This song has no word-level lyrics (line timing only), so word mode will look the same', libCleanup:'Clean leftovers', libCleanupTitle:'Clean up leftover files', libCleanupDesc:'Scan the library for files left behind by deleted songs', libScanning:'Scanning…', libCleanupEmpty:'No leftover files found — the library is clean', libCleanupSummary:'Found {count} leftover items, {size} in total', libCleanupHint:'Only files with no matching database record are listed. Songs currently being processed never appear here.', libCleanupSelectAll:'Select all', libCleanupDeselectAll:'Deselect all', libCleanupConfirm:'Delete the selected {count} items? {size} in total. This cannot be undone.', libCleanupRunning:'Cleaning…', libCleanupDone:'Removed {count} items, freed {size}', libCleanupPartial:'Done: {removed} removed, {skipped} skipped, {failed} failed', libCleanupManifest:'A manifest of deleted files was saved under data/', libScanFailed:'Scan failed: {error}', libCleanupFailed:'Cleanup failed: {error}', libGroupOutput:'Audio / video output', libGroupCovers:'Cover art', libGroupLyrics:'Lyrics files', libGroupUpstream:'Raw downloads', libGroupOverrides:'Lyrics overrides', libCleanupActive:'{count} song(s) are being processed — their files are excluded', libCleanupGroupItems:'{count} items · {size}' });
Object.assign(commonI18n.en, { libMvFilterTitle:"Show only tracks with a given MV status", libMvFilterAll:"MV: all" });
Object.assign(commonI18n.en, { libMvRateLimited:"⏳ YouTube is rate-limiting (429). MV search paused; it retries automatically." });
Object.assign(commonI18n.en, { libMatchStart:"Match ({mv} MV · {lyrics} lyrics missing)", libMatchTitle:"Fill in missing official MVs and lyrics in the background (sequential, low concurrency)", libMatchRunning:"Matching in background {done}/{total}", libMatchOk:"done", libMatchSkip:"skipped", libMatchFail:"failed", libMatchCancel:"Stop", libMatchCanceled:"Background matching stopped", libMatchStarted:"Started background matching for {count} tracks", libMatchNothing:"Nothing to match", libMatchBusy:"A matching job is already running", libMatchLast:"Last run", libMatchRateLimited:"YouTube is rate-limiting — try again later" });
Object.assign(commonI18n.en, { libMatchRateLimitedAt:"YouTube is rate-limiting — recovers automatically in {sec}s" });
Object.assign(commonI18n.en, { libMatchQuotaOut:"YouTube\u0027s daily search quota is used up today; it resets tomorrow" });
Object.assign(commonI18n.en, {
  libMatchForceQuota:"YouTube\u0027s official API quota is used up today. Retrying now will most likely skip everything. Force retry anyway?",
  libMatchForceQuotaYtm:"YouTube\u0027s official API quota is used up today. Matching will fall back to the YouTube Music source (no quota limit). Continue?",
  libMatchForceRate:"YouTube is rate-limiting ({sec}s until automatic recovery). Retrying now will most likely skip everything. Force retry anyway?",
  libMatchForceRateYtm:"YouTube is rate-limiting ({sec}s until recovery). Matching will fall back to the YouTube Music source (no quota limit). Continue?",
  libMatchStillBlocked:"Still could not start: the official YouTube API is limited",
  libMatchQuotaHint:"Quota limited",
});
Object.assign(commonI18n.en, { libColMv:"MV", libMvShort:"MV", libMvShortTitle:"View / change the official MV (video mode background)", libMvTitle:"Official MV (background)", libMvHint:"The official MV is only a muted, online background in video mode (YouTube IFrame). Nothing is downloaded and the local MP3 audio is untouched. If it is missing or unavailable, the blurred album cover is used automatically.", libMvLoading:"Loading…", libMvSearch:"Search again", libMvSearching:"Searching YouTube for the official MV…", libMvScore:"Score", libMvPreview:"Preview", libMvUse:"Use this", libMvConfirm:"Confirm this MV", libMvClear:"Clear", libMvClearConfirm:"Clear the MV for this song? Video mode will use the blurred album cover.", libMvCleared:"Cleared", libMvSaved:"✅ Saved and marked as confirmed", libMvNeedId:"Enter a YouTube videoId or link", libMvManualLabel:"Set a YouTube videoId manually", libMvSave:"Save", libMvCandidates:"Candidate videos", libMvCandidatesHint:"The best score is picked automatically; click “Use this” to switch — automatic matching never changes your choice afterwards.", libMvNoCandidates:"No candidates yet. Click “Search again” to look for the official MV on YouTube.", libMvNone:"No MV (the album cover is shown)", libMvNoKey:"No YouTube API Key configured: automatic matching is skipped, only a manual videoId works.", libMvAuto:"Auto-matched", libMvManual:"Confirmed", libMvPending:"Needs review", libMvUnavailable:"Unavailable", libMvNotFound:"Not found", libMvAutoDone:"✅ High confidence, applied automatically", libMvPendingDone:"✅ Highest score picked automatically (weak confidence — you can swap below)", libMvNotFoundDone:"No usable MV found (video mode uses the blurred album cover)" });
Object.assign(commonI18n.de, { libEyebrow:'BIBLIOTHEK · MODUS B', libIntro:'Verarbeitungsstatus, Dauer, Dateigröße und Match-Score aller Titel. Durch Songwünsche ausgelöste Downloads und Trennungen zeigen hier live ihren Fortschritt.', libLoading:'Bibliothek wird geladen…', libOpenDisplay:'Anzeige öffnen ↗', libRematchTitle:'Songtext neu zuordnen', libClose:'Schließen', libTrackTitle:'Songtitel', libTrackArtist:'Interpret', libArtistsHint:'Mehrere Interpreten mit Kommas trennen', libRematchHint:'Änderungen betreffen nur die Songtextsuche, nicht die Angaben in der Bibliothek.', libRematchSearch:'Songtext suchen', libCancel:'Abbrechen', libTitleRequired:'Bitte einen Songtitel eingeben', libSearchingLyrics:'Suche läuft…', libMatched:'✅ Treffer: {provider} · {kind} · {lines} Zeilen', libLyricsUpdated:'Songtext aktualisiert und bei der nächsten Wiedergabe aktiv', libNoLyricsFound:'❌ Kein Songtext gefunden. Versuche einen kürzeren Titel oder eine andere Schreibweise (z. B. ohne Zusatz in Klammern).', libRematchFailed:'❌ Fehlgeschlagen: {error}', libUnknownError:'unbekannter Fehler', libNoLyrics:'Kein Songtext', libWordLevel:'Wortgenau', libLineLevel:'Zeilenweise', libPlainText:'Nur Text', libStatusProcessed:'Verarbeitet', libStatusProcessing:'In Verarbeitung', libStatusPending:'Ausstehend', libStatusFailed:'Fehlgeschlagen', libStatusCanceled:'Abgebrochen', libQueued:'In Warteschlange', libUnavailable:'Bibliothek nicht verfügbar: ', libHeading:'Bibliotheksverwaltung', libDesc:'Verarbeitungsstatus, Dauer, Dateigröße und Match-Score aller Songs. Durch Songwünsche ausgelöste Downloads und Trennungen zeigen hier live ihren Fortschritt.', libSummary:'{total} Titel · Verarbeitet {processed} · In Verarbeitung {processing} · Ausstehend {pending} · Fehlgeschlagen {failed}', libFilterPlaceholder:'Nach Titel / Interpret / Album filtern', libRefresh:'Aktualisieren', libColTrack:'Titel', libColStatus:'Status', libColLyrics:'Songtext', libColDuration:'Dauer', libColSize:'Größe', libColMatch:'Match', libColActions:'Aktionen', libErrorReason:'Grund: ', libStop:'Stoppen', libStopTitle:'Hintergrundverarbeitung abbrechen (nur DJ)', libRematchShort:'Neu suchen', libRematchShortTitle:'Titel oder Interpret ändern und Songtext erneut suchen', libDelete:'Löschen', libDeleteTitle:'Aus der Bibliothek löschen (inklusive erzeugter Dateien)', libEmpty:'Keine passenden Titel', libDeleteConfirm:'„{title}“ aus der Bibliothek löschen? Dabei werden fertige Audiodateien, Video, Cover, Songtext und der Quelldownload entfernt.', libDeleted:'Gelöscht', libDeleteOutdated:'Der Server läuft mit einer älteren Version. Bitte den Dienst neu starten und erneut versuchen.', libAbortConfirm:'Diesen Hintergrundauftrag abbrechen? Bereits erzeugte Zwischendateien bleiben erhalten, bei der nächsten Anforderung geht es weiter.', libAborted:'Abgebrochen', qrAlt: 'QR-Code zum Songaussuchen', liveMessage: 'Live-Durchsage', videoLyricsOn: 'Songtext im Video: an', videoLyricsOff: 'Songtext im Video: aus', wordLevelTitle: 'Aktuelle Zeile leuchtet Wort für Wort auf', wordLevelUnavailable: 'Für diesen Song gibt es keinen wortgenauen Songtext (nur Zeilentiming) – der Wortmodus sieht daher gleich aus', libCleanup:'Reste aufräumen', libCleanupTitle:'Übrig gebliebene Dateien aufräumen', libCleanupDesc:'Bibliothek nach Dateien durchsuchen, die von gelöschten Songs übrig geblieben sind', libScanning:'Suche läuft…', libCleanupEmpty:'Keine Reste gefunden – die Bibliothek ist sauber', libCleanupSummary:'{count} Reste gefunden, insgesamt {size}', libCleanupHint:'Es werden nur Dateien ohne passenden Datenbankeintrag aufgelistet. Songs in Bearbeitung erscheinen hier nie.', libCleanupSelectAll:'Alle auswählen', libCleanupDeselectAll:'Alle abwählen', libCleanupConfirm:'Die ausgewählten {count} Einträge löschen? Insgesamt {size}. Das kann nicht rückgängig gemacht werden.', libCleanupRunning:'Aufräumen…', libCleanupDone:'{count} Einträge entfernt, {size} freigegeben', libCleanupPartial:'Fertig: {removed} entfernt, {skipped} übersprungen, {failed} fehlgeschlagen', libCleanupManifest:'Eine Liste der gelöschten Dateien wurde unter data/ gespeichert', libScanFailed:'Suche fehlgeschlagen: {error}', libCleanupFailed:'Aufräumen fehlgeschlagen: {error}', libGroupOutput:'Audio- / Videoausgabe', libGroupCovers:'Cover', libGroupLyrics:'Songtext-Dateien', libGroupUpstream:'Rohdaten', libGroupOverrides:'Songtext-Überschreibungen', libCleanupActive:'{count} Song(s) werden gerade verarbeitet – ihre Dateien sind ausgeschlossen', libCleanupGroupItems:'{count} Einträge · {size}' });
Object.assign(commonI18n.de, { libMvFilterTitle:"Nur Titel mit einem bestimmten MV-Status anzeigen", libMvFilterAll:"MV: alle" });
Object.assign(commonI18n.de, { libMvRateLimited:"⏳ YouTube drosselt gerade (429). MV-Suche pausiert und wird automatisch erneut versucht." });
Object.assign(commonI18n.de, { libMatchStart:"Zuordnen ({mv} MVs · {lyrics} Songtexte fehlen)", libMatchTitle:"Fehlende offizielle MVs und Songtexte im Hintergrund nachziehen (sequenziell)", libMatchRunning:"Zuordnung läuft {done}/{total}", libMatchOk:"ok", libMatchSkip:"übersprungen", libMatchFail:"fehlgeschlagen", libMatchCancel:"Stopp", libMatchCanceled:"Hintergrund-Zuordnung gestoppt", libMatchStarted:"Hintergrund-Zuordnung für {count} Titel gestartet", libMatchNothing:"Nichts zuzuordnen", libMatchBusy:"Es läuft bereits eine Zuordnung", libMatchLast:"Letzter Lauf", libMatchRateLimited:"YouTube drosselt gerade – später erneut versuchen" });
Object.assign(commonI18n.de, { libMatchRateLimitedAt:"YouTube drosselt – automatische Fortsetzung in {sec}s" });
Object.assign(commonI18n.de, { libMatchQuotaOut:"Das t\u00e4gliche YouTube-Suchkontingent ist heute aufgebraucht; morgen wieder verf\u00fcgbar" });
Object.assign(commonI18n.de, {
  libMatchForceQuota:"Das offizielle YouTube-Kontingent ist heute aufgebraucht. Ein erneuter Versuch w\u00fcrde vermutlich alles \u00fcberspringen. Trotzdem erzwingen?",
  libMatchForceQuotaYtm:"Das offizielle YouTube-Kontingent ist heute aufgebraucht. Es wird stattdessen die YouTube-Music-Quelle genutzt (ohne Kontingent). Fortfahren?",
  libMatchForceRate:"YouTube drosselt gerade (automatische Fortsetzung in {sec}s). Ein erneuter Versuch w\u00fcrde vermutlich alles \u00fcberspringen. Trotzdem erzwingen?",
  libMatchForceRateYtm:"YouTube drosselt gerade (Fortsetzung in {sec}s). Es wird stattdessen die YouTube-Music-Quelle genutzt (ohne Kontingent). Fortfahren?",
  libMatchStillBlocked:"Konnte nicht starten: Die offizielle YouTube-API ist weiterhin eingeschr\u00e4nkt",
  libMatchQuotaHint:"Kontingent eingeschr\u00e4nkt",
});
Object.assign(commonI18n.de, { libColMv:"MV", libMvShort:"MV", libMvShortTitle:"Offizielles MV ansehen / ändern (Hintergrund im Videomodus)", libMvTitle:"Offizielles MV (Hintergrund)", libMvHint:"Das offizielle MV ist im Videomodus nur ein stummer Online-Hintergrund (YouTube IFrame). Es wird nichts heruntergeladen und das lokale MP3-Audio bleibt unberührt. Fehlt es oder ist es nicht verfügbar, wird automatisch das unscharfe Albumbild verwendet.", libMvLoading:"Wird geladen…", libMvSearch:"Neu suchen", libMvSearching:"YouTube wird nach dem offiziellen MV durchsucht…", libMvScore:"Score", libMvPreview:"Vorschau", libMvUse:"Auswählen", libMvConfirm:"Dieses MV bestätigen", libMvClear:"Löschen", libMvClearConfirm:"MV für diesen Song löschen? Der Videomodus nutzt dann das unscharfe Albumbild.", libMvCleared:"Gelöscht", libMvSaved:"✅ Gespeichert und als bestätigt markiert", libMvNeedId:"YouTube-Video-ID oder Link eingeben", libMvManualLabel:"YouTube-Video-ID manuell setzen", libMvSave:"Speichern", libMvCandidates:"Kandidaten", libMvCandidatesHint:"Der beste Wert wird automatisch gewählt; mit „Auswählen\" änderst du es, danach fasst die automatische Suche es nicht mehr an.", libMvNoCandidates:"Noch keine Kandidaten. Auf „Neu suchen\" klicken, um das offizielle MV auf YouTube zu suchen.", libMvNone:"Kein MV (es wird das Albumbild gezeigt)", libMvNoKey:"Kein YouTube-API-Key konfiguriert: die automatische Suche entfällt, nur eine manuelle Video-ID funktioniert.", libMvAuto:"Automatisch", libMvManual:"Bestätigt", libMvPending:"Zu prüfen", libMvUnavailable:"Nicht verfügbar", libMvNotFound:"Nicht gefunden", libMvAutoDone:"✅ Hohe Sicherheit, automatisch übernommen", libMvPendingDone:"✅ Höchster Wert automatisch gewählt (unsichere Zuordnung – unten änderbar)", libMvNotFoundDone:"Kein nutzbares MV gefunden (Videomodus nutzt das unscharfe Albumbild)" });
// 曲库文案查找：优先本页字典，缺 key 回退到 commonI18n（localeText 读的那份）。
function libraryText(key, fallback = '') {
  // key 已并入 commonI18n，直接复用 localeText；保留此包装是为了不改 36 处调用点。
  return localeText(key, fallback);
}
function libraryFormat(template, values) { return String(template).replace(/\{(\w+)\}/g, (m, k) => (values[k] === undefined ? m : String(values[k]))); }
// 后端错误码 → 用户可见文案（toast / 错误提示）。三语字典：{ zh, en, de }。
const SERVER_ERROR_COPY = {
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
    NOT_FOUND: 'Interface not found. The server may need a restart or update.', PAGE_NOT_FOUND: 'Page not found',
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
    NOT_FOUND: '接口不存在，服务端可能需要重启或升级', PAGE_NOT_FOUND: '页面不存在',
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
    NOT_FOUND: 'Schnittstelle nicht gefunden. Server muss eventuell neu gestartet oder aktualisiert werden.', PAGE_NOT_FOUND: 'Seite nicht gefunden',
    SERVER_ERROR: 'Serverfehler'
  }
};

// 后端错误码 → 用户可见文案。三语字典，按当前界面语言取；找不到时回退英文，再回退后端给出的原始 error。
function serverErrorMessage(data) {
  if (!data) return '';
  if (!data.code) return data.error || '';
  const language = currentAdminLanguage();
  const templates = SERVER_ERROR_COPY[language] || SERVER_ERROR_COPY.en;
  const template = templates[data.code] || SERVER_ERROR_COPY.en[data.code];
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
  if (hero) { hero.querySelector('.eyebrow').textContent = language === 'de' ? 'DJ STEUERZENTRALE' : language === 'en' ? 'DJ CONTROL DESK' : 'DJ 控制台'; hero.querySelector('h1').textContent = t.title; hero.querySelector('p').textContent = t.intro; // 注意：不能用 hero.querySelector('.btn.soft') —— 那取的是第一个按钮
        // （控制台里是「曲库管理」、曲库页里是「返回控制台」），
        // 会把它们都改名成「打开大屏」，导致两个按钮同名却指向不同页面。
        {
          const openDisplay = hero.querySelector('[data-role="open-display"]');
          if (openDisplay) openDisplay.textContent = t.display;
          const backAdmin = hero.querySelector('[data-role="back-admin"]');
          if (backAdmin) backAdmin.textContent = language === 'de' ? '← Zur Steuerung' : language === 'en' ? '← Back to Console' : '← 返回控制台';
          const openLibrary = hero.querySelector('[data-role="open-library"]');
          if (openLibrary) openLibrary.textContent = language === 'de' ? 'Songbibliothek ↗' : language === 'en' ? 'Song Library ↗' : '曲库管理 ↗';
        } document.getElementById('admin-logout').textContent = t.logout; }
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
  if (settingsForm) { settingsForm.querySelectorAll('label')[0].textContent = localeText('eventName', '活动名称'); settingsForm.querySelectorAll('label')[1].textContent = language === 'de' ? 'Maximale wartende Songs pro Gast' : language === 'en' ? 'Max waiting songs per guest' : '每人最多等待歌曲'; const duplicateLabel = settingsForm.querySelector('input[name="allowDuplicatePerSession"]')?.parentElement; if (duplicateLabel) duplicateLabel.lastChild.textContent = language === 'de' ? ' Dieselbe Session darf denselben Song wiederholen' : language === 'en' ? ' Allow this session to repeat the same song' : ' 允许同一会话重复点同一首'; settingsForm.querySelector('button:not(#new-session)').textContent = t.save; }
  const newSessionButton = document.getElementById('new-session'); if (newSessionButton) newSessionButton.textContent = t.newSession;
  const publicUrlField = document.querySelector('#settings-form [data-role="public-url-field"]'); if (publicUrlField) { publicUrlField.querySelector('[data-role="public-url-label"]').textContent = t.publicUrl; publicUrlField.querySelector('input').placeholder = t.publicUrlPlaceholder; publicUrlField.querySelector('[data-role="public-url-hint"]').textContent = t.publicUrlHint; }
  const broadcastForm = document.getElementById('broadcast-form'); if (broadcastForm) { broadcastForm.querySelector('input').placeholder = language === 'de' ? 'z. B. Nächster Song von Lin' : language === 'en' ? 'e.g. Next song by Lin' : '例如：下一首由小林演唱'; broadcastForm.querySelector('button').textContent = extraText('add'); }
  const playbackToggle = document.querySelector('.playback-toggle'); if (playbackToggle && !playbackToggle.disabled) playbackToggle.textContent = playbackToggle.dataset.action === 'resume' ? t.resume : t.pause;
  const importantToggle = document.querySelector('.important-control-card .important-toggle'); if (importantToggle) importantToggle.textContent = importantToggle.disabled ? t.importantCountdown : importantToggle.dataset.action === 'stop' ? t.importantStop : t.importantStart;
  document.querySelectorAll('.playback[data-action="skip"]').forEach(button => { if (!button.classList.contains('armed')) button.textContent = t.skip; });
  document.querySelectorAll('.playback[data-action="stop"]').forEach(button => { if (!button.classList.contains('armed')) button.textContent = t.stop; });
  document.querySelectorAll('.pin-action').forEach(button => {
    const pinned = button.dataset.action === 'unpin';
    button.textContent = pinned ? t.unpin : t.pin;
    // 切换语言只改文字，高亮状态（pin-on）要保持
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
}
function ensureAppearancePanel(token, state) {
  const topActions = document.querySelector('.topbar .top-actions');
  if (!topActions) return;
  let button = document.getElementById('interface-settings-button');
  if (!button) {
    button = document.createElement('button');
    button.id = 'interface-settings-button';
    button.className = 'btn ghost';
    button.textContent = localeText('settingsButton', '设置');
    topActions.appendChild(button);
  }
  let modal = document.getElementById('interface-settings-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'interface-settings-modal';
    modal.className = 'settings-modal-backdrop';
    modal.innerHTML = `<section class="settings-modal card"><div class="section-head"><div><h2 data-role="settings-title">${localeText('adminSettingsTitle', '界面设置')}</h2><p data-role="settings-desc">${localeText('adminSettingsDesc', '这里设置现场默认，用户可在自己的设备上单独覆盖')}</p></div><button class="btn ghost small" data-role="settings-close">${localeText('close', '关闭')}</button></div><div class="grid"><div class="field"><label data-role="language-label">${localeText('language', '语言')}</label><select class="select" id="admin-language"><option value="zh">中文</option><option value="en">English</option><option value="de">Deutsch</option></select></div><div class="field"><label data-role="theme-label">配色模式</label><select class="select" id="admin-theme"><option value="system">${localeText('themeSystem', '跟随系统')}</option><option value="day">${localeText('themeDay', '白天')}</option><option value="night">${localeText('themeNight', '夜间')}</option></select></div><div class="field"><label>${localeText('playbackScreen', '播放画面')}</label><select class="select" id="admin-playback-mode"><option value="video">${localeText('playbackModeVideo', '视频（YouTube）')}</option><option value="lyrics">${localeText('playbackModeLyrics', '歌词（仿 Apple Music）')}</option></select><p class="helper">${localeText('playbackScreenHint', '视频：1080p 视频 + 两行歌词；歌词：仿 Apple Music 滚动歌词。切换后大屏会重新挂载播放器')}</p></div></div><div class="filter-block"><label class="toggle-row" id="show-translation-row"><input id="admin-show-translation" type="checkbox"><span><strong>${localeText('showTranslation', '显示歌词翻译')}</strong><small>${localeText('showTranslationHint', '关闭后大屏只显示原文')}</small></span></label><div class="field"><label data-role="guest-timeout-label">${localeText('guestTimeout', 'Guest 超时（分钟）')}</label><input class="input" id="admin-guest-timeout" type="number" min="5" max="10080" step="1" value="60"><p class="helper" data-role="guest-timeout-hint">${localeText('guestTimeoutHint', '超过该时间没有点歌且没有排队歌曲时自动移除；有活动歌曲不会清理。')}</p></div></div><div class="timing-block"><div class="eyebrow" data-role="timing-label">Timing</div><div class="grid timing-grid"><div class="field"><label data-role="timing-broadcastDuration"></label><input class="input" id="admin-broadcast-duration" type="number" min="3" max="30" /></div><div class="field"><label data-role="timing-broadcastInterval"></label><input class="input" id="admin-broadcast-interval" type="number" min="0" max="60" /></div><div class="field"><label data-role="timing-drinkDuration"></label><input class="input" id="admin-drink-duration" type="number" min="3" max="120" /></div><div class="field"><label data-role="timing-drinkInterval"></label><input class="input" id="admin-drink-interval" type="number" min="0" max="60" /></div></div><p class="helper timing-warning" data-role="timing-warning" hidden></p></div><div class="timing-block"><div class="eyebrow" data-role="loudness-label">${localeText('loudnessSection', '伴奏响度均衡')}</div><label class="toggle-row" id="loudness-auto-row"><input id="admin-loudness-auto" type="checkbox"><span><strong>${localeText('loudnessAuto', '自动均衡伴奏响度')}</strong><small>${localeText('loudnessAutoHint', '按测得的 LUFS 实时补增益；关闭后所有歌都用原始电平')}</small></span></label><div class="grid timing-grid"><div class="field"><label data-role="loudness-target-label">${localeText('loudnessTarget', '目标响度（LUFS）')}</label><input class="input" id="admin-loudness-target" type="number" min="-40" max="-5" step="0.5" value="-18" /></div><div class="field"><label data-role="loudness-peak-label">${localeText('loudnessPeakCeiling', '真峰值上限（dBFS）')}</label><input class="input" id="admin-loudness-peak" type="number" min="-9" max="0" step="0.5" value="-1" /></div><div class="field"><label data-role="loudness-maxgain-label">${localeText('loudnessMaxGain', '最大增益（dB）')}</label><input class="input" id="admin-loudness-max-gain" type="number" min="0" max="24" step="1" value="12" /></div><div class="field"><label data-role="loudness-maxcut-label">${localeText('loudnessMaxCut', '最大衰减（dB）')}</label><input class="input" id="admin-loudness-max-cut" type="number" min="0" max="24" step="1" value="12" /></div></div><p class="helper" data-role="loudness-hint">${localeText('loudnessHint', '只影响播放增益，不改动任何音频文件。没测过响度的歌保持原始电平。')}</p></div></section>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', event => { if (event.target === modal || event.target.closest('[data-role="settings-close"]')) modal.classList.remove('open'); });
    modal.querySelector('#admin-language').onchange = async event => { const value = event.target.value; localStorage.setItem('karaoke_language', value); applyAdminLanguage(value); try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({interfaceLanguage:value})}); interfaceDefaults.language = value; } catch (error) { toast(error.message); } toast(adminI18n[value].languageSaved); };
    modal.querySelector('#admin-theme').onchange = async event => { const value = event.target.value; localStorage.setItem('karaoke_theme', value); applyTheme(value); try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({interfaceTheme:value})}); interfaceDefaults.theme = value; } catch (error) { toast(error.message); } toast(adminI18n[currentAdminLanguage()].themeSaved); };
     const showTranslationEl = modal.querySelector('#admin-show-translation');
     if (showTranslationEl) showTranslationEl.onchange = async event => { try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({showTranslation:event.target.checked})}); } catch (error) { event.target.checked = !event.target.checked; toast(error.message); } };
     modal.querySelector('#admin-guest-timeout').onchange = async event => { const value = Math.min(10080, Math.max(5, Number(event.target.value) || 60)); event.target.value = value; try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({guestInactivityMinutes:value})}); } catch (error) { toast(error.message); } };
     modal.querySelector('#admin-playback-mode').onchange = async event => { try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({playbackMode:event.target.value})}); toast(event.target.value === 'lyrics' ? '已切换到歌词画面' : '已切换到视频画面'); } catch (error) { toast(error.message); } };
     // ── 伴奏响度均衡 ──
     // 四个数字一次全提交：即使服务端是旧版本，也不会把没提交的项显示成 0。
     const loudnessAutoEl = modal.querySelector('#admin-loudness-auto');
     if (loudnessAutoEl) loudnessAutoEl.onchange = async event => { try { await api('/api/admin/settings', {method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({loudnessAutoEnabled:event.target.checked})}); } catch (error) { event.target.checked = !event.target.checked; toast(error.message); } };
     const loudnessFields = [
       ['#admin-loudness-target', 'loudnessTargetLufs', -40, -5, -18],
       ['#admin-loudness-peak', 'loudnessTruePeakCeiling', -9, 0, -1],
       ['#admin-loudness-max-gain', 'loudnessMaxGainDb', 0, 24, 12],
       ['#admin-loudness-max-cut', 'loudnessMaxCutDb', 0, 24, 12],
     ];
     const patchLoudness = async () => {
       const payload = {};
       for (const [selector, key, min, max, fallback] of loudnessFields) {
         const field = modal.querySelector(selector);
         const raw = String(field?.value ?? '').trim();
         const numeric = raw === '' ? NaN : Number(raw);
         payload[key] = Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : fallback));
         if (field) field.value = payload[key];
       }
       try { await api('/api/admin/settings', { method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify(payload) }); }
       catch (error) { toast(error.message); }
     };
     for (const [selector] of loudnessFields) {
       const field = modal.querySelector(selector);
       if (field) field.onchange = patchLoudness;
     }
  }
  button.onclick = () => modal.classList.add('open');
  modal.querySelector('#admin-language').value = currentAdminLanguage();
  modal.querySelector('#admin-theme').value = currentThemePreference();
  const playbackModeSelect = modal.querySelector('#admin-playback-mode');
  if (playbackModeSelect) {
    playbackModeSelect.value = state?.settings?.playbackMode === 'lyrics' ? 'lyrics' : 'video';
    // 两种画面（video / lyrics）在模式 A、模式 B 下都生效：切换后 display 页会整体重挂播放器
    const row = playbackModeSelect.closest('.field');
    if (row) row.hidden = false;
  }
  // 音源模式由启动器（服务器控制面板）决定，网页控制台不再提供切换
  // 模式 B 下隐藏「仅允许 Karaoke 歌曲」：本地曲库的歌名是原名，
  // 含 "karaoke" 的极少，这个过滤会把点歌全拒掉，没有意义。
  const showTranslationInput = modal.querySelector('#admin-show-translation');
  if (showTranslationInput) showTranslationInput.checked = state?.settings?.showTranslation !== false;
  const guestTimeoutInput = modal.querySelector('#admin-guest-timeout');
  if (guestTimeoutInput && document.activeElement !== guestTimeoutInput) guestTimeoutInput.value = Number(state?.settings?.guestInactivityMinutes) || 60;
  // 响度均衡：把服务端值回填到输入框（正在编辑的那个不动，免得打字被打断）
  const loudnessAutoInput = modal.querySelector('#admin-loudness-auto');
  if (loudnessAutoInput) loudnessAutoInput.checked = state?.settings?.loudnessAutoEnabled !== false;
  const loudnessDefaults = { loudnessTargetLufs: -18, loudnessTruePeakCeiling: -1, loudnessMaxGainDb: 12, loudnessMaxCutDb: 12 };
  const loudnessInputs = [
    ['#admin-loudness-target', 'loudnessTargetLufs'],
    ['#admin-loudness-peak', 'loudnessTruePeakCeiling'],
    ['#admin-loudness-max-gain', 'loudnessMaxGainDb'],
    ['#admin-loudness-max-cut', 'loudnessMaxCutDb'],
  ];
  for (const [selector, key] of loudnessInputs) {
    const input = modal.querySelector(selector);
    if (!input || document.activeElement === input) continue;
    const numeric = Number(state?.settings?.[key]);
    input.value = Number.isFinite(numeric) ? numeric : loudnessDefaults[key];
  }
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
  // 「顺便搜 Karaoke 版」只对 YouTube 搜索有意义（要主动加上 karaoke 关键词）。
  // 模式 B 搜的是 Spotify 元数据，音源由本地分离产出，再拼 karaoke 反而搜不到东西。
  const isLocalSource = joinConfig?.sourceMode === 'local';
  if (searchForm && !isLocalSource && !document.getElementById('karaoke-version')) { const option = document.createElement('label'); option.className = 'karaoke-option'; option.innerHTML = '<input id="karaoke-version" type="checkbox" checked><span></span>'; searchForm.insertAdjacentElement('afterend', option); }
  if (isLocalSource) { const stale = document.getElementById('karaoke-version'); if (stale && stale.parentElement) stale.parentElement.remove(); }
  const karaokeInput = document.getElementById('karaoke-version');
  if (karaokeInput) { const onlyKaraoke = Boolean(joinConfig?.onlyKaraokeSongs); karaokeInput.disabled = onlyKaraoke; if (onlyKaraoke) karaokeInput.checked = true; }
  const karaokeOption = document.querySelector('.karaoke-option span'); if (karaokeOption) karaokeOption.textContent = t.karaokeSearch;
  const cards = page.querySelectorAll('.grid.two > .card');
  const searchCard = cards[0]; const queueCard = cards[1];
  if (searchCard) { const localSource = joinConfig?.sourceMode === 'local'; searchCard.querySelector('h2').textContent = localSource ? (t.searchTitleLocal || '搜索歌曲（Spotify）') : t.searchTitle; searchCard.querySelector('.section-head p').textContent = localSource ? (t.searchDescLocal || '搜索 Spotify 曲库，点歌后自动准备伴奏（未下载的会自动下载并分离）。') : t.searchDesc; searchCard.querySelector('input').placeholder = localSource ? (t.searchPlaceholderLocal || '搜索歌名，例如：晴天 周杰伦') : t.searchPlaceholder; searchCard.querySelector('form button').textContent = t.search; const initial = searchCard.querySelector('#results .empty'); if (initial && !initial.textContent.includes('搜索中') && !initial.textContent.includes('Searching') && !initial.textContent.includes('Suche')) initial.textContent = t.searchStart; searchCard.querySelectorAll('.add-song').forEach(button => { button.textContent = t.addSong; }); }
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
  // 注意：处理中画面（display-preparing）有自己的文案，不能被这一步改回「Your turn to sing」。
  // 之前就是漏了这个判断，导致进度条出来了、大字却还是待机文案。
  const idle = document.querySelector('.display-idle'); if (idle && !idle.classList.contains('display-preparing')) { const eyebrow = idle.querySelector('.eyebrow'); const bigNote = idle.querySelector('.big-note'); const copy = idle.querySelector('p'); if (eyebrow) eyebrow.textContent = t.ready; if (bigNote) bigNote.textContent = t.idleTitle; if (copy) copy.textContent = t.idleDesc; }
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
  renderShell(`<main class="login-wrap"><section class="card login-card"><div class="eyebrow">JOIN THE ROOM</div><h1>${esc(config.roomName)}</h1><p>${localeText('joinDesc', '扫描大屏二维码后，在这里输入你的昵称。无需注册，浏览器会记住本次点歌会话。')}</p><form id="join-form"><div class="field"><label>${localeText('nickname', '演唱者昵称')}</label><input class="input" name="displayName" maxlength="24" placeholder="${localeText('nicknamePlaceholder', '例如：小林')}" autofocus required /></div><button class="btn primary" type="submit">${localeText('joinRoom', '进入点歌台 →')}</button><div class="helper">${localeText('sessionTip', '你的昵称可以重复，但歌曲归属由临时会话识别。')}</div></form></section></main>`);
  joinEvents?.close();
  joinEvents = connectEvents(state => { syncLiveInterfaceSettings(state.settings); const title = document.querySelector('.login-card h1'); if (title && state.settings?.roomName) title.textContent = state.settings.roomName; });
  document.getElementById('join-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { const data = await api('/api/sessions', { method:'POST', body:JSON.stringify({ displayName:event.target.displayName.value }) }); localStorage.setItem('karaoke_session', JSON.stringify(data)); renderJoinApp(config, data); }
    catch (error) { toast(error.message); }
  });
}
function renderJoinApp(config, session) {
  // 模式 B：搜索走 Spotify，文案随之切换（YouTube 链接粘贴在本地模式下无效）
  const localSource = config?.sourceMode === 'local';
  const searchTitle = localSource ? localeText('searchTitleLocal', '搜索歌曲（Spotify）') : localeText('searchTitle', '搜索 YouTube');
  const searchDesc = localSource ? localeText('searchDescLocal', '搜索 Spotify 曲库，点歌后自动准备伴奏（未下载的会自动下载并分离）。') : localeText('searchDesc', '支持搜索歌名，也可以直接粘贴 YouTube 链接。');
  const searchPlaceholder = localSource ? localeText('searchPlaceholderLocal', '搜索歌名，例如：晴天 周杰伦') : localeText('searchPlaceholder', '搜索歌名，或粘贴 YouTube 链接');
  const searchStart = localSource ? localeText('searchStartLocal', '输入关键词开始搜索') : localeText('searchStart', '输入关键词或粘贴链接开始');
  renderShell(`<main class="page"><div class="hero"><div><div class="eyebrow">GUEST CONTROLLER</div><h1>${esc(config.roomName)}</h1><p>${esc(localeText('greeting', '你好，{name}。搜索一首想唱的歌，加入现场队列。').replace('{name}', session.session.displayName))}</p></div><button class="btn ghost" id="change-name">${localeText('changeName', '更换昵称')}</button></div><div id="now-playing" class="notice" style="margin-bottom:18px">${localeText('currentEmpty', '当前还没有播放歌曲，点歌后会自动开始。')}</div><div class="grid two"><section class="card panel"><div class="section-head"><div><h2>${esc(searchTitle)}</h2><p>${esc(searchDesc)}</p></div></div><form class="search-row" id="search-form"><input class="input" name="q" placeholder="${esc(searchPlaceholder)}" /><button class="btn primary">${localeText('search', '搜索')}</button></form><div id="results" class="results"><div class="empty">${esc(searchStart)}</div></div></section><section class="card panel"><div class="section-head"><div><h2>${localeText('myQueue', '我的等待队列')}</h2><p id="quota-note" data-max="${config.maxQueuedSongsPerGuest}">${localeText('quota', '每人最多')} ${config.maxQueuedSongsPerGuest} ${localeText('queueNumber', '首')}</p></div><span class="tag" id="live-status">${localeText('syncing', '同步中')}</span></div><div id="own-queue" class="list"></div><div class="section-head" style="margin-top:25px"><div><h2>${localeText('publicQueue', '公开后续队列')}</h2><p>${localeText('publicDesc', '所有参与者看到的播放顺序')}</p></div></div><div id="public-queue" class="list"></div></section></div></main>`);
  document.getElementById('change-name').onclick = async () => { const displayName = prompt(localeText('namePrompt', '请输入新的演唱者昵称'), session.session.displayName); if (!displayName || displayName.trim() === session.session.displayName) return; try { const data = await api('/api/sessions', { method:'PATCH', headers:{'x-session-token':session.token}, body:JSON.stringify({displayName}) }); session.session = data.session; localStorage.setItem('karaoke_session', JSON.stringify(session)); renderJoinApp(config, session); toast(localeText('nameChanged', '昵称已更新，歌曲归属不变')); } catch (error) { toast(error.message); } };
   document.getElementById('search-form').addEventListener('submit', async event => { event.preventDefault(); const rawQuery = event.target.q.value.trim(); if (!rawQuery) return; const result = document.getElementById('results'); result.innerHTML = `<div class="empty">${localeText('searching', '搜索中…')}</div>`; try { const items = await searchByMode(rawQuery); result.innerHTML = items.length ? items.map((item, index) => renderResult(item, index)).join('') : `<div class="empty">${localeText('noResults', '没有找到匹配歌曲')}</div>`; result.querySelectorAll('.add-song').forEach(button => button.onclick = () => addSong(items[Number(button.dataset.index)], session)); applyJoinLanguage(); } catch (error) { result.innerHTML = `<div class="notice">${esc(error.message)}</div>`; } });
  joinEvents?.close();
  joinEvents = connectEvents(state => { updateJoinState(state, session); });
  api('/api/state').then(state => updateJoinState(state, session));
  
}
async function addSong(song, session) {
  if (song && song.embeddable === false) { toast(localeText('notEmbeddable', '这个视频不允许嵌入播放，请换一个')); return; }
  try {
    const data = await api('/api/queue', { method:'POST', headers:{ 'x-session-token':session.token }, body:JSON.stringify(song) });
    updateJoinState(data.state, session);
    // 曲库里没有的歌：加入点歌成功但还在后台制作
    if (data.song && data.song.status === 'preparing') toast(localeText('addedPreparing', '已加入，正在后台制作'));
    else toast(localeText('added', '已加入等待队列'));
  } catch (error) {
    // 后端已返回 DUPLICATE_SESSION_SONG 错误码，serverErrorMessage 会自动按界面语言翻译，
        // 这里不再用中文字符串做比较（切到 en/de 后比不到，会漏翻）。
        toast(error.message);
  }
}

/**
 * 按当前音源模式取搜索结果。
 * 模式 A：YouTube Data API（原逻辑保持不变）
 * 模式 B：搜索走 Spotify（返回全部结果），结果一律可点（inLibrary/ready 仅作元数据，不影响按钮）
 */
async function searchByMode(rawQuery) {
  const mode = joinConfig?.sourceMode === 'local' ? 'local' : 'youtube';
  if (mode === 'local') {
    const data = await api(`/api/spotify/search?q=${encodeURIComponent(rawQuery)}&limit=10`);
    if (!data.available) throw new Error(data.reason ? localeText('spotifyUnavailable', 'Spotify 搜索不可用：{reason}').replace('{reason}', data.reason) : localeText('spotifyUnavailableShort', 'Spotify 搜索不可用'));
    return (data.items || []).map((t) => ({
      source: 'local',
      spotifyId: t.spotifyId,
      title: t.title,
      channelTitle: (t.artists || []).join(', ') || 'Spotify',
      thumbnailUrl: t.localCover || t.cover || '',
      duration: t.durationMs ? formatDurationMs(t.durationMs) : '—',
      inLibrary: Boolean(t.inLibrary),
      ready: Boolean(t.ready),
      embeddable: true,
    }));
  }
  const isYoutubeUrl = /^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(rawQuery);
  const q = document.getElementById('karaoke-version')?.checked && !isYoutubeUrl ? `${rawQuery} karaoke` : rawQuery;
  const data = await api(`/api/youtube/search?q=${encodeURIComponent(q)}`);
  const items = joinConfig?.onlyKaraokeSongs ? data.items.filter((item) => /karaoke/i.test(item.title || '')) : data.items;
  return items.map((item) => ({ ...item, source: 'youtube' }));
}

function formatDurationMs(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderResult(item, index) {
  // 模式 B 的搜索结果一律可点：未下载/未分离的曲目在点歌后统一走后台下载+分离（"准备中"）。
  const local = item.source === 'local';
  const title = local
    ? `<span class="result-title">${esc(item.title)}</span>`
    : `<a class="result-title" href="https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`;
  const button = `<button class="btn teal small add-song" data-index="${index}">${localeText('addSong', '点歌')}</button>`;
  const thumb = item.thumbnailUrl ? `<img src="${esc(item.thumbnailUrl)}" alt="">` : '<img src="" alt="">';
  return `<article class="result">${thumb}<div class="result-copy">${title}<div class="result-meta">${esc(item.channelTitle)} · ${esc(item.duration)}</div></div>${button}</article>`;
}
function checkServerVersion(state) {
  if (serverVersionWarned || !state) return;
  if (state.apiVersion === undefined || Number(state.apiVersion) < REQUIRED_API_VERSION) {
    serverVersionWarned = true;
    toast(localeText('serverOutdated', '服务端版本过旧，请关闭控制台重新打开后再试'));
  }
}
/** 队列项状态标签：用户侧只显示粗粒度「准备中 / 已就绪 / 准备失败」。 */
function queueStatusLabel(song) {
  if (!song || song.source !== 'local') return '';
  if (song.status === 'preparing') return `<span class="queue-status preparing">${localeText('queueStatusPreparing', '准备中')}</span>`;
  if (song.status === 'prepare_failed') return `<span class="queue-status failed" title="${esc(song.error || '')}">${localeText('queueStatusPrepareFailed', '准备失败')}</span>`;
  return `<span class="queue-status ready">${localeText('queueStatusReady', '已就绪')}</span>`;
}
/** 准备失败的项在用户侧额外显示一行失败原因（截断，详情只有 DJ 能看到全量） */
function queueFailureNote(song) {
  if (!song || song.status !== 'prepare_failed') return '';
  const reason = String(song.error || '').split('：')[0].slice(0, 80);
  return `<div class="song-meta song-failed-note">${esc(reason || localeText('prepareFailed', '制作失败'))}</div>`;
}
function updateJoinState(state, session) {
  checkServerVersion(state);
  const ownEl = document.getElementById('own-queue'); const publicEl = document.getElementById('public-queue'); if (!ownEl || !publicEl) return;
  syncLiveInterfaceSettings(state.settings);
  document.getElementById('live-status').textContent = state.playback.status === 'idle' ? localeText('waiting', '等待播放') : localeText('realtime', '实时同步');
  const nowPlaying = document.getElementById('now-playing'); if (nowPlaying) nowPlaying.innerHTML = state.current ? `<strong>${localeText('currentPlaying', '正在播放：')}</strong> ${esc(state.current.title)} <span class="muted">· ${esc(state.current.singerName)} · ${state.playback.status === 'paused' ? localeText('paused', '已暂停') : state.playback.status === 'transition' ? localeText('preparing', '准备播放') : localeText('playing', '播放中')}</span>` : localeText('currentEmpty', '当前还没有播放歌曲，点歌后会自动开始。');
  const row = song => `<div class="song-row${song.status === 'preparing' ? ' is-preparing' : ''}${song.status === 'prepare_failed' ? ' is-failed' : ''}"><div class="song-rank">${song.queuePosition + 1}</div><img class="song-thumb" src="${esc(song.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(song.title)}</div><div class="song-meta">${esc(song.singerName)} · ${esc(song.channelTitle)}${queueStatusLabel(song) ? ' · ' + queueStatusLabel(song) : ''}</div>${queueFailureNote(song)}</div>${song.singerName === session.session.displayName ? `<button class="btn danger small remove-own" data-id="${song.id}">${localeText('remove', '删除')}</button>` : ''}</div>`;
  const currentRow = state.current ? `<div class="song-row queue-current"><div class="song-rank current-rank" aria-label="${esc(localeText('playing', '播放中'))}">▶</div><img class="song-thumb" src="${esc(state.current.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(state.current.title)}</div><div class="song-meta">${esc(state.current.singerName)} · ${esc(state.current.channelTitle)} · ${localeText('playing', '播放中')}</div></div></div>` : '';
  publicEl.innerHTML = currentRow + (state.queue.length ? state.queue.map(row).join('') : `<div class="empty">${localeText('queueEmpty', '队列为空，来唱第一首吧')}</div>`);
  refreshOwnQueue(session, state.current);
}
async function refreshOwnQueue(session, current = null) {
  const ownEl = document.getElementById('own-queue'); if (!ownEl) return;
  try {
    const data = await api('/api/my-queue', { headers:{'x-session-token':session.token} });
    const quotaNote = document.getElementById('quota-note'); const maxSongs = quotaNote.dataset.max || quotaNote.textContent.match(/\d+$/)?.[0] || '—'; quotaNote.dataset.max = maxSongs; quotaNote.textContent = localeText('quotaStatus', '{n} songs · max {max} per guest').replace('{n}', data.songs.length).replace('{max}', maxSongs);
    const row = (song, index) => {
      // 服务端现在允许移动 queued / preparing / prepare_failed 三种状态的歌，
      // 所以每首自己的歌都有上移/下移。
      const moveButtons = data.songs.length > 1
        ? `<button class="btn ghost small move-own" data-id="${song.id}" data-dir="-1" ${index === 0 ? 'disabled' : ''} aria-label="${esc(localeText('moveUp', '上移'))}">↑</button><button class="btn ghost small move-own" data-id="${song.id}" data-dir="1" ${index === data.songs.length - 1 ? 'disabled' : ''} aria-label="${esc(localeText('moveDown', '下移'))}">↓</button>`
        : '';
      return `<div class="song-row${song.status === 'preparing' ? ' is-preparing' : ''}${song.status === 'prepare_failed' ? ' is-failed' : ''}"><div class="song-rank">${index + 1}</div><img class="song-thumb" src="${esc(song.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(song.title)}</div><div class="song-meta">${esc(song.singerName)} · ${esc(song.channelTitle)}${queueStatusLabel(song) ? ' · ' + queueStatusLabel(song) : ''}</div>${queueFailureNote(song)}</div><div class="own-actions">${moveButtons}<button class="btn danger small remove-own" data-id="${song.id}">${localeText('remove', '删除')}</button></div></div>`;
    };
    const currentRow = current && current.singerName === session.session.displayName ? `<div class="song-row queue-current"><div class="song-rank current-rank" aria-label="${esc(localeText('playing', '播放中'))}">▶</div><img class="song-thumb" src="${esc(current.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(current.title)}</div><div class="song-meta">${esc(current.singerName)} · ${esc(current.channelTitle)} · ${localeText('playing', '播放中')}</div></div></div>` : '';
    ownEl.innerHTML = currentRow + (data.songs.length ? data.songs.map((song, index) => row(song, index)).join('') : `<div class="empty">${localeText('noSongs', '你还没有点歌')}</div>`);
    ownEl.querySelectorAll('.remove-own').forEach(button => button.onclick = async () => { try { await api(`/api/queue/${button.dataset.id}`, { method:'DELETE', headers:{'x-session-token':session.token} }); toast(localeText('removed', '已从队列移除')); } catch (error) { toast(error.message); } });
    ownEl.querySelectorAll('.move-own').forEach(button => button.onclick = async () => {
      const index = data.songs.findIndex(song => song.id === button.dataset.id);
      const target = data.songs[index + Number(button.dataset.dir)];
      if (!target) return;
      try { await api('/api/queue/order', { method: 'PATCH', headers: { 'x-session-token': session.token }, body: JSON.stringify({ firstId: button.dataset.id, secondId: target.id }) }); }
      catch (error) {
        toast(error.code === 'SONG_NOT_QUEUED'
          ? localeText('moveNotQueued', '这首歌已经不在等待队列中（可能刚开始播放），刷新后再试')
          : error.status === 404
            ? localeText('serverOutdated', '服务端版本过旧，请让 DJ 重启服务后再试')
            : error.message);
      }
    });
    applyJoinLanguage();
  } catch (error) { if (error.status === 401) { localStorage.removeItem('karaoke_session'); initJoin(); } }
}

// admin: 已检查过逐字可用性的歌曲 id，避免每次 SSE 都发一次歌词请求。
// 必须声明在脚本顶层 —— bindAdminEvents() 要用它；早先被误放在播放页的闭包里，
// 导致 Admin 一进 bindAdminEvents 就抛 ReferenceError，后面的
// 「开始新会话」按钮、酒水单、大屏动画卡片全都建不出来。
let adminWordAvailKey = null;

async function initAdmin() {
  const token = localStorage.getItem('karaoke_admin_token');
  try { const config = await api('/api/config'); setInterfaceDefaults(config); applyTheme(); } catch {}
  if (!token) return renderAdminLogin();
  try { const data = await api('/api/admin/state', { headers:{ 'x-admin-token':token } }); renderAdminApp(token, data); } catch { localStorage.removeItem('karaoke_admin_token'); renderAdminLogin(); }
}
function renderAdminLogin() {
  renderShell(`<main class="login-wrap"><section class="card login-card"><div class="eyebrow">DJ CONSOLE</div><h1>${localeText('adminLoginTitle', '现场控制台')}</h1><p>${localeText('adminLoginDesc', '登录后管理播放状态、等待队列、活动参数和大屏广播。')}</p><form id="admin-form"><div class="field"><label>${localeText('djPassword', 'DJ 密码')}</label><input class="input" name="password" type="password" placeholder="${localeText('adminPasswordPlaceholder', '输入现场密码')}" autofocus required /></div><button class="btn primary">${localeText('enterConsole', '进入控制台 →')}</button><div class="helper">${localeText('adminDemoPassword', '本地演示默认密码：karaok-admin。生产环境请通过 DJ_PASSWORD 环境变量设置。')}</div></form></section></main>`);
  document.getElementById('admin-form').addEventListener('submit', async event => { event.preventDefault(); try { const data = await api('/api/admin/auth', { method:'POST', body:JSON.stringify({password:event.target.password.value}) }); localStorage.setItem('karaoke_admin_token', data.token); renderAdminApp(data.token, data.state); } catch (error) { toast(error.message); } });
  applyAdminLanguage(currentAdminLanguage());
}
// ---------------------------------------------------------------- 曲库管理（独立页面）
// 从控制台点「曲库管理」按钮打开，复用同一套 DJ 令牌。
// 放在独立页面而不是控制台标签页里：控制台保持模式 A 原样，
// 曲库是重操作界面（表格、删除、中止），不该混进现场控制动线。
let libraryAutoRefresh = null;

async function initLibrary() {
  const token = localStorage.getItem('karaoke_admin_token');
  try { const config = await api('/api/config'); setInterfaceDefaults(config); applyTheme(); } catch {}
  if (!token) return renderLibraryLogin();
  try {
    await api('/api/library/admin', { headers: { 'x-admin-token': token } });
    renderLibraryApp(token);
  } catch (error) {
    if (error.status === 401) { localStorage.removeItem('karaoke_admin_token'); renderLibraryLogin(); return; }
    renderLibraryApp(token, error.message);
  }
}

function renderLibraryLogin() {
  renderShell(`<main class="login-wrap"><section class="card login-card"><div class="eyebrow">LIBRARY</div><h1>${localeText('libraryTitle', '曲库管理')}</h1><p>${localeText('libraryLoginDesc', '需要 DJ 权限才能查看和处理曲库。')}</p><form id="library-login-form"><div class="field"><label>${localeText('djPassword', 'DJ 密码')}</label><input class="input" name="password" type="password" placeholder="${localeText('adminPasswordPlaceholder', '输入现场密码')}" autofocus required /></div><button class="btn primary">${localeText('enterLibrary', '进入曲库 →')}</button><div class="helper"><a href="/admin">← ${localeText('backToConsole', '返回控制台')}</a></div></form></section></main>`);
  document.getElementById('library-login-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await api('/api/admin/auth', { method: 'POST', body: JSON.stringify({ password: event.target.password.value }) });
      localStorage.setItem('karaoke_admin_token', data.token);
      initLibrary();
    } catch (error) { toast(error.message); }
  });
}

function renderLibraryApp(token, initialError) {
  renderShell(`<main class="page compact library-page"><div class="hero"><div><div class="eyebrow">${esc(libraryText('libEyebrow', 'LIBRARY · 模式 B'))}</div><h1>${esc(libraryText('libHeading', '曲库管理'))}</h1><p>${esc(libraryText('libIntro', '所有曲目的处理状态、耗时、文件大小与匹配分。点歌触发的下载与分离会在这里实时显示阶段。'))}</p></div><div class="top-actions"><a class="btn soft" data-role="back-admin" href="/admin">← ${esc(localeText('backToConsole', '返回控制台'))}</a><a class="btn soft" data-role="open-display" href="${displayHref()}" target="_blank" rel="noopener">${esc(libraryText('libOpenDisplay', '打开大屏 ↗'))}</a></div></div><div id="admin-content">${initialError ? `<div class="notice">${esc(initialError)}</div>` : `<div class="notice">${esc(libraryText('libLoading', '正在读取曲库…'))}</div>`}</div></main>`);
  refreshAdminLibrary(token);
}

function renderAdminApp(token, initial) {
  setInterfaceDefaults(initial.settings);
  applyTheme();
  // 控制台布局与模式 A 完全一致，只多一个「曲库管理」入口按钮（独立页面，不在本页开标签页）。
  renderShell(`<main class="page compact"><div class="hero"><div><div class="eyebrow">DJ CONTROL DESK</div><h1>${esc(adminLabel('title'))}</h1><p>${esc(adminLabel('intro'))}</p></div><div class="top-actions"><a class="btn soft" data-role="open-library" href="/library" target="_blank" rel="noopener">${esc(adminLabel('openLibrary'))}</a><a class="btn soft" data-role="open-display" href="${displayHref()}" target="_blank">${esc(adminLabel('display'))}</a><button class="btn ghost" id="admin-logout">${esc(adminLabel('logout'))}</button></div></div><div id="admin-content"></div></main>`);
  document.getElementById('admin-logout').onclick = () => { localStorage.removeItem('karaoke_admin_token'); initAdmin(); };
  // 初次渲染要把 state 一起传给 bindAdminEvents：它需要 state 才能绑定
  // 置顶/删除这类队列按钮。只传 token 会走「自己再拉一次 state」的分支，
  // 那一步只重绑事件、不重建 DOM，按钮就变成点了没反应。
  const render = state => { document.getElementById('admin-content').innerHTML = renderAdminLiveHtml(state); linkAdminQueueTitles(document.getElementById('admin-content'), state.queue, state.current); bindAdminEvents(token, state); };
  // 队列行每次刷新都会整体重建 innerHTML，逐按钮绑定一旦某次没重绑上就彻底失效。
  // 在 #admin-content 上做一次事件委托，重建多少次都不会丢，这是置顶/删除的兜底路径。
  const adminContent = document.getElementById('admin-content');
  if (adminContent && !adminContent.dataset.queueDelegated) {
    adminContent.dataset.queueDelegated = '1';
    adminContent.addEventListener('click', async event => {
      const pinButton = event.target.closest?.('.pin-action');
      const removeButton = pinButton ? null : event.target.closest?.('.admin-remove');
      if (pinButton) {
        if (pinButton.disabled) return;
        pinButton.disabled = true;
        try {
          const fresh = await api(`/api/admin/queue/${pinButton.dataset.id}`, { method: 'PATCH', headers: { 'x-admin-token': token }, body: JSON.stringify({ action: pinButton.dataset.action }) });
          if (fresh && fresh.queue) updateAdminContent(token, fresh); else pinButton.disabled = false;
        } catch (error) { toast(error.message); pinButton.disabled = false; }
        return;
      }
      if (!removeButton) return;
      if (!confirm(adminLabel('confirmRemove'))) return;
      removeButton.disabled = true;
      try {
        const fresh = await api(`/api/admin/queue/${removeButton.dataset.id}`, { method: 'DELETE', headers: { 'x-admin-token': token } });
        if (fresh && fresh.queue) updateAdminContent(token, fresh); else removeButton.disabled = false;
      } catch (error) { toast(error.message); removeButton.disabled = false; }
    });
  }
  render(initial);
  connectEvents(() => {
    api('/api/admin/state', {headers:{'x-admin-token':token}}).then(freshState => updateAdminContent(token, freshState)).catch(error => { if (error.status === 401) { localStorage.removeItem('karaoke_admin_token'); initAdmin(); } });
  });
}
function renderAdminLiveHtml(state) {
  const adminCopy = adminI18n[currentAdminLanguage()] || adminI18n.zh;
  // 从 state 取当前曲目。抽函数时漏了这一行会导致 ReferenceError → 控制台整页白屏。
  const current = state.current;
  return `<div class="stat-row"><div class="card stat"><div class="label">${esc(adminLabel('status'))}</div><div class="value">${state.playback.status === 'idle' ? esc(adminLabel('idle')) : state.playback.status === 'transition' ? esc(adminLabel('transitioning')) : state.playback.status === 'paused' ? esc(adminLabel('paused')) : esc(adminLabel('playing'))}</div></div><div class="card stat"><div class="label">${esc(adminLabel('queue'))}</div><div class="value">${state.queue.length}</div></div><div class="card stat"><div class="label">${esc(adminLabel('users'))}</div><div class="value">${state.users.length}</div></div><div class="card stat"><div class="label">${esc(adminLabel('volume'))}</div><div class="value">${state.playback.volume}%</div></div></div><div class="admin-layout"><section class="grid"><div class="card panel"><div class="section-head"><div><h2>${esc(adminLabel('nowPlaying'))}</h2><p>${current ? esc(nowPlayingMeta(current)) : esc(adminLabel('nowPlayingDescEmpty'))}</p></div><span class="tag ${current ? 'pin' : ''}">${current ? esc(current.duration) : 'IDLE'}</span></div><div class="notice" style="margin-bottom:17px">${current ? `<strong>${esc(current.title)}</strong><br><span class="muted">${current.source === 'local' ? `${esc(adminLabel('trackLibrary'))} · ${esc(current.spotifyId || '')}` : `Video ID: ${esc(current.videoId || '')}`}</span>` : esc(adminLabel('noCurrentSong'))}</div><div class="control-strip"><button class="btn primary playback" data-action="pause">${esc(adminLabel('pause'))}</button><button class="btn soft playback" data-action="resume">${esc(adminLabel('resume'))}</button><button class="btn ghost playback" data-action="skip">${esc(adminLabel('skip'))}</button><button class="btn danger playback" data-action="stop">${esc(adminLabel('stop'))}</button><div class="volume"><span class="muted">${esc(adminLabel('volume'))}</span><input id="volume" type="range" min="0" max="100" value="${state.playback.volume}"><b>${state.playback.volume}%</b></div></div><div class="vocal-mix" ${current ? '' : 'hidden'}><span class="muted">${esc(adminLabel('vocal'))}</span><input id="admin-vocal" type="range" min="0" max="100" step="1" value="${Number(state.playback.vocalLevel) || 0}"><b id="admin-vocal-value">${Number(state.playback.vocalLevel) || 0}%</b><div class="vocal-mix-presets"><button class="btn tiny soft vocal-preset" data-vocal="100" type="button">${esc(adminLabel('vocalOriginal'))}</button><button class="btn tiny soft vocal-preset" data-vocal="25" type="button">${esc(adminLabel('vocalGuide'))}</button><button class="btn tiny soft vocal-preset" data-vocal="0" type="button">${esc(adminLabel('instrumental'))}</button><span class="vocal-mix-sep"></span><button class="btn tiny soft vocal-preset ${state.settings.lyricsWordLevel ? ' on' : ''}" data-word-level="1" type="button" title="${esc(adminLabel('lyricsWordTitle'))}">${esc(adminLabel('lyricsWord'))}</button><button class="btn tiny soft vocal-preset ${state.settings.lyricsWordLevel ? '' : ' on'}" data-word-level="0" type="button" title="${esc(adminLabel('lyricsLineTitle'))}">${esc(adminLabel('lyricsLine'))}</button></div><span class="helper">${esc(adminLabel('vocalHint'))}</span></div><div class="playback-extras" id="video-lyrics-row" ${state.settings.playbackMode === 'video' ? '' : 'hidden'}><span class="extra-label">${esc(adminLabel('videoScreen'))}</span><button class="btn tiny soft vocal-preset${state.settings.videoShowLyrics ? ' on' : ''}" id="video-lyrics-toggle" type="button">${state.settings.videoShowLyrics ? esc(adminLabel('videoLyricsOn')) : esc(adminLabel('videoLyricsOff'))}</button><span class="helper">${esc(adminLabel('videoLyricsHint'))}</span></div></div><div class="card panel"><div class="section-head"><div><h2>${esc(adminLabel('queueTitle'))}</h2><p>${esc(adminLabel('queueDesc'))}</p></div><span class="tag">${state.queue.length} ${adminCopy.songUnit}</span></div><div class="queue-table">${state.queue.length ? state.queue.map((song, index) => `<div class="queue-item${song.isPinned ? ' is-pinned' : ''}" data-id="${song.id}"><div class="drag">⠿</div><div class="song-rank">${index + 1}</div><img class="song-thumb" src="${esc(song.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(song.title)}</div><div class="song-meta">${esc(song.singerName)} · ${esc(song.channelTitle)} · ${timeAgo(song.createdAt)}</div></div><div class="queue-actions"><button class="btn small ${song.isPinned ? 'pin-on' : 'soft'} pin-action" data-id="${song.id}" data-action="${song.isPinned ? 'unpin' : 'pin'}">${esc(song.isPinned ? adminLabel('unpin') : adminLabel('pin'))}</button><button class="btn small danger admin-remove" data-id="${song.id}">${esc(adminLabel('remove'))}</button></div></div>`).join('') : '<div class="empty">' + esc(adminLabel('queueEmpty')) + '</div>'}</div></div></section><aside class="grid"><div class="card panel"><div class="section-head"><div><h2>${esc(adminLabel('broadcastTitle'))}</h2><p>${esc(adminLabel('broadcastDesc'))}</p></div></div><form class="broadcast" id="broadcast-form"><input class="input" name="message" maxlength="120" placeholder="${esc(adminLabel('broadcastPlaceholder'))}" /><button class="btn teal">${esc(adminLabel('send'))}</button></form><label class="helper important-choice"><input name="important" type="checkbox"> ${esc(adminLabel('importantChoice'))}</label>${state.importantBroadcast ? `<div class="important-state"><span class="tag pin">${state.importantBroadcast.status === 'countdown' ? esc(adminLabel('recovering')) : esc(adminLabel('djOnAir'))}</span><button class="btn small danger" id="stop-important">${esc(adminLabel('stopImportant'))}</button></div>` : ''}</div><div class="card panel"><div class="section-head"><div><h2>${esc(adminLabel('settingsTitle'))}</h2><p>${esc(adminLabel('settingsDescShort'))}</p></div></div><form id="settings-form" class="grid"><div class="field"><label>${esc(adminLabel('eventName'))}</label><input class="input" name="roomName" value="${esc(state.settings.roomName)}" /></div><div class="field"><label>${esc(adminLabel('maxQueuedSongs'))}</label><input class="input" name="maxQueuedSongsPerGuest" type="number" min="1" max="10" value="${state.settings.maxQueuedSongsPerGuest}" /></div><label class="helper"><input name="allowDuplicatePerSession" type="checkbox" ${state.settings.allowDuplicatePerSession ? 'checked' : ''}> ${esc(adminLabel('allowDuplicate'))}</label><button class="btn primary">${esc(adminLabel('saveSettings'))}</button></form></div><div class="card panel participants-card"><div class="section-head"><div><h2>${esc(adminLabel('participants'))}</h2><p>${esc(adminLabel('participantsDescShort'))}</p></div></div>${state.users.length ? state.users.map(user => `<div class="user-row"><div class="avatar">${esc(user.displayName.slice(0,1))}</div><div class="user-copy"><div class="user-name">${esc(user.displayName)}</div><div class="user-meta">${currentAdminLanguage() === 'de' ? 'Warten' : currentAdminLanguage() === 'en' ? 'Waiting' : esc(adminLabel('waiting'))} ${user.songCount} ${adminCopy.songUnit} · ${timeAgo(user.lastSeenAt)}</div></div><span class="tag">${adminCopy.online}</span></div>`).join('') : `<div class="empty">${adminCopy.usersEmpty}</div>`}</div></aside></div>`;
}
// ---------------------------------------------------------------- 曲库管理（独立页面用）
let libraryRefreshTimer = null;

/**
 * 「改词重搜」弹窗：改歌名/歌手 → 调 /api/library/lyrics/rematch → 显示结果。
 * 搜到会写进 data/lyrics-overrides.json，之后播放时优先用这份歌词。
 */
function openLyricsRematchDialog(token, track) {
  const old = document.getElementById('lyrics-rematch');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'lyrics-rematch';
  wrap.className = 'settings-modal-backdrop open';
  wrap.innerHTML = `<section class="settings-modal card" style="max-width:520px">
    <div class="section-head"><div><h2>${esc(libraryText('libRematchTitle', '重新匹配歌词'))}</h2><p>${esc(track.title)} · ${esc((track.artists || []).join(', ') || '—')}</p></div><button class="btn ghost small" data-role="close">${esc(libraryText('libClose', '关闭'))}</button></div>
    <div class="grid">
      <div class="field"><label>${esc(libraryText('libTrackTitle', '歌名'))}</label><input class="input" id="lr-title" value="${esc(track.title || '')}" /></div>
      <div class="field"><label>${esc(libraryText('libTrackArtist', '歌手'))}</label><input class="input" id="lr-artist" value="${esc((track.artists || []).join(', ') || '')}" placeholder="${esc(libraryText('libArtistsHint', '多个歌手用逗号分隔'))}" /></div>
    </div>
    <p class="helper">${esc(libraryText('libRematchHint', '改动只影响歌词搜索，不会改曲库里的曲目信息。'))}</p>
    <div class="notice" id="lr-result" hidden></div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn primary" id="lr-go">${esc(libraryText('libRematchSearch', '搜索歌词'))}</button>
      <button class="btn ghost" data-role="close">${esc(libraryText('libCancel', '取消'))}</button>
    </div>
  </section>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-role="close"]')) close(); });
  const result = wrap.querySelector('#lr-result');
  const go = wrap.querySelector('#lr-go');
  go.onclick = async () => {
    const songTitle = wrap.querySelector('#lr-title').value.trim();
    const artist = wrap.querySelector('#lr-artist').value.trim();
    if (!songTitle) { toast(libraryText('libTitleRequired', '歌名不能为空')); return; }
    go.disabled = true;
    result.hidden = false;
    result.textContent = libraryText('libSearchingLyrics', '搜索中…');
    try {
      const r = await api('/api/library/lyrics/rematch', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify({ spotifyId: track.spotifyId, songTitle, artist }),
      });
      if (r.ok) {
        result.textContent = `${libraryFormat(libraryText('libMatched', '✅ 匹配成功：{provider} · {kind} · {lines} 行'), { provider: r.provider, kind: r.wordLevel ? libraryText('libWordLevel', '逐字') : libraryText('libLineLevel', '行级'), lines: r.lines })}\n${(r.preview || []).join(' / ')}`;
        toast(libraryText('libLyricsUpdated', '歌词已更新，播放时立即生效'));
        setTimeout(() => { close(); refreshAdminLibrary(token); }, 900);
      } else {
        result.textContent = r.reason === 'no-match'
          ? libraryText('libNoLyricsFound', '❌ 没搜到歌词。试试把歌名改得更短、或换一种写法（比如去掉括号里的后缀）。')
          : libraryFormat(libraryText('libRematchFailed', '❌ 失败：{error}'), { error: r.error || libraryText('libUnknownError', '未知错误') });
      }
    } catch (error) {
      result.textContent = `❌ ${error.message}`;
    } finally {
      go.disabled = false;
    }
  };
}

/** 残留分组标题：后端给的是 key，展示文案走 i18n。 */
const ORPHAN_GROUP_LABEL = {
  output: () => libraryText('libGroupOutput', '成品音频 / 视频'),
  covers: () => libraryText('libGroupCovers', '封面'),
  lyrics: () => libraryText('libGroupLyrics', '歌词文件'),
  upstream: () => libraryText('libGroupUpstream', '原始下载'),
  overrides: () => libraryText('libGroupOverrides', '歌词覆盖'),
};

/**
 * 「清理残留」弹窗：打开即扫描 → 勾选 → 清理。
 *
 * 扫描是只读的，只有点「清理选中」才会动文件，且删除前会二次确认。
 * 服务端还会再校验一次路径白名单，前端勾选什么都不能越界。
 */
function openOrphanCleanupDialog(token) {
  const old = document.getElementById('orphan-cleanup');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'orphan-cleanup';
  wrap.className = 'settings-modal-backdrop open';
  wrap.innerHTML = `<section class="settings-modal card" style="max-width:660px">
    <div class="section-head"><div><h2>${esc(libraryText('libCleanupTitle', '清理残留文件'))}</h2><p>${esc(libraryText('libCleanupDesc', '扫描曲库，找出已删除歌曲遗留的产物文件'))}</p></div><button class="btn ghost small" data-role="close">${esc(libraryText('libClose', '关闭'))}</button></div>
    <div id="oc-body"><div class="notice">${esc(libraryText('libScanning', '扫描中…'))}</div></div>
    <div id="oc-result" class="notice" hidden></div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button class="btn danger" id="oc-go" hidden>${esc(libraryText('libCleanup', '清理残留'))}</button>
      <button class="btn ghost" data-role="close">${esc(libraryText('libCancel', '取消'))}</button>
    </div>
  </section>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-role="close"]')) close(); });

  const body = wrap.querySelector('#oc-body');
  const result = wrap.querySelector('#oc-result');
  const go = wrap.querySelector('#oc-go');
  let scanned = null;

  const selected = () => {
    const paths = [...body.querySelectorAll('input[data-path]:checked')].map((i) => i.dataset.path);
    const keys = [...body.querySelectorAll('input[data-key]:checked')].map((i) => i.dataset.key);
    return { paths, overrideKeys: keys };
  };

  const syncButton = () => {
    const { paths, overrideKeys } = selected();
    const bytes = [...body.querySelectorAll('input:checked[data-bytes]')]
      .reduce((n, i) => n + (Number(i.dataset.bytes) || 0), 0);
    go.hidden = !(paths.length || overrideKeys.length);
    if (!go.hidden) {
      go.textContent = libraryFormat(libraryText('libCleanupConfirm', '确定删除选中的 {count} 项？共 {size}，删除后不可恢复。'),
        { count: paths.length + overrideKeys.length, size: formatBytes(bytes) });
    }
  };

  (async () => {
    try {
      scanned = await api('/api/library/admin/orphans', { headers: { 'x-admin-token': token } });
    } catch (error) {
      body.innerHTML = `<div class="notice">${esc(libraryFormat(libraryText('libScanFailed', '扫描失败：{error}'), { error: error.message }))}</div>`;
      return;
    }
    if (!scanned.available) {
      body.innerHTML = `<div class="notice">${esc(libraryText('libUnavailable', '曲库不可用：'))}${esc(scanned.reason || 'unknown')}</div>`;
      return;
    }
    const groups = (scanned.groups || []).filter((g) => g.items.length);
    if (!groups.length) {
      body.innerHTML = `<div class="notice">${esc(libraryText('libCleanupEmpty', '没有发现残留文件，曲库是干净的'))}</div>`;
      return;
    }

    body.innerHTML = `
      <p class="helper">${esc(libraryText('libCleanupHint', '只列出数据库里已无对应记录的产物。正在制作的歌曲不会出现在这里。'))}</p>
      ${(scanned.activeIds || []).length ? `<p class="helper">${esc(libraryFormat(libraryText('libCleanupActive', '有 {count} 首歌正在制作，其产物已自动排除'), { count: scanned.activeIds.length }))}</p>` : ''}
      <div class="oc-summary">${esc(libraryFormat(libraryText('libCleanupSummary', '发现 {count} 项残留，共 {size}'), { count: scanned.totalCount, size: formatBytes(scanned.totalBytes) }))}</div>
      <div class="oc-toolbar">
        <button class="btn soft small" id="oc-all">${esc(libraryText('libCleanupSelectAll', '全选'))}</button>
        <button class="btn soft small" id="oc-none">${esc(libraryText('libCleanupDeselectAll', '全不选'))}</button>
      </div>
      ${groups.map((group) => `
        <div class="oc-group">
          <div class="oc-group-head">
            <label class="oc-label"><input type="checkbox" data-group="${esc(group.key)}" checked /> <strong>${esc((ORPHAN_GROUP_LABEL[group.key] || (() => group.label))())}</strong></label>
            <span class="song-meta">${esc(libraryFormat(libraryText('libCleanupGroupItems', '{count} 项 · {size}'), { count: group.items.length, size: formatBytes(group.totalBytes) }))}</span>
          </div>
          <div class="song-meta oc-hint">${esc(group.hint || '')}</div>
          <div class="oc-items">
            ${group.items.map((item, index) => `
              <label class="oc-item">
                <input type="checkbox" data-group-item="${esc(group.key)}" ${item.path ? `data-path="${esc(item.path)}"` : `data-key="${esc(item.key)}"`} data-bytes="${Number(item.bytes) || 0}" checked />
                <span class="oc-name">${esc(item.name || item.id)}</span>
                <span class="song-meta">${esc(item.bytes ? formatBytes(item.bytes) : '')}</span>
                <span class="song-meta">${esc((item.mtime || '').slice(0, 10))}</span>
              </label>`).join('')}
          </div>
        </div>`).join('')}`;

    body.querySelector('#oc-all').onclick = () => {
      body.querySelectorAll('input[type="checkbox"]').forEach((i) => { i.checked = true; });
      syncButton();
    };
    body.querySelector('#oc-none').onclick = () => {
      body.querySelectorAll('input[type="checkbox"]').forEach((i) => { i.checked = false; });
      syncButton();
    };
    // 组级勾选框 = 组内全选/全不选
    body.querySelectorAll('input[data-group]').forEach((box) => {
      box.onchange = () => {
        body.querySelectorAll(`input[data-group-item="${box.dataset.group}"]`).forEach((i) => { i.checked = box.checked; });
        syncButton();
      };
    });
    body.querySelectorAll('input[data-group-item]').forEach((box) => { box.onchange = syncButton; });
    syncButton();
  })();

  go.onclick = async () => {
    const { paths, overrideKeys } = selected();
    const bytes = [...body.querySelectorAll('input:checked[data-bytes]')]
      .reduce((n, i) => n + (Number(i.dataset.bytes) || 0), 0);
    // 二次确认：文件是真删，不进回收站
    if (!confirm(libraryFormat(libraryText('libCleanupConfirm', '确定删除选中的 {count} 项？共 {size}，删除后不可恢复。'),
      { count: paths.length + overrideKeys.length, size: formatBytes(bytes) }))) return;

    go.disabled = true;
    result.hidden = false;
    result.textContent = libraryText('libCleanupRunning', '清理中…');
    try {
      const r = await api('/api/library/admin/orphans/purge', {
        method: 'POST',
        headers: { 'x-admin-token': token },
        body: JSON.stringify({ paths, overrideKeys }),
      });
      const removed = (r.files?.removed || []).length + (r.overrides?.removed || []).length;
      const skipped = (r.files?.rejected || []).length + (r.files?.failed || []).length + (r.overrides?.skipped || []).length;
      const freed = (r.files?.freedBytes || 0);
      result.textContent = skipped
        ? libraryFormat(libraryText('libCleanupPartial', '清理完成：成功 {removed} 项，跳过 {skipped} 项，失败 {failed} 项'),
          { removed, skipped, failed: (r.files?.failed || []).length })
        : `${libraryFormat(libraryText('libCleanupDone', '已清理 {count} 项，释放 {size}'), { count: removed, size: formatBytes(freed) })}\n${libraryText('libCleanupManifest', '删除清单已保存到 data/ 目录')}`;
      toast(libraryText('libCleanupDone', '已清理 {count} 项，释放 {size}').replace('{count}', removed).replace('{size}', formatBytes(freed)));
      setTimeout(() => { close(); refreshAdminLibrary(token); }, 1200);
    } catch (error) {
      result.textContent = libraryFormat(libraryText('libCleanupFailed', '清理失败：{error}'), { error: error.message });
    } finally {
      go.disabled = false;
    }
  };
}


/**
 * 歌词状态徽标。
 * 逐字 > 行级 > 纯文本 > 无。provider 前缀让人一眼看出是哪来的。
 */
function lyricsBadge(track) {
  const n = Number(track.lyricsCount) || 0;
  if (!n || !track.lyricsProvider) {
    return '<span class="lib-badge lib-badge-warn">' + esc(libraryText('libNoLyrics', '无歌词')) + '</span>';
  }
  const fmt = String(track.lyricsFormat || '').toLowerCase();
  const wordLevel = fmt === 'qrc' || (track.lyricsChars && fmt !== 'lrc' && fmt !== 'plain');
  const kind = wordLevel ? libraryText('libWordLevel', '逐字') : (track.lyricsSynced ? libraryText('libLineLevel', '行级') : libraryText('libPlainText', '纯文本'));
  const cls = wordLevel ? 'lib-badge-ok' : (track.lyricsSynced ? 'lib-badge' : 'lib-badge-warn');
  return `<span class="lib-badge ${cls}">${kind}</span><div class="song-meta">${esc(track.lyricsProvider)}</div>`;
}

// ---------------------------------------------------------------- 官方 MV（视频模式背景）
// 状态 → 徽章。顺序按「已经能用/在等/不能用」排列，方便一眼扫出需要处理的歌。
const VISUAL_STATUS_META = {
  auto_matched: { cls: 'lib-badge-ok', label: () => libraryText('libMvAuto', '自动匹配') },
  manually_confirmed: { cls: 'lib-badge-ok', label: () => libraryText('libMvManual', '已确认') },
  pending: { cls: 'lib-badge-warn', label: () => libraryText('libMvPending', '待确认') },
  unavailable: { cls: 'lib-badge-warn', label: () => libraryText('libMvUnavailable', '不可用') },
  not_found: { cls: 'lib-badge', label: () => libraryText('libMvNotFound', '未找到') },
};

/** 「MV」列的徽章：状态 + 标题/频道/时长（鼠标悬停看评分明细） */
function visualBadge(track) {
  const status = track.visualMatchStatus || 'pending';
  const meta = VISUAL_STATUS_META[status] || VISUAL_STATUS_META.pending;
  const score = track.visualMatchScore == null ? '' : ` · ${Number(track.visualMatchScore).toFixed(0)}`;
  const badge = `<span class="lib-badge ${meta.cls}">${esc(meta.label())}${esc(score)}</span>`;
  const detail = track.visualVideoId
    ? `${esc(String(track.visualVideoTitle || track.visualVideoId).slice(0, 42))}${track.visualChannelTitle ? `<br><span class="muted">${esc(String(track.visualChannelTitle).slice(0, 26))}</span>` : ''}`
    : `<span class="muted">${esc(libraryText('libMvNone', '没有 MV（播放时用专辑封面）'))}</span>`;
  const title = esc(track.visualMatchReason || '');
  return `<div class="lib-status-cell" title="${title}">${badge}<div class="song-meta">${detail}</div></div>`;
}

/**
 * 「官方 MV」弹窗：查看当前匹配 / 重新搜索 / 从候选中选择 / 手填 videoId / 确认 / 清除。
 *
 * 只动曲库的 visual_* 字段，**不会**碰 sourceVideoId（音频处理用的 YouTube 源）。
 */
function openMvDialog(token, track) {
  const old = document.getElementById('mv-dialog');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = 'mv-dialog';
  wrap.className = 'settings-modal-backdrop open';
  wrap.innerHTML = `<section class="settings-modal card" style="max-width:720px">
    <div class="section-head"><div><h2>${esc(libraryText('libMvTitle', '官方 MV（背景画面）'))}</h2><p>${esc(track.title)} · ${esc((track.artists || []).join(', ') || '—')}</p></div><button class="btn ghost small" data-role="close">${esc(libraryText('libClose', '关闭'))}</button></div>
    <p class="helper">${esc(libraryText('libMvHint', '官方 MV 只在视频模式里作为静音背景在线播放（YouTube IFrame），不会下载，也不影响本地 MP3 音频。找不到或不可用时会自动换成模糊专辑封面。'))}</p>
    <div id="mv-body"><div class="notice">${esc(libraryText('libMvLoading', '读取中…'))}</div></div>
    <div id="mv-result" class="notice" hidden></div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
      <button class="btn primary" id="mv-search">${esc(libraryText('libMvSearch', '重新搜索'))}</button>
      <button class="btn ghost" data-role="close">${esc(libraryText('libCancel', '取消'))}</button>
    </div>
  </section>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-role="close"]')) close(); });
  const body = wrap.querySelector('#mv-body');
  const result = wrap.querySelector('#mv-result');
  const searchBtn = wrap.querySelector('#mv-search');
  let current = null;

  const say = (text, isError) => {
    result.hidden = false;
    result.textContent = text;
    result.style.color = isError ? '#b42318' : '';
  };

  const call = async (action, payload = {}) => api(`/api/library/admin/tracks/${encodeURIComponent(track.spotifyId)}/mv`, {
    method: 'POST',
    headers: { 'x-admin-token': token },
    body: JSON.stringify({ action, ...payload }),
  });

  const fmtDuration = (sec) => {
    if (!sec && sec !== 0) return '—';
    const total = Math.round(Number(sec));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };

  const render = (data) => {
    current = data;
    const status = data.visualMatchStatus || 'pending';
    const meta = VISUAL_STATUS_META[status] || VISUAL_STATUS_META.pending;
    const candidates = data.candidates || [];
    body.innerHTML = `
      <div class="mv-current">
        <div class="mv-current-head">
          <span class="lib-badge ${meta.cls}">${esc(meta.label())}${data.visualMatchScore == null ? '' : ` · ${Number(data.visualMatchScore).toFixed(0)}`}</span>
          ${data.visualMatchedAt ? `<span class="song-meta">${esc(String(data.visualMatchedAt).slice(0, 19))}</span>` : ''}
        </div>
        ${data.visualVideoId
          ? `<div class="mv-line"><strong>${esc(data.visualVideoTitle || data.visualVideoId)}</strong>
               <a href="https://www.youtube.com/watch?v=${encodeURIComponent(data.visualVideoId)}" target="_blank" rel="noopener noreferrer">${esc(data.visualVideoId)} ↗</a></div>
             <div class="song-meta">${esc(data.visualChannelTitle || '—')} · ${esc(fmtDuration(data.visualDuration))}</div>`
          : `<div class="song-meta">${esc(libraryText('libMvNone', '没有 MV（播放时用专辑封面）'))}</div>`}
        ${data.visualMatchReason ? `<div class="song-meta mv-reason">${esc(data.visualMatchReason)}</div>` : ''}
        <div class="mv-actions">
          ${data.visualVideoId && status !== 'manually_confirmed' ? `<button class="btn small soft" data-mv="confirm">${esc(libraryText('libMvConfirm', '确认这个 MV'))}</button>` : ''}
          ${data.visualVideoId ? `<button class="btn small ghost" data-mv="clear">${esc(libraryText('libMvClear', '清除'))}</button>` : ''}
        </div>
      </div>
      <div class="mv-manual">
        <label class="field"><span>${esc(libraryText('libMvManualLabel', '手动指定 YouTube videoId'))}</span>
          <input class="input" id="mv-videoid" placeholder="dQw4w9WgXcQ" value="" /></label>
        <button class="btn small soft" data-mv="custom">${esc(libraryText('libMvSave', '保存'))}</button>
      </div>
      <div class="mv-candidates">
        <div class="section-head"><div><h3>${esc(libraryText('libMvCandidates', '候选视频'))}</h3><p class="helper">${esc(libraryText('libMvCandidatesHint', '点「选用」把候选项设为官方 MV（状态变成已确认，之后自动匹配不会再改动它）。'))}</p></div></div>
        <div class="mv-list">
        ${candidates.length ? candidates.map((c) => `
          <div class="mv-candidate${c.videoId === data.visualVideoId ? ' is-current' : ''}" title="${esc((c.reasons || []).join('；'))}">
            <img class="song-thumb" src="${esc(c.thumbnailUrl || '')}" alt="">
            <div class="song-main">
              <div class="song-title" title="${esc(c.title || '')}">${esc(c.title || c.videoId)}</div>
              <div class="song-meta">${esc(c.channelTitle || '—')} · ${esc(fmtDuration(c.duration))}${c.source === 'ytmusic' ? `<span class="mv-source" title="${esc(libraryText('libMvSourceYtmTitle', '来自 YouTube Music（ytmusicapi），不消耗官方 API 配额'))}">YouTube Music</span>` : ''}</div>
            </div>
            <div class="queue-actions">
              <span class="mv-score" title="${esc(libraryText('libMvScore', '评分'))}">${Number(c.score || 0).toFixed(0)}</span>
              <a class="btn small ghost" href="https://www.youtube.com/watch?v=${encodeURIComponent(c.videoId)}" target="_blank" rel="noopener noreferrer">${esc(libraryText('libMvPreview', '预览'))}</a>
              <button class="btn small soft" data-mv="select" data-video-id="${esc(c.videoId)}">${esc(libraryText('libMvUse', '选用'))}</button>
            </div>
          </div>`).join('') : `<div class="empty">${esc(libraryText('libMvNoCandidates', '还没有候选。点「重新搜索」从 YouTube 找官方 MV。'))}</div>`}
        </div>
      </div>
      ${data.config && data.config.apiKeyConfigured === false && !(data.config.ytmusic && data.config.ytmusic.available)
        ? `<div class="notice">${esc(libraryText('libMvNoKey', '没有配置 YouTube API Key：自动匹配被跳过，只能手动填 videoId。'))}</div>`
        : ''}`;

    body.querySelectorAll('[data-mv]').forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.mv;
        button.disabled = true;
        try {
          if (action === 'custom') {
            const videoId = (body.querySelector('#mv-videoid')?.value || '').trim();
            if (!videoId) { say(libraryText('libMvNeedId', '请填写 YouTube videoId 或链接'), true); return; }
            const data2 = await call('custom', { videoId });
            say(libraryText('libMvSaved', '✅ 已保存并标记为「已确认」'));
            render(data2);
          } else if (action === 'select') {
            const data2 = await call('select', { videoId: button.dataset.videoId });
            say(libraryText('libMvSaved', '✅ 已保存并标记为「已确认」'));
            render(data2);
          } else if (action === 'confirm') {
            const data2 = await call('confirm');
            say(libraryText('libMvSaved', '✅ 已保存并标记为「已确认」'));
            render(data2);
          } else if (action === 'clear') {
            if (!confirm(libraryText('libMvClearConfirm', '清除这首歌的 MV？视频模式会改用模糊专辑封面。'))) return;
            const data2 = await call('clear');
            say(libraryText('libMvCleared', '已清除'));
            render(data2);
          }
          setTimeout(() => refreshAdminLibrary(token), 400);
        } catch (error) {
          say(`❌ ${error.message}`, true);
        } finally {
          button.disabled = false;
        }
      };
    });
  };

  const load = async () => {
    try {
      const data = await api(`/api/library/admin/tracks/${encodeURIComponent(track.spotifyId)}/mv`, { headers: { 'x-admin-token': token } });
      render(data);
    } catch (error) {
      body.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
    }
  };

  searchBtn.onclick = async () => {
    searchBtn.disabled = true;
    say(libraryText('libMvSearching', '正在 YouTube 搜索官方 MV…'));
    try {
      const data = await call('search');
      // 现在只要能搜到候选就会自动选最高分；只有"一个候选都没有"才是没找到。
      say(data.visualVideoId
        ? libraryText('libMvAutoDone', '✅ 已自动选用最高分')
        : libraryText('libMvNotFoundDone', '没有找到可用的 MV（视频模式会用模糊专辑封面）'));
      render(data);
      setTimeout(() => refreshAdminLibrary(token), 400);
    } catch (error) {
      // 限流（429）不是"没找到"：明确告诉管理员稍后自动恢复，别误以为这首歌没有 MV
      const limited = error.code === 'YOUTUBE_RATE_LIMITED' || /限流|429/.test(String(error.message));
      say(limited
        ? libraryText('libMvRateLimited', '⏳ YouTube 暂时限流（429），MV 搜索已暂停，稍后会自动恢复重试')
        : `❌ ${error.message}`, true);
    } finally {
      searchBtn.disabled = false;
    }
  };

  load();
}

function formatBytes(n) {
  if (!n) return '—';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
function formatDuration(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
function libraryStatusBadge(track) {  const map = {
    processed: [libraryText('libStatusProcessed', '已处理'), 'teal-status'],
    processing: [libraryText('libStatusProcessing', '处理中'), 'warn'],
    pending: [libraryText('libStatusPending', '待处理'), 'muted'],
    failed: [libraryText('libStatusFailed', '处理失败'), 'danger'],
    canceled: [libraryText('libStatusCanceled', '已取消'), 'muted'],
  };
  let key = 'pending';
  if (track.status === 'separated' || track.status === 'processed') key = 'processed';
  else if (track.status === 'processing') key = 'processing';
  else if (track.status === 'failed') key = 'failed';
  else if (track.status === 'canceled') key = 'canceled';
  const [label] = map[key];
  const stage = track.status === 'processing' ? ` · ${esc(track.stageLabel || libraryText('libQueued', '排队中'))}${track.progress && track.progress.percent ? ` ${track.progress.percent}%` : ''}` : '';
  return `<span class="lib-badge lib-${key}">${label}${stage}</span>`;
}
/**
 * 「一键匹配 MV / 歌词」进度条 + 按钮。
 *
 * 后端是**串行 + 间隔**跑（避免 YouTube 429），所以这里只显示进度，
 * 不做前端并发；刷新时按 `/api/library/admin` 里带回的 matcher 状态渲染。
 */
function matchBarHtml(data) {
  const job = data.matcher || { state: 'idle', counts: { total: 0, done: 0, failed: 0, skipped: 0, remaining: 0 } };
  const need = data.matchCandidates || { mv: 0, lyrics: 0 };
  const c = job.counts || {};
  const total = c.total || 0;
  const finished = (c.done || 0) + (c.failed || 0) + (c.skipped || 0);
  const pct = total ? Math.round((finished / total) * 100) : 0;
  const running = job.state === 'running';
  const limit = data.visualConfig && data.visualConfig.quota ? data.visualConfig.quota : {};
  const limited = Boolean(limit.rateLimited);

  // 「补测伴奏响度」：老曲库导入的歌没有 LUFS 数据，得跑一遍 ffmpeg 才能均衡。
  // 它和「一键匹配」共用同一个串行队列（一次只跑一个任务），跑的时候两个按钮都禁用。
  const needLoudness = (data.matchCandidates || {}).loudness || 0;
  const loudnessOk = Boolean(data.loudnessTool && data.loudnessTool.available);
  const loudnessBtn = `
    <button class="btn soft" id="lib-loudness-start" data-count="${needLoudness}"
      title="${esc(loudnessOk ? libraryText('loudnessMeasureTitle', '用 ffmpeg 测出缺失的伴奏 LUFS / 真峰值（串行跑，不影响播放）') : libraryText('loudnessMeasureUnavailable', '响度测量不可用：找不到 ffmpeg 或 Python'))}"
      ${(running || !needLoudness || !loudnessOk) ? 'disabled' : ''}>
      ${esc(libraryFormat(libraryText('loudnessMeasureBtn', '补测响度（缺 {n}）'), { n: needLoudness }))}
    </button>`;
  // 配额用完 / 限流中：**不禁用按钮，改成红色**——DJ 点下去会弹二次确认，
  // 确认后带 force 强行重试（并且优先走免配额的 YouTube Music 源）。
  const hasWork = need.mv + need.lyrics > 0;
  const limitClass = limited ? ' danger is-limited' : '';
  const ytmOk = Boolean(data.visualConfig && data.visualConfig.ytmusic && data.visualConfig.ytmusic.available);
  const limitTitle = limited
    ? (limit.exhausted
      ? (ytmOk
        ? libraryText('libMatchForceQuotaYtm', 'YouTube 官方 API 今日配额已用完。将改用 YouTube Music 源（无配额限制）继续匹配。是否继续？')
        : libraryText('libMatchForceQuota', 'YouTube 官方 API 今日配额已用完，继续匹配大概率会全部跳过。仍要强行重试？'))
      : (ytmOk
        ? libraryFormat(libraryText('libMatchForceRateYtm', 'YouTube 正在限流（{sec} 秒后自动恢复）。将改用 YouTube Music 源（无配额限制）继续匹配。是否继续？'), { sec: limit.cooldownRemainingSec || 0 })
        : libraryFormat(libraryText('libMatchForceRate', 'YouTube 正在限流（{sec} 秒后自动恢复），现在匹配大概率会全部跳过。仍要强行重试？'), { sec: limit.cooldownRemainingSec || 0 })))
    : libraryText('libMatchTitle', '后台串行补齐缺失的官方 MV 与歌词（低并发，避免 YouTube 限流）');
  const matchBtn = `
    <button class="btn soft${limitClass}" id="lib-match-start" data-force="${limited ? '1' : '0'}" title="${esc(limitTitle)}" ${(running || !hasWork) ? 'disabled' : ''}>
      ${esc(libraryFormat(libraryText('libMatchStart', '一键匹配（缺 {mv} MV · {lyrics} 歌词）'), { mv: need.mv, lyrics: need.lyrics }))}
      ${limited ? `<span class="lib-match-flag">${esc(libraryText('libMatchQuotaHint', '配额受限'))}</span>` : ''}
    </button>`;
  if (running) {
    // 后台跑的时候**保留两个入口按钮（禁用）**，进度收成一小段「n/total + 进度条」。
    // 旧版会把整个工具栏换成一行长文字，MV / 补测响度按钮直接消失，DJ 会以为功能没了。
    return `<div class="lib-match is-running">
      ${matchBtn}
      <span class="lib-match-text" title="${esc(libraryFormat(libraryText('libMatchRunningTitle', '后台任务进行中：完成 {done} / 共 {total} · 失败 {failed} · 跳过 {skipped}'), { done: finished, total, failed: c.failed || 0, skipped: c.skipped || 0 }))}"><span class="lib-match-spinner"></span>${finished}/${total}</span>
      <div class="lib-match-bar"><i style="width:${pct}%"></i></div>
      <button class="btn ghost" id="lib-match-cancel" title="${esc(libraryText('libMatchCancelTitle', '停止后台任务'))}">${esc(libraryText('libMatchCancel', '停止'))}</button>
      ${loudnessBtn}
    </div>`;
  }
  const summary = total
    ? `${libraryText('libMatchLast', '上次')}：${c.done || 0}/${total}${c.failed ? ` · ${libraryText('libMatchFail', '失败')} ${c.failed}` : ''}${c.skipped ? ` · ${libraryText('libMatchSkip', '跳过')} ${c.skipped}` : ''}`
    : '';
  return `<div class="lib-match">${matchBtn}${summary ? `<span class="song-meta">${esc(summary)}</span>` : ''}${loudnessBtn}</div>`;
}

async function refreshAdminLibrary(token) {
  const content = document.getElementById('admin-content');
  if (!content) return;
  try {
    const data = await api('/api/library/admin', { headers: { 'x-admin-token': token } });
    if (!data.available) { content.innerHTML = `<div class="notice">${esc(libraryText('libUnavailable', '曲库不可用：'))}${esc(data.reason || 'unknown')}</div>`; return; }
    const q = document.getElementById('lib-search')?.value || '';
    // MV 状态筛选（「待确认」最常用：人工过一遍低置信度的歌）
    const mvFilter = document.getElementById('lib-mv-filter')?.value || '';
    let tracks = q ? data.tracks.filter(t => `${t.title} ${(t.artists || []).join(' ')} ${t.album || ''}`.toLowerCase().includes(q.toLowerCase())) : data.tracks;
    if (mvFilter) tracks = tracks.filter(t => (t.visualMatchStatus || 'pending') === mvFilter);
    const counts = data.counts || {};
    content.innerHTML = `
      <div class="card panel lib-panel">
        <div class="section-head">
          <div><h2>${esc(libraryText('libHeading', '曲库管理'))}</h2><p>${esc(libraryText('libDesc', '每首歌的处理状态、耗时、文件大小与匹配分。点歌触发的下载/分离会在这里显示实时阶段。'))}</p></div>
          <span class="tag">${esc(libraryFormat(libraryText('libSummary', '{total} 首 · 已处理 {processed} · 处理中 {processing} · 待处理 {pending} · 失败 {failed}'), { total: data.total, processed: counts.separated || 0, processing: counts.processing || 0, pending: (counts.new || 0) + (counts.resolved || 0) + (counts.downloaded || 0), failed: counts.failed || 0 }))}</span>
        </div>
        <div class="search-row" style="margin-bottom:14px"><input class="input" id="lib-search" placeholder="${esc(libraryText('libFilterPlaceholder', '按歌名 / 歌手 / 专辑筛选'))}" value="${esc(q)}" /><select id="lib-mv-filter" class="input" style="max-width:190px" title="${esc(libraryText('libMvFilterTitle', '只看某个 MV 状态的曲目'))}">
            <option value="">${esc(libraryText('libMvFilterAll', 'MV：全部'))}</option>
            ${['pending', 'auto_matched', 'manually_confirmed', 'not_found', 'unavailable'].map((key) => `<option value="${key}"${mvFilter === key ? ' selected' : ''}>${esc((VISUAL_STATUS_META[key] || VISUAL_STATUS_META.pending).label())} (${(data.visualCounts || {})[key] || 0})</option>`).join('')}
          </select>
          ${matchBarHtml(data)}
          <button class="btn soft" id="lib-refresh">${esc(libraryText('libRefresh', '刷新'))}</button><button class="btn ghost" id="lib-cleanup" title="${esc(libraryText('libCleanupDesc', '扫描曲库，找出已删除歌曲遗留的产物文件'))}">${esc(libraryText('libCleanup', '清理残留'))}</button></div>
        <div class="lib-table">
          <div class="lib-row lib-head"><div></div><div>${esc(libraryText('libColTrack', '曲目'))}</div><div>${esc(libraryText('libColStatus', '状态'))}</div><div>${esc(libraryText('libColLyrics', '歌词'))}</div><div>${esc(libraryText('libColMv', 'MV'))}</div><div>${esc(libraryText('libColDuration', '耗时'))}</div><div>${esc(libraryText('libColSize', '大小'))}</div><div>${esc(libraryText('libColMatch', '匹配分'))}</div><div>${esc(libraryText('libColActions', '操作'))}</div></div>
          ${tracks.length ? tracks.map(track => `
            <div class="lib-row${track.status === 'processing' ? ' lib-processing' : ''}">
              <img class="song-thumb" src="${esc(track.cover || '')}" alt="">
              <div class="song-main">
                <div class="song-title">${esc(track.title)}</div>
                <div class="song-meta">${esc((track.artists || []).join(', ') || '—')} · ${esc(track.album || '—')}</div>
                ${track.error ? `<div class="song-meta lib-error" title="${esc(track.error)}">${esc(libraryText('libErrorReason', '原因：'))}${esc(String(track.error).slice(0, 160))}</div>` : ''}
              </div>
              <div class="lib-status-cell">${libraryStatusBadge(track)}<div class="song-meta">${esc(track.statusText || '')}</div></div>
              <div class="lib-status-cell">${lyricsBadge(track)}</div>
              <div class="lib-status-cell">${visualBadge(track)}</div>
              <div class="song-meta">${formatDuration(track.elapsedMs)}${track.rtf ? `<br><span class="muted">RTF ${track.rtf}</span>` : ''}</div>
              <div class="song-meta">${formatBytes(track.outputBytes || track.audioBytes)}</div>
              <div class="song-meta">${track.matchScore === null || track.matchScore === undefined ? '—' : Number(track.matchScore).toFixed(1)}</div>
              <div class="queue-actions">
                ${track.status === 'processing'
                  ? `<button class="btn small ghost lib-cancel" data-id="${esc(track.spotifyId)}" title="${esc(libraryText('libStopTitle', '中止后台制作（仅 DJ）'))}">${esc(libraryText('libStop', '停止'))}</button>`
                  : ''}
                <button class="btn small soft lib-mv" data-id="${esc(track.spotifyId)}" title="${esc(libraryText('libMvShortTitle', '查看/更换官方 MV（视频模式背景）'))}">${esc(libraryText('libMvShort', 'MV'))}</button>
                <button class="btn small soft lib-lyrics" data-id="${esc(track.spotifyId)}" title="${esc(libraryText('libRematchShortTitle', '改歌名/歌手后重新搜歌词'))}">${esc(libraryText('libRematchShort', '改词重搜'))}</button>
                <button class="btn small danger lib-remove" data-id="${esc(track.spotifyId)}" title="${esc(libraryText('libDeleteTitle', '从曲库删除（含产物文件）'))}">${esc(libraryText('libDelete', '删除'))}</button>
              </div>
            </div>`).join('') : `<div class="empty">${esc(libraryText('libEmpty', '没有匹配的曲目'))}</div>`}
        </div>
      </div>`;
    const search = document.getElementById('lib-search');
    if (search) {
      search.onkeydown = (event) => { if (event.key === 'Enter') refreshAdminLibrary(token); };
      search.oninput = () => { clearTimeout(libraryRefreshTimer); libraryRefreshTimer = setTimeout(() => refreshAdminLibrary(token), 250); };
    }
    document.getElementById('lib-mv-filter')?.addEventListener('change', () => refreshAdminLibrary(token));
    document.getElementById('lib-refresh')?.addEventListener('click', () => refreshAdminLibrary(token));
    // 一键匹配：后端串行跑，这里只负责发起/停止，进度靠 4s 轮询（页面在跑时会自动刷新）
    document.getElementById('lib-match-start')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      // 配额受限时按钮是**红色但仍可点**：先弹二次确认，DJ 确认后才带 force 强行重试。
      // 服务端在 force 时会顺手清掉限流冷却，让官方 API 真的再试一次。
      const needsConfirm = button.dataset.force === '1';
      if (needsConfirm && !confirm(button.title || libraryText('libMatchForceQuota', 'YouTube 官方 API 今日配额已用完，继续匹配大概率会全部跳过。仍要强行重试？'))) {
        return;
      }
      button.disabled = true;
      try {
        const r = await api('/api/library/admin/match', {
          method: 'POST',
          headers: { 'x-admin-token': token },
          body: JSON.stringify({ kinds: ['mv', 'lyrics'], force: needsConfirm }),
        });
        const reasonText = r.reason === 'quota-exhausted' || r.reason === 'rate-limited'
          ? libraryText('libMatchStillBlocked', '还是没能启动：YouTube 官方 API 仍然受限')
          : libraryText('libMatchNothing', '没有需要匹配的歌曲');
        toast(r.started
          ? libraryFormat(libraryText('libMatchStarted', '已开始后台匹配 {count} 首'), { count: r.count })
          : reasonText);
      } catch (error) {
        toast(error.code === 'MATCH_ALREADY_RUNNING'
          ? libraryText('libMatchBusy', '已经有一批匹配任务在跑了')
          : error.message);
      } finally {
        refreshAdminLibrary(token);
      }
    });
    // 补测伴奏响度：和「一键匹配」同一个串行队列，只是 kind 不同
    document.getElementById('lib-loudness-start')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const r = await api('/api/library/admin/match', {
          method: 'POST',
          headers: { 'x-admin-token': token },
          body: JSON.stringify({ kinds: ['loudness'] }),
        });
        toast(r.started
          ? libraryFormat(libraryText('loudnessMeasureStarted', '已开始补测 {n} 首伴奏响度'), { n: r.count })
          : libraryText('loudnessMeasureNothing', '没有需要补测的歌曲'));
      } catch (error) {
        toast(error.code === 'MATCH_ALREADY_RUNNING'
          ? libraryText('libMatchBusy', '已经有一批匹配任务在跑了')
          : error.message);
      } finally {
        refreshAdminLibrary(token);
      }
    });
    document.getElementById('lib-match-cancel')?.addEventListener('click', async () => {
      try {
        await api('/api/library/admin/match/cancel', { method: 'POST', headers: { 'x-admin-token': token }, body: '{}' });
        toast(libraryText('libMatchCanceled', '已停止后台匹配'));
      } catch (error) { toast(error.message); }
      refreshAdminLibrary(token);
    });
    document.getElementById('lib-cleanup')?.addEventListener('click', () => openOrphanCleanupDialog(token));
    content.querySelectorAll('.lib-remove').forEach(button => button.onclick = async () => {
      const removeTrack = tracks.find(t => t.spotifyId === button.dataset.id);
      if (!confirm(libraryFormat(libraryText('libDeleteConfirm', '从曲库删除「{title}」？会同时删除成品音频、封面、歌词和原始下载文件。'), { title: removeTrack?.title || button.dataset.id }))) return;
      try { await api(`/api/library/admin/tracks/${encodeURIComponent(button.dataset.id)}`, { method: 'DELETE', headers: { 'x-admin-token': token } }); toast(libraryText('libDeleted', '已删除')); refreshAdminLibrary(token); }
      catch (error) {
        toast(error.code === 'NOT_FOUND'
          ? libraryText('libDeleteOutdated', '服务端版本过旧，请重启服务后再试')
          : error.message);
      }
    });
    content.querySelectorAll('.lib-cancel').forEach(button => button.onclick = async () => {
      if (!confirm(libraryText('libAbortConfirm', '中止这个后台制作任务？已生成的中间产物会保留，下次点歌会继续跑。'))) return;
      try { await api('/api/prepare/cancel', { method: 'POST', headers: { 'x-admin-token': token }, body: JSON.stringify({ spotifyId: button.dataset.id }) }); toast(libraryText('libAborted', '已中止')); refreshAdminLibrary(token); }
      catch (error) { toast(error.message); }
    });
    content.querySelectorAll('.lib-lyrics').forEach(button => button.onclick = () => {
      const track = tracks.find(t => t.spotifyId === button.dataset.id);
      if (track) openLyricsRematchDialog(token, track);
    });
    // 官方 MV：查看 / 重新搜索 / 从候选选择 / 手填 / 确认 / 清除
    content.querySelectorAll('.lib-mv').forEach(button => button.onclick = () => {
      const track = tracks.find(t => t.spotifyId === button.dataset.id);
      if (track) openMvDialog(token, track);
    });
    // 有任务在跑时自动刷新（制作中要看到阶段推进）；离开页面就停掉。
    if (libraryRefreshTimer) { clearInterval(libraryRefreshTimer); libraryRefreshTimer = null; }
    const onLibraryPage = () => location.pathname.startsWith('/library') && document.getElementById('admin-content');
    if (tracks.some(t => t.status === 'processing') || onLibraryPage()) {
      libraryRefreshTimer = setInterval(() => {
        if (onLibraryPage()) refreshAdminLibrary(token);
        else { clearInterval(libraryRefreshTimer); libraryRefreshTimer = null; }
      }, 4000);
    }
  } catch (error) {
    content.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
  }
}

function renderAdminCurrent(current) {
  if (!current) return '';
  return `<div class="queue-item queue-current"><div class="drag"></div><div class="song-rank current-rank" aria-label="${esc(localeText('playing', '播放中'))}">▶</div><img class="song-thumb" src="${esc(current.thumbnailUrl)}" alt=""><div class="song-main"><div class="song-title">${esc(current.title)}</div><div class="song-meta">${esc(current.singerName)} · ${esc(current.channelTitle)} · ${localeText('playing', '播放中')}</div></div><div class="queue-actions queue-actions-placeholder" aria-hidden="true"><button class="btn small soft" tabindex="-1">${esc(adminLabel('pin'))}</button><button class="btn small danger" tabindex="-1">${esc(adminLabel('remove'))}</button></div></div>`;
}
function renderAdminQueue(songs, current = null) {
  const currentRow = renderAdminCurrent(current);
  // 置顶状态用按钮自身表达（文字 + 高亮），不再额外塞一个「置顶」徽章，
  // 否则按钮写着"取消置顶"、旁边又挂着"置顶"，看着自相矛盾。
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
  const unit = adminLabel('songUnit');
  const waiting = localeText('waiting', '等待');
  return users.length ? users.map(user => `<div class="user-row" data-user-id="${esc(user.id)}"><div class="avatar">${esc(user.displayName.slice(0,1))}</div><div class="user-copy"><div class="user-name">${esc(user.displayName)}</div><div class="user-meta">${waiting} ${user.songCount} ${unit} · ${timeAgo(user.lastSeenAt)}</div></div><span class="tag">${adminI18n[currentAdminLanguage()]?.online || '在线活动'}</span><button class="btn small danger block-guest" data-session-id="${esc(user.id)}">${adminI18n[currentAdminLanguage()]?.blockGuest || '拉黑'}</button></div>`).join('') : `<div class="empty">${adminI18n[currentAdminLanguage()]?.usersEmpty || '还没有参与者'}</div>`;
}

function ensureGuestManagementPanel(token, state) {
  const participantsCard = [...document.querySelectorAll('#admin-content .card.panel')].find(card => card.classList.contains('participants-card') || card.querySelector('.user-row'));
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
  // 状态标签一律走 i18n key，不要回写中文字面量 —— applyAdminLanguage() 靠这些中文做状态判断，写死中文会让英文界面来回跳。
  if (statValues[0]) statValues[0].textContent = state.playback.status === 'idle' ? localeText('standby', '待机') : state.playback.status === 'transition' ? localeText('transition', '切歌中') : state.playback.status === 'paused' ? adminLabel('pause') : localeText('playing', '播放中');
  if (statValues[1]) statValues[1].textContent = state.queue.length;
  if (statValues[2]) statValues[2].textContent = state.users.length;
  if (statValues[3]) statValues[3].textContent = `${state.playback.volume}%`;
  const currentPanel = content.querySelector('.admin-layout > section > .card.panel');
  if (currentPanel) {
    const current = state.current;
    const currentMeta = currentPanel.querySelector('.section-head p');
    const currentTag = currentPanel.querySelector('.section-head .tag');
    const currentNotice = currentPanel.querySelector('.notice');
    if (currentMeta) currentMeta.textContent = current ? nowPlayingMeta(current) : adminLabel('nowPlayingEmpty');
    if (currentTag) currentTag.textContent = current ? current.duration : 'IDLE';
    if (currentNotice) currentNotice.innerHTML = current ? `<strong>${esc(current.title)}</strong><br><span class="muted">${current.source === 'local' ? `${localeText('localLibrary', '本地曲库')} · ${esc(current.spotifyId || '')}` : `Video ID: ${esc(current.videoId || '')}`}</span>` : localeText('currentEmpty', '当前还没有播放歌曲，点歌后会自动开始。');
  }
  const queueTable = content.querySelector('.queue-table');
  if (queueTable) { queueTable.innerHTML = renderAdminQueue(state.queue, state.current); linkAdminQueueTitles(content, state.queue, state.current); }
  const queueCount = content.querySelector('.queue-table')?.closest('.card')?.querySelector('.section-head .tag');
  if (queueCount) queueCount.textContent = `${state.queue.length} ${adminLabel('songUnit')}`;
  const usersCard = content.querySelector('.participants-card');
  if (usersCard) { const header = usersCard.querySelector('.section-head'); usersCard.innerHTML = ''; usersCard.append(header); usersCard.insertAdjacentHTML('beforeend', renderAdminUsers(state.users)); }
  const settings = document.getElementById('settings-form');
  if (settings) { settings.roomName.value = state.settings.roomName; settings.maxQueuedSongsPerGuest.value = state.settings.maxQueuedSongsPerGuest; settings.allowDuplicatePerSession.checked = state.settings.allowDuplicatePerSession; }
  const volume = document.getElementById('volume'); if (volume) volume.value = state.playback.volume;
  const volumeText = content.querySelector('.volume b'); if (volumeText) volumeText.textContent = `${state.playback.volume}%`;
  // 人声滑块双向同步：大屏上调了人声，DJ 这边要跟着动。
  // 之前只写不回读，两边各显示各的，DJ 看到的永远是旧值。
  const adminVocalInput = document.getElementById('admin-vocal');
  if (adminVocalInput && document.activeElement !== adminVocalInput) {
    const raw = Number(state.playback.vocalLevel);
    const v = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 100;
    if (Number(adminVocalInput.value) !== v) {
      adminVocalInput.value = String(v);
      const label = document.getElementById('admin-vocal-value');
      if (label) label.textContent = `${v}%`;
      document.querySelectorAll('.vocal-preset[data-vocal]').forEach(b => b.classList.toggle('on', Number(b.dataset.vocal) === v));
    }
  }
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
  const participantsCard = [...document.querySelectorAll('#admin-content .card.panel')].find(card => card.classList.contains('participants-card') || card.querySelector('.user-row'));
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
      if (normalHeading) normalHeading.textContent = adminLabel('normalBroadcast');
      if (normalDescription) normalDescription.textContent = adminLabel('normalBroadcastDesc');
      const importantCard = document.createElement('div');
      importantCard.className = 'card panel important-control-card';
      const isActive = Boolean(legacyState);
      // 旧版占位按钮的状态：优先看 data-state="countdown"，老 DOM 没有该属性时退回标签比对（用 i18n 后的文案，不写死中文）。
      const isCountdown = legacyState ? legacyState.dataset.state ? legacyState.dataset.state === 'countdown' : legacyState.textContent.includes(adminLabel('importantCountdown')) : false;
      const toggleLabel = isCountdown ? adminLabel('importantCountdown') : isActive ? adminLabel('importantStop') : adminLabel('importantStart');
      const toggleAction = isActive ? 'stop' : 'start';
      importantCard.innerHTML = `<div class="section-head"><div><h2>${adminLabel('importantBroadcast')}</h2><p>${adminLabel('importantDesc')}</p></div></div><button class="btn danger important-toggle" data-action="${toggleAction}" data-state="${isCountdown ? 'countdown' : isActive ? 'active' : 'idle'}" ${isCountdown ? 'disabled' : ''}>${toggleLabel}</button>`;
      legacyChoice?.remove();
      legacyState?.remove();
      broadcastCard.insertAdjacentElement('afterend', importantCard);
    }
  }
  // 只有当前歌曲变了（或按钮被重建）才撤销「再次确认」。普通 SSE 刷新不能撤销：
  // 准备期间后台每 250ms 广播一次，旧写法会让切歌按钮永远等不到第二次点击。
  const confirmSongId = state.current?.id || null;
  if (playbackConfirmButton && (!playbackConfirmButton.isConnected || confirmSongId !== playbackConfirmSongId)) {
    if (playbackConfirmTimer) clearInterval(playbackConfirmTimer);
    playbackConfirmButton.textContent = playbackConfirmAction === 'skip' ? adminLabel('skip') : adminLabel('stop');
    playbackConfirmButton.classList.remove('armed');
    playbackConfirmTimer = null;
    playbackConfirmButton = null;
    playbackConfirmAction = null;
    playbackConfirmSongId = null;
  }
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
    existingToggle.textContent = state.importantBroadcast ? localeText('importantOnAir', '重要广播中') : state.playback.status === 'paused' ? adminLabel('resume') : adminLabel('pause');
    existingToggle.disabled = !state.current || Boolean(state.importantBroadcast);
  } else if (pauseButton && resumeButton) {
    const toggleButton = document.createElement('button');
    toggleButton.className = 'btn primary playback-toggle';
    toggleButton.dataset.action = state.importantBroadcast ? '' : state.playback.status === 'paused' ? 'resume' : 'pause';
    toggleButton.textContent = state.importantBroadcast ? localeText('importantOnAir', '重要广播中') : state.playback.status === 'paused' ? adminLabel('resume') : adminLabel('pause');
    toggleButton.disabled = !state.current || Boolean(state.importantBroadcast);
    pauseButton.remove();
    resumeButton.replaceWith(toggleButton);
  }
  const importantButton = document.querySelector('.important-control-card .important-toggle');
  if (importantButton) {
    const countdown = state.importantBroadcast?.status === 'countdown';
    importantButton.dataset.action = state.importantBroadcast ? 'stop' : 'start';
    importantButton.dataset.state = countdown ? 'countdown' : state.importantBroadcast ? 'active' : 'idle';
    importantButton.textContent = countdown ? adminLabel('importantCountdown') : state.importantBroadcast ? adminLabel('importantStop') : adminLabel('importantStart');
    importantButton.disabled = countdown;
  }
  const playbackToggle = document.querySelector('.playback-toggle');
  if (playbackToggle) playbackToggle.onclick = async () => { try { await api('/api/admin/playback', { method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({action:playbackToggle.dataset.action}) }); } catch (error) { toast(error.message); } };
  document.querySelectorAll('.playback[data-action="skip"], .playback[data-action="stop"]').forEach(button => button.onclick = async () => {
    const action = button.dataset.action;
    const label = action === 'skip' ? adminLabel('skip') : adminLabel('stop');
    if (playbackConfirmButton === button && playbackConfirmAction === action) {
      if (playbackConfirmTimer) clearInterval(playbackConfirmTimer);
      playbackConfirmTimer = null; playbackConfirmButton = null; playbackConfirmAction = null; playbackConfirmSongId = null;
      button.textContent = label;
      button.classList.remove('armed');
      try { await api('/api/admin/playback', { method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({action}) }); } catch (error) { toast(error.message); }
      return;
    }
    if (playbackConfirmTimer) clearInterval(playbackConfirmTimer);
    if (playbackConfirmButton) { playbackConfirmButton.textContent = playbackConfirmAction === 'skip' ? adminLabel('skip') : adminLabel('stop'); playbackConfirmButton.classList.remove('armed'); }
    playbackConfirmButton = button; playbackConfirmAction = action; playbackConfirmSongId = state.current?.id || null; button.classList.add('armed');
    let remaining = 3;
    button.textContent = `${adminLabel('confirmAgain')} (${remaining})`;
    playbackConfirmTimer = setInterval(() => { remaining -= 1; if (remaining <= 0) { clearInterval(playbackConfirmTimer); playbackConfirmTimer = null; button.textContent = label; button.classList.remove('armed'); playbackConfirmButton = null; playbackConfirmAction = null; playbackConfirmSongId = null; } else button.textContent = `${adminLabel('confirmAgain')} (${remaining})`; }, 1000);
  });
  const volume = document.getElementById('volume'); if (volume) volume.onchange = async () => { try { await api('/api/admin/playback', { method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({action:'volume',volume:Number(volume.value)}) }); } catch (error) { toast(error.message); } };
  // 人声强度：滑块 + 三个预设，都走 action:'vocal'，服务端写进 state.playback.vocalLevel
  // 再通过 SSE 广播，大屏的 KaraokeMixer 会自动跟随。
  const adminVocal = document.getElementById('admin-vocal');
  const adminVocalValue = document.getElementById('admin-vocal-value');
  const sendVocal = async (pct) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (adminVocal) adminVocal.value = String(v);
    if (adminVocalValue) adminVocalValue.textContent = `${v}%`;
    document.querySelectorAll('.vocal-preset[data-vocal]').forEach(b => b.classList.toggle('on', Number(b.dataset.vocal) === v));
    try { await api('/api/admin/playback', { method:'POST', headers:{'x-admin-token':token}, body:JSON.stringify({action:'vocal',vocalLevel:v}) }); }
    catch (error) { toast(error.message); }
  };
  if (adminVocal) {
    adminVocal.oninput = () => { if (adminVocalValue) adminVocalValue.textContent = `${adminVocal.value}%`; };
    adminVocal.onchange = () => sendVocal(adminVocal.value);
    document.querySelectorAll('.vocal-preset[data-vocal]').forEach(b => { b.classList.toggle('on', Number(b.dataset.vocal) === Number(adminVocal.value)); b.onclick = () => sendVocal(b.dataset.vocal); });
  }
  // 歌词显示方式：逐字 / 逐行（影响两种画面）
  document.querySelectorAll('[data-word-level]').forEach(btn => {
    btn.onclick = async () => {
      const want = btn.dataset.wordLevel === '1';
      document.querySelectorAll('[data-word-level]').forEach(b => b.classList.toggle('on', b === btn));
      try { await api('/api/admin/settings', { method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({lyricsWordLevel:want}) }); }
      catch (error) { toast(error.message); }
    };
  });
  // 视频模式：歌词开 / 关
  // 这组按钮总是渲染在 DOM 里，只在视频模式可见 —— 每次进入这里都同步一次显隐，
  // 否则切换播放画面后按钮不会出现（页面初次渲染的 hidden 不会自己更新）。
  // 「歌词逐字」只有在歌词真的带逐字数据时才有意义。
  // 网易云 / lrclib 只有行级时间轴，切过去看不出任何变化 —— 这里如实标注。
  (() => {
    const btn = document.querySelector('[data-word-level="1"]');
    if (!btn) return;
    const cur = state.current;
    if (!cur || !cur.spotifyId) {
      btn.classList.remove('unavailable');
      btn.title = localeText('wordLevelTitle', '当前行按字逐个点亮');
      return;
    }
    if (cur.spotifyId === adminWordAvailKey) return;
    adminWordAvailKey = cur.spotifyId;
    const qs = new URLSearchParams({ videoId: 'local:' + cur.spotifyId, wordLevel: '1' });
    if (cur.title) qs.set('songTitle', cur.title);
    if (cur.channelTitle) qs.set('artist', cur.channelTitle);
    api('/api/lyrics/lookup?' + qs).then(payload => {
      const has = ((payload && payload.lines) || []).some(l => (l.chars || []).length > 1);
      btn.classList.toggle('unavailable', !has);
      btn.title = has
        ? localeText('wordLevelTitle', '当前行按字逐个点亮')
        : localeText('wordLevelUnavailable', '这首歌的歌词没有逐字数据（只有行级时间轴），切到逐字也不会有变化');
    }).catch(() => {});
  })();

  // 视频画面：歌词开关（单个按钮，只在「播放画面 = 视频」时出现）
  const videoLyricsRow = document.getElementById('video-lyrics-row');
  const videoLyricsBtn = document.getElementById('video-lyrics-toggle');
  if (videoLyricsRow) videoLyricsRow.hidden = state.settings.playbackMode !== 'video';
  if (videoLyricsBtn) {
    const on = state.settings.videoShowLyrics !== false;
    videoLyricsBtn.textContent = on ? localeText('videoLyricsOn', '视频歌词：开') : localeText('videoLyricsOff', '视频歌词：关');
    videoLyricsBtn.classList.toggle('on', on);
    videoLyricsBtn.onclick = async () => {
      const want = !(state.settings.videoShowLyrics !== false);
      // 先本地切一下给即时反馈，失败再回滚
      state.settings.videoShowLyrics = want;
      videoLyricsBtn.textContent = want ? localeText('videoLyricsOn', '视频歌词：开') : localeText('videoLyricsOff', '视频歌词：关');
      videoLyricsBtn.classList.toggle('on', want);
      try { await api('/api/admin/settings', { method:'PATCH', headers:{'x-admin-token':token}, body:JSON.stringify({videoShowLyrics:want}) }); }
      catch (error) { state.settings.videoShowLyrics = !want; videoLyricsBtn.textContent = !want ? localeText('videoLyricsOn', '视频歌词：开') : localeText('videoLyricsOff', '视频歌词：关'); videoLyricsBtn.classList.toggle('on', !want); toast(error.message); }
    };
  }
  // 置顶 / 删除的点击处理统一交给 renderAdminApp 里的 #admin-content 事件委托，
  // 这里不再逐按钮绑定：队列行每次刷新都重建 innerHTML，逐按钮绑定容易丢。
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
    ipWarning: 'YouTube 不允许在 IP 地址下嵌入播放。请在本机用 {url} 打开大屏，或用电脑名代替 IP；手机扫码用 IP 不受影响。',
    pointToWord: '切到逐字', pointToLine: '切到逐行'
  },
  en: {
    drinks: 'Drinks', drinksHint: 'Two-column price list under the queue; long lists keep the header and scroll slowly.',
    addRow: 'Add row', interval: 'Show interval (s)', saveDrinks: 'Save drinks', saved: 'Saved',
    name: 'Name', price: 'Price', drinksTitle: 'Bar',
    animations: 'Display animations', animationsHint: 'Plays on the display for about 7 seconds.',
    fireworks: 'Fireworks', confetti: 'Celebrate', hearts: 'Hearts', sparkles: 'Sparkles', disco: 'Disco', balloons: 'Balloon Party', petals: 'Petal Rain', bubbles: 'Dreamy Bubbles', neon: 'Neon Pulse', aurora: 'Aurora Glow', shootingStars: 'Meteor Shower',
    noBroadcasts: 'No broadcasts yet', broadcastAdded: 'Added — it now loops on the display', add: 'Add', broadcastInterval: 'Broadcast gap (s)',
    timing: 'Timing', broadcastDuration: 'Broadcast visible (s)', drinkDuration: 'Drinks visible (s)', drinkInterval: 'Drinks gap (s)', timingStale: 'The service is still running an older version. Restart the console so all timing values are saved.',
    ipWarning: 'YouTube does not allow embeds on IP addresses. Open the display at {url} on this PC, or use the PC name instead of the IP. Phone QR codes can still use the IP.',
    pointToWord: 'Switch to word-by-word', pointToLine: 'Switch to line-by-line'
  },
  de: {
    drinks: 'Getränke', drinksHint: 'Zweispaltige Preisliste unter der Warteschlange; lange Listen behalten die Kopfzeile und scrollen langsam.',
    addRow: 'Zeile hinzufügen', interval: 'Anzeigeintervall (s)', saveDrinks: 'Getränke speichern', saved: 'Gespeichert',
    name: 'Name', price: 'Preis', drinksTitle: 'Bar',
    animations: 'Display-Animationen', animationsHint: 'Läuft etwa 7 Sekunden auf der Anzeige.',
    fireworks: 'Feuerwerk', confetti: 'Feiern', hearts: 'Herzen', sparkles: 'Funkeln', disco: 'Disco', balloons: 'Ballonparty', petals: 'Blütenregen', bubbles: 'Traumblasen', neon: 'Neon-Puls', aurora: 'Polarlicht', shootingStars: 'Sternschnuppen',
    noBroadcasts: 'Noch keine Durchsagen', broadcastAdded: 'Hinzugefügt – läuft jetzt im Wechsel', add: 'Hinzufügen', broadcastInterval: 'Durchsage-Pause (s)',
    timing: 'Zeiten', broadcastDuration: 'Durchsage sichtbar (s)', drinkDuration: 'Getränke sichtbar (s)', drinkInterval: 'Getränke-Pause (s)', timingStale: 'Der Dienst läuft noch mit einer älteren Version. Konsole neu starten, damit alle Zeiten gespeichert werden.',
    ipWarning: 'YouTube erlaubt keine Einbettung über IP-Adressen. Öffne die Anzeige auf diesem PC unter {url} oder nutze den PC-Namen statt der IP. QR-Codes für Handys können die IP weiterhin verwenden.',
    pointToWord: 'Zu Wort für Wort', pointToLine: 'Zu Zeile für Zeile'
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
  renderShell(`<div class="display-shell"><main class="display-main"><div class="display-brand"><div class="brand"><img class="brand-mark" src="/ICON.png" alt="EESTEC LC AACHEN"><span>${esc(config.roomName)} - EESTEC LC AACHEN</span></div><div class="live-dot"><i></i> LIVE ROOM</div></div><div id="player" class="player-frame"></div><div id="display-broadcast" class="broadcast-banner"><strong>${localeText('liveMessage', '现场消息')}</strong><span>${localeText('welcome', '欢迎来到歌唱现场，扫描二维码点歌。')}</span></div></main><aside class="display-side"><div class="eyebrow">${localeText('scan', '扫码点歌')}</div><h1>${localeText('joinDisplay', '加入现场')}</h1><p>${localeText('scanDesc', '用手机扫描二维码，搜索并加入你的歌曲。')}</p><div class="qr-box"><img id="qr" alt="${localeText('qrAlt', '点歌二维码')}"></div><div class="side-title">${localeText('upNext', 'UP NEXT')} · <span id="queue-count">0</span></div><div id="display-queue" class="display-queue"></div><section id="drinks-card" class="drinks-card" hidden><div class="drinks-head"><span data-drinks-title>Bar</span><span>€</span></div><div class="drinks-viewport"><div id="drinks-track" class="drinks-track"></div></div></section><div class="display-footer"><span data-role="display-footer-copy">${localeText('displayFooter', '播放器区域保持独立，不覆盖 YouTube 控件。DJ 可在控制台暂停、恢复、切歌与调节音量。')}</span><button class="btn ghost small" id="display-fullscreen" type="button" aria-label="${localeText('fullscreen', '全屏')}" title="${localeText('fullscreen', '全屏')}"></button></div></aside><div id="animation-layer" class="animation-layer"></div><div id="important-overlay" class="important-overlay" aria-live="assertive"></div></div>`, {dark:true});
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
  // 页面加载就建好共享 AudioContext，并用第一次点击/按键尝试解锁。
  // 之后所有歌曲复用同一个 context：浏览器最多只在页面首次需要一次手势，
  // 不会每切一首歌都重新要求点击（以前每首歌 destroy 时 close 了 context）。
  try { window.KaraokeMixer?.preloadContext?.(); } catch {}
  const unlockAudioOnce = () => { try { window.KaraokeMixer?.unlock?.(); } catch {} };
  document.addEventListener('pointerdown', unlockAudioOnce, { capture: true, once: true });
  document.addEventListener('keydown', unlockAudioOnce, { capture: true, once: true });
  let currentPublicUrl = config.publicUrl || '';
  const refreshQr = async publicUrl => { const nextPublicUrl = publicUrl || ''; if (nextPublicUrl === currentPublicUrl) return; currentPublicUrl = nextPublicUrl; const joinUrl = `${(currentPublicUrl || location.origin).replace(/\/+$/, '')}/join`; try { const qr = await api(`/api/qr?text=${encodeURIComponent(joinUrl)}`); const image = document.getElementById('qr'); if (image) image.src = qr.dataUrl; } catch {} };
  displayQrRefresh = refreshQr;
  const qr = await api(`/api/qr?text=${encodeURIComponent(config.joinUrl)}`); document.getElementById('qr').src = qr.dataUrl;
  let playerInstance = null; let currentRequestId = null; let lastState = null; let countdownTimer = null;
  const renderImportant = important => { const overlay = document.getElementById('important-overlay'); if (!overlay) return; clearInterval(countdownTimer); countdownTimer = null; if (!important) { overlay.classList.remove('visible'); overlay.innerHTML = ''; return; } overlay.classList.add('visible'); const speakerIcon = '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M12 48h25l47-29v81L37 71H12z"></path><path d="M38 74l10 29h15L52 70"></path><path d="M97 39c9 11 9 31 0 42"></path><path d="M106 28c17 17 17 47 0 64"></path></svg>'; const update = () => { if (important.status !== 'countdown') { overlay.innerHTML = `<div class="important-card"><div class="speaker-icon">${speakerIcon}</div><div class="important-message">${localeText('djBroadcast', 'DJ 正在广播中')}</div><div class="important-subtitle">${localeText('listenNotice', '请听取现场通知')}</div></div>`; return; } const remaining = Math.max(0, Math.ceil((new Date(important.countdownEndsAt).getTime() - Date.now()) / 1000)); overlay.innerHTML = `<div class="important-card"><div class="speaker-icon countdown-speaker">${speakerIcon}</div><div class="important-message">${localeText('resumeSoon', '即将恢复播放')}</div><div class="important-countdown">${remaining || 1}</div><div class="important-subtitle">${localeText('resumeHint', '音乐将在倒计时结束后继续')}</div></div>`; if (remaining <= 0) clearInterval(countdownTimer); }; update(); if (important.status === 'countdown') countdownTimer = setInterval(update, 100); };
  const report = (requestId, event, detail) => api('/api/display/event', {method:'POST', body:JSON.stringify({requestId,event,detail})}).catch(() => {});
  let lyricsView = null; let lyricsKey = null; let appliedPlaybackMode = null;
  // spotifyId → 曲库详情（含 artists）。歌词查询需要歌手名，Apple Music 画面在
  // 拉详情之前就挂了，所以缓存起来供后续查询用。
  const trackCache = new Map();
  // 模式 B 的 video 画面：视频（静音）+ 两行歌词，时间轴仍以 KaraokeMixer 为准
  let videoMode = null; let videoModeKey = null;
  // 当前音乐引擎：'youtube'（模式 A）| 'local'（模式 B）| null（无歌/尚未挂载）
  let activeEngine = null;
  // 最近一次挂载的曲目，供测试核对（浏览器无播放权限时用于判定实际激活的引擎）
  let engineSong = null;

  // ===================== 本地曲库播放引擎（模式 B）=====================
  // YouTube 曲目走 YT.Player，本地曲目走 KaraokeMixer（伴奏 + 人声双轨 Web Audio）。
  // 两者统一包装成同一套接口，render() 的同步逻辑因此不需要区分引擎：
  //   getCurrentTime() / seekTo(sec) / setVolume(0-1) / play() / pause() / destroy()
  let localMixer = null; let localMixerSongId = null; let localVocalPct = 25;
  // 当前挂载的曲目 spotifyId：响度均衡要在"设置变了 / 详情回来了"时重新算增益，
  // 那时手边不一定有 track 对象，只能靠它从 trackCache 里取。
  let lastMountedSpotifyId = null;
  // 上一次生效的响度配置指纹：DJ 改设置时据此判断要不要重算（SSE 每帧都会推 state）
  let lastLoudnessSignature = null;
  // ---- 人声滑块的"本地优先"保护 ----
  // 拖滑块时本地值立刻变，但服务端的 SSE 还会继续推**旧值**（写回请求是节流的）。
  // render() 以前无条件用服务端值覆盖 → 滑块被拽回上一次的值，
  // 用户看到的就是"每动一下都闪一下，闪到原声"。
  // 下面三个变量让本地值在一小段时间内（或拖动期间）压过服务端回显。
  let vocalHoldPct = null;      // 本地刚设过、还没被服务端确认的值
  let vocalHoldUntil = 0;       // 保持到什么时候（毫秒时间戳）
  let vocalDragging = false;    // 正在拖（松手后还有一段兜底保持）
  let vocalDragTimer = null;
  // admin: 已检查过逐字可用性的歌曲 id，避免每次 SSE 都发一次歌词请求
  let lastPreparingKey = null;

  /** 歌曲标识：本地曲目只有 spotifyId（videoId 为 null），两者的缓存键必须分开 */
  const songIdentity = song => song ? (song.source === 'local' ? `local:${song.spotifyId || song.id}` : `yt:${song.videoId || song.id}`) : null;

  /**
   * 歌词查询用的歌手/歌名。
   *
   * 本地曲目有结构化元数据，不该让服务端从标题字符串里猜 ——
   * 只传 "Bohemian Rhapsody" 时 parseYoutubeTitle 拆不出歌手，
   * lrclib / QQ 都会匹配不到或匹配错歌（这就是"有时候歌词匹配失败"的主因）。
   * 队列项里的 channelTitle 存的就是歌手（点歌时写入），作为兜底。
   */
  const lyricsQueryFor = (song, track) => {
    const out = { songTitle: '', artist: '' };
    if (!song) return out;
    if (song.source === 'local') {
      out.songTitle = song.title || '';
      const fromTrack = track && Array.isArray(track.artists) ? track.artists.join(', ') : '';
      const ct = String(song.channelTitle || '').trim();
      // 不能用中文值 '本地曲库' 判断：那是接口给「本地点歌没带歌手」时写的兜底值，
      // 一旦界面语言切换或服务端改文案就会失效（曾因此把“本地曲库”当成歌手发给歌词源）。
      // 现在改判：默认占位值（本地曲库 / YouTube / Spotify 等，英文、德文的写法也算）不算歌手，
      // 其余 channelTitle 按「点歌时写入的歌手名」使用。
      const ctPlaceholder = String(track?.channelTitle || '').trim();
      const ctUsable = Boolean(ct) && !['本地曲库', '本地', 'Local library', 'Lokale Bibliothek', 'YouTube', 'Spotify'].includes(ct) && ct !== ctPlaceholder;
      out.artist = fromTrack || (ctUsable ? ct : '');
      return out;
    }
    out.songTitle = song.title || '';
    return out;
  };

  /**
   * 统一的歌词请求。视频模式和 Apple Music 模式**必须走这里**。
   *
   * 之前两边各写一套，差异很致命：
   *   视频模式   videoId = YouTube 的 id  → 服务端判不出是本地曲目，直接联网
   *   Apple Music videoId = local:<spotifyId> → 命中覆盖表/曲库，歌词完整还带翻译
   * 结果就是同一首歌，一个画面逐字但不完整、另一个完整但没逐字。
   * 现在统一用 songIdentity（本地曲目 = local:<spotifyId>），并带上时长与歌手。
   */
  const lyricsPayloadCache = new Map(); // 请求串 → Promise<payload>
  const lyricsRequestParams = (song, track) => {
    const lq = lyricsQueryFor(song, track);
    const qs = new URLSearchParams({ videoId: songIdentity(song) || '', wordLevel: '1' });
    if (lq.songTitle) qs.set('songTitle', lq.songTitle);
    if (lq.artist) qs.set('artist', lq.artist);
    if (!lq.songTitle) qs.set('title', (song && song.title) || '');
    const dur = track && track.durationMs ? Math.round(track.durationMs / 1000) : 0;
    if (dur) qs.set('duration', String(dur));
    return qs;
  };
  /** 两个画面共用同一份结果：同一首歌只请求一次 */
  const loadLyrics = (song, track) => {
    const qs = lyricsRequestParams(song, track);
    const cacheKey = qs.toString();
    const hit = lyricsPayloadCache.get(cacheKey);
    if (hit) return hit;
    const promise = api(`/api/lyrics/lookup?${qs}`).catch(error => {
      lyricsPayloadCache.delete(cacheKey); // 失败不要缓存，下次重试
      throw error;
    });
    lyricsPayloadCache.set(cacheKey, promise);
    // 只保留最近 12 条，避免内存无限增长
    if (lyricsPayloadCache.size > 12) {
      const first = lyricsPayloadCache.keys().next().value;
      if (first !== cacheKey) lyricsPayloadCache.delete(first);
    }
    return promise;
  };
  const isLocalSong = song => song?.source === 'local' && Boolean(song.spotifyId);
  // 准备中/准备失败：后台还没有产出音频文件，display 只显示状态，不建播放器
  const isSongPreparing = song => song?.status === 'preparing' || song?.status === 'prepare_failed';

  /**
   * 沉浸模式：鼠标一段时间不动，人声条和状态提示就完全消失。
   * 动一下就回来（并重新计时）。触摸屏上点一下也算。
   */
  const IDLE_MS = 2600;
  let idleTimer = null;
  let lastWakeAt = 0;
  const wakeUI = () => {
    const player = document.getElementById('player');
    if (!player) return;
    lastWakeAt = Date.now();
    player.classList.add('ui-awake');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // 定时器可能被重挂/清理，这里二次确认再收
      if (Date.now() - lastWakeAt >= IDLE_MS - 100) player.classList.remove('ui-awake');
    }, IDLE_MS);
  };
  /** 兜底：定时器万一丢了，渲染时把过期的 ui-awake 收掉，保证沉浸不会失效 */
  const enforceIdle = () => {
    const player = document.getElementById('player');
    if (!player || !player.classList.contains('ui-awake')) return;
    if (Date.now() - lastWakeAt > IDLE_MS + 400) player.classList.remove('ui-awake');
  };
  /**
   * 沉浸模式：**只有鼠标在歌词/播放区里动**才退出沉浸。
   *
   * 在其他地方（右侧二维码、顶部标题、DJ 面板）移动鼠标不会唤醒控件 ——
   * 现场大屏上 DJ 常要动鼠标做别的事，不希望歌词条的按钮一直闪出来。
   */
  const installIdleWatcher = () => {
    const player = document.getElementById('player');
    if (!player || player.dataset.idleWatched === '1') return;
    player.dataset.idleWatched = '1';
    const wake = () => wakeUI();
    // 监听绑在播放器上，不绑 window：范围外的移动不唤醒
    ['mousemove', 'pointermove', 'pointerdown', 'touchstart', 'wheel'].forEach((evt) => {
      player.addEventListener(evt, wake, { passive: true });
    });
    // 指针离开播放区就立刻收起（不用等 2.6 秒）
    const sleep = () => {
      clearTimeout(idleTimer);
      player.classList.remove('ui-awake');
    };
    player.addEventListener('mouseleave', sleep);
    player.addEventListener('pointerleave', sleep);
    // 键盘仍然全局：无障碍（键盘调滑块的人不该被卡住）
    window.addEventListener('keydown', wake, { passive: true });
  };

  /**
   * 大屏上的「逐字 / 逐行」切换。
   * 按钮显示的是**点下去会切到的那一种**，避免歧义。
   */
  const lyricsModeBtnEl = () => document.getElementById('vocal-lyrics-mode');
  const currentWordLevel = () => (lastState?.settings?.lyricsWordLevel !== false);
  function syncLyricsModeButton() {
    const btn = lyricsModeBtnEl();
    if (!btn) return;
    const on = currentWordLevel();
    btn.textContent = on ? localeText('lyricsToLine', '切到逐行') : localeText('lyricsToWord', '切到逐字');
    btn.title = on ? localeText('lyricsNowWord', '当前逐字高亮，点击改为整行高亮') : localeText('lyricsNowLine', '当前整行高亮，点击改为逐字高亮');
    btn.dataset.wordLevel = on ? '1' : '0';
  }
  /**
   * 把「逐字/逐行」立刻作用到已挂载的视图。
   *
   * 视频模式没有 lyricsView，只有 videoMode；以前切换只改按钮文字 + 打服务端，
   * 不重画视图，所以点了看不到任何变化（用户反馈"逐字/逐行点不了"）。
   */
  function applyWordLevelToViews(next) {
    try { videoMode?.setWordLevel?.(next); } catch { /* ignore */ }
    try {
      if (lyricsView && typeof lyricsView.setWordLevel === 'function') lyricsView.setWordLevel(Boolean(next));
    } catch { /* ignore */ }
    try { syncLyricsModeButton(); } catch { /* ignore */ }
  }

  async function toggleLyricsMode() {
    const next = !currentWordLevel();
    // 先本地切（立刻有反馈），失败再回滚
    if (lastState?.settings) lastState.settings.lyricsWordLevel = next;
    applyWordLevelToViews(next);
    try {
      await api('/api/display/lyrics-mode', { method: 'POST', body: JSON.stringify({ wordLevel: next }) });
    } catch {
      if (lastState?.settings) lastState.settings.lyricsWordLevel = !next;
      applyWordLevelToViews(!next);
    }
  }

  /** 本地曲目的人声强度滑块（把 lyrics-preview 的胶囊搬进正式播放界面） */
  const ensureVocalControl = () => {
    let el = document.getElementById('vocal-control');
    if (el) return el;
    const player = document.getElementById('player');
    if (!player) return null;
    installIdleWatcher();
    el = document.createElement('div');
    el.id = 'vocal-control';
    el.className = 'vocal-control';
    el.innerHTML = '<span class="vocal-control-label">' + esc(localeText('vocal', '人声')) + '</span>'
      + '<input id="vocal-level" class="vocal-control-range" type="range" min="0" max="100" step="1" title="' + esc(localeText('vocalLevel', '人声强度')) + '" aria-label="' + esc(localeText('vocalLevel', '人声强度')) + '" value="' + localVocalPct + '">'
      + '<span class="vocal-control-value" id="vocal-level-value"></span>'
      + '<span class="vocal-control-sep"></span>'
      + '<button type="button" class="vocal-control-preset" data-vocal-preset="100" title="' + esc(localeText('vocalOriginalTitle', '原唱：人声 100%')) + '">' + esc(localeText('vocalOriginal', '原唱')) + '</button>'
      + '<button type="button" class="vocal-control-preset" data-vocal-preset="25" title="' + esc(localeText('vocalGuideTitle', '人声导唱：人声 25%')) + '">' + esc(localeText('vocalGuide', '人声导唱')) + '</button>'
      + '<button type="button" class="vocal-control-preset" data-vocal-preset="0" title="' + esc(localeText('instrumentalTitle', '伴奏：人声 0%')) + '">' + esc(localeText('instrumental', '伴奏')) + '</button>'
      + '<span class="vocal-control-sep"></span>'
      + '<button type="button" class="vocal-control-preset" id="vocal-lyrics-mode" title="' + esc(localeText('lyricsModeSwitchTitle', '切换歌词显示方式（逐字 / 逐行）')) + '"></button>';
    const range = el.querySelector('#vocal-level');
    if (range) {
      // 拖动期间把 vocalDragging 拉起来：松手后稍等再放下，
      // 免得 SSE 恰好在松手那一瞬间把滑块拽回去。
      const markDragging = () => {
        vocalDragging = true;
        clearTimeout(vocalDragTimer);
        vocalDragTimer = setTimeout(() => { vocalDragging = false; }, 600);
      };
      range.addEventListener('pointerdown', markDragging);
      range.addEventListener('touchstart', markDragging, { passive: true });
      range.addEventListener('keydown', markDragging);
      range.addEventListener('input', () => { markDragging(); applyVocalPercent(range.value, { persist: true }); });
      range.addEventListener('change', () => {
        clearTimeout(vocalDragTimer);
        vocalDragTimer = setTimeout(() => { vocalDragging = false; }, 300);
      });
      range.addEventListener('pointerup', () => {
        clearTimeout(vocalDragTimer);
        vocalDragTimer = setTimeout(() => { vocalDragging = false; }, 300);
      });
    }
    el.querySelectorAll('[data-vocal-preset]').forEach(button => { button.addEventListener('click', () => applyVocalPercent(button.dataset.vocalPreset, { persist: true })); });
    const lyricsModeBtn = el.querySelector('#vocal-lyrics-mode');
    if (lyricsModeBtn) {
      syncLyricsModeButton();
      lyricsModeBtn.addEventListener('click', () => toggleLyricsMode());
    }
    // 视频模式：工具栏必须挂进 stage 里的 slot（.vlm-vocal-slot，z-index 高于 MV iframe）。
    // 以前这里查的选择器是 `.vlm-stage [data-vlm-vocal-slot]`（后代选择器），
    // 而 slot 本身就是一个带 data-vlm-vocal-slot 的元素、且它是 stage 的子元素 ——
    // 写法不对导致永远查不到，于是工具栏挂到了 #player 上：
    //   * 被 MV iframe 盖住 → 按钮点不到（"逐字/逐行点了没反应"）
    //   * 也没有 .vlm-vocal-slot .vocal-control 那套常驻可见样式
    // 现在优先认 `.vlm-stage .vlm-vocal-slot` / `[data-vlm-vocal-slot]` 两种写法。
    const slot = document.querySelector('.vlm-stage .vlm-vocal-slot')
      || document.querySelector('[data-vlm-vocal-slot]')
      || null;
    (slot || player).appendChild(el);
    applyVocalPercent(localVocalPct);
    // 刚出现时先亮着，2.6 秒后再进入沉浸态
    wakeUI();
    return el;
  };

  /** 显示/隐藏滑块：只有本地曲目能拆轨，YouTube 音轨拆不开，必须隐藏 */
  const toggleVocalControl = show => {
    if (!show) { document.getElementById('vocal-control')?.remove(); return; }
    const el = ensureVocalControl();
    // 视频模式下 slot 是后建的（mountVideoMode 才创建），如果之前挂到了 #player 上，
    // 这里把它搬到 slot 里，保证 z-index 盖过 MV iframe、按钮可点。
    const slot = document.querySelector('.vlm-stage .vlm-vocal-slot');
    if (el && slot && el.parentElement !== slot) slot.appendChild(el);
  };

  /**
   * 统一入口：滑块 + 数值 + 快捷按钮高亮 + mixer，全部从这里走。
   * persist=true 表示这是用户主动操作，要把人声值写回服务端 ——
   * 否则切歌 / 任何一次重渲染都会从 state 读回默认 100（原声），
   * 用户每次都得重新调。
   */
  /**
   * 从服务端 state.settings 里取出响度均衡配置，交给 mixer。
   * 缺字段时用与服务端一致的默认（老 state.json / 旧服务端）。
   */
  const loudnessConfigFrom = (settings) => {
    const s = settings || {};
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
      enabled: s.loudnessAutoEnabled !== false,
      targetLufs: num(s.loudnessTargetLufs, -18),
      truePeakCeiling: num(s.loudnessTruePeakCeiling, -1),
      maxGainDb: num(s.loudnessMaxGainDb, 12),
      maxCutDb: num(s.loudnessMaxCutDb, 12),
    };
  };

  /** 把当前歌曲的响度测量值 + 配置应用到 mixer（播放中改设置也走这里） */
  const applyLoudness = (settings, track) => {
    if (!localMixer) return null;
    const source = track || (lastMountedSpotifyId ? trackCache.get(lastMountedSpotifyId) : null);
    try {
      return localMixer.setLoudness?.(source?.loudness || null, loudnessConfigFrom(settings));
    } catch (error) {
      console.warn('[display] 响度均衡失败（不影响播放）', error);
      return null;
    }
  };

  const applyVocalPercent = (percent, options = {}) => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    localVocalPct = pct;
    const el = document.getElementById('vocal-control');
    const range = el?.querySelector('#vocal-level');
    const value = el?.querySelector('#vocal-level-value');
    if (range && range.value !== String(pct)) range.value = String(pct);
    if (value) value.textContent = `${pct}%`;
    el?.querySelectorAll('[data-vocal-preset]').forEach(button => { button.classList.toggle('on', Number(button.dataset.vocalPreset) === pct); });
    // 人声强度在 mixer 里是 0..1
    try { localMixer?.setVocalLevel?.(pct / 100); } catch {}
    if (options.persist) {
      // 用户主动改：本地值优先一段时（等服务端把新值回显回来再放开）
      vocalHoldPct = pct;
      vocalHoldUntil = Date.now() + 1500;
      persistVocalLevel(pct);
    }
    return pct;
  };

  /**
   * 服务端回显 → 是否应该接受（覆盖本地值）。
   *
   * 拖动中 / 刚设完的 1.5 秒内一律不接受，除非服务端正好等于我们设的值
   * （那说明写回已经生效，可以解除保持）。
   * 这就是"滑块不再被拽回原声"的关键。
   */
  function shouldAcceptServerVocal(serverPct) {
    if (vocalDragging) return false;
    if (vocalHoldPct == null) return true;
    if (Math.abs(Number(serverPct) - vocalHoldPct) <= 1) {
      // 服务端已经跟上我们的值 → 解除保持，以后完全听服务端的
      vocalHoldPct = null;
      vocalHoldUntil = 0;
      return true;
    }
    if (Date.now() < vocalHoldUntil) return false;
    vocalHoldPct = null;
    vocalHoldUntil = 0;
    return true;
  }

  /** 把人声值写回服务端（节流：拖滑块时别每像素发一次请求） */
  let vocalPersistTimer = null;
  const persistVocalLevel = pct => {
    if (lastState?.playback) lastState.playback.vocalLevel = pct;
    clearTimeout(vocalPersistTimer);
    vocalPersistTimer = setTimeout(() => {
      api('/api/display/vocal', { method: 'POST', body: JSON.stringify({ vocalLevel: pct }) }).catch(() => {});
    }, 350);
  };

  const destroyLocalMixer = () => {
    try { localMixer?.destroy?.(); } catch {}
    localMixer = null; localMixerSongId = null; lastMountedSpotifyId = null;
  };

  // ===================== 模式 B · 视频 + 两行歌词（playbackMode: 'video'）=====================
  /**
   * 曲目 → 画面所需素材：
   *   visualVideoId —— 官方 MV 的 YouTube videoId（IFrame 静音播放；不是本地文件）
   *   coverUrl      —— 官方 MV 不可用时的模糊封面
   * 注意：track.sourceVideoId 是**音频处理**用的 YouTube 源，与画面无关，绝不拿它当 MV。
   */
  const videoModeAssets = (song, track) => {
    const id = song.spotifyId || '';
    const visualVideoId = (song && song.visualVideoId) || (track && track.visualVideoId) || null;
    const cover = (track && track.cover) || (id ? `/media/covers/${encodeURIComponent(id)}.jpg` : (song.thumbnailUrl || ''));
    return {
      visualVideoId,
      visualMatchStatus: (track && track.visualMatchStatus) || (song && song.visualMatchStatus) || 'pending',
      coverUrl: cover,
      durationSec: track && track.durationMs ? track.durationMs / 1000 : 0,
    };
  };

  /**
   * 大屏报告"这个官方 MV 放不出来"：服务端把匹配状态写成 unavailable，
   * 下次不再自动加载同一个坏视频。失败只写日志，绝不影响本地音频与歌词。
   */
  const reportedVisualErrors = new Set();
  const reportVisualError = (spotifyId, detail) => {
    if (!spotifyId || !detail || !detail.videoId) return;
    const key = `${spotifyId}|${detail.videoId}`;
    if (reportedVisualErrors.has(key)) return;
    reportedVisualErrors.add(key);
    api('/api/display/visual-error', {
      method: 'POST',
      body: JSON.stringify({ spotifyId, videoId: detail.videoId, reason: detail.reason || '', code: detail.code ?? null }),
    }).catch(() => { /* 上报失败无所谓：播放器已经回退封面了 */ });
  };

  /** DJ 的「逐字/逐行」开关；默认开 */
  const lyricsWordLevelOn = state => state?.settings?.lyricsWordLevel !== false;
  /** DJ 的「视频模式显示歌词」开关；默认开 */
  const videoShowLyricsOn = state => state?.settings?.videoShowLyrics !== false;

  /**
   * 建/复用视频歌词视图，并按需加载歌词。
   * 时间轴只在 mixer.onTimeUpdate 里推进；歌词走 wordLevel=1（QQ 逐字 QRC），
   * 没有逐字数据时自动退化为整行。
   */
  const mountVideoMode = (state, track) => {
    const song = state.current;
    const host = document.getElementById('video-host');
    if (!song || !host || !window.VideoLyricsMode) return;
    const assets = videoModeAssets(song, track);
    if (!videoMode || videoMode.root !== host) {
      destroyVideoMode();
      videoMode = new window.VideoLyricsMode(host, {
        t: (key, fallback) => localeText(key, fallback),
        // 官方 MV（YouTube IFrame，静音）；null = 没有/未匹配/不可用 → 模糊封面
        visualVideoId: assets.visualVideoId,
        coverUrl: assets.coverUrl,
        duration: assets.durationSec,
        // 点画面跳转：只动本地音频
        onSeek: sec => { try { if (activeEngine === 'local') localMixer?.seek?.(sec); } catch {} },
        // MV 不可用：回退封面 + 上报服务端（写 visualMatchStatus=unavailable）
        onVideoError: detail => reportVisualError(song.spotifyId, detail),
      });
      videoMode.mount();
      // DJ 的两个开关：歌词逐字/逐行、视频模式下是否显示歌词
      videoMode?.setWordLevel?.(lyricsWordLevelOn(state));
      videoMode?.setLyricsVisible?.(videoShowLyricsOn(state));
      // 人声滑块挂进 stage 的 slot（MV 上方）
      if (document.getElementById('vocal-control')) toggleVocalControl(true);
    } else {
      videoMode.setCover(assets.coverUrl);
      // 只会「没有 → 有」或「同一首」：setVisualVideoId 内部判断，不会反复重建播放器
      videoMode.setVisualVideoId(assets.visualVideoId);
      videoMode?.setWordLevel?.(lyricsWordLevelOn(state));
      videoMode?.setLyricsVisible?.(videoShowLyricsOn(state));
    }
    try { videoMode.setPlaying(Boolean(localMixer && localMixer.playing)); } catch {}

    const key = `${songIdentity(song)}#video`;
    if (videoModeKey === key) return;
    videoModeKey = key;
    // 和 Apple Music 模式共用同一个请求（同样的 videoId/歌手/时长），
    // 否则两个画面会拿到不同的歌词。
    loadLyrics(song, track)
      .then(payload => { if (videoModeKey === key) { videoMode?.setLyrics(payload); videoMode?.setWordLevel?.(lyricsWordLevelOn(lastState || {})); } })
      .catch(() => { if (videoModeKey === key) videoMode?.setLyrics({ found: false, lines: [] }); });
  };

  const destroyVideoMode = () => {
    if (videoMode) { try { videoMode.destroy(); } catch {} }
    videoMode = null; videoModeKey = null;
  };

  // ===================== 自动播放被拒时的提示层 =====================
  // 浏览器要求「先有用户手势才能出声」。服务重启后大屏重新加载、还没人点过页面，
  // play() 就会被拒；此时所有播放/暂停操作都"没反应"。给个明显提示并接住第一次点击。
  let autoplayHintEl = null;
  const hideAutoplayHint = () => {
    if (autoplayHintEl) { autoplayHintEl.remove(); autoplayHintEl = null; }
    pendingResume = null;
    document.removeEventListener('pointerdown', onFirstGesture, true);
    document.removeEventListener('keydown', onFirstGesture, true);
  };
  let pendingResume = null;
  function onFirstGesture() {
    try { pendingResume?.(); } catch { /* ignore */ }
    hideAutoplayHint();
  }
  const showAutoplayHint = (onGesture) => {
    const player = document.getElementById('player');
    if (!player) return;
    pendingResume = onGesture;
    // 歌一换，player.innerHTML 会整体重建，旧的提示节点会被摘掉但变量还在；
    // 只判断 `!autoplayHintEl` 会让提示永远不再出现（有声音锁死却没有任何提示）。
    if (!autoplayHintEl || !autoplayHintEl.isConnected) {
      autoplayHintEl?.remove();
      autoplayHintEl = document.createElement('button');
      autoplayHintEl.type = 'button';
      autoplayHintEl.className = 'autoplay-hint';
      autoplayHintEl.innerHTML = '<span class="autoplay-hint-icon">▶</span><span>' + esc(localeText('tapToStart', '点击任意位置开始播放')) + '</span>';
      autoplayHintEl.onclick = () => { try { pendingResume?.(); } catch {} hideAutoplayHint(); };
    }
    if (autoplayHintEl.parentNode !== player) player.appendChild(autoplayHintEl);
    document.addEventListener('pointerdown', onFirstGesture, true);
    document.addEventListener('keydown', onFirstGesture, true);
  };

  /**
   * 挂载本地曲目（模式 B）。两种画面：
   *   playbackMode === 'lyrics' → 仿 Apple Music（LyricsView）
   *   其余（默认 'video'）      → 视频（静音）+ 两行歌词（VideoLyricsMode）
   * 音频始终走 KaraokeMixer：只有 MP3 混音才能调人声强度；视频只是视觉层。
   */
  const mountLocalPlayer = async state => {
    const song = state.current;
    const player = document.getElementById('player');
    const videoModeOn = !isLyricsMode(state);
    const missing = () => { player.innerHTML = `<div class="display-idle"><div class="big-note">${esc(localeText('trackMissing', '本地曲库中没有这首歌'))}</div><p>${esc(localeText('trackMissingDesc', '请让 DJ 重新导入，或跳到下一首。'))}</p></div>`; };
    player.classList.toggle('lyrics-mode', !videoModeOn);
    player.classList.toggle('video-mode', videoModeOn);
    player.innerHTML = videoModeOn ? '<div id="video-host" class="vlm-host"></div>' : '<div id="lyrics-host" class="lv-host"></div>';
    // 准备中/准备失败：还没有可播的音频文件，只显示状态，不建 mixer、不上报 error
    // （上报 error 会让服务端把这首歌判成 failed 跳过；这里应当安静等待 SSE 推来新状态）
    if (isSongPreparing(song)) {
      toggleVocalControl(false);
      player.innerHTML = `<div class="display-idle"><div class="big-note">${song.status === 'preparing' ? esc(localeText('preparing', '准备中…')) : esc(localeText('prepareFailed', '准备失败'))}</div><p>${song.status === 'preparing' ? esc(localeText('preparingDesc', '正在处理这首本地曲目，完成后会自动开始。')) : esc(localeText('prepareFailedDesc', '这首本地曲目处理失败，请让 DJ 跳过或重新导入。'))}</p></div>`;
      return null;
    }
    toggleVocalControl(true);
    // 人声强度以服务端 playback.vocalLevel 为准（DJ 控制台可调，SSE 会推过来）；
    // 但刚拖过滑块、还没被服务端确认时，别用旧值把用户刚设的值顶掉。
    if (typeof state.playback?.vocalLevel === 'number' && shouldAcceptServerVocal(state.playback.vocalLevel)) {
      localVocalPct = state.playback.vocalLevel;
    }
    applyVocalPercent(localVocalPct);
    if (videoModeOn) {
      mountVideoMode(state, null);
    } else {
      mountLyricsView(state);
    }
    let track = null;
    try { track = await api(`/api/library/tracks/${encodeURIComponent(song.spotifyId)}`); }
    catch (error) {
      missing();
      report(song.id, 'error', `本地音轨加载失败：${error.message}`);
      return;
    }
    // 缓存详情：歌词查询要用 artists（Apple Music 画面在拉详情前就挂了，得靠后续重查）
    if (track && song.spotifyId) trackCache.set(song.spotifyId, track);
    if (!state.current || state.current.id !== currentRequestId) return;
    const audio = track?.audio || {};
    // ready === false：后台还在下载/分离，同样只显示「准备中」，等状态变化/SSe 推新状态再挂载
    if (track?.ready === false) {
      toggleVocalControl(false);
      player.innerHTML = `<div class="display-idle"><div class="big-note">${esc(localeText('preparing', '准备中…'))}</div><p>${esc(localeText('preparingDesc', '正在处理这首本地曲目，完成后会自动开始。'))}</p></div>`;
      return null;
    }
    if (!audio.accompaniment || !audio.vocals) { missing(); report(song.id, 'error', '本地音轨缺失：缺伴奏或人声轨'); return; }
    if (!window.KaraokeMixer) {
      player.innerHTML = `<div class="display-idle"><div class="big-note">${localeText('playerFail', '播放器连接失败')}</div><p>${localeText('playerFailDesc', '请检查展示台的网络连接，再由 DJ 手动切歌。')}</p></div>`;
      return;
    }
    if (localMixerSongId === song.id && localMixer) return;
    destroyLocalMixer();
    const mixer = new window.KaraokeMixer({
      accompanimentUrl: audio.accompaniment,
      vocalsUrl: audio.vocals,
      // 视频模式的歌词与视频同步全部由这里驱动：mixer 每 50ms 报一次时间
      onTimeUpdate: (sec, duration) => {
        // 只用来推进歌词；MV 不跟时间轴（不做 seek/校正），见 video-lyrics-mode.js
        try { videoMode?.update?.(sec); } catch {}
        if (duration) try { videoMode.duration = duration; } catch {}
      },
      // 播完 → 先停 MV（MV 比歌长时随歌结束停止），再通知服务端切下一首
      onEnded: () => { try { videoMode?.stopVideo?.(); videoMode?.setPlaying?.(false); } catch {} report(song.id, 'ended'); }
    });
    // 统一播放引擎接口：mixer 只有 seek()，没有 YouTube 的 seekTo()
    mixer.seekTo = sec => mixer.seek(sec);
    localMixer = mixer; localMixerSongId = song.id; lastMountedSpotifyId = song.spotifyId || null;
    try {
      await mixer.load();
      if (localMixer !== mixer || currentRequestId !== song.id) return;
      // 坑 1：state.playback.volume 是 0–100，mixer.setVolume() 要 0–1
      mixer.setVolume((Number(state.playback.volume) || 0) / 100);
      applyVocalPercent(localVocalPct);
      // 响度均衡：按这首伴奏测出来的 LUFS / True Peak 实时补增益（不改音频文件）
      applyLoudness(state.settings, track);
      // 视频模式：音频解码完才挂 MV 与歌词（MV 来自曲库的 visualVideoId，与音频来源无关）
      if (videoModeOn) {
        mountVideoMode(state, track);
        try { videoMode.duration = mixer.duration; } catch {}
        try { videoMode.update(mixer.getCurrentTime()); } catch {}
      }
      // 浏览器自动播放策略：无用户手势时 play() 可能被拒绝，不能因此报 error 切歌
      if (state.importantBroadcast || state.playback.status === 'paused') mixer.pause();
      else {
        await mixer.play().then(() => { hideAutoplayHint(); report(song.id, 'playing'); }).catch(error => {
          // 浏览器自动播放策略：没有用户手势时 play() 会被拒。
          // 以前这里只 console.warn，界面毫无提示，表现得像"按播放/暂停都没反应"。
          console.warn('[display] 本地曲目自动播放被拒绝，等用户手势', error);
          showAutoplayHint(async () => {
            try {
              await mixer.play();
              hideAutoplayHint();
              report(song.id, 'playing');
            } catch (playError) {
              console.warn('[display] 用户手势后仍然无法播放', playError);
            }
          });
        });
      }
      // MV 跟随 mixer 的播放状态（mixer.play() 已 await，这里拿到的是真实状态）。
      // MV 只是背景：它出错/没就绪时 setPlaying 内部直接返回，不影响本地播放。
      try { videoMode?.setPlaying?.(Boolean(mixer.playing) && !state.importantBroadcast); } catch {}
    } catch (error) {
      console.error('[display] 本地音频解码失败', error);
      if (currentRequestId === song.id) report(song.id, 'error', `本地音频加载失败：${error.message}`);
    }
  };

  const isLyricsMode = state => state?.settings?.playbackMode === 'lyrics';
  const mountLyricsView = state => {
    const host = document.getElementById('lyrics-host');
    if (!host || !window.LyricsView) return;
    if (!lyricsView || lyricsView.root !== host) {
      lyricsView?.destroy?.();
      // 坑 3：时间源必须是当前引擎 —— 本地曲目只有 mixer 在走时钟，YT 播放器不存在
      lyricsView = new window.LyricsView(host, { t: (key, fallback) => localeText(key, fallback), getCurrentTime: () => { try { const engine = activeEngine === 'local' ? localMixer : playerInstance; return engine?.getCurrentTime?.() ?? null; } catch { return null; } } });
      // 坑 2：mixer 只有 seek()，没有 YouTube 的 seekTo()
      lyricsView.onSeek = sec => { try { if (activeEngine === 'local') localMixer?.seek?.(sec); else playerInstance?.seekTo?.(sec, true); } catch {} };
      lyricsView.mount();
    }
    // 本地曲目没有 videoId：封面走曲库封面（/media/covers/<spotifyId>.jpg），歌词查询退化为按标题匹配
    const localArt = state.current.source === 'local' && state.current.spotifyId ? `/media/covers/${encodeURIComponent(state.current.spotifyId)}.jpg` : '';
    lyricsView.setArtwork(window.LyricsViewHelpers?.artworkFor(state.current.videoId, localArt || state.current.thumbnailUrl));
    const key = songIdentity(state.current);
    if (lyricsKey === key) return;
    lyricsKey = key;
    lyricsView.setLoading(true);
    // 与视频模式共用同一个请求（见 loadLyrics 的说明）
    loadLyrics(state.current, trackCache.get(state.current.spotifyId))
      .then(payload => {
        if (lyricsKey !== key) return;
        lyricsView.setLyrics(payload);
        // 关键：以前漏了这一步，Apple Music 画面永远不会开逐字（只做行级高亮）。
        // 现在还要服从 DJ 的「逐字/逐行」开关。
        lyricsView.setWordLevel(Boolean(payload && payload.wordLevel) && lyricsWordLevelOn(lastState || {}));
        lyricsView.setLoading(false);
      })
      .catch(() => { if (lyricsKey === key) { lyricsView.setLyrics({ found: false, lines: [] }); lyricsView.setLoading(false); } });
  };
  const mountYoutubePlayer = async state => { const player = document.getElementById('player'); const lyricsMode = isLyricsMode(state); player.classList.toggle('lyrics-mode', lyricsMode); player.innerHTML = lyricsMode ? '<div id="lyrics-host" class="lv-host"></div><div id="yt-player" class="yt-audio-only"></div>' : '<div id="yt-player" style="width:100%;height:100%;min-height:420px"></div>'; if (lyricsMode) mountLyricsView(state); try { const YT = await loadYoutubeApi(); if (!state.current || state.current.id !== currentRequestId) return; playerInstance = new YT.Player('yt-player', { videoId: state.current.videoId, playerVars:{autoplay:1,controls:1,rel:0,playsinline:1,origin:location.origin}, events:{ onReady:event => { event.target.setVolume(state.playback.volume); if (state.importantBroadcast || state.playback.status === 'paused') event.target.pauseVideo(); else { event.target.playVideo(); report(state.current.id, 'playing'); } }, onStateChange:event => { if (event.data === 0) report(state.current.id, 'ended'); if (event.data === 1) report(state.current.id, 'playing'); if (event.data === 2) report(state.current.id, 'paused'); }, onError:event => { const playerEl = document.getElementById('player'); if (playerEl && !playerEl.classList.contains('lyrics-mode')) playerEl.innerHTML = `<div class="display-idle"><div class="big-note">${esc(localeText('unplayable', '这首歌无法嵌入播放'))}</div><p>${esc(localeText('unplayableDesc', '正在跳到下一首…'))}</p></div>`; report(state.current.id, 'error', `YouTube error ${event.data}`); } } }); } catch { player.innerHTML = `<div class="display-idle"><div class="big-note">${localeText('playerFail', '播放器连接失败')}</div><p>${localeText('playerFailDesc', '请检查展示台的网络连接，再由 DJ 手动切歌。')}</p></div>`; } };
  // 播放引擎分派：本地曲目走 KaraokeMixer，其余一律走原来的 YouTube 逻辑（模式 A 行为完全不变）
  const mountPlayer = async state => {
    engineSong = state.current || null;
    if (isLocalSong(state.current)) {
      activeEngine = 'local';
      playerInstance = null;
      return mountLocalPlayer(state);
    }
    activeEngine = 'youtube';
    destroyLocalMixer();
    toggleVocalControl(false);
    return mountYoutubePlayer(state);
  };
  const resetPlayback = () => { playerInstance?.destroy?.(); playerInstance = null; destroyLocalMixer(); destroyVideoMode(); activeEngine = null; engineSong = null; if (lyricsView) { lyricsView.destroy(); lyricsView = null; } lyricsKey = null; toggleVocalControl(false); };
  const render = state => { displayCurrentSong = state.current; const nextLanguage = state.settings?.interfaceLanguage || interfaceDefaults.language; const nextTheme = state.settings?.interfaceTheme || interfaceDefaults.theme; if (nextLanguage !== interfaceDefaults.language || nextTheme !== interfaceDefaults.theme) { setInterfaceDefaults(state.settings); applyTheme(); } const roomName = document.querySelector('.display-brand .brand span:last-child'); if (roomName && state.settings?.roomName) roomName.textContent = `${state.settings.roomName} - EESTEC LC AACHEN`; renderImportant(state.importantBroadcast); updateDrinks(state.settings); updateBroadcastBanner(state); updateDisplayAnimation(state.animation); document.getElementById('queue-count').textContent = state.queue.length; document.getElementById('display-queue').innerHTML = state.queue.length ? state.queue.slice(0, 8).map((song, i) => `<div class="display-song"><div class="number">${String(i+1).padStart(2,'0')}</div><div class="copy"><div class="title">${esc(song.title)}</div><div class="meta">${esc(song.singerName)}${song.isPinned ? ` · ${currentAdminLanguage() === 'de' ? 'Angepinnt' : currentAdminLanguage() === 'en' ? 'Pinned' : '置顶'}` : ''}</div></div></div>`).join('') : `<div class="empty">${localeText('noNext', '暂无后续歌曲')}</div>`; const banner = document.getElementById('display-broadcast'); const player = document.getElementById('player'); if (!state.current) { resetPlayback(); currentRequestId = null; player.classList.remove('lyrics-mode'); player.classList.remove('video-mode'); // 队列里还有正在制作的歌 → 显示"处理中"，不要显示"该你唱了"。
    // 只有队列真的空了才显示待机画面。
    // 注意要同时认 'queued'：点歌后歌先进 prepare 队列，这时是 queued，
// 等流水线真正跑起来才变 preparing。只认 preparing 的话，这段等待期会误显示待机。
    const q = state.queue || [];
    const preparingSong = q.find(s => s.status === 'preparing')
      || q.find(s => s.status === 'queued' && s.source === 'local')
      || null;
    // 制作中服务端每 250ms 广播一次，无脑重写 innerHTML 会让进度条动画不停从头开始。
    // 同一首歌只画一次。
    const preparingKey = preparingSong ? `${preparingSong.id}|${preparingSong.title}|${preparingSong.singerName || ''}` : '';
    if (preparingKey === lastPreparingKey) { applyDisplayLanguage(); lastState = state; return; }
    lastPreparingKey = preparingKey;
    player.innerHTML = preparingSong
      ? `<div class="display-idle display-preparing"><div class="eyebrow">${localeText('preparingEyebrow', 'PLEASE WAIT')}</div><div class="big-note">${localeText('preparingTitle', '处理中…')}</div><p>${esc(preparingSong.title || '')}${preparingSong.singerName ? ' · ' + esc(preparingSong.singerName) : ''}</p><p class="muted">${localeText('preparingDesc', '完成后会自动开始播放。')}</p><div class="preparing-bar"><i></i></div></div>`
      : `<div class="display-idle"><div class="eyebrow">${localeText('ready', 'READY WHEN YOU ARE')}</div><div class="big-note">${localeText('idleTitle', '等你来唱')}</div><p>${localeText('idleDesc', '点歌后，歌曲会自动出现在这里。')}</p></div>`;
    applyDisplayLanguage(); lastState = state; return; } // 有歌在播：准备中画面的"同一首歌只画一次"缓存必须失效。
    // 否则播完/切歌回到「没有 current、下一首还在制作」时，会因为 key 和上次相同而提前 return，
    // 但播放器 DOM 已经被上一位的播放器替换掉 → 大屏直接黑屏，不显示「处理中」。
    lastPreparingKey = null; const nextPlaybackMode = isLocalSong(state.current) ? (isLyricsMode(state) ? 'local-lyrics' : 'local-video') : (isLyricsMode(state) ? 'lyrics' : 'video'); const modeChanged = appliedPlaybackMode !== null && appliedPlaybackMode !== nextPlaybackMode; appliedPlaybackMode = nextPlaybackMode; const becameReady = engineSong?.id === state.current.id && engineSong?.status === 'preparing' && state.current.status !== 'preparing'; if (modeChanged && state.current) { resetPlayback(); currentRequestId = state.current.id; mountPlayer(state); } else if (currentRequestId !== state.current.id) { resetPlayback(); currentRequestId = state.current.id; mountPlayer(state); } else if (becameReady) { resetPlayback(); currentRequestId = state.current.id; mountPlayer(state); } else if (activeEngine === 'local') { if (state.playback.status === 'paused') { localMixer?.pause?.(); try { videoMode?.setPlaying?.(false); } catch {} } if (state.playback.status === 'playing') { localMixer?.play?.().catch(() => {}); try { videoMode?.setPlaying?.(!state.importantBroadcast); } catch {} } localMixer?.setVolume?.((Number(state.playback.volume) || 0) / 100); if (typeof state.playback.vocalLevel === 'number' && state.playback.vocalLevel !== localVocalPct && shouldAcceptServerVocal(state.playback.vocalLevel)) applyVocalPercent(state.playback.vocalLevel); } else if (playerInstance) { if (state.playback.status === 'paused') playerInstance.pauseVideo?.(); if (state.playback.status === 'playing') playerInstance.playVideo?.(); playerInstance.setVolume?.(state.playback.volume); } if (isLocalSong(state.current) && !isLyricsMode(state)) mountVideoMode(state, null); else if (isLyricsMode(state) || isLocalSong(state.current)) mountLyricsView(state); // DJ 改了「逐字/逐行」或「视频歌词开/关」时，立刻作用到已挂载的视图
    // DJ 改了响度均衡设置（目标 LUFS / 真峰值上限 / 最大增益…）→ 立刻重算增益，
    // 不用等切下一首歌才生效。只在配置真的变了时做，避免每帧都去 setTargetAtTime。
    try {
      const sig = JSON.stringify(loudnessConfigFrom(state.settings));
      if (sig !== lastLoudnessSignature) { lastLoudnessSignature = sig; applyLoudness(state.settings); }
    } catch {}
    try { videoMode?.setWordLevel?.(lyricsWordLevelOn(state)); videoMode?.setLyricsVisible?.(videoShowLyricsOn(state)); } catch {}
    try { if (lyricsView && typeof lyricsView.setWordLevel === 'function') { const want = lyricsWordLevelOn(state); if (lyricsView.state.wordLevel !== want) { lyricsView.setWordLevel(want); } } } catch {}
    try { if (lyricsView && typeof lyricsView.setShowTranslation === 'function') { const want = state.settings?.showTranslation !== false; if (lyricsView.state.showTranslation !== want) lyricsView.setShowTranslation(want); } } catch {}
    try { syncLyricsModeButton(); } catch {}
    try { enforceIdle(); } catch {}
    toggleVocalControl(isLocalSong(state.current) && !isSongPreparing(state.current)); applyDisplayLanguage(); lastState = state; };
  render(await api('/api/state')); connectEvents(render); window.__displayRender = render;
  // 初始画面画完后再尝试自动解锁：避免「点击开始播放」提示被待机画面覆写。
  // 带 --autoplay-policy 启动时 resume 会直接成功；被拦则等 1.5s 再提示点一次。
  try {
    const audioCtx = window.KaraokeMixer?.preloadContext?.();
    if (audioCtx && audioCtx.state === 'suspended' && !lastState?.current) {
      const resumed = await new Promise((resolve) => {
        let settled = false;
        const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        const timer = setTimeout(() => done(false), 1500);
        audioCtx.resume()
          .then(() => { clearTimeout(timer); done(audioCtx.state === 'running'); })
          .catch(() => { clearTimeout(timer); done(false); });
      });
      if (!resumed) showAutoplayHint(() => { window.KaraokeMixer?.unlock?.(); });
    }
  } catch { /* ignore */ }
}

applyTheme();
if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (currentThemePreference() === 'system') applyTheme('system'); });
window.addEventListener('storage', event => { if (event.key === 'karaoke_language' || event.key === 'karaoke_user_language') applyLocale(); if (event.key === 'karaoke_theme' || event.key === 'karaoke_user_theme') applyTheme(currentThemePreference()); });
(mode === 'admin' ? initAdmin : mode === 'library' ? initLibrary : mode === 'display' ? initDisplay : initJoin)().catch(error => { app.innerHTML = `<main class="login-wrap"><section class="card login-card"><div class="eyebrow">SYSTEM ERROR</div><h1>${esc(localeText('connectionFailed', '无法连接服务'))}</h1><p>${esc(error.message)}</p><button class="btn primary" onclick="location.reload()">${esc(localeText('reload', '重新加载'))}</button></section></main>`; });
