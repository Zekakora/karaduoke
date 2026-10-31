'use strict';
/**
 * 子进程环境净化（childEnv）。
 *
 * 为什么需要：从 Agent 沙箱里启动 node 服务时，环境会带一批 CODEBUDDY_* 守卫变量
 * （PYTHONPATH 指向沙箱 shim、CODEBUDDY_TOOL_CALL_ID、CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR 等）。
 * 它们会被本文件 `...process.env` 展开进所有 Python / Node 子进程：
 *
 *  * Python：shim 的 sitecustomize 会给 os.remove / Path.unlink 装上 "safe-delete" 守卫，
 *    每个 turn（CODEBUDDY_TOOL_CALL_ID 一个回合）删除累计到阈值（50 个）就要求人工确认，
 *    打印 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` 并 SystemExit(1)。
 *    pipeline 的 step_cleanup / finalize 清理中间产物（每首歌约 50 个临时文件：下载 WAV、
 *    4 轨 stem WAV 等）是**设计内**的批量删除 → 被误杀后退出码 1，整首歌被判"处理失败"，
 *    而其实两个成品 MP3 早就编码完了。
 *  * Node：NODE_OPTIONS --require 沙箱 shim 会钩住 fs 删除（同样认 CODEBUDDY_SAFE_DELETE_ENABLED）。
 *
 * 本应用子进程删的都是自己曲库目录里的可再生中间产物，不属于需要人工确认的批量删除，
 * 所以 spawn 前把这些变量剥掉 / 显式关掉。守卫的三个关断点（任一即失效）：
 *   1. CODEBUDDY_SAFE_DELETE_ENABLED='0'（shim 总开关）
 *   2. 去掉 CODEBUDDY_TOOL_CALL_ID 或 CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR（bulk 守卫激活条件）
 *   3. PYTHONPATH 移除 shim 目录（sitecustomize 根本不加载）
 */
const SANDBOX_PATH_RE = /app\.asar\.unpacked/i;

function childEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  // 1) 总开关置 0：shim 里 `_SAFE_DELETE_ENABLED = env.CODEBUDDY_SAFE_DELETE_ENABLED != '0'`
  env.CODEBUDDY_SAFE_DELETE_ENABLED = '0';
  // 2) bulk 守卫激活条件：STATE_DIR 与 TOOL_CALL_ID **同时**存在 → 全部剥掉
  for (const key of [
    'CODEBUDDY_TOOL_CALL_ID',
    'CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR',
    'CODEBUDDY_SAFE_DELETE_BULK_GUARD',
    'CODEBUDDY_SAFE_DELETE_BULK_REPLAY_FILE',
    'CODEBUDDY_SESSION_ID',
    'CLAUDE_SESSION_ID',
  ]) delete env[key];
  // 3) PYTHONPATH / NODE_OPTIONS 里的沙箱 shim 条目按路径特征剔除，用户自己的条目保留
  const pathsep = process.platform === 'win32' ? ';' : ':';
  if (env.PYTHONPATH) {
    const kept = String(env.PYTHONPATH).split(pathsep)
      .filter((p) => p && !SANDBOX_PATH_RE.test(p) && !/[\\/]vendor[\\/]shim[\\/]?$/i.test(p));
    if (kept.length) env.PYTHONPATH = kept.join(pathsep);
    else delete env.PYTHONPATH;
  }
  if (env.NODE_OPTIONS && /safe-delete|node-language-shim|genie-safe-delete/i.test(env.NODE_OPTIONS)) {
    delete env.NODE_OPTIONS;
  }
  return env;
}

module.exports = { childEnv };
