'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { translate, normalizeLanguage } = require('./i18n');
const { normalizeEnv } = require('./environment');

const PORT_MIN = 1024;
const PORT_MAX = 65535;

function randomPassword(length = 10) {
  return crypto.randomBytes(16).toString('hex').slice(0, length);
}

function defaults() {
  return {
    language: 'en',
    // 两个模式互斥，共用一个端口；切换模式后重启服务即可换工程。
    service: { port: 3000, host: '0.0.0.0' },
    djPassword: randomPassword(),
    youtubeApiKey: '',
    // Spotify 凭证与授权状态集中放在这里（不再依赖 karaoke_spo\.env / data\spotify-token.json）。
    // 发布项目时 config\ 已被 .gitignore 排除，不会把真实凭证带出去。
    // refreshToken 由面板填入或从服务导入，启动服务时推给 karaoke_spo。
    spotify: { clientId: '', clientSecret: '', redirectUri: '', refreshToken: '', scope: '' },
    // 运行环境目录：Python 虚拟环境 / 模型缓存 / 二进制工具。
    // 留空 = 项目根\env（env\python、env\cache、env\bin）。
    // 也可以分别覆盖 python/cache/bin 三个子目录。
    env: { dir: '', python: '', cache: '', bin: '' },
    tunnel: { cloudflaredPath: '', fixedPublicUrl: '', autoStart: false },
    // 双工程模式切换：A = YouTube 在线版，B = 本地曲库版。
    // 这份配置在项目根，**一份配置同时管两个模式**：
    // 端口 / DJ 密码 / API Key / 穿透设置对 A、B 都是同一个值。
    // rootA/rootB 留空时按 karaoke_ytb / karaoke_spo 子目录自动推断。
    mode: { active: 'B', rootA: '', rootB: '' }
  };
}

// 兼容旧布局：配置以前放在 karaoke_spo\config\config.json。
// 项目根还没有 config.json、但子目录里有的时候，直接沿用那一份，避免重新生成 DJ 密码。
function legacyConfigFile(root) {
  for (const dir of ['karaoke_spo', 'karaoke_ytb']) {
    const file = path.join(root, dir, 'config', 'config.json');
    try { if (fs.existsSync(file)) return file; } catch { /* ignore */ }
  }
  return '';
}

function readLegacyEnv(root, key) {
  for (const name of ['.env', '.env.example']) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { continue; }
    const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, 'm'));
    if (!match) continue;
    const value = match[1].replace(/^['"]|['"]$/g, '').trim();
    if (value) return value;
  }
  return '';
}

// 旧版本把配置写在 .env 里，第一次生成 config.json 时顺手迁移，避免用户重新填一遍。
function applyLegacyEnv(config, root) {
  const port = Number(readLegacyEnv(root, 'PORT'));
  if (Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX) config.service.port = port;
  const password = readLegacyEnv(root, 'DJ_PASSWORD');
  if (password && password !== 'change-this-password') config.djPassword = password;
  const apiKey = readLegacyEnv(root, 'YOUTUBE_API_KEY');
  if (apiKey) config.youtubeApiKey = apiKey;
}

function normalize(raw) {
  const base = defaults();
  const source = raw && typeof raw === 'object' ? raw : {};
  const service = source.service && typeof source.service === 'object' ? source.service : {};
  const tunnel = source.tunnel && typeof source.tunnel === 'object' ? source.tunnel : {};
  const mode = source.mode && typeof source.mode === 'object' ? source.mode : {};
  const str = (value) => (typeof value === 'string' ? value.trim() : '');
  const port = Number(service.port);
  return {
    language: normalizeLanguage(source.language),
    service: {
      port: Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX ? port : base.service.port,
      host: typeof service.host === 'string' && service.host.trim() ? service.host.trim() : base.service.host
    },
    djPassword: typeof source.djPassword === 'string' && source.djPassword.trim() ? source.djPassword.trim() : base.djPassword,
    youtubeApiKey: typeof source.youtubeApiKey === 'string' ? source.youtubeApiKey.trim() : '',
    spotify: {
      clientId: str(source.spotify && source.spotify.clientId),
      clientSecret: str(source.spotify && source.spotify.clientSecret),
      redirectUri: str(source.spotify && source.spotify.redirectUri).replace(/\/+$/, ''),
      refreshToken: str(source.spotify && source.spotify.refreshToken),
      scope: str(source.spotify && source.spotify.scope)
    },
    env: {
      dir: str(source.env && source.env.dir),
      python: str(source.env && source.env.python),
      cache: str(source.env && source.env.cache),
      bin: str(source.env && source.env.bin)
    },
    tunnel: {
      cloudflaredPath: typeof tunnel.cloudflaredPath === 'string' ? tunnel.cloudflaredPath.trim() : '',
      fixedPublicUrl: typeof tunnel.fixedPublicUrl === 'string' ? tunnel.fixedPublicUrl.trim().replace(/\/+$/, '') : '',
      autoStart: Boolean(tunnel.autoStart)
    },
    mode: {
      active: mode.active === 'A' ? 'A' : 'B',
      rootA: typeof mode.rootA === 'string' ? mode.rootA.trim() : '',
      rootB: typeof mode.rootB === 'string' ? mode.rootB.trim() : ''
    }
  };
}

