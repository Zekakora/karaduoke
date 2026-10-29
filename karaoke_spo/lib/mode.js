'use strict';
/**
 * 模式 B —— 本地曲库版卡拉OK控制台
 *
 * 与 karaoke-hub（模式 A，YouTube）是**两套完全独立的工程**：
 *   - 不同目录、不同端口、不同 state.json、不同 sessions
 *   - 改这里的任何代码都不会影响模式 A
 *
 * 本文件只做「差异化覆盖」，其余全部复用与模式 A 相同的实现。
 *
 * 差异点汇总：
 *   1. 音源固定为本地曲库（sourceMode = 'local'，不可切换）
 *   2. 曲库指向项目根 data/library.db（可通过 LIBRARY_DB 覆盖）
 *   3. media 根指向项目根 assets/
 *   4. 默认播放画面为歌词模式（本地曲目没有视频）
 *   5. 关闭 onlyKaraokeSongs（本地曲目名不含 karaoke）
 */

const SERVICE_NAME = 'karaoke-hub-local';
const MODE = 'local';
const MODE_LABEL = '模式 B · 本地曲库';

module.exports = { SERVICE_NAME, MODE, MODE_LABEL };
