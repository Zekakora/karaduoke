'use strict';
/**
 * 队列顺序（模式 B）。
 *
 * 为什么单独抽出来：
 * 队列里不只有「能立刻播」的 queued，还有后台制作中的 preparing 和制作失败的
 * prepare_failed。以前选下一首时只看 queued（pendingSongs），于是正在准备的歌
 * 完全不占位：它后面新点的、曲库里已经 ready 的歌会直接开播，把前一首挤掉。
 * 大屏随之从「处理中」切到新歌，之后切歌时又因为前端缓存的准备中 key 没重置
 * 而黑屏。
 *
 * 现在的规则：
 * - 展示/排序：queued + preparing + prepare_failed 一起排（置顶优先，再按
 *   queuePosition，同位置按创建时间）。
 * - 选下一首：按同一个顺序扫描；遇到 preparing 就**停下等它**，不能越过它去
 *   播后面的歌；prepare_failed 是死项（不会自己变可播），跳过继续找。
 * - 位置归一化：把三种状态一起归一，preparing 因此能稳定占住自己入队时的位置，
 *   后续新点的歌不会因为 queuePosition 被重排而跑到它前面。
 */

const ACTIVE_STATUSES = ['queued', 'preparing', 'prepare_failed'];

/** 队列排序：置顶优先 → queuePosition → 创建时间（稳定兜底）。 */
function compareQueueOrder(a, b) {
  return Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned))
    || (Number(a.queuePosition) || 0) - (Number(b.queuePosition) || 0)
    || String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

/** 所有还占着队列位置的歌（含制作中/失败），已按播放顺序排好。 */
function activeSongs(songs) {
  return (Array.isArray(songs) ? songs : [])
    .filter((song) => song && ACTIVE_STATUSES.includes(song.status))
    .sort(compareQueueOrder);
}

/** 真正可以开播的等待项。 */
function pendingSongs(songs) {
  return (Array.isArray(songs) ? songs : [])
    .filter((song) => song && song.status === 'queued')
    .sort(compareQueueOrder);
}

/**
 * 按完整队列顺序选下一首。
 * @returns {{ next: object|null, blockedBy: object|null }}
 *   next      可以开播的 queued 歌（没有则 null）
 *   blockedBy 挡在前面的 preparing 歌（没有则 null）
 */
function chooseNextSong(songs) {
  for (const song of activeSongs(songs)) {
    if (song.status === 'preparing') return { next: null, blockedBy: song };
    // prepare_failed 是死项：不会自己变可播，跳过它，别把整条队列卡死。
    if (song.status === 'queued') return { next: song, blockedBy: null };
  }
  return { next: null, blockedBy: null };
}

/**
 * 把 active 队列的位置重排成 0..n-1。
 * 注意必须包含 preparing/prepare_failed：只归一 queued 会让制作中的歌的
 * queuePosition 停在旧值上，下一次归一后新歌反而排到它前面。
 * @returns {object[]} 原数组（原地修改）
 */
function normalizePositions(songs) {
  activeSongs(songs).forEach((song, index) => { song.queuePosition = index; });
  return songs;
}

/** 新歌应该放在队尾：当前 active 队列里最大的 queuePosition + 1。 */
function nextQueuePosition(songs) {
  return activeSongs(songs).reduce(
    (max, song) => Math.max(max, Number(song.queuePosition) || 0),
    -1,
  ) + 1;
}

module.exports = {
  ACTIVE_STATUSES,
  compareQueueOrder,
  activeSongs,
  pendingSongs,
  chooseNextSong,
  normalizePositions,
  nextQueuePosition,
};
