const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = ['.env', '.env.example']
    .map(file => path.join(__dirname, file))
    .find(file => fs.existsSync(file));
  if (!envPath) return;

  const isExample = path.basename(envPath) === '.env.example';
  if (!isExample && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  } else {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const value = match[2].replace(/^['"]|['"]$/g, '');
      if (isExample && value === 'change-this-password') continue;
      if (!process.env[match[1]]) process.env[match[1]] = value;
    }
  }

  if (isExample) {
    console.warn('[config] 未找到 .env，使用 config/config.json 与 .env.example 中的默认值。');
  }
}

loadDotEnv();

// 直接用 npm start / node main.js 调试时，从控制台的 config.json 补齐没设置的项；
// 显式设置的 .env 或环境变量优先级更高。
function loadLauncherConfig() {
  const file = path.join(__dirname, 'config', 'config.json');
  try {
    if (!fs.existsSync(file)) return;
    const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const service = config.service || {};
    if (!process.env.PORT && service.port) process.env.PORT = String(service.port);
    if (!process.env.HOST && service.host) process.env.HOST = service.host;
    if (!process.env.DJ_PASSWORD && config.djPassword) process.env.DJ_PASSWORD = config.djPassword;
    if (!process.env.YOUTUBE_API_KEY && config.youtubeApiKey) process.env.YOUTUBE_API_KEY = config.youtubeApiKey;
  } catch {}
}

loadLauncherConfig();

const { start } = require('./server');

start();
