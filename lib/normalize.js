// 域名 / 应用 / URL 规范化工具 + 校验。
// 依赖：node:url、node:crypto、./constants。
// 不依赖其他 lib/，可被任意模块 require。

const crypto = require('crypto');
const { DOMAIN_RE, MASK } = require('./constants');

// ---------- 域名规范化 ----------
function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}

// ---------- 证书 SAN 是否覆盖 domain ----------
// 精确相等直接 true；通配 SAN（以 `*.` 开头）匹配单级子域（domain.endsWith(san.slice(1))，
// 且前缀非空、不含点）。
function certificateCoversDomain(san, domain) {
  const s = normalizeDomain(san);
  const d = normalizeDomain(domain);
  if (!s || !d) return false;
  if (s === d) return true;
  if (s.startsWith('*.')) {
    const suffix = s.slice(1); // ".example.com"
    if (!d.endsWith(suffix)) return false;
    const prefix = d.slice(0, d.length - suffix.length);
    return prefix.length > 0 && !prefix.includes('.');
  }
  return false;
}

function assertDomain(value, label) {
  const domain = normalizeDomain(value);
  if (!domain || !DOMAIN_RE.test(domain)) {
    throw new Error(`${label} 不是有效域名: ${value || '(空)'}`);
  }
  return domain;
}

// ---------- 内网服务地址 ----------
function normalizeTarget(value) {
  let raw = String(value || '').trim();
  if (!raw) {
    throw new Error('内网目标地址不能为空');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`内网目标地址仅支持 http/https: ${value}`);
  }
  if (!url.hostname) {
    throw new Error(`内网目标地址格式错误: ${value}`);
  }
  return `${url.protocol}//${url.host}`;
}

// ---------- Lucky 后台地址 ----------
function normalizeBaseUrl(value) {
  let raw = String(value || '').trim();
  if (!raw) {
    throw new Error('Lucky 后台地址不能为空');
  }
  if (!/^https?:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  return new URL(raw).origin;
}

// ---------- Lucky 安全入口路径前缀 ----------
function normalizeApiPrefix(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') {
    return '';
  }
  const cleaned = raw.replace(/\/+$/, '');
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
}

function luckyApiBase(config) {
  return normalizeBaseUrl(config.lucky.baseUrl) + normalizeApiPrefix(config.lucky.pathPrefix);
}

// ---------- 应用规范化 ----------
// 部署状态机：pending → building → live / failed。
// 每次 deploy 进入 building，scheduleLiveCheck 收敛到 live/failed。
// 手动校验（应用行 / 健康检查）不影响 status，只触发一次探测。
function normalizeApp(app) {
  const normalized = { ...(app || {}) };
  normalized.id = String(normalized.id || crypto.randomBytes(6).toString('hex'));
  normalized.prefix = normalizeDomain(normalized.prefix);
  normalized.name = String(normalized.name || '').trim() || normalized.prefix || '未命名应用';
  normalized.target = normalizeTarget(normalized.target);
  const legacyOn = normalized.luckyEnabled ?? normalized.esaEnabled ?? normalized.enabled;
  if (normalized.luckyEnabled === undefined) normalized.luckyEnabled = legacyOn !== false;
  if (normalized.esaEnabled === undefined) normalized.esaEnabled = legacyOn !== false;
  if (!['pending', 'building', 'live', 'failed'].includes(normalized.status)) {
    normalized.status = 'pending';
  }
  delete normalized.enabled;
  return normalized;
}

// ---------- 域名前缀模型派生 ----------
// 与前端 state.js nasDomainFor/cdnDomainFor/originHostFor 对齐
function rootDomainOf(config) {
  return (config && config.esa && config.esa.rootDomain) || '';
}

function nasDomainOf(app, config) {
  if (!app) return '';
  if (app.originDomain) return normalizeDomain(app.originDomain);
  const root = rootDomainOf(config);
  if (!app.prefix || !root) return '';
  return `${app.prefix}.nas.${root}`;
}

