-- Spotify Karaoke Lab —— 本地曲库（SQLite）
-- 设计目标：以 Spotify track_id 为唯一键，避免重复下载与重复分离。

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- 曲目表：一行 = 一个 Spotify 曲目（不论来自哪个来源）
CREATE TABLE IF NOT EXISTS tracks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Spotify 身份
  spotify_id        TEXT    NOT NULL UNIQUE,
  title             TEXT    NOT NULL,
  artists           TEXT    NOT NULL,              -- JSON 数组
  album             TEXT,
  album_art         TEXT,                          -- Spotify 封面 URL（CDN 原始地址）
  album_art_path    TEXT,                          -- 下载到本地的封面文件路径
  album_id          TEXT,                          -- Spotify 专辑 ID
  release_date      TEXT,                          -- 发行日期（精度可能只有年份）
  track_number      INTEGER,
  disc_number       INTEGER,
  explicit          INTEGER,                       -- 0/1
  popularity        INTEGER,                       -- 0~100，Spotify 热度
  duration_ms       INTEGER,
  uri               TEXT,
  isrc              TEXT,
  -- 音频来源（来自 YouTube / 备份站）
  source            TEXT,                          -- 'youtube' | 'spotriff' | 'local'
  source_video_id   TEXT,
  source_url        TEXT,
  source_title      TEXT,
  match_score       REAL,                          -- 0~100，匹配度
  match_reason      TEXT,                          -- 人类可读的匹配理由
  -- 本地文件
  audio_path        TEXT,                          -- 原始下载（44.1k WAV）
  audio_bytes       INTEGER,
  audio_sha256      TEXT,                          -- 内容级去重
  -- 状态
  status            TEXT NOT NULL DEFAULT 'new',
      -- new | resolving | resolved | downloading | downloaded
      -- separating | separated | failed
  error             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracks_status   ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_tracks_artist   ON tracks(artists);
CREATE INDEX IF NOT EXISTS idx_tracks_sha      ON tracks(audio_sha256);
CREATE INDEX IF NOT EXISTS idx_tracks_sourceid ON tracks(source_video_id);

-- 分离结果：一行 = 一种模型对某曲目的分离产物
CREATE TABLE IF NOT EXISTS stems (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id          INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  model             TEXT    NOT NULL,              -- htdemucs / htdemucs_ft ...
  device            TEXT,                          -- xpu / cpu
  segment           REAL,
  out_dir           TEXT    NOT NULL,
  vocals_path       TEXT,
  no_vocals_path    TEXT,
  drums_path        TEXT,
  bass_path         TEXT,
  other_path        TEXT,
  input_duration_s  REAL,
  processing_s      REAL,
  rtf               REAL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(track_id, model)
);

CREATE INDEX IF NOT EXISTS idx_stems_track ON stems(track_id);

-- 歌词：一行 = 一首歌的一份歌词
CREATE TABLE IF NOT EXISTS lyrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id          INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,                 -- lrclib | local
  synced            INTEGER NOT NULL DEFAULT 0,    -- 1 = 带时间轴
  format            TEXT,                          -- lrc | plain
  language          TEXT,
  content           TEXT,                          -- 原始文本（LRC 或纯文本）
  plain             TEXT,
  provider_id       TEXT,                          -- lrclib 记录 id
  offset_ms         INTEGER DEFAULT 0,             -- 人工校准偏移
  fetched_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(track_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_lyrics_track ON lyrics(track_id);

-- 任务日志：便于排查与统计
CREATE TABLE IF NOT EXISTS jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id          INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,                 -- resolve | download | lyrics | separate
  status            TEXT NOT NULL,                 -- started | ok | failed
  message           TEXT,
  duration_ms       INTEGER,
  at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_track ON jobs(track_id);
