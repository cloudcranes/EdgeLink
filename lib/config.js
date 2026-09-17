// 配置持久化层：默认配置、读写、合并、清理（凭据遮罩）。
// 依赖：node:fs、node:path、node:crypto、./constants（MASK）、./normalize（normalizeApp）。
// 不依赖其他 lib/。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MASK, CONFIG_BACKUP_LIMIT } = require('./constants');
const { normalizeApp } = require('./normalize');

// 配置路径支持环境变量覆盖（离线测试用临时目录，避免触碰真实配置）
// 默认优先 /app/data/config.json（Docker 卷挂载点），fallback 到项目根 config.json（本地开发）
const DEFAULT_CONFIG_PATHS = [
  path.join(__dirname, '..', 'data', 'config.json'),
  path.join(__dirname, '..', 'config.json'),
];
function resolveConfigPath() {
  if (process.env.LUCKY_ESA_CONFIG_PATH) {
    return path.resolve(process.env.LUCKY_ESA_CONFIG_PATH);
  }
  for (const p of DEFAULT_CONFIG_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return DEFAULT_CONFIG_PATHS[0]; // 都不存在时返回 data 路径（Docker 默认）
}
const CONFIG_PATH = resolveConfigPath();

// 唯一备份文件名：时间戳 + 随机后缀，避免同一秒内多次写入互相覆盖
function uniqueConfigBackupPath(tag) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${CONFIG_PATH}.${tag}-${timestamp}-${rand}.json`;
}

// 注：DNS 写入统一由 Lucky DDNS 引擎负责，本项目禁止直接调用 alidns API。
function defaultConfig() {
  return {
    lucky: {
      baseUrl: 'http://127.0.0.1:16601',
      pathPrefix: '',
      openToken: '',
      account: '',
      password: '',
      basicAuth: { enabled: false, reuse: true, users: [] },
      // Lucky 主机的公网 IPv6，用于为 nas 子域写 AAAA 记录（不配则跳过 nas 解析写入）
      publicIPv6: '',
      // DDNS 任务按类型拆分：记录类型 → 任务 Key 映射（用户在 Lucky 后台手动建任务后填入）
      // 缺省仍走原 findEsaDdnsTask 自动选（兼容旧部署）
      ddnsTasks: { ipv6: '', esa: '', other: '' },
    },
    esa: {
      accessKeyId: '',
      accessKeySecret: '',
      siteName: '',
      siteId: '',
      rootDomain: 'alanmaster.top',
    },
    gateway: {
      listenIp: '::',
      listenPort: 8443,
      originScheme: 'http',
      originHttpPort: 8000,
      enableTls: false,
      originVerify: false,
      originReadTimeout: 30,
      ruleKey: '',
    },
    panel: {
      token: '',
      theme: 'brutal-sun',
    },
    apps: [],
  };
}

function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return defaultConfig();
    }
    throw error;
  }
  try {
    return mergeConfig(defaultConfig(), JSON.parse(raw));
  } catch (error) {
    // 坏 JSON：保留原文件并备份现场（唯一名），然后抛错——拒绝静默回退默认值，
    // 否则后续任意一次保存都会把损坏的原始配置覆盖掉，无法找回。
    const backupPath = uniqueConfigBackupPath('corrupt');
    try {
      fs.copyFileSync(CONFIG_PATH, backupPath);
    } catch {
      // 备份失败不阻断抛错（原文件仍在，不会被覆盖）
    }
    const err = new Error(
      `config.json 解析失败（已备份为 ${path.basename(backupPath)}）: ${error.message}`,
    );
    err.code = 'EINVALID_CONFIG';
    throw err;
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  // 写入前自动备份旧配置（唯一文件名，防同秒覆盖）；备份失败必须中止写入，
  // 否则会把旧配置覆盖掉且无法找回（不允许静默吞错后继续覆盖）。
  if (fs.existsSync(CONFIG_PATH)) {
    const backupPath = uniqueConfigBackupPath('backup');
    fs.copyFileSync(CONFIG_PATH, backupPath);
    // 只保留最近 N 份备份（清理失败不影响写入本身）；按 mtime 排序，
    // 避免同秒内文件名随机后缀导致字典序≠时间序、误删最新备份
    try {
      const dir = path.dirname(CONFIG_PATH);
      const backups = fs
        .readdirSync(dir)
        .filter((name) => name.startsWith('config.json.backup-') || name.startsWith('config.json.corrupt-'))
        .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      while (backups.length > CONFIG_BACKUP_LIMIT) {
        fs.unlinkSync(path.join(dir, backups.shift().name));
      }
    } catch (error) {
      console.error(`config 备份清理失败: ${error.message}`);
    }
  }
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_PATH);
}

function mergeConfig(existing, incoming) {
  const base = JSON.parse(JSON.stringify(existing || defaultConfig()));
  const inc = incoming || {};

  const incLucky = inc.lucky || {};
  const { password: luckyPassword, openToken: luckyOpenToken, ...restLucky } = incLucky;
  base.lucky = { ...base.lucky, ...restLucky };
  if (luckyPassword && luckyPassword !== MASK) {
    base.lucky.password = luckyPassword;
  }
  if (luckyOpenToken && luckyOpenToken !== MASK) {
    base.lucky.openToken = luckyOpenToken;
  }

  const incEsa = inc.esa || {};
  const { accessKeySecret: esaSecret, ...restEsa } = incEsa;
  base.esa = { ...base.esa, ...restEsa };
  if (esaSecret && esaSecret !== MASK) {
    base.esa.accessKeySecret = esaSecret;
  }

  base.gateway = { ...base.gateway, ...(inc.gateway || {}) };
  base.gateway.listenPort = Number(base.gateway.listenPort) || 8443;
  base.gateway.originHttpPort = Number(base.gateway.originHttpPort) || 8000;
  base.gateway.originReadTimeout = Number(base.gateway.originReadTimeout) || 30;

  const incPanel = inc.panel || {};
  const { token: panelToken, ...restPanel } = incPanel;
  base.panel = { ...base.panel, ...restPanel };
  if (panelToken && panelToken !== MASK) {
    base.panel.token = panelToken;
  }

  if (Array.isArray(inc.apps)) {
    base.apps = inc.apps.map((app) => normalizeApp(app));
  }
  return base;
}

function sanitizeConfig(config) {
  return {
    ...config,
    lucky: {
      ...config.lucky,
      password: config.lucky.password ? MASK : '',
      openToken: config.lucky.openToken ? MASK : '',
    },
    esa: {
      ...config.esa,
      accessKeySecret: config.esa.accessKeySecret ? MASK : '',
    },
    panel: {
      ...config.panel,
      token: config.panel.token ? MASK : '',
    },
  };
}

module.exports = {
  CONFIG_PATH,
  defaultConfig,
  readConfig,
  writeConfig,
  mergeConfig,
  sanitizeConfig,
};
