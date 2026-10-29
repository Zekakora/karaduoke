'use strict';

/*
 * 统一服务入口（项目根）。
 *
 * 控制台（launcher）启动服务时不直接跑子工程，而是跑这个文件：
 *   launcher\main.js  →  spawn(node <项目根>\main.js)  cwd = 当前模式的工程目录
 *
 * 这里负责两件事：
 *   1. 读出控制台配置（<项目根>\config\config.json，一份配置管 A/B 两个模式），
 *      补齐 PORT / DJ_PASSWORD / YOUTUBE_API_KEY 等环境变量；
 *   2. 按「当前跑的是哪个模式」加载对应工程自己的 main.js
 *      （工程目录 = process.cwd()，由 launcher 在 spawn 时设定）。
 *
 * 为什么不用 require 固定路径：两个模式是不同的工程，各自的 main.js 都在
 * cwd 里；这样切换模式只需要改 cwd，不用改入口文件。
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config', 'config.json');

// 控制台已经通过环境变量把配置传进来了；只有直接用 node main.js 调试时才需要兜底。
function loadLauncherConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return;
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    const service = config.service || {};
    if (!process.env.PORT && service.port) process.env.PORT = String(service.port);
    if (!process.env.HOST && service.host) process.env.HOST = service.host;
    if (!process.env.DJ_PASSWORD && config.djPassword) process.env.DJ_PASSWORD = config.djPassword;
    if (!process.env.YOUTUBE_API_KEY && config.youtubeApiKey) process.env.YOUTUBE_API_KEY = config.youtubeApiKey;
  } catch { /* 配置坏了不阻塞启动，工程会用自己的默认值 */ }
}

loadLauncherConfig();

// 工程目录：优先用启动器设定的 cwd；直接在命令行跑 node main.js 时按 config.json 里的 active 模式推断。
function resolveProject() {
  const cwd = process.cwd();
  if (cwd !== ROOT && fs.existsSync(path.join(cwd, 'main.js'))) return cwd;

  const modes = { A: 'karaoke_ytb', B: 'karaoke_spo' };
  // 启动器通过 KARADUOKE_MODE 指定模式；没有时读配置里的 mode.active。
  let active = process.env.KARADUOKE_MODE === 'A' ? 'A' : process.env.KARADUOKE_MODE === 'B' ? 'B' : '';
  if (!active) {
    active = 'B';
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (config.mode && config.mode.active === 'A') active = 'A';
    } catch { /* 用默认模式 */ }
  }
  const dir = path.join(ROOT, modes[active]);
  if (fs.existsSync(path.join(dir, 'main.js'))) return dir;

  // 兜底：项目根本身就是一个工程（旧布局）
  if (fs.existsSync(path.join(ROOT, 'server.js'))) return ROOT;
  return '';
}

const project = resolveProject();
if (!project) {
  console.error('[karaoke] 没有找到可启动的工程目录（karaoke_spo / karaoke_ytb 里都没有 main.js）。');
  process.exit(1);
}
process.chdir(project);

// 交给工程自己的入口：它会加载 .env、调用 server.start()
require(path.join(project, 'main.js'));