function cdnDomainOf(app, config) {
  if (!app) return '';
  if (app.externalDomain) return normalizeDomain(app.externalDomain);
  const root = rootDomainOf(config);
  if (!app.prefix || !root) return '';
  return `${app.prefix}.cdn.${root}`;
}

function originHostOf(app, config) {
  if (!app) return '';
  if (app.originHostHeader) return normalizeDomain(app.originHostHeader);
  return nasDomainOf(app, config);
}

// ---------- 部署配置校验 ----------
// lucky-prefix 应用专用：阻断把面板后端本身当外部应用反代/加速。
// 设计原则：阻断配置不自洽；不替用户决策，仅抛错+巡检提示。
function validateLuckySelfReference(app, config) {
  if (!app || app.prefix !== 'lucky') return;
  const target = normalizeTarget(app.target);
  const luckyOrigin = (() => {
    try {
      return new URL(normalizeBaseUrl(config.lucky.baseUrl));
    } catch {
      return null;
    }
  })();
  if (!luckyOrigin) return; // lucky 未配置时不在此处阻断，由 validateDeployConfig 处理
  const targetUrl = new URL(target);
  const sameHost = targetUrl.hostname === luckyOrigin.hostname;
  const samePort =
    (targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80')) ===
    (luckyOrigin.port || (luckyOrigin.protocol === 'https:' ? '443' : '80'));
  if (!sameHost || !samePort) {
    throw new Error(
      `应用「lucky」的 target(${target}) 与面板配置 lucky.baseUrl(${luckyOrigin.origin}) 不一致，` +
        `lucky-prefix 应用专用于把面板后端自身反代出去，请保持二者 host:port 相同`,
    );
  }
  // ESA 路径前缀与面板 pathPrefix 一致性提示：不阻断，给巡检用
  const pathPrefix = String(config.lucky.pathPrefix || '').replace(/\/+$/, '');
  if (app.esaEnabled !== false) {
    // 留作 /api/audit 中体现，不抛错
    app.__luckySelfRefNote = pathPrefix
      ? `面板有 pathPrefix=${pathPrefix}，访问 cdn 域名时需带此前缀`
      : '';
  }
}

function validateDeployConfig(config, parts) {
  const selected = new Set(
    Array.isArray(parts) && parts.length > 0
      ? parts.filter((part) => part === 'lucky' || part === 'esa')
      : ['lucky', 'esa'],
  );
  if (
    selected.has('lucky') &&
    (!config.lucky.baseUrl ||
      (!config.lucky.openToken && !(config.lucky.account && config.lucky.password)))
  ) {
    throw new Error('请先填写 Lucky 后台地址，以及 OpenToken 或账号密码');
  }
  if (selected.has('esa') && (!config.esa.accessKeyId || !config.esa.accessKeySecret)) {
    throw new Error('请先填写阿里云 ESA AccessKey ID 和 Secret');
  }
  if (selected.has('esa') && !config.esa.siteId) {
    throw new Error('请先选择 ESA 站点');
  }
  for (const app of config.apps) {
    normalizeTarget(app.target);
    if (selected.has('lucky') || selected.has('esa')) {
      assertDomain(nasDomainOf(app, config), `回源域名 ${app.name}`);
      assertDomain(originHostOf(app, config), `回源 Host ${app.name}`);
    }
    if (selected.has('esa')) {
      assertDomain(cdnDomainOf(app, config), `外网域名 ${app.name}`);
    }
    validateLuckySelfReference(app, config);
  }
  if (selected.has('esa')) {
    const domains = config.apps.map((app) => cdnDomainOf(app, config));
    if (new Set(domains).size !== domains.length) {
      throw new Error('外网域名不能重复');
    }
  }
}

module.exports = {
  normalizeDomain,
  certificateCoversDomain,
  assertDomain,
  normalizeTarget,
  normalizeBaseUrl,
  normalizeApiPrefix,
  luckyApiBase,
  normalizeApp,
  rootDomainOf,
  nasDomainOf,
  cdnDomainOf,
  originHostOf,
  validateLuckySelfReference,
  validateDeployConfig,
  MASK, // 转发，避免 lib/config.js 再从 constants 拉
};