class ConfigStore {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, 'config');
    this.file = path.join(this.dir, 'config.json');
    this.data = this.load();
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const text = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '');
        const parsed = normalize(JSON.parse(text));
        // 环境目录必须跟着项目根走。老配置里可能存着别的副本的绝对路径，
        // 项目整个复制到别处后它还会指着旧位置，新副本因此误报「环境已就绪」。
        // 这里在启动时一次性改回相对路径，不用用户手动去点保存。
        const fixed = normalizeEnv(this.root, parsed.env);
        if (fixed.changed) {
          parsed.env = fixed.env;
          this.write(parsed);
        }
        return parsed;
      } catch {
        const backup = `${this.file}.broken-${Date.now()}`;
        try { fs.renameSync(this.file, backup); } catch {}
      }
    }
    // 旧布局迁移：读 karaoke_spo\config\config.json 后写一份到项目根
    const legacy = legacyConfigFile(this.root);
    if (legacy) {
      try {
        const text = fs.readFileSync(legacy, 'utf8').replace(/^\uFEFF/, '');
        const migrated = normalize(JSON.parse(text));
        this.write(migrated);
        return migrated;
      } catch { /* 旧配置坏了就按全新处理 */ }
    }
    const fresh = defaults();
    applyLegacyEnv(fresh, this.root);
    this.write(fresh);
    return fresh;
  }

  write(data) {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.file);
  }

  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  save(patch) {
    const before = this.get();
    const input = patch && typeof patch === 'object' ? patch : {};
    const language = normalizeLanguage(input.language || before.language);
    if (input.language !== undefined && !['en', 'zh', 'de'].includes(input.language)) {
      throw new Error(translate(language, 'config.language'));
    }
    if (input.service && input.service.port !== undefined) {
      const port = Number(input.service.port);
      if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
        throw new Error(translate(language, 'config.portRange', { min: PORT_MIN, max: PORT_MAX }));
      }
    }
    if (input.djPassword !== undefined && String(input.djPassword).trim().length < 4) {
      throw new Error(translate(language, 'config.passwordMin'));
    }
    const fixed = input.tunnel && input.tunnel.fixedPublicUrl !== undefined
      ? String(input.tunnel.fixedPublicUrl).trim().replace(/\/+$/, '')
      : '';
    if (fixed && !/^https?:\/\/[^\s]+$/i.test(fixed)) {
      throw new Error(translate(language, 'config.fixedUrl'));
    }

    // Spotify 的 redirect URI 必须是可以回调的 http(s) 地址；留空表示未配置。
    const spotifyInput = input.spotify && typeof input.spotify === 'object' ? input.spotify : {};
    if (spotifyInput.redirectUri !== undefined) {
      const uri = String(spotifyInput.redirectUri).trim().replace(/\/+$/, '');
      if (uri && !/^https?:\/\/[^\s]+$/i.test(uri)) {
        throw new Error(translate(language, 'config.redirectUri'));
      }
    }

    const next = normalize({
      ...before,
      ...input,
      language,
      service: { ...before.service, ...(input.service || {}) },
      spotify: { ...before.spotify, ...spotifyInput },
      env: { ...before.env, ...(input.env && typeof input.env === 'object' ? input.env : {}) },
      tunnel: { ...before.tunnel, ...(input.tunnel || {}) }
    });
    this.data = next;
    this.write(next);

    return {
      config: this.get(),
      requiresRestart: before.service.port !== next.service.port
        || before.djPassword !== next.djPassword
    };
  }
}

module.exports = { ConfigStore, PORT_MIN, PORT_MAX };
