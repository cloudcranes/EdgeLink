const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const {
  default: EsaClient,
  ListSitesRequest,
  ListOriginRulesRequest,
  ListRecordsRequest,
  ListCertificatesRequest,
  CreateRecordRequest,
  UpdateRecordRequest,
  DeleteRecordRequest,
} = require('@alicloud/esa20240910');
const {
  default: AlidnsClient,
  DescribeDomainRecordsRequest,
  DeleteDomainRecordRequest,
} = require('@alicloud/alidns20150109');

// 配置路径支持环境变量覆盖（离线测试用临时目录，避免触碰真实配置）
const CONFIG_PATH = process.env.LUCKY_ESA_CONFIG_PATH
  ? path.resolve(process.env.LUCKY_ESA_CONFIG_PATH)
  : path.join(__dirname, 'config.json');

// 唯一备份文件名：时间戳 + 随机后缀，避免同一秒内多次写入互相覆盖
function uniqueConfigBackupPath(tag) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${CONFIG_PATH}.${tag}-${timestamp}-${rand}.json`;
}
const GATEWAY_RULE_NAME = 'lucky-esa-gateway';
const PROXY_KEY_PREFIX = 'lucky-esa-';
const ESA_RULE_PREFIX = 'lucky-esa-';
const MASK = '********';
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

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
      siteId: '',
      siteName: '',
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

const CONFIG_BACKUP_LIMIT = 10;

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

// 域名前缀模型派生（与前端 state.js nasDomainFor/cdnDomainFor/originHostFor 对齐）
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

function normalizeApp(app) {
  const normalized = { ...(app || {}) };
  normalized.id = String(normalized.id || crypto.randomBytes(6).toString('hex'));
  normalized.prefix = normalizeDomain(normalized.prefix);
  normalized.name = String(normalized.name || '').trim() || normalized.prefix || '未命名应用';
  normalized.target = normalizeTarget(normalized.target);
  const legacyOn = normalized.luckyEnabled ?? normalized.esaEnabled ?? normalized.enabled;
  if (normalized.luckyEnabled === undefined) normalized.luckyEnabled = legacyOn !== false;
  if (normalized.esaEnabled === undefined) normalized.esaEnabled = legacyOn !== false;
  // 部署状态机：pending → building → live / failed。每次 deploy 进入 building，scheduleLiveCheck 收敛到 live/failed。
  // 手动校验（应用行 / 健康检查）不影响 status，只触发一次探测。
  if (!['pending', 'building', 'live', 'failed'].includes(normalized.status)) {
    normalized.status = 'pending';
  }
  delete normalized.enabled;
  return normalized;
}

function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .toLowerCase();
}

// 证书 SAN 是否覆盖 domain：大小写归一；精确相等直接 true；
// 仅当 SAN 以 `*.` 开头时视为通配，匹配单级子域（domain.endsWith(san.slice(1))
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

function normalizeTarget(value) {
  let raw = String(value || '').trim();
  if (!raw) {
    throw new Error('内网目标地址不能为空');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `http://${raw}`;
  }
  const url = new URL(raw);
  if (!url.hostname) {
    throw new Error(`内网目标地址格式错误: ${value}`);
  }
  return `${url.protocol}//${url.host}`;
}

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

// lucky-prefix 应用专用校验：防止把面板后端本身当外部应用反代/加速。
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
  const samePort = (targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80')) === (luckyOrigin.port || (luckyOrigin.protocol === 'https:' ? '443' : '80'));
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
    app.__luckySelfRefNote = pathPrefix ? `面板有 pathPrefix=${pathPrefix}，访问 cdn 域名时需带此前缀` : '';
  }
}

function validateDeployConfig(config, parts) {
  const selected = new Set(
    Array.isArray(parts) && parts.length > 0 ? parts.filter((part) => part === 'lucky' || part === 'esa') : ['lucky', 'esa'],
  );
  if (selected.has('lucky') && (!config.lucky.baseUrl || (!config.lucky.openToken && !(config.lucky.account && config.lucky.password)))) {
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

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回非 JSON (HTTP ${response.status}): ${text.slice(0, 120)}`);
  }
}

async function luckyLogin(config) {
  const baseUrl = luckyApiBase(config);
  const openToken = String(config.lucky.openToken || '').trim();
  if (openToken) {
    // openToken 是历史别名；Lucky v2.27.2 token 可能因重启/Lucky端失效而不再可鉴权。
    // 探一次轻量读接口：若 ret=-1 或 login invalid，则放弃并改走 /api/login 重新拿 fresh token。
    try {
      await luckyRequest(baseUrl, openToken, 'GET', '/api/info');
      return { baseUrl, token: openToken };
    } catch (error) {
      if (!/login invalid|logininvalid|OpenToken error/i.test(error.message)) {
        throw error;
      }
      // fall through to login
    }
  }
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      Account: config.lucky.account,
      Password: config.lucky.password,
    }),
  });
  const data = await readJsonResponse(response);
  if (data.ret !== 0 || !data.token) {
    throw new Error(`Lucky 登录失败: ${data.msg || '未知错误'}`);
  }
  // 把 fresh token 写回配置，后续请求优先复用（不存盘，避免覆盖用户原始偏好）
  config.lucky.openToken = data.token;
  return { baseUrl, token: data.token };
}

async function luckyRequest(baseUrl, token, method, apiPath, body) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      // Lucky v2.27.2 实际鉴权头：OpenToken（实测 Lucky-Admin-Token 返回 login invalid）
      OpenToken: token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await readJsonResponse(response);
  if (data.ret !== undefined && data.ret !== 0) {
    const msg = data.msg || data.message || '未知错误';
    if (msg === 'logininvalid') {
      throw new Error('Lucky Token 无效或已失效');
    }
    throw new Error(`Lucky 接口 ${apiPath} 失败: ${msg}`);
  }
  return data;
}

async function getLuckyRules(config) {
  const { baseUrl, token } = await luckyLogin(config);
  const data = await luckyRequest(baseUrl, token, 'GET', '/api/webservice/rules');
  const rules = data.ruleList || data.list || [];
  return { baseUrl, token, rules };
}

function isManagedProxyKey(key) {
  return String(key || '').startsWith(PROXY_KEY_PREFIX);
}

function managedProxyKey(appId) {
  return PROXY_KEY_PREFIX + appId;
}

// Lucky v2.27.2 子规则的 OtherParams 里承载"定制模式"高级开关。
// 默认打开：万事大吉(EasyLucky)、自动反代重定向(AutoProxyLocation)、记录访问日志(RecordAccessLogs)。
// 其余字段对齐 Lucky 默认值，避免 PUT 时被 Lucky 重置。
function buildOtherParams() {
  return {
    AllowAllThirdAuthUsers: false,
    AllowThirdUserList: [],
    AllowThirdUserSkipTwoFA: false,
    HttpClientProxyAddr: '',
    HttpClientProxyPassword: '',
    HttpClientProxyType: '',
    HttpClientProxyUser: '',
    OauthClientID: '',
    OauthClientKey: '',
    OauthClientSecret: '',
    OauthRedirectURI: '',
    OauthServer: '',
    OauthType: 'github',
    ProxyProtocolV2: true,
    SpeedTestFrontSource: '',
    WebAuth: false,
    WebAuthAllowNonBrowserReuse: false,
    WebAuthAllowNonBrowserUserAgents: ['*'],
    // ---- 用户要求默认开启的高级开关 ----
    EasyLucky: true,
    AutoProxyLocation: true,
    RecordAccessLogs: true,
  };
}

function buildLuckyProxy(app, config) {
  const ba = config.lucky && config.lucky.basicAuth;
  const webAuthOn = app.webAuth === true;
  // 网页认证（WebAuth）：浏览器走 Lucky 内置登录页，非浏览器回退 BasicAuth。
  // 用户要求"认证用网页认证不用 basic"：开启时写 WebAuth=true + BasicAuthUserList，
  // 不写 EnableBasicAuth（避免浏览器原生弹窗）。
  // 注意：basicAuth.enabled 是旧版"Lucky 基本认证总开关"，对 WebAuth 无意义；
  // 只要应用开了认证且有用户列表就写入（无用户则认证开着但无人可登录）。
  const authUsers = webAuthOn && ba && Array.isArray(ba.users) ? ba.users : [];
  const first = authUsers[0] || {};
  const basicAuthUserList = webAuthOn
    ? authUsers.map((u) => (u.username || '') + ':' + (u.password || '')).filter((line) => line !== ':').join('\n')
    : '';
  const otherParams = buildOtherParams();
  otherParams.WebAuth = webAuthOn;
  return {
    Key: managedProxyKey(app.id),
    GroupKey: '',
    WebServiceType: 'reverseproxy',
    Enable: app.luckyEnabled !== false,
    Locations: [app.target],
    FileServerMountList: [],
    // ---- 定制模式高级开关：UI 从子规则【顶层】读取，面板必须写顶层（不是只写 OtherParams）----
    EasyLucky: true, // 万事大吉：自动添加常见反向所需请求头
    AutoProxyLocation: true, // 自动反代重定向
    AutoProxyLocationWithoutSameHost: false, // 仅自动反代不同host的重定向
    EnableAccessLog: true, // 记录访问日志
    LogLevel: 0,
    LogOutputToConsole: false,
    AccessLogMaxNum: 0,
    WebListShowLastLogMaxCount: 0,
    // ---- 认证（网页认证）----
    EnableBasicAuth: false,
    WebAuth: webAuthOn,
    BasicAuthUser: webAuthOn ? (first.username || '') : '',
    BasicAuthPasswd: webAuthOn ? (first.password || '') : '',
    BasicAuthUserList: basicAuthUserList,
    SafeIPMode: 'blacklist',
    SafeUserAgentMode: 'blacklist',
    Remark: app.name,
    Domains: [nasDomainOf(app, config)],
    CustomOutputText: '',
    LastErrMsg: '',
    CacheEnabled: false,
    CaCheTotalSize: 0,
    CacheFilesTotal: 0,
    DisplayInFrontendList: false,
    CorazaWAF: false,
    OtherParams: otherParams,
  };
}

function buildLuckyRule(config, proxies, ruleKey) {
  const originScheme = config.gateway.originScheme || 'http';
  return {
    RuleName: '',
    RuleKey: ruleKey,
    Enable: true,
    ListenIP: '',
    ListenPort: Number(config.gateway.listenPort) || 8443,
    EnableTLS: originScheme === 'https' || !!config.gateway.enableTls,
    Network: ((config.gateway.listenIp || '::').includes(':') ? 'tcp6' : 'tcp'),
    Message: '',
    Http3: false,
    CorazaWAF: false,
    SendRateLimitEnabled: false,
    SendRateLimit: 0,
    ReceRateLimitEnabled: false,
    ReceRateLimit: 0,
    SingleConnSendRateLimitEnabled: false,
    SingleConnSendRateLimit: 0,
    SingleConnReceRateLimitEnabled: false,
    SingleConnReceRateLimit: 0,
    SingleIPSendRateLimitEnabled: false,
    SingleIPSendRateLimit: 0,
    SingleIPReceRateLimitEnabled: false,
    SingleIPReceRateLimit: 0,
    SingleIPConnectionsLimitEnabled: false,
    SingleIPConnectionsLimit: 0,
    FrontRuleListDisplay: 'showAll',
    DefaultProxy: {
      Key: ruleKey,
      GroupKey: '',
      WebServiceType: 'reverseproxy',
      Enable: false,
      Locations: [],
      FileServerMountList: [],
      EnableBasicAuth: false,
      WebAuth: false,
      BasicAuthUser: '',
      BasicAuthPasswd: '',
      BasicAuthUserList: '',
      SafeIPMode: 'blacklist',
      SafeUserAgentMode: 'blacklist',
      Remark: '',
      Domains: null,
      CustomOutputText: '',
      LastErrMsg: '',
      CacheEnabled: false,
      CaCheTotalSize: 0,
      CacheFilesTotal: 0,
      DisplayInFrontendList: false,
      CorazaWAF: false,
      OtherParams: buildOtherParams(),
    },
    ProxyList: proxies,
  };
}

function keepExistingProxies(existing, appId) {
  if (!existing) {
    return [];
  }
  const targetKey = appId ? managedProxyKey(appId) : null;
  return existing.ProxyList.filter((proxy) => {
    const managed = isManagedProxyKey(proxy.Key);
    if (!managed) {
      return true;
    }
    return targetKey ? proxy.Key !== targetKey : false;
  });
}

async function applyLucky(config, logs, appId) {
  const { baseUrl, token, rules } = await getLuckyRules(config);
  const gatewayPort = Number(config.gateway.listenPort) || 8443;
  const existing =
    rules.find(
      (rule) =>
        (config.gateway.ruleKey && rule.RuleKey === config.gateway.ruleKey) ||
        rule.RuleName === GATEWAY_RULE_NAME ||
        Number(rule.ListenPort) === gatewayPort,
    ) || null;
  const ruleKey = existing?.RuleKey || config.gateway.ruleKey || crypto.randomBytes(8).toString('hex');
  config.gateway.ruleKey = ruleKey;

  // 端口冲突预检：网关端口不得被其它 Lucky 规则占用
  const clash = (rules || []).find(
    (r) =>
      Number(r.ListenPort) === gatewayPort &&
      r.RuleKey !== (existing?.RuleKey || '') &&
      r.RuleName !== GATEWAY_RULE_NAME,
  );
  if (clash) {
    throw new Error(`网关端口 ${gatewayPort} 与 Lucky 规则「${clash.RuleName}」监听冲突，请先到 Lucky 调整`);
  }

  const apps = appId ? config.apps.filter((app) => app.id === appId) : config.apps;
  if (appId && apps.length === 0) {
    throw new Error(`找不到应用: ${appId}`);
  }

  const generatedProxies = apps.map((app) => buildLuckyProxy(app, config));
  const preservedProxies = keepExistingProxies(existing, appId);
  // Lucky PUT 拒绝任何重复的 host：新建托管子规则若与既有非托管子规则同 domain，
  // 会被 `has exist [...]` 拒掉。先把冲突的非托管子规则从 preservedProxies 里过滤掉。
  const generatedDomains = new Set(generatedProxies.flatMap((p) => p.Domains || []));
  const conflictsRemoved = [];
  const conflictFree = preservedProxies.filter((proxy) => {
    if (isManagedProxyKey(proxy.Key)) return true; // 托管子规则我们自己管
    const overlap = (proxy.Domains || []).some((d) => generatedDomains.has(d));
    if (overlap) conflictsRemoved.push(`${proxy.Key} (${(proxy.Domains || []).join(',')})`);
    return !overlap;
  });
  if (conflictsRemoved.length > 0) {
    logs.push({
      step: 'Lucky 冲突清理',
      status: 'ok',
      detail: `已移除 ${conflictsRemoved.length} 条与新建子规则同域名的手动规则：${conflictsRemoved.join('；')}`,
    });
  }
  const proxyList = [...conflictFree, ...generatedProxies];
  const rule = buildLuckyRule(config, proxyList, ruleKey);

  if (existing) {
    await luckyRequest(baseUrl, token, 'PUT', `/api/webservice/rule/${ruleKey}`, rule);
    logs.push({ step: 'Lucky 反向代理', status: 'ok', detail: `已更新 ${GATEWAY_RULE_NAME} 监听 ${rule.ListenIP}:${rule.ListenPort}` });
  } else {
    const created = await luckyRequest(baseUrl, token, 'POST', '/api/webservice/rules', rule);
    if (created.ruleKey && created.ruleKey !== ruleKey) {
      config.gateway.ruleKey = created.ruleKey;
    }
    logs.push({ step: 'Lucky 反向代理', status: 'ok', detail: `已创建 ${GATEWAY_RULE_NAME} 监听 ${rule.ListenIP}:${rule.ListenPort}` });
  }
  logs.push({ step: 'Lucky 子规则', status: 'ok', detail: `${proxyList.length} 条规则（含非面板规则 ${preservedProxies.length} 条）` });
}

function getEsaClient(esaConfig) {
  if (!esaConfig.accessKeyId || !esaConfig.accessKeySecret) {
    throw new Error('请先填写阿里云 ESA AccessKey ID 和 Secret');
  }
  return new EsaClient({
    accessKeyId: esaConfig.accessKeyId,
    accessKeySecret: esaConfig.accessKeySecret,
    regionId: 'cn-hangzhou',
    endpoint: 'esa.cn-hangzhou.aliyuncs.com',
  });
}

function esaErrorMessage(error) {
  const code = error && (error.code || error.Code);
  const message = error && (error.message || error.Message || error.data?.Message || String(error));
  return code ? `${code}: ${message}` : String(message || error);
}

async function esaListSites(creds) {
  const client = getEsaClient(creds);
  const request = new ListSitesRequest({ pageSize: 500 });
  const response = await client.listSites(request);
  return response.body?.sites || [];
}

async function esaListOriginRules(client, siteId) {
  const request = new ListOriginRulesRequest({
    siteId: Number(siteId),
    configType: 'rule',
    pageSize: 500,
  });
  const response = await client.listOriginRules(request);
  return response.body?.configs || [];
}

function extractEsaDomain(ruleExpression) {
  const match = String(ruleExpression || '').match(/http\.host\s+eq\s+"([^"]+)"/);
  return match ? match[1] : '';
}

async function esaListDomains(client, siteId) {
  const request = new ListRecordsRequest({
    siteId: Number(siteId),
    pageSize: 500,
  });
  const response = await client.listRecords(request);
  return (response.body?.records || []).map((record) => ({
    id: record.recordId,
    name: record.recordName,
    type: record.recordType,
    value: record.data?.value || '',
    recordCname: record.recordCname || '',
    proxied: !!record.proxied,
    hostPolicy: record.hostPolicy || record.HostPolicy || '',
    ttl: record.ttl ?? record.TTL ?? 0,
    sourceType: record.recordSourceType || record.SourceType || '',
    bizName: record.bizName || record.BizName || 'web',
    comment: record.comment || record.Comment || '',
  }));
}

async function esaListCertificates(client, siteId, keyword) {
  const request = new ListCertificatesRequest({
    siteId: Number(siteId),
    pageSize: 500,
    keyword: keyword || '',
  });
  const response = await client.listCertificates(request);
  const list = (response.body?.result || response.body?.certificates || response.body?.data || []).map((cert) => {
    // ESA 返回 SAN 字段类型不稳定：可能是字符串（单个域名）、数组、或 SANs/dnsNames 数组
    const rawSans = cert.sans ?? cert.SANs ?? cert.dnsNames ?? cert.SAN;
    const sans = Array.isArray(rawSans)
      ? rawSans
      : typeof rawSans === 'string' && rawSans
        ? rawSans.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    return {
      id: cert.id || cert.certId || cert.certificateId,
      name: cert.name,
      commonName: cert.commonName,
      type: cert.type,
      sans,
      notAfter: cert.notAfter || cert.NotAfter,
      notBefore: cert.notBefore || cert.NotBefore,
      status: cert.status,
    };
  });
  return list;
}

async function getLuckyDdnsTasks(config) {
  const { baseUrl, token } = await luckyLogin(config);
  const data = await luckyRequest(baseUrl, token, 'GET', '/api/ddnstasklist');
  return data.data || data.list || [];
}

// ---------- alidns 直连（仅用于清理脏解析残留；日常 DNS 写入仍由 Lucky DDNS 负责） ----------
// 凭据：优先用 Lucky DDNS 任务里的 DNS.ID/Secret（Lucky 实际使用的），回退到 config.esa 凭据
async function getAlidnsClient(config, { preferLucky = true } = {}) {
  let id = '';
  let secret = '';
  if (preferLucky) {
    try {
      const tasks = await getLuckyDdnsTasks(config);
      const t = tasks.find((x) => ((x.DNS || {}).Name || '') === 'alidns' && x.DNS.ID && x.DNS.Secret);
      if (t) {
        id = t.DNS.ID;
        secret = t.DNS.Secret;
      }
    } catch {
      // Lucky 不可用则回退
    }
  }
  if (!id || !secret) {
    id = config.esa.accessKeyId;
    secret = config.esa.accessKeySecret;
  }
  if (!id || !secret) throw new Error('缺少 alidns 凭据（Lucky DDNS 任务或 ESA AccessKey）');
  return new AlidnsClient({ accessKeyId: id, accessKeySecret: secret, endpoint: 'alidns.cn-hangzhou.aliyuncs.com' });
}

// 查某主域下所有解析记录（返回精简结构）
async function alidnsListRecords(config, domainName) {
  const client = await getAlidnsClient(config);
  const req = new DescribeDomainRecordsRequest({ domainName, pageSize: 500 });
  const res = await client.describeDomainRecords(req);
  const list = res.body?.domainRecords?.record || [];
  return list.map((r) => ({
    recordId: r.recordId,
    domainName: r.domainName,
    RR: r.RR,
    type: r.type,
    value: r.value,
    ttl: r.TTL,
    line: r.line,
    status: r.status,
    locked: r.locked === true,
    weight: r.weight,
  }));
}

async function alidnsDeleteRecord(config, recordId) {
  const client = await getAlidnsClient(config);
  await client.deleteDomainRecord(new DeleteDomainRecordRequest({ recordId: String(recordId) }));
}

// 从任务列表中挑选"用于写入 cdn CNAME 的 Lucky DDNS 任务"
// 优先级：1) 已有 .cdn CNAME 的任务；2) 含 .nas AAAA 的 alidns 任务；3) 任意 alidns 任务
function findEsaDdnsTask(tasks) {
  const hasCdnCname = (task) =>
    (task.Records || []).some((record) => {
      const sub = String(record.SubDomain || '');
      return record.Type === 'CNAME' && sub.endsWith('.cdn');
    });
  const hasNasAaaa = (task) =>
    (task.Records || []).some((record) => {
      const sub = String(record.SubDomain || '');
      return record.Type === 'AAAA' && sub.endsWith('.nas');
    });
  const isAlidns = (task) => ((task.DNS || {}).Name || '') === 'alidns';
  return (
    tasks.find((task) => hasCdnCname(task)) ||
    tasks.find((task) => isAlidns(task) && hasNasAaaa(task)) ||
    tasks.find((task) => isAlidns(task)) ||
    null
  );
}

// 按 recordType + 用户配置的 ddnsTasks 映射选任务
// recordType 分类：AAAA/A → ipv6 任务；CNAME → esa 任务；TXT/其它 → other 任务
// 用户没配置对应 taskKey → 回退到 findEsaDdnsTask（兼容旧部署）
function findDdnsTaskByType(tasks, recordType, configured) {
  const target = (() => {
    if (recordType === 'AAAA' || recordType === 'A') return configured.ipv6;
    if (recordType === 'CNAME') return configured.esa;
    if (recordType === 'TXT' || recordType === 'SRV' || recordType === 'CAA' || recordType === 'NS' || recordType === 'MX') return configured.other;
    return '';
  })();
  if (target) {
    const found = tasks.find((t) => t.TaskKey === target);
    if (found) return found;
  }
  return findEsaDdnsTask(tasks);
}

// 解析 Lucky SyncRecordData 字符串（PowerShell hashtable 格式：@{k=v; k2=v2}）
function parseSyncRecord(syncRecordData) {
  if (!syncRecordData) return null;
  if (typeof syncRecordData === 'object') return syncRecordData;
  const text = String(syncRecordData);
  const parsed = {};
  for (const match of text.matchAll(/([A-Za-z]+)=([^;]+)/g)) {
    parsed[match[1]] = match[2].trim();
  }
  return parsed;
}

// 抽取一条 record 的语义字段（兼容 Lucky LIST 扁平结构与 DETAIL 的嵌套 SyncRecordData）
function readRecordDetail(record) {
  const sd = record && record.SyncRecordData && typeof record.SyncRecordData === 'object'
    ? record.SyncRecordData
    : null;
  return {
    type: (sd?.type ?? record?.Type ?? '').toString().toUpperCase(),
    domainName: (sd?.DomainName ?? record?.DomainName ?? '').toString().toLowerCase(),
    subDomainName: (sd?.SubDomainName ?? record?.SubDomain ?? '').toString().toLowerCase(),
    fullDomainName: (sd?.fullDomainName ?? record?.fullDomainName ?? '').toString().toLowerCase(),
    cnameContent: (sd?.CNAMEContent ?? record?.CNAMEContent ?? '').toString(),
    line: (sd?.line ?? record?.line ?? '').toString(),
    ttl: sd?.ttl ?? record?.ttl ?? 0,
    remark: (sd?.remark ?? record?.remark ?? '').toString(),
    bizName: (sd?.BizName ?? record?.BizName ?? 'web').toString(),
  };
}

// 比较 record 与期望 sub/siteRoot 是否精确匹配该记录
// recordType 限定 'CNAME' / 'TXT' / 其它；contentField 指示同步的内容字段（CNAMEContent / TXTContent）
function recordMatches(record, subDomain, siteRoot, recordType, contentField, contentValue) {
  const d = readRecordDetail(record);
  if (d.type !== recordType) return false;
  if (d.domainName !== siteRoot) return false;
  if (d.subDomainName !== subDomain) return false;
  if (contentField === 'CNAMEContent') return d.cnameContent === contentValue;
  if (contentField === 'TXTContent') {
    const txt = (record.SyncRecordData?.TXTContent ?? record?.TXTContent ?? '').toString();
    return txt === contentValue;
  }
  return true;
}

function readRecordContent(record, contentField) {
  if (contentField === 'TXTContent') {
    return (record.SyncRecordData?.TXTContent ?? record?.TXTContent ?? '').toString();
  }
  return readRecordDetail(record).cnameContent;
}

// 生成 Lucky Record Key（16 字符 base64url）
function generateRecordKey() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

// 向后兼容 CNAME 匹配：仅在 type==CNAME 且 sub/domain 匹配时为 true，不校验内容（addDdnsRecord 二次校验）
function recordMatchesCname(record, subDomain, siteRoot) {
  const d = readRecordDetail(record);
  return d.type === 'CNAME' && d.domainName === siteRoot && d.subDomainName === subDomain;
}

// 通过 Lucky DDNS 任务写入 / 更新 / 跳过 CNAME/TXT 子域（不直连 alidns API）
// recordType: 'CNAME' | 'TXT' | 其它（Value 原样转发到 alidns）
// contentField: 'CNAMEContent' | 'TXTContent'
async function addDdnsRecord(config, subDomain, recordType, contentField, contentValue, siteRoot, remark) {
  const tasks = await getLuckyDdnsTasks(config);
  const configured = (config.lucky && config.lucky.ddnsTasks) || {};
  const candidate = findDdnsTaskByType(tasks, recordType, configured);
  if (!candidate) {
    throw new Error('未找到 Lucky DDNS 任务（按 recordType 匹配失败，且无默认 alidns 任务）');
  }
  const taskKey = candidate.TaskKey;
  const { baseUrl, token } = await luckyLogin(config);
  const query = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${taskKey}`);
  const task = query.task || query.data || candidate;
  if (!Array.isArray(task.Records)) task.Records = [];

  const matched = task.Records.find((r) =>
    recordMatches(r, subDomain, siteRoot, recordType, contentField, contentValue),
  ) || task.Records.find((r) => {
    const d = readRecordDetail(r);
    return d.type === recordType && d.domainName === siteRoot && d.subDomainName === subDomain;
  }) || null;
  let action = 'added';
  let message = '';
  if (matched) {
    const currentContent = readRecordContent(matched, contentField);
    const currentRemark = readRecordDetail(matched).remark;
    if (currentContent === contentValue && currentRemark === (remark || '')) {
      action = 'skipped';
      message = `Lucky DDNS 已存在且一致 ${subDomain}.${siteRoot} ${recordType} -> ${contentValue}，触发 manualSync`;
    } else {
      if (typeof matched.SyncRecordData !== 'object' || matched.SyncRecordData === null) {
        matched.SyncRecordData = {};
      }
      matched.SyncRecordData[contentField] = contentValue;
      matched.SyncRecordData.fullDomainName = `${subDomain}.${siteRoot}`;
      matched.SyncRecordData.remark = remark || '';
      matched[contentField] = contentValue;
      matched.fullDomainName = `${subDomain}.${siteRoot}`;
      matched.remark = remark || '';
      action = 'updated';
      message = `Lucky DDNS 已更新 ${subDomain}.${siteRoot} ${recordType} -> ${contentValue}`;
    }
  } else {
    const newRecord = {
      SyncRecordData: {
        BizName: 'web',
        DomainName: siteRoot,
        SubDomainName: subDomain,
        fullDomainName: `${subDomain}.${siteRoot}`,
        line: '',
        remark: remark || '',
        ttl: 0,
        type: recordType,
      },
      Key: generateRecordKey(),
      Disable: false,
    };
    newRecord.SyncRecordData[contentField] = contentValue;
    task.Records.push(newRecord);
    message = `Lucky DDNS 已追加 ${subDomain}.${siteRoot} ${recordType} -> ${contentValue}`;
  }

  await luckyRequest(
    baseUrl,
    token,
    'PUT',
    `/api/ddns?key=${encodeURIComponent(taskKey)}`,
    task,
  );
  // manualSync 是 best-effort：Lucky PUT 后若引擎仍在同步会回 ret=isSyncing。
  // CNAME 已写入任务对象，公网最终一致性由 Lucky 引擎保证，不阻断。
  let manualSyncWarning = '';
  try {
    await luckyRequest(baseUrl, token, 'GET', `/api/ddns/manualSync/${taskKey}`);
  } catch (error) {
    if (/isSyncing/i.test(error.message)) {
      manualSyncWarning = '（Lucky 引擎同步未结束，公网生效等待其完成）';
    } else {
      throw error;
    }
  }

  return {
    added: action === 'added',
    updated: action === 'updated',
    skipped: action === 'skipped',
    taskKey,
    message: message + manualSyncWarning,
  };
}

// 向后兼容：CNAME 写入委托到通用记录接口
function addDdnsCnameRecord(config, subDomain, cnameContent, siteRoot, remark) {
  return addDdnsRecord(config, subDomain, 'CNAME', 'CNAMEContent', cnameContent, siteRoot, remark);
}

// AAAA 记录写入：Lucky SyncRecordData 字段名是 ipv6Address（不是 AAAA）
function addDdnsAaaaRecord(config, subDomain, ipv6Address, siteRoot, remark) {
  // nas AAAA 子域固定为 "{prefix}.nas"（无 siteRoot 拼接），与 addDdnsCnameRecord 行为不同
  // 内部走 addDdnsRecord 时用占位 siteRoot（不会被 fullDomainName 字符串用到）
  return addDdnsRecord(config, subDomain, 'AAAA', 'ipv6Address', ipv6Address, siteRoot, remark);
}

// 查找：主域下 nas 子域的 DDNS 记录（不要求 *.nas 通配，支持逐条子域）
function findNasDdnsTask(tasks, rootDomain, prefix) {
  if (!rootDomain) return null;
  const needle = prefix ? `${prefix}.nas.${rootDomain}`.toLowerCase() : `*.nas.${rootDomain}`;
  const suffix = `.nas.${rootDomain.toLowerCase()}`;
  return (
    tasks.find((task) =>
      (task.Records || []).some((record) => {
        const sdData = record.SyncRecordData || {};
        const sd = String(sdData.SubDomainName || record.SubDomain || '').toLowerCase();
        const dn = String(sdData.DomainName || record.DomainName || '').toLowerCase();
        const isNasRecord = dn === rootDomain.toLowerCase() && sd.endsWith('.nas');
        // 接受两种匹配：精确单条（如 ql.nas.alanmaster.top）或通配（*.nas.alanmaster.top）
        const exact = sd === (prefix ? `${prefix}.nas` : null);
        const wildcard = sd === '*.nas';
        const hasMatching = exact || wildcard || (prefix && isNasRecord && sd === `${prefix}.nas`);
        return hasMatching && needle.endsWith(suffix);
      }),
    ) || null
  );
}

// 简化判断：任务里有任何 .nas.{rootDomain} 子域记录即视为已就绪
function hasNasDdnsRecords(tasks, rootDomain) {
  if (!rootDomain) return false;
  const suffix = `.nas.${rootDomain.toLowerCase()}`;
  return tasks.some((task) =>
    (task.Records || []).some((record) => {
      const sdData = record.SyncRecordData || {};
      const sd = String(sdData.SubDomainName || record.SubDomain || '').toLowerCase();
      const dn = String(sdData.DomainName || record.DomainName || '').toLowerCase();
      return dn === rootDomain.toLowerCase() && sd.endsWith('.nas');
    }),
  );
}

// 创建 *.nas.{rootDomain} AAAA 泛解析 DDNS 任务
// 注：Lucky v3 POST /api/ddns 对 payload 校验严格且 500 响应无 body，难以程序化创建。
// 这里改为返回明确指引，提示用户在 Lucky 后台手动添加 *.nas.{rootDomain} AAAA 记录。
async function createNasDdnsTask(config, rootDomain) {
  return {
    created: false,
    manual: true,
    message: `请到 Lucky 后台 → DDNS 任务 → 在 alidns 任务下为每个应用前缀添加 AAAA 记录（SubDomain=<前缀>.nas, DomainName=${rootDomain}）。当前面板仅做预检，不写入 DDNS（Lucky v3 POST 校验接口限制）。`,
  };
}

const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const SNAPSHOT_LIMIT = 10;

// 连通性自检历史：按 "appId:label" 序列保留最近 100 个点（每次 /api/apps/health 写入）
const HEALTH_HISTORY_FILE = path.join(__dirname, 'data', 'health-history.json');
const HEALTH_H_MAX_POINTS = 100;

function readHealthHistory() {
  try {
    // 容忍 UTF-8 BOM（Windows 工具写入可能附加 EF BB BF，Node JSON.parse 会拒绝）
    let raw = fs.readFileSync(HEALTH_HISTORY_FILE, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return { series: {} };
  }
}

function writeHealthHistory(data) {
  try {
    fs.mkdirSync(path.dirname(HEALTH_HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HEALTH_HISTORY_FILE, JSON.stringify(data));
  } catch (error) {
    console.error('health-history 写入失败:', error.message);
  }
}

function appendHealthHistory(results, checkedAt) {
  const data = readHealthHistory();
  const stamp = Date.parse(checkedAt) || Date.now();
  for (const app of results) {
    for (const check of app.checks || []) {
      if (!check || typeof check.latency !== 'number') continue;
      const key = `${app.id}:${check.label}`;
      const series = data.series[key] || (data.series[key] = []);
      series.push({ t: stamp, status: check.status || 0, latency: check.latency, ok: check.ok !== false });
      if (series.length > HEALTH_H_MAX_POINTS) {
        series.splice(0, series.length - HEALTH_H_MAX_POINTS);
      }
    }
  }
  writeHealthHistory(data);
}

function saveSnapshot(config, label) {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
    const file = path.join(SNAPSHOT_DIR, `snapshot-${timestamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ label, time: new Date().toISOString(), config }, null, 2), 'utf8');
    // 保留最近 N 份
    const snaps = fs.readdirSync(SNAPSHOT_DIR).filter((n) => n.startsWith('snapshot-')).sort();
    while (snaps.length > SNAPSHOT_LIMIT) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, snaps.shift()));
    }
    return file;
  } catch (error) {
    console.error(`快照保存失败: ${error.message}`);
    return null;
  }
}

function listSnapshots() {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      return [];
    }
    return fs
      .readdirSync(SNAPSHOT_DIR)
      .filter((n) => n.startsWith('snapshot-') && n.endsWith('.json'))
      .sort()
      .reverse()
      .map((name) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, name), 'utf8'));
          return {
            file: name,
            label: data.label || '部署前快照',
            time: data.time || name,
            apps: (data.config?.apps || []).length,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function deploy(config, appId, parts, logs) {
  const selected = new Set(
    Array.isArray(parts) && parts.length > 0 ? parts.filter((part) => part === 'lucky' || part === 'esa') : ['lucky', 'esa'],
  );
  validateDeployConfig(config, selected);
  // 部署前快照（可回滚）
  const scopeLabel = appId ? `同步应用 ${appId}` : '全量部署';
  const snapFile = saveSnapshot(config, scopeLabel);
  if (snapFile) {
    logs.push({ step: '配置快照', status: 'ok', detail: `已保存部署前快照 ${path.basename(snapFile)}（可在设置页回滚）` });
  }
  const errors = [];
  if (selected.has('lucky')) {
    try {
      await applyLucky(config, logs, appId);
    } catch (error) {
      errors.push({ part: 'lucky', message: error.message });
      logs.push({ step: 'Lucky 反向代理', status: 'error', detail: error.message });
    }
  }
  if (selected.has('esa')) {
    // ESA 加速域名 + Lucky DDNS CNAME：CNAME 是公网可访问前提，必须先于回源规则
    const esaTargets = (appId ? config.apps.filter((a) => a.id === appId) : config.apps)
      .filter((app) => app.esaEnabled !== false);
    for (const app of esaTargets) {
      try {
        const result = await enableEsaDomain(
          config,
          cdnDomainOf(app, config),
          nasDomainOf(app, config),
          `EdgeLink ${app.name}`,
        );
        logs.push({ step: 'ESA 加速域名', status: 'ok', detail: result.esa?.existed
          ? `${app.name} ESA 加速域名已存在`
          : `${app.name} ESA 加速域名已创建` });
        const ddns = result.ddns || {};
        const ddnsStatus = ddns.error ? 'error' : 'ok';
        const ddnsDetail = ddns.error
          ? `${app.name} Lucky DDNS CNAME 失败：${ddns.error}`
          : ddns.added
            ? `${app.name} Lucky DDNS CNAME added -> ${result.cnameTarget}`
            : ddns.updated
              ? `${app.name} Lucky DDNS CNAME updated -> ${result.cnameTarget}`
              : `${app.name} Lucky DDNS CNAME skipped（已存在且一致）`;
        logs.push({ step: 'Lucky DDNS CNAME', status: ddnsStatus, detail: ddnsDetail });
        if (ddns.error) {
          throw new Error(`Lucky DDNS CNAME 同步失败：${ddns.error}`);
        }
        // nas AAAA 写入结果（如果配置了 publicIPv6）
        if (result.nasAaaa && (result.nasAaaa.added || result.nasAaaa.updated || result.nasAaaa.skipped || result.nasAaaa.error)) {
          if (result.nasAaaa.error) {
            logs.push({ step: 'Lucky DDNS nas AAAA', status: 'warn', detail: `${app.name} ${result.nasAaaa.error}` });
          } else {
            const action = result.nasAaaa.added ? 'added' : result.nasAaaa.updated ? 'updated' : 'skipped';
            logs.push({ step: 'Lucky DDNS nas AAAA', status: 'ok', detail: `${app.name} ${nasDomainOf(app, config)} AAAA ${action}` });
          }
        }
      } catch (error) {
        errors.push({ part: 'esa', message: error.message });
        logs.push({ step: 'Lucky DDNS CNAME', status: 'error', detail: error.message });
        break;
      }
    }
    try {
      logs.push({
        step: 'ESA 回源规则',
        status: 'ok',
        detail: '用户统一管理，本次未创建、更新或删除',
      });
    } catch (error) {
      errors.push({ part: 'esa', message: error.message });
      logs.push({ step: 'ESA 回源规则', status: 'error', detail: error.message });
    }
    // ESA 成功完成后启动该应用的后台 CDN 健康探测
    if (errors.length === 0) {
      for (const app of esaTargets) {
        if (typeof scheduleLiveCheck === 'function') {
          app.status = 'building';
          scheduleLiveCheck(app.id);
          logs.push({ step: 'cdn 健康探测', status: 'ok', detail: `${app.name} 已启动后台轮询（每 10s，最多 5 分钟）` });
        }
      }
    }
  }
  // 写回：不整体覆盖旧快照（异步窗口内其他编辑会被冲掉），
  // 只把 deploy 自己改的状态字段合并进最新配置：app.status='building' + gateway.ruleKey（部署中从 Lucky 学到）
  const persistDeployState = () => {
    const latest = readConfig();
    const statusChanges = (config.apps || [])
      .filter((a) => a.status === 'building')
      .map((a) => ({ id: a.id, status: 'building' }));
    let changed = false;
    for (const { id, status } of statusChanges) {
      const target = (latest.apps || []).find((x) => x.id === id);
      if (target && target.status !== status) {
        target.status = status;
        changed = true;
      }
    }
    if (config.gateway && config.gateway.ruleKey && latest.gateway?.ruleKey !== config.gateway.ruleKey) {
      latest.gateway = { ...latest.gateway, ruleKey: config.gateway.ruleKey };
      changed = true;
    }
    if (changed) writeConfig(latest);
  };
  if (errors.length === 0) {
    persistDeployState();
  } else if (selected.size === errors.length) {
    throw new Error(`同步失败：${errors.map((e) => e.message).join('；')}`);
  } else {
    persistDeployState();
  }

  // ESA 健康探测启动已移入 ESA 块（避免 lucky 抛错时 esaTargets 未定义）

  // 完整性自检：所有 luckyEnabled 应用都应在 Lucky 上有托管子规则
  if (errors.length === 0) {
    try {
      const { rules: refreshedRules } = await getLuckyRules(config);
      const refreshedProxies = (refreshedRules || []).flatMap((r) => r.ProxyList || []);
      const refreshedKeys = new Set(refreshedProxies.map((p) => p.Key));
      const missing = [];
      for (const app of (appId ? config.apps.filter((a) => a.id === appId) : config.apps)) {
        if (app.luckyEnabled === false) continue;
        const key = managedProxyKey(app.id);
        if (!refreshedKeys.has(key)) missing.push(`${key} (${nasDomainOf(app, config)})`);
      }
      if (missing.length > 0) {
        logs.push({
          step: 'Lucky 自检',
          status: 'warn',
          detail: `检测到以下应用缺少托管子规则（deploy 阶段未被 Lucky 接受）：${missing.join('、')}。可能是 Lucky 限流，建议稍后重试 /api/audit/fix`,
        });
      }
    } catch (e) {
      // 自检失败不阻断
    }
  }

  const scopeText = selected.has('lucky') && selected.has('esa') ? '全部' : selected.has('lucky') ? 'Lucky' : 'ESA';
  if (errors.length === 0) {
    logs.push({ step: '完成', status: 'ok', detail: `${scopeText}同步完成，配置已保存，DNS 记录请继续由 Lucky DDNS 自动更新` });
  } else {
    logs.push({ step: '完成', status: 'error', detail: `${scopeText}同步部分失败（${errors.map((e) => e.part).join('、')}），配置已保存` });
  }
}

function checkGatewayPort(config) {
  const port = Number(config.gateway.listenPort) || 8443;
  const listenIp = config.gateway.listenIp || '::';
  const hosts = listenIp === '::' ? ['::1', '127.0.0.1'] : listenIp === '0.0.0.0' ? ['127.0.0.1'] : [listenIp];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let index = 0;
    const tryNext = () => {
      if (index >= hosts.length) {
        finish({ listening: false, error: '无法连接本地回源端口' });
        return;
      }
      const socket = net.createConnection({ host: hosts[index], port }, () => {
        socket.destroy();
        finish({ listening: true });
      });
      socket.once('error', () => {
        socket.destroy();
        index += 1;
        tryNext();
      });
      socket.setTimeout(1200, () => {
        socket.destroy();
        index += 1;
        tryNext();
      });
    };
    tryNext();
  });
}

// 连通性探测：https 失败若为证书校验错误（自签/纯 http 网关）则回退 http，不做全局关闭证书校验
async function probeUrl(url) {
  const attempt = async (target) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const start = Date.now();
    try {
      const res = await fetch(target, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'EdgeLink-health' },
      });
      return { ok: true, status: res.status, latency: Date.now() - start };
    } catch (error) {
      return {
        ok: false,
        error: error.name === 'AbortError' ? '超时' : String(error.cause?.code || error.code || error.message || '连接失败'),
      };
    } finally {
      clearTimeout(timer);
    }
  };
  let result = await attempt(url);
  if (!result.ok && /CERT|TLS|SSL|UNABLE_TO_VERIFY|self.?signed/i.test(result.error)) {
    result = await attempt(url.replace(/^https:\/\//, 'http://'));
  }
  return result;
}

async function getRuntimeStatus(config) {
  const result = {
    lucky: { configured: false, ok: false, gatewayRule: false, managedProxies: 0 },
    esa: { configured: false, ok: false, managedRules: 0 },
    gateway: { listening: false, error: '' },
  };

  if (config.lucky.baseUrl && (config.lucky.openToken || (config.lucky.account && config.lucky.password))) {
    result.lucky.configured = true;
    try {
      const { rules } = await getLuckyRules(config);
      result.lucky.ok = true;
      const gateway = rules.find(
        (rule) =>
          rule.RuleName === GATEWAY_RULE_NAME ||
          Number(rule.ListenPort) === (Number(config.gateway.listenPort) || 8443),
      );
      result.lucky.gatewayRule = !!gateway;
      result.lucky.managedProxies = gateway
        ? gateway.ProxyList.filter((proxy) => isManagedProxyKey(proxy.Key)).length
        : 0;
    } catch (error) {
      result.lucky.error = error.message;
    }
  } else {
    result.lucky.error = '未配置';
  }

  if (config.esa.accessKeyId && config.esa.accessKeySecret && config.esa.siteId) {
    result.esa.configured = true;
    try {
      const client = getEsaClient(config.esa);
      const rules = await esaListOriginRules(client, config.esa.siteId);
      result.esa.ok = true;
      result.esa.managedRules = rules.filter((rule) =>
        String(rule.ruleName || '').startsWith(ESA_RULE_PREFIX),
      ).length;
    } catch (error) {
      result.esa.error = esaErrorMessage(error);
    }
  } else {
    result.esa.error = config.esa.siteId ? '未配置' : '未选择站点';
  }

  const portCheck = await checkGatewayPort(config);
  result.gateway = { ...result.gateway, ...portCheck };
  return result;
}

function asyncHandler(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      console.error(error);
      pushServerLog('服务端', 'error', error.message || String(error));
      res.status(500).json({ ok: false, error: error.message || String(error) });
    });
  };
}

// ---------- 服务端日志环形缓冲 + SSE 实时广播 ----------
const SERVER_LOG_LIMIT = 500;
const serverLogs = [];
const logClients = new Set();

function pushServerLog(step, status = 'ok', detail = '') {
  const entry = { step, status, detail, time: new Date().toISOString() };
  serverLogs.push(entry);
  if (serverLogs.length > SERVER_LOG_LIMIT) {
    serverLogs.splice(0, serverLogs.length - SERVER_LOG_LIMIT);
  }
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logClients) {
    try {
      client.write(payload);
    } catch {
      logClients.delete(client);
    }
  }
  return entry;
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/lucide/dist/umd')));

// 访问口令（可选）：config.panel.token 非空时，/api/* 除 /api/health 外校验 X-Panel-Token
app.use('/api', (req, res, next) => {
  if (req.path === '/health') {
    next();
    return;
  }
  let config;
  try {
    config = readConfig();
  } catch (error) {
    // 配置损坏时给出 JSON 错误（而非 Express 默认 HTML 500），避免泄露堆栈且前端可读
    res.status(500).json({ ok: false, error: error.message || String(error) });
    return;
  }
  const token = config.panel?.token || '';
  if (!token) {
    next();
    return;
  }
  const provided = req.get('X-Panel-Token') || req.query.token;
  if (provided === token) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: '访问口令无效或未提供' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({ ok: true, config: sanitizeConfig(readConfig()) });
});

// 服务端日志：历史（最近 500 条）+ SSE 实时流（前端用 fetch 流式读取以携带口令头）
app.get('/api/logs', (req, res) => {
  res.json({ ok: true, logs: serverLogs });
});

app.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  logClients.add(res);
  req.on('close', () => {
    logClients.delete(res);
  });
});

app.get(
  '/api/summary',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const summary = {
      apps: (config.apps || []).length,
      luckySubRules: 0,
      luckyPanelProxies: 0,
      esaDomains: 0,
      esaPanelDomains: 0,
      luckyDdnsTasks: 0,
      luckyDdnsNasTask: false,
      luckySsl: 0,
      luckyNasSsl: false,
      esaCertificates: 0,
      esaNasCertificate: false,
      rootDomain: config.esa?.rootDomain || '',
      configured: {
        lucky: !!config.lucky?.baseUrl && (!!config.lucky?.openToken || !!(config.lucky?.account && config.lucky?.password)),
        esa: !!config.esa?.accessKeyId && !!config.esa?.accessKeySecret && !!config.esa?.siteId,
      },
    };
    try {
      const { rules } = await getLuckyRules(config);
      const allProxies = (rules || []).flatMap((r) => r.ProxyList || []);
      summary.luckySubRules = allProxies.length;
      summary.luckyPanelProxies = allProxies.filter((p) => isManagedProxyKey(p.Key)).length;
    } catch {}
    // 直接复用现有 ESA 域名获取
    try {
      if (config.esa?.siteId) {
        const client = getEsaClient(config.esa);
        const domains = await esaListDomains(client, config.esa.siteId);
        summary.esaDomains = domains.length;
        summary.esaPanelDomains = domains.filter((d) => d.name && d.name.endsWith('.cdn.' + summary.rootDomain)).length;
        const certs = await esaListCertificates(client, config.esa.siteId, '');
        summary.esaCertificates = certs.length;
        if (summary.rootDomain) {
          const cdnKeyword = `*.cdn.${summary.rootDomain}`.toLowerCase();
          const nasKeyword = `*.nas.${summary.rootDomain}`.toLowerCase();
          summary.esaNasCertificate = certs.some((c) =>
            Array.isArray(c.sans) && c.sans.some((s) => String(s).toLowerCase().includes('.cdn.' + summary.rootDomain)),
          );
        }
      }
    } catch {}
    try {
      const tasks = await getLuckyDdnsTasks(config);
      summary.luckyDdnsTasks = tasks.length;
      summary.luckyDdnsNasTask = hasNasDdnsRecords(tasks, summary.rootDomain);
    } catch {}
    try {
      if (config.lucky?.baseUrl && (config.lucky?.openToken || (config.lucky?.account && config.lucky?.password))) {
        const { baseUrl, token } = await luckyLogin(config);
        const data = await luckyRequest(baseUrl, token, 'GET', '/api/ssl');
        const list = data.list || [];
        summary.luckySsl = list.length;
        if (summary.rootDomain) {
          const target = `*.nas.${summary.rootDomain}`.toLowerCase();
          summary.luckyNasSsl = list.some((cert) => {
            const ext = parseSyncRecord(cert.ExtParams) || {};
            const info = parseSyncRecord(cert.CertsInfo) || {};
            const sans = [...(ext.SubDomainList || []), ...(info.SAN ? [info.SAN] : [])];
            return sans.some((s) => String(s).toLowerCase() === target);
          });
        }
      }
    } catch {}
    res.json({ ok: true, summary });
  }),
);

app.get(
  '/api/status',
  asyncHandler(async (req, res) => {
    const status = await getRuntimeStatus(readConfig());
    res.json({ ok: true, status });
  }),
);

app.get(
  '/api/lucky/rules',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const { rules } = await getLuckyRules(config);
    const subRules = [];
    for (const rule of rules || []) {
      for (const proxy of rule.ProxyList || []) {
        subRules.push({
          key: proxy.Key,
          managed: isManagedProxyKey(proxy.Key),
          name: proxy.Remark,
          domains: proxy.Domains || [],
          locations: proxy.Locations || [],
          enabled: proxy.Enable !== false,
          enableBasicAuth: proxy.EnableBasicAuth === true,
          webAuth: proxy.WebAuth === true || (proxy.OtherParams && proxy.OtherParams.WebAuth === true),
          groupKey: proxy.GroupKey || '',
          ruleKey: rule.RuleKey,
          listenPort: rule.ListenPort,
        });
      }
    }
    res.json({ ok: true, rules: subRules });
  }),
);

// Lucky 分组列表：所有 group + 每个分组的子规则数
app.get(
  '/api/lucky/groups',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const { baseUrl, token } = await luckyLogin(config);
    const data = await luckyRequest(baseUrl, token, 'GET', '/api/webservice/groups');
    const groups = data.list || data.groups || [];
    let counts = {};
    try {
      const c = await luckyRequest(baseUrl, token, 'GET', '/api/webservice/groups/subrulecount');
      counts = c.counts || c.data || {};
    } catch {
      counts = {};
    }
    res.json({ ok: true, groups, counts });
  }),
);

app.get(
  '/api/lucky/ddns/tasks',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const tasks = await getLuckyDdnsTasks(config);
    const rootDomain = String(config.esa?.rootDomain || '').toLowerCase();
    const summary = tasks.map((task) => ({
      taskKey: task.TaskKey,
      taskName: task.TaskName,
      taskType: task.TaskType,
      enable: task.Enable !== false,
      dnsProvider: (task.DNS || {}).Name || '',
      recordCount: (task.Records || []).length,
      records: (task.Records || []).map((r) => ({
        key: r.Key || '',
        subDomain: r.SubDomain || '',
        domainName: r.DomainName || '',
        type: r.Type || '',
        content: r.CNAMEContent || r.Value || '',
      })),
      hasNasWildcard:
        rootDomain &&
        (task.Records || []).some(
          (r) =>
            r.Type === 'AAAA' &&
            String(r.SubDomain || '') === '*.nas' &&
            String(r.DomainName || '').toLowerCase() === rootDomain,
        ),
    }));
    res.json({ ok: true, rootDomain, tasks: summary });
  }),
);

app.post(
  '/api/lucky/ddns/nas-task',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const rootDomain = String(req.body?.rootDomain || config.esa?.rootDomain || '').trim().toLowerCase();
    if (!rootDomain) {
      throw new Error('缺少站点根域');
    }
    const result = await createNasDdnsTask(config, rootDomain);
    res.json({ ok: true, created: result.created, manual: !!result.manual, message: result.message });
  }),
);

// DDNS 维护：删除单条记录（按 subDomain 匹配整条 Lucky DDNS 任务里的任意 alidns 记录）
// 用途：用户手动维护 DDNS 记录（如退役一条旧子域）；不替代面板自动写路径
// 强制要求 recordKey（不再按 subDomain 一刀切，避免误删多条同名记录）
// ?dryRun=1 返回待删记录清单但不动 Lucky
app.post(
  '/api/lucky/ddns/record-delete',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const recordKey = String(req.body?.recordKey || '').trim();
    if (!recordKey) throw new Error('缺少 recordKey（必须精确指定一条记录，禁止按 subDomain 批量删除）');
    const dryRun = String(req.query.dryRun || '') === '1' || req.body?.dryRun === true;
    const tasks = await getLuckyDdnsTasks(config);
    const target = tasks.find((t) => ((t.DNS || {}).Name || '') === 'alidns') || tasks[0];
    if (!target) throw new Error('未找到 DDNS 任务');
    const { baseUrl, token } = await luckyLogin(config);
    const detail = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${target.TaskKey}`);
    const task = detail.task || detail.data;
    const before = (task.Records || []).length;
    const matched = (task.Records || []).filter((r) => r.Key === recordKey);
    if (matched.length === 0) {
      return res.json({ ok: false, error: `Lucky 任务中未找到 recordKey=${recordKey}`, removed: 0, dryRun, taskKey: target.TaskKey });
    }
    const matchedView = matched.map((r) => ({
      key: r.Key,
      subDomain: (r.SyncRecordData && r.SyncRecordData.SubDomainName) || r.SubDomain || '',
      domain: (r.SyncRecordData && r.SyncRecordData.DomainName) || r.DomainName || '',
      type: (r.SyncRecordData && r.SyncRecordData.type) || r.Type || '',
      content: (r.SyncRecordData && (r.SyncRecordData.CNAMEContent || r.SyncRecordData.TXTContent || r.SyncRecordData.Value)) || '',
      remark: (r.SyncRecordData && r.SyncRecordData.remark) || '',
    }));
    if (dryRun) {
      return res.json({ ok: true, dryRun: true, willRemove: matchedView.length, records: matchedView, taskKey: target.TaskKey });
    }
    task.Records = (task.Records || []).filter((r) => r.Key !== recordKey);
    await luckyRequest(baseUrl, token, 'PUT', `/api/ddns?key=${target.TaskKey}`, task);
    res.json({ ok: true, removed: before - task.Records.length, records: matchedView, taskKey: target.TaskKey });
  }),
);

// 清除公网解析残留：直连 alidns 删除指定主域下的解析记录（如已删除应用遗留的 aiusage.nas / aiusage.cdn）
// body: { domainName: "alanmaster.top", records: [{ rr, type, value }] } 或 { rrPrefix: "aiusage" } 按前缀匹配
// ?dryRun=1 只预览不删
app.post(
  '/api/lucky/ddns/cleanup-residue',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const dryRun = String(req.query.dryRun || '') === '1' || req.body?.dryRun === true;
    const domainName = String(req.body?.domainName || config.esa?.rootDomain || '').trim().toLowerCase();
    if (!domainName) throw new Error('缺少 domainName（站点根域）');
    const explicit = Array.isArray(req.body?.records) ? req.body.records : null;
    const rrPrefix = String(req.body?.rrPrefix || '').trim().toLowerCase();

    // 拉取 alidns 全部记录
    let all;
    try {
      all = await alidnsListRecords(config, domainName);
    } catch (error) {
      return res.json({ ok: false, error: `alidns 查询失败：${error.message}`, dryRun });
    }

    // 筛选待删：显式列表 或 rrPrefix 前缀匹配
    let targets = [];
    if (explicit) {
      targets = explicit.map((r) => ({
        recordId: String(r.recordId || ''),
        RR: String(r.rr || '').toLowerCase(),
        type: String(r.type || '').toUpperCase(),
        value: String(r.value || ''),
        matched: false,
      }));
    } else if (rrPrefix) {
      targets = all
        .filter((r) => String(r.RR || '').toLowerCase() === rrPrefix || String(r.RR || '').toLowerCase().startsWith(rrPrefix + '.'))
        .map((r) => ({ ...r, matched: false }));
    } else {
      throw new Error('需提供 records 列表或 rrPrefix');
    }

    // 从 alidns 现有记录中找 recordId（显式列表可能没给 recordId）
    for (const t of targets) {
      if (t.recordId) continue;
      const found = all.find((r) => r.RR === t.RR && r.type === t.type && (!t.value || r.value === t.value));
      if (found) {
        t.recordId = String(found.recordId);
        t.matched = true;
      }
    }
    const withId = targets.filter((t) => t.recordId);
    const notFound = targets.filter((t) => !t.recordId);

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        domainName,
        willDelete: withId.map((t) => ({ recordId: t.recordId, rr: t.RR, type: t.type, value: t.value })),
        notFound: notFound.map((t) => ({ rr: t.RR, type: t.type, value: t.value })),
        message: `dryRun 模式：将删除 ${withId.length} 条，${notFound.length} 条未找到；不带 dryRun=1 才会真正执行`,
      });
    }

    const deleted = [];
    const errors = [];
    for (const t of withId) {
      try {
        await alidnsDeleteRecord(config, t.recordId);
        deleted.push({ recordId: t.recordId, rr: t.RR, type: t.type, value: t.value });
      } catch (error) {
        errors.push({ rr: t.RR, type: t.type, error: error.message });
      }
    }
    for (const item of deleted) {
      pushServerLog('清理解析残留', 'ok', `已删除 ${item.rr}.${domainName} (${item.type})`);
    }
    for (const item of errors) {
      pushServerLog('清理解析残留', 'error', `${item.rr}.${domainName} (${item.type})：${item.error}`);
    }
    res.json({
      ok: true,
      domainName,
      deleted,
      notFound: notFound.map((t) => ({ rr: t.RR, type: t.type })),
      errors,
      message: `已删除 ${deleted.length} 条残留${errors.length ? `，${errors.length} 条失败` : ''}${notFound.length ? `，${notFound.length} 条未找到` : ''}`,
    });
  }),
);

async function dohLookup(name, type) {
  // Cloudflare DoH（1.1.1.1）—— 改用其 JSON API
  // 与 Google dns.google 协议兼容，Status 字段语义相同
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { Accept: 'application/dns-json' },
    signal: AbortSignal.timeout(2000),
  });
  const j = await r.json();
  // Status: 0 NOERROR w/ Answer, 3 NOERROR no data, 4 NXDOMAIN, etc.
  if (!j || !Array.isArray(j.Answer) || j.Answer.length === 0) return false;
  return true;
}

// 简易并发限制器：限制同时运行的 promise 数量（Cloudflare 1.1.1.1 对突发并发会限流/丢包）
async function pooled(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  async function next() {
    const i = cursor++;
    if (i >= items.length) return;
    out[i] = await worker(items[i], i);
    return next();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return out;
}

// 公网 DoH 解析结果缓存：60s 内复用上次查询，避免 1.1.1.1 慢/限流时反复转圈
const dohCache = new Map(); // key: rootDomain -> { at, payload }
const DOH_CACHE_TTL_MS = 60_000;
let dohInFlight = null; // 同一时刻只跑一次实际查询（去重并发请求）

app.get(
  '/api/lucky/ddns/pending',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const rootDomain = String(config.esa?.rootDomain || '').toLowerCase();
    if (!rootDomain) {
      return res.json({ ok: true, rootDomain: '', items: [], message: '未配置站点根域' });
    }
    const cached = dohCache.get(rootDomain);
    if (cached && Date.now() - cached.at < DOH_CACHE_TTL_MS) {
      return res.json({ ok: true, cached: true, ...cached.payload });
    }
    // 去重：若有请求在飞，让本次请求共享其结果（避免连续多次刷新把后端打满）
    if (!dohInFlight) {
      dohInFlight = (async () => {
        let tasks = [];
        try {
          tasks = await getLuckyDdnsTasks(config);
        } catch (error) {
          return { ok: false, rootDomain, items: [], message: `Lucky 读取失败：${error.message}` };
        }
        const seen = new Map();
        for (const task of tasks || []) {
          const taskEnable = task.Enable !== false;
          const taskName = task.TaskName || task.TaskKey;
          for (const r of task.Records || []) {
            const sd = String(r.SubDomain || '').toLowerCase();
            const dn = String(r.DomainName || '').toLowerCase();
            const type = String(r.Type || 'A').toUpperCase();
            if (dn !== rootDomain) continue;
            if (!(sd === '*.nas' || sd.endsWith('.nas'))) continue;
            const key = `${sd}::${type}`;
            if (!seen.has(key)) {
              seen.set(key, { subDomain: sd, type, tasks: [] });
            }
            seen.get(key).tasks.push({ name: taskName, enable: taskEnable });
          }
        }
        const candidates = [...seen.values()].slice(0, 12);
        // 并发上限 6，避免 1.1.1.1 突发限流
        const looked = await pooled(candidates, 6, async (item) => {
          const full = item.subDomain === '*.nas' ? `*.nas.${rootDomain}` : `${item.subDomain}.${rootDomain}`;
          const queryName = item.subDomain === '*.nas' ? rootDomain : full;
          try {
            const [a, aaaa] = await Promise.all([
              dohLookup(queryName, 'A'),
              dohLookup(queryName, 'AAAA'),
            ]);
            return { ...item, fullDomain: full, queryName, hasA: a, hasAAAA: aaaa };
          } catch {
            return { ...item, fullDomain: full, queryName, hasA: false, hasAAAA: false, lookupError: true };
          }
        });
        const items = looked.map((it) => {
          const hasAny = it.hasA || it.hasAAAA;
          const isWildcard = it.subDomain === '*.nas';
          const status = isWildcard ? 'wildcard' : hasAny ? 'ok' : 'pending';
          return { ...it, status };
        });
        return { ok: true, rootDomain, items, checkedAt: new Date().toISOString() };
      })();
    }
    try {
      const payload = await dohInFlight;
      // 写入缓存（错误结果也缓存 30s，避免错误抖动）
      const ttl = payload.ok ? DOH_CACHE_TTL_MS : Math.min(DOH_CACHE_TTL_MS, 30_000);
      dohCache.set(rootDomain, { at: Date.now(), payload });
      res.json(payload);
    } finally {
      dohInFlight = null;
    }
  }),
);

// 向 Lucky DDNS 任务追加 / 更新 TXT 记录（用于证书 DNS-01 校验等场景）
// Lucky v3 alidns provider: params.Set("Type", recordType) 原样转发给 alidns API，
// 故写入 type='TXT' + TXTContent 即可让 Lucky 引擎代为写公网 TXT 解析。
app.post(
  '/api/lucky/ddns/txt',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const subDomain = String(req.body?.subDomain || '').trim().toLowerCase();
    const content = String(req.body?.content || '');
    const siteRoot = String(req.body?.siteRoot || config.esa?.rootDomain || '').trim().toLowerCase();
    const remark = String(req.body?.remark || `面板写入 ${new Date().toISOString().slice(0, 10)}`);
    if (!/^[a-z0-9_.*-]*$/.test(subDomain)) {
      throw new Error(`subDomain 含非法字符: ${subDomain}`);
    }
    if (!content) {
      throw new Error('缺少 TXT 内容');
    }
    if (!siteRoot) {
      throw new Error('缺少站点根域（siteRoot）');
    }
    const result = await addDdnsRecord(config, subDomain, 'TXT', 'TXTContent', content, siteRoot, remark);
    res.json({ ok: true, ...result });
  }),
);


// Lucky 现存子规则开关（反代 Enable / 网页认证 BasicAuth）
app.post(
  '/api/lucky/proxy/toggle',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const proxyKey = String(req.body.proxyKey || '');
    const field = String(req.body.field || '');
    const value = !!req.body.value;
    if (!proxyKey || !['luckyEnabled', 'webAuth'].includes(field)) {
      throw new Error('参数无效');
    }
    const { baseUrl, token, rules } = await getLuckyRules(config);
    const rule = (rules || []).find((r) =>
      (r.ProxyList || []).some((p) => p.Key === proxyKey),
    );
    if (!rule) throw new Error('未找到该子规则');
    const proxy = rule.ProxyList.find((p) => p.Key === proxyKey);
    if (field === 'luckyEnabled') {
      proxy.Enable = value;
    } else {
      // 网页认证（WebAuth）：浏览器走 Lucky 内置登录页，非浏览器回退 BasicAuth。
      // 用户要求"认证用网页认证不用 basic"：开启时写 WebAuth=true + BasicAuthUserList，
      // 关闭时清掉 WebAuth + 认证信息，EnableBasicAuth 始终为 false。
      const ba = config.lucky && config.lucky.basicAuth;
      const users = (ba && ba.users) || [];
      const first = users[0] || {};
      proxy.WebAuth = value;
      if (!proxy.OtherParams) proxy.OtherParams = {};
      proxy.OtherParams.WebAuth = value;
      proxy.EnableBasicAuth = false;
      proxy.BasicAuthUser = value ? (first.username || '') : '';
      proxy.BasicAuthPasswd = value ? (first.password || '') : '';
      proxy.BasicAuthUserList = value
        ? users.map((u) => (u.username || '') + ':' + (u.password || '')).filter((l) => l !== ':').join('\n')
        : '';
      // 定制模式高级开关：Lucky UI 从顶层读取，确保新创建/更新子规则带上
      if (proxy.EasyLucky === undefined) proxy.EasyLucky = true;
      if (proxy.AutoProxyLocation === undefined) proxy.AutoProxyLocation = true;
      if (proxy.EnableAccessLog === undefined) proxy.EnableAccessLog = true;
    }
    try {
      // Lucky 的 PUT /api/webservice/rule/{ruleKey} 期望整个主规则对象（含 RuleKey/DefaultProxy/ProxyList），
      // 不能只 PUT 单个子规则 proxy，否则 Lucky 返回 500。
      await luckyRequest(baseUrl, token, 'PUT', '/api/webservice/rule/' + rule.RuleKey, rule);
    } catch (error) {
      // 部分 Lucky 版本对未知字段严格返回 500，但实际已落盘——回读校验
      const refreshed = await luckyRequest(baseUrl, token, 'GET', '/api/webservice/rules');
      const recheck = (refreshed.ruleList || refreshed.list || []).flatMap((r) => r.ProxyList || []).find((p) => p.Key === proxyKey);
      const gotValue = field === 'luckyEnabled' ? recheck?.Enable : recheck?.WebAuth === true;
      const wantValue = field === 'luckyEnabled' ? value : value;
      if (gotValue === wantValue) {
        // 已落盘，500 是 Lucky 对 PUT 中未知字段的抱怨；放行
        res.json({ ok: true, message: (field === 'luckyEnabled' ? '反代' : '网页认证') + (value ? '已开启' : '已关闭') + '（Lucky 忽略部分字段警告，已生效）' });
        return;
      }
      throw error;
    }
    res.json({ ok: true, message: (field === 'luckyEnabled' ? '反代' : '网页认证') + (value ? '已开启' : '已关闭') });
  }),
);
app.get(
  '/api/lucky/ssl',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const { baseUrl, token } = await luckyLogin(config);
    const data = await luckyRequest(baseUrl, token, 'GET', '/api/ssl');
    const list = data.list || [];
    const parsed = list.map((cert) => {
      const ext = parseSyncRecord(cert.ExtParams) || {};
      const info = parseSyncRecord(cert.CertsInfo) || {};
      const sansFromExt = ext.SubDomainList || [];
      const sansFromInfo = info.SAN ? [info.SAN] : [];
      return {
        key: cert.Key,
        remark: cert.Remark,
        enable: cert.Enable !== false,
        addFrom: cert.AddFrom,
        san: sansFromExt.length ? sansFromExt : sansFromInfo,
        notBefore: info.NotBeforeTime || cert.NotBeforeTime,
        notAfter: info.NotAfterTime || cert.NotAfterTime,
        acmeDomains: ext.acmeDomains || [],
        acmeDNS: ext.acmeDNSServer,
        acmeRunning: cert.ACMEing === true,
      };
    });
    res.json({ ok: true, certificates: parsed });
  }),
);

app.get(
  '/api/lucky/ssl/nas-check',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const rootDomain = String(req.query.rootDomain || config.esa?.rootDomain || '').trim().toLowerCase();
    if (!rootDomain) {
      throw new Error('缺少站点根域');
    }
    const { baseUrl, token } = await luckyLogin(config);
    const data = await luckyRequest(baseUrl, token, 'GET', '/api/ssl');
    const list = data.list || [];
    const target = `*.nas.${rootDomain}`;
    // 同时按 SAN 字符串、证书 Remark、acmeDomains 三处匹配（SAN 字段在 v2.27.2 经常为空，靠 Remark 兜底）
    const found = list.find((cert) => {
      const ext = parseSyncRecord(cert.ExtParams) || {};
      const info = parseSyncRecord(cert.CertsInfo) || {};
      const sans = [
        ...(ext.SubDomainList || []),
        ...(info.SAN ? [info.SAN] : []),
        ...(ext.acmeDomains || []),
      ];
      if (sans.some((s) => String(s).toLowerCase() === target)) return true;
      if (String(cert.Remark || '').toLowerCase() === target) return true;
      return false;
    });
    if (!found) {
      return res.json({
        ok: true,
        exists: false,
        target,
        message: `未找到 ${target} 的 SSL 证书，请到 Lucky 后台申请 ACME 证书（AddFrom=acme，SAN 包含 ${target}，DNS 验证选 alidns）`,
      });
    }
    const ext = parseSyncRecord(found.ExtParams) || {};
    const info = parseSyncRecord(found.CertsInfo) || {};
    return res.json({
      ok: true,
      exists: true,
      target,
      certificate: {
        key: found.Key,
        remark: found.Remark,
        notAfter: info.NotAfterTime || found.NotAfterTime,
        san: ext.SubDomainList || (info.SAN ? [info.SAN] : []),
        acmeDNS: ext.acmeDNSServer,
      },
    });
  }),
);



app.post(
  '/api/esa/domain/toggle',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const domain = normalizeDomain(req.body.domain);
    const proxied = !!req.body.value;
    if (!domain) throw new Error('缺少域名');
    const client = getEsaClient(config.esa);
    const siteId = Number(config.esa.siteId);
    if (!siteId) throw new Error('请先选择 ESA 站点');
    const records = await client.listRecords(new ListRecordsRequest({ siteId, pageSize: 500 }));
    const rec = (records.body?.records || []).find((r) => normalizeDomain(r.recordName) === domain);
    if (!rec) throw new Error('ESA 未找到该加速域名');
    await client.updateRecord(
      new UpdateRecordRequest({
        siteId,
        recordId: rec.recordId,
        recordName: rec.recordName,
        type: rec.recordType,
        data: rec.data,
        proxied,
        hostPolicy: rec.hostPolicy,
        sourceType: rec.recordSourceType,
        ttl: rec.ttl,
      }),
    );
    res.json({ ok: true, message: domain + (proxied ? ' 已开启加速' : ' 已关闭加速') });
  }),
);
app.get(
  '/api/esa/certificates',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const client = getEsaClient(config.esa);
    const siteId = Number(config.esa.siteId);
    if (!siteId) {
      throw new Error('请先选择 ESA 站点');
    }
    const keyword = String(req.query.keyword || '').trim();
    const certs = await esaListCertificates(client, siteId, keyword);
    res.json({ ok: true, certificates: certs });
  }),
);

app.get(
  '/api/app/precheck',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const rootDomain = String(config.esa?.rootDomain || '').trim().toLowerCase();
    const prefix = String(req.query.prefix || '').trim().toLowerCase();
    const result = {
      prefix,
      rootDomain,
      dns: { ok: false, message: '' },
      luckySsl: { ok: false, message: '' },
      esaSsl: { ok: false, message: '' },
      ready: false,
    };
    if (!prefix || !rootDomain) {
      result.dns.message = '缺少域名前缀或站点根域';
      return res.json({ ok: true, precheck: result });
    }

    // DNS：检查主域下是否已有 nas 子域 DDNS 记录（不要求 *.nas 通配；逐条子域亦可）
    try {
      const tasks = await getLuckyDdnsTasks(config);
      if (hasNasDdnsRecords(tasks, rootDomain)) {
        result.dns.ok = true;
        result.dns.message = `主域 ${rootDomain} 下已有 nas 子域 DDNS 记录`;
      } else {
        result.dns.message = `主域 ${rootDomain} 下尚未发现 nas 子域 DDNS 记录，请到 Lucky 后台 DDNS 任务中添加（如 ${prefix}.nas.${rootDomain} 的 AAAA 记录）`;
      }
    } catch (error) {
      result.dns.message = `DDNS 检查失败：${error.message}`;
    }

    // Lucky SSL：检查 *.nas.{root} 证书
    try {
      const { baseUrl, token } = await luckyLogin(config);
      const data = await luckyRequest(baseUrl, token, 'GET', '/api/ssl');
      const list = data.list || [];
      const target = `*.nas.${rootDomain}`;
      const found = list.find((cert) => {
        const ext = parseSyncRecord(cert.ExtParams) || {};
        const info = parseSyncRecord(cert.CertsInfo) || {};
        const sans = [...(ext.SubDomainList || []), ...(info.SAN ? [info.SAN] : [])];
        return sans.some((s) => String(s).toLowerCase() === target);
      });
      if (found) {
        result.luckySsl.ok = true;
        result.luckySsl.message = `${target} SSL 证书已就绪`;
      } else {
        result.luckySsl.message = `未找到 ${target} SSL 证书，请到 Lucky 后台申请 ACME 证书`;
      }
    } catch (error) {
      result.luckySsl.message = `Lucky SSL 检查失败：${error.message}`;
    }

    // ESA SSL：检查覆盖 *.cdn.{root}（或精确子域）的证书（仅检查，部署前要求用户手动在 ESA 控制台申请）
    const siteId = Number(config.esa.siteId);
    if (siteId) {
      try {
        const client = getEsaClient(config.esa);
        const cdnKeyword = `*.cdn.${rootDomain}`;
        const cdnExact = `${prefix}.cdn.${rootDomain}`;
        const certs = await esaListCertificates(client, siteId, cdnKeyword);
        const matched = certs.find((c) => {
          if (!Array.isArray(c.sans)) return false;
          return c.sans.some((s) => certificateCoversDomain(s, cdnExact));
        });
        if (matched) {
          result.esaSsl.ok = true;
          result.esaSsl.message = `${cdnExact} ESA 证书已就绪（含 SAN ${cdnKeyword}）`;
        } else {
          result.esaSsl.message = `未找到覆盖 ${cdnExact} 的 ESA 证书（需要 SAN ${cdnKeyword} 或精确域名），请到 ESA 控制台申请后再部署`;
        }
      } catch (error) {
        result.esaSsl.message = `ESA 证书检查失败：${error.message}`;
      }
    } else {
      result.esaSsl.message = '未选择 ESA 站点，跳过证书检查';
    }

    result.ready = result.dns.ok && result.luckySsl.ok && result.esaSsl.ok;
    res.json({ ok: true, precheck: result });
  }),
);


app.get(
  '/api/esa/rules',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const client = getEsaClient(config.esa);
    const siteId = Number(config.esa.siteId);
    if (!siteId) {
      throw new Error('请先选择 ESA 站点');
    }
    const rules = await esaListOriginRules(client, siteId);
    const list = (rules || []).map((rule) => ({
      configId: rule.configId,
      managed: String(rule.ruleName || '').startsWith(ESA_RULE_PREFIX),
      ruleName: rule.ruleName,
      domain: extractEsaDomain(rule.rule),
      dnsRecord: rule.dnsRecord,
      originHost: rule.originHost,
      originHttpPort: rule.originHttpPort,
      originHttpsPort: rule.originHttpsPort,
      enabled: rule.ruleEnable === 'on',
    }));
    const domains = await esaListDomains(client, siteId);
    res.json({ ok: true, rules: list, domains });
  }),
);

app.post('/api/config', (req, res) => {
  const config = mergeConfig(readConfig(), req.body.config || req.body);
  writeConfig(config);
  pushServerLog('保存配置', 'ok', '配置已保存');
  res.json({ ok: true, config: sanitizeConfig(config) });
});

// 配置导出：完整配置（含凭据，便于换机/备份迁移）
app.get('/api/config/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="edgelink-config.json"');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(readConfig(), null, 2));
});

// 配置导入：整体覆盖保存
app.post('/api/config/import', (req, res) => {
  const incoming = req.body?.config || req.body;
  if (!incoming || typeof incoming !== 'object') {
    throw new Error('导入内容无效');
  }
  const config = mergeConfig(defaultConfig(), incoming);
  writeConfig(config);
  res.json({ ok: true, config: sanitizeConfig(config), message: '配置已导入' });
});

// 部署快照：列表
app.get('/api/snapshots', (req, res) => {
  res.json({ ok: true, snapshots: listSnapshots() });
});

// 部署快照：恢复
app.post('/api/snapshots/restore', (req, res) => {
  const file = String(req.body?.file || '');
  if (!file || !file.startsWith('snapshot-') || !file.endsWith('.json') || file.includes('..')) {
    throw new Error('无效的快照文件');
  }
  const full = path.join(SNAPSHOT_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`快照不存在: ${file}`);
  }
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  const config = mergeConfig(defaultConfig(), data.config || {});
  writeConfig(config);
  res.json({ ok: true, config: sanitizeConfig(config), message: `已恢复快照 ${file}` });
});

// 一致性巡检：面板配置 vs 实际 Lucky/ESA 状态
app.get(
  '/api/audit',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const rootDomain = String(config.esa?.rootDomain || '').toLowerCase();
    const issues = [];
    const summary = { apps: 0, luckyRules: 0, esaDomains: 0, checkedAt: new Date().toISOString() };

    summary.apps = (config.apps || []).length;

    // 1. Lucky 子规则对比
    try {
      const { rules } = await getLuckyRules(config);
      const allProxies = (rules || []).flatMap((r) => r.ProxyList || []);
      summary.luckyRules = allProxies.length;
      const luckyDomains = new Set(allProxies.map((p) => (p.Domains || [])[0]).filter(Boolean));
      for (const app of config.apps || []) {
        const nas = nasDomainOf(app, config);
        if (!nas) continue;
        const proxy = allProxies.find((p) => (p.Domains || []).includes(nas));
        if (!proxy) {
          issues.push({ type: 'lucky-missing', level: 'error', app: app.name, detail: `Lucky 缺少 ${nas} 的反代子规则` });
        } else if (proxy.Enable !== (app.luckyEnabled !== false)) {
          issues.push({ type: 'lucky-enabled', level: 'warn', app: app.name, detail: `${nas} 反代开关不一致（Lucky=${proxy.Enable}, 面板=${app.luckyEnabled !== false}）` });
        }
        // 认证一致性：面板用网页认证（WebAuth），Lucky 上 WebAuth 或 EnableBasicAuth 任一开启都算"开"
        const proxyAuthOn = proxy.WebAuth === true || (proxy.EnableBasicAuth === true && !!proxy.BasicAuthUser);
        const appAuthOn = app.webAuth === true;
        if (proxyAuthOn !== appAuthOn) {
          issues.push({
            type: 'lucky-auth-mismatch',
            level: 'warn',
            app: app.name,
            detail: `${nas} 认证状态不一致（Lucky=${proxyAuthOn ? '开' : '关'}，面板=${appAuthOn ? '开' : '关'}）。请在面板重新点击「同步」或在 Lucky 后台手动调整`,
          });
        }
      }
      // lucky-prefix 专项：target 必须与 lucky.baseUrl host:port 一致，否则反代命中错误
      for (const app of config.apps || []) {
        if (app.prefix !== 'lucky') continue;
        try {
          validateLuckySelfReference(app, config);
        } catch (error) {
          issues.push({ type: 'lucky-self-misroute', level: 'error', app: app.name, detail: error.message });
        }
      }
      // 端口冲突扫描（跨所有 Lucky 规则）
      const portMap = new Map();
      for (const rule of rules || []) {
        const key = `${rule.ListenPort || '?'}/${rule.Network || '?'}`;
        if (!portMap.has(key)) portMap.set(key, []);
        portMap.get(key).push(rule.RuleName || '未命名');
      }
      for (const [key, names] of portMap) {
        if (names.length > 1) {
          issues.push({ type: 'port-conflict', level: 'warn', detail: `监听端口 ${key} 被多个规则占用：${[...new Set(names)].join('、')}` });
        }
      }
    } catch (error) {
      issues.push({ type: 'lucky-error', level: 'error', detail: `Lucky 读取失败：${error.message}` });
    }

    // 2. ESA 加速域名对比
    try {
      if (config.esa?.siteId) {
        const client = getEsaClient(config.esa);
        const domains = await esaListDomains(client, config.esa.siteId);
        summary.esaDomains = domains.length;
        const esaNames = new Set(domains.map((d) => d.name));
        for (const app of config.apps || []) {
          if (app.esaEnabled === false) continue;
          const cdn = cdnDomainOf(app, config).toLowerCase();
          if (!cdn) continue;
          if (!esaNames.has(cdn)) {
            issues.push({ type: 'esa-missing', level: 'error', app: app.name, detail: `ESA 缺少加速域名 ${cdn}` });
          }
        }
      } else {
        issues.push({ type: 'esa-not-configured', level: 'info', detail: '未选择 ESA 站点，跳过 ESA 对比' });
      }
    } catch (error) {
      issues.push({ type: 'esa-error', level: 'error', detail: `ESA 读取失败：${error.message}` });
    }

    // 3. Lucky DDNS CNAME 对比：ESA 域名已存在但 Lucky 任务里缺少对应的 .cdn CNAME
    try {
      if (config.lucky?.baseUrl && (config.lucky?.openToken || (config.lucky?.account && config.lucky?.password)) && rootDomain) {
        const tasks = await getLuckyDdnsTasks(config);
        const cdnCnameSet = new Set();
        for (const task of tasks || []) {
          for (const r of task.Records || []) {
            if (r.Type === 'CNAME' && String(r.SubDomain || '').endsWith('.cdn')) {
              cdnCnameSet.add(String(r.SubDomain).toLowerCase());
            }
          }
        }
        for (const app of config.apps || []) {
          if (app.esaEnabled === false) continue;
          const cdnSub = `${app.prefix}.cdn`.toLowerCase();
          if (!cdnCnameSet.has(cdnSub)) {
            issues.push({
              type: 'lucky-cname-missing',
              level: 'warn',
              app: app.name,
              detail: `Lucky DDNS 缺少 ${cdnSub} 的 CNAME 记录`,
            });
          }
        }
      }
    } catch (error) {
      issues.push({ type: 'lucky-dns-error', level: 'warn', detail: `Lucky DDNS 读取失败：${error.message}` });
    }

    issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
    res.json({ ok: true, summary, issues });
  }),
);

app.post('/api/panel/token', (req, res) => {
  const config = readConfig();
  if (req.body?.clear) {
    config.panel = { ...config.panel, token: '' };
    writeConfig(config);
    res.json({ ok: true, token: '', message: '已关闭访问口令' });
    return;
  }
  const token = crypto.randomBytes(16).toString('base64url');
  config.panel = { ...config.panel, token };
  writeConfig(config);
  res.json({ ok: true, token, message: '已生成新口令，请用新口令重新访问' });
});

// 主题切换：6 套主题持久化到 config.panel.theme
const PANEL_THEMES = new Set(['neon', 'aurora', 'brutal-sun', 'brutal-ocean', 'brutal-berry', 'terminal']);

app.patch(
  '/api/panel/theme',
  asyncHandler(async (req, res) => {
    const theme = String(req.body?.theme || '').trim();
    if (!PANEL_THEMES.has(theme)) {
      throw new Error(`未知主题: ${theme}（允许：${[...PANEL_THEMES].join('、')}）`);
    }
    const config = readConfig();
    config.panel = { ...config.panel, theme };
    writeConfig(config);
    res.json({ ok: true, theme, message: `已切换到 ${theme}` });
  }),
);

app.post(
  '/api/lucky/test',
  asyncHandler(async (req, res) => {
    const current = readConfig();
    const candidate = mergeConfig(current, req.body || {});
    await luckyLogin(candidate);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/esa/sites',
  asyncHandler(async (req, res) => {
    const current = readConfig();
    const candidate = mergeConfig(current, req.body || {});
    const sites = await esaListSites(candidate.esa);
    res.json({ ok: true, sites });
  }),
);

app.post(
  '/api/deploy',
  asyncHandler(async (req, res) => {
    const config = mergeConfig(readConfig(), req.body.config || req.body);
    const rootDomain = String(config.esa?.rootDomain || '').trim().toLowerCase();
    const siteId = Number(config.esa.siteId);
    const deployApps = req.body.appId
      ? config.apps.filter((app) => app.id === req.body.appId)
      : config.apps;
    const parts = req.body.parts || null;
    const selected = new Set(
      Array.isArray(parts) && parts.length > 0
        ? parts.filter((p) => p === 'lucky' || p === 'esa')
        : ['lucky', 'esa'],
    );
    if (selected.has('esa') && siteId && rootDomain) {
      const client = getEsaClient(config.esa);
      const certs = await esaListCertificates(client, siteId, '');
      const sansAll = [];
      for (const c of certs) {
        if (Array.isArray(c.sans)) {
          for (const s of c.sans) sansAll.push(String(s));
        }
      }
      const missing = [];
      for (const app of deployApps) {
        const cdn = `${app.prefix}.cdn.${rootDomain}`.toLowerCase();
        const covered = sansAll.some((s) => certificateCoversDomain(s, cdn));
        if (!covered) {
          missing.push(cdn);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `ESA 证书未覆盖：${missing.join('、')}。请到 ESA 控制台申请覆盖 *.cdn.${rootDomain} 的证书（含 SAN *.cdn.${rootDomain} 或精确域名）后再部署`,
        );
      }
    }
    const logs = [];
    const appId = req.body.appId || null;
    await deploy(config, appId, parts, logs);
    for (const item of logs) {
      pushServerLog(item.step, item.status, item.detail);
    }
    res.json({ ok: true, logs, config: sanitizeConfig(config) });
  }),
);

// 创建 ESA 加速域名记录 + 同步 alidns CNAME（enable-domain 与巡检修复共用）
// 删除 ESA 加速域名记录：仅删 ESA 记录，DDNS CNAME 不动
// ESA 记录创建后短时间内可能处于"配置中"状态（ServiceBusy），加轻量重试
// 传 recordId 时按 recordId 删除并重试（不按 name 查找），避免 name 重试误删同名其他类型记录
async function disableEsaDomain(config, domain, { retries = 4, delayMs = 1500, recordId = 0 } = {}) {
  const client = getEsaClient(config.esa);
  const siteId = Number(config.esa.siteId);
  if (!siteId) throw new Error('缺少 ESA siteId');
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let recId = recordId;
    if (!recId) {
      const list = await esaListDomains(client, siteId);
      const rec = list.find((r) => normalizeDomain(r.name) === domain);
      if (!rec) {
        return { deleted: false, reason: 'not_found', domain };
      }
      if (!rec.id) {
        return { deleted: false, reason: 'no_record_id', domain };
      }
      recId = rec.id;
    }
    try {
      await client.deleteRecord(new DeleteRecordRequest({ recordId: recId }));
      return { deleted: true, domain, recordId: recId, attempts: attempt + 1 };
    } catch (error) {
      const msg = String(error?.message || error);
      const busy = /ServiceBusy|being configured|Try again later/i.test(msg);
      if (busy && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw error;
    }
  }
  return { deleted: false, reason: 'exhausted_retries', domain };
}

// 从所有 Lucky DDNS 任务中精确删除匹配记录（root+sub+type，复用 recordMatches）。
// targets: [{ sub, type }]；siteRoot 为站点根域（如 alanmaster.top）。
// 返回 { count, tasks }：count 为删除条数，tasks 为实际改写的任务 Key 列表。
async function deleteDdnsRecords(config, siteRoot, targets) {
  const removed = { count: 0, tasks: [] };
  const tasks = await getLuckyDdnsTasks(config);
  for (const t of tasks) {
    if (!t.TaskKey) continue;
    const { baseUrl, token } = await luckyLogin(config);
    const detail = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${t.TaskKey}`);
    const task = detail.task || detail.data;
    const before = (task.Records || []).length;
    task.Records = (task.Records || []).filter(
      (r) => !targets.some(({ sub, type }) => recordMatches(r, sub, siteRoot, type)),
    );
    if (task.Records.length < before) {
      await luckyRequest(baseUrl, token, 'PUT', `/api/ddns?key=${t.TaskKey}`, task);
      removed.count += before - task.Records.length;
      removed.tasks.push(t.TaskKey);
    }
  }
  return removed;
}

async function enableEsaDomain(config, domain, target, remark) {
  const client = getEsaClient(config.esa);
  const siteId = Number(config.esa.siteId);
  const messages = [];
  let created = false;
  let ddnsAdded = false;
  let ddnsSkipped = false;
  let nasAaaaAdded = false;
  let nasAaaaUpdated = false;
  let nasAaaaSkipped = false;
  let nasAaaaError = '';
  let ddnsError = '';
  let cnameTarget = '';
  let esaRecord = null;
  const existing = await esaListDomains(client, siteId);
  esaRecord = existing.find((record) => normalizeDomain(record.name) === domain) || null;
  if (esaRecord) {
    cnameTarget = esaRecord.recordCname || '';
    messages.push(`ESA 加速域名已存在（${domain}）`);
  } else {
    const request = new CreateRecordRequest({
      siteId,
      recordName: domain,
      type: 'CNAME',
      data: { value: target },
      proxied: true,
      hostPolicy: 'follow_origin_domain',
      sourceType: 'Domain',
      ttl: 1,
      bizName: 'web',
    });
    await client.createRecord(request);
    created = true;
    // 创建响应无 recordCname，重新查询获取 ESA 分配的接入节点
    const refreshed = await esaListDomains(client, siteId);
    esaRecord = refreshed.find((record) => normalizeDomain(record.name) === domain) || null;
    cnameTarget = esaRecord?.recordCname || '';
    messages.push(`已创建 ESA 加速域名 ${domain} -> ${target}`);
  }

  // 同步到 Lucky DDNS（CNAME 指向 ESA 节点 + nas AAAA 指向 Lucky 公网 IPv6）
  if (!cnameTarget) {
    ddnsError = 'ESA 记录缺少 recordCname，无法同步 DDNS';
    messages.push(ddnsError);
  } else if (config.lucky.openToken || (config.lucky.account && config.lucky.password)) {
    const rootMatch = domain.match(/^[^.]+\.cdn\.(.+)$/);
    const siteRoot = normalizeDomain(rootMatch ? rootMatch[1] : domain.split('.').slice(-2).join('.'));
    const subDomain = domain.slice(0, -(siteRoot.length + 1));
    // subDomain 此时形如 "aiusage.cdn"；nas AAAA 的子域是 "{prefix}.nas"，要剥掉 .cdn 后缀
    const nasSub = subDomain.replace(/\.cdn$/, '');
    try {
      const ddnsResult = await addDdnsCnameRecord(config, subDomain, cnameTarget, siteRoot, remark || '');
      ddnsAdded = ddnsResult.added;
      ddnsSkipped = !ddnsResult.added;
      messages.push(ddnsResult.message);
    } catch (error) {
      ddnsError = error.message;
      messages.push(`Lucky DDNS 同步失败：${error.message}`);
    }
    // nas AAAA：把 nas.alanmaster.top 指向 Lucky 公网 IPv6（用户需在 config.lucky.publicIPv6 配一次）
    const publicIPv6 = String(config.lucky.publicIPv6 || '').trim();
    if (publicIPv6 && siteRoot) {
      try {
        // nas AAAA 子域固定 "{prefix}.nas"，与 ESA 任务主域通过 cdn 任务的 cname 值共享 rootDomain，
        // 写入 IPv6 任务（aliyun alidns 同步），siteRoot 仍传 alanmaster.top 让 addDdnsRecord 内部
        // 把 DomainName 字段设为 "alanmaster.top"，SubDomainName 字段设为 "aiusage.nas"。
        const aaaaResult = await addDdnsAaaaRecord(config, `${nasSub}.nas`, publicIPv6, siteRoot, remark || '');
        nasAaaaAdded = aaaaResult.added;
        nasAaaaUpdated = aaaaResult.updated;
        nasAaaaSkipped = !aaaaResult.added && !aaaaResult.updated;
        messages.push(`Lucky DDNS nas AAAA ${aaaaResult.added ? 'added' : aaaaResult.updated ? 'updated' : 'skipped'}: ${nasSub} -> ${publicIPv6}`);
      } catch (error) {
        nasAaaaError = error.message;
        messages.push(`Lucky DDNS nas AAAA 同步失败：${error.message}`);
      }
    }
  } else {
    messages.push('未配置 Lucky，跳过 DNS CNAME 同步');
  }
  return { created, domain, cnameTarget, esa: { created, existed: !!esaRecord && !created }, ddns: { added: ddnsAdded, skipped: ddnsSkipped, error: ddnsError }, nasAaaa: { added: nasAaaaAdded, updated: nasAaaaUpdated, skipped: nasAaaaSkipped, error: nasAaaaError }, message: messages.join('；') };
}

app.post(
  '/api/esa/enable-domain',
  asyncHandler(async (req, res) => {
    const config = mergeConfig(readConfig(), req.body.config || req.body);
    const siteId = Number(config.esa.siteId);
    if (!siteId) {
      throw new Error('请先选择 ESA 站点');
    }
    const domain = normalizeDomain(req.body.domain);
    const target = normalizeDomain(req.body.target);
    if (!domain || !target) {
      throw new Error('缺少域名或回源目标');
    }
    const result = await enableEsaDomain(config, domain, target, req.body.remark || '');
    // 推送两条服务端日志：ESA 加速域名状态、Lucky DDNS CNAME 状态
    pushServerLog(
      'ESA 加速域名',
      result.esa?.existed ? 'ok' : 'ok',
      result.esa?.existed ? `${domain} ESA 加速域名已存在` : `${domain} ESA 加速域名已创建 -> ${result.cnameTarget}`,
    );
    const ddns = result.ddns || {};
    if (ddns.error) {
      pushServerLog('Lucky DDNS CNAME', 'error', `${domain} Lucky DDNS CNAME 失败：${ddns.error}`);
    } else if (ddns.added) {
      pushServerLog('Lucky DDNS CNAME', 'ok', `${domain} Lucky DDNS CNAME added -> ${result.cnameTarget}`);
    } else if (ddns.updated) {
      pushServerLog('Lucky DDNS CNAME', 'ok', `${domain} Lucky DDNS CNAME updated -> ${result.cnameTarget}`);
    } else {
      pushServerLog('Lucky DDNS CNAME', 'ok', `${domain} Lucky DDNS CNAME skipped（已存在且一致）`);
    }
    res.json({ ok: true, ...result });
  }),
);

// 部署状态机：cdn 域名健康检查通过 → live，超时 → failed
// 仅对 ESA 分支且 esaEnabled!==false 的应用触发；nas-only 应用跳过
// 编辑 ESA 加速域名记录（单条）：支持修改回源值/hostPolicy/proxied/ttl/sourceType/bizName
// ?dryRun=1 返回预览（不真改）
app.patch(
  '/api/esa/record/:recordId',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const recordId = Number(req.params.recordId);
    if (!Number.isInteger(recordId) || recordId <= 0) {
      throw new Error('缺少 recordId（recordId 必须是正整数）');
    }
    const dryRun = String(req.query.dryRun || '') === '1' || req.body?.dryRun === true;
    const body = req.body || {};
    // 允许的字段白名单 + 严格边界校验（拒绝 NaN/越界/非法枚举/空 value）
    const allowed = {};
    if ('value' in body) {
      const value = String(body.value).trim();
      if (!value) throw new Error('value 不能为空');
      allowed.data = { value };
    }
    if ('hostPolicy' in body) {
      const hostPolicy = String(body.hostPolicy || '');
      if (!['follow_origin_domain', 'follow_hostname', 'none'].includes(hostPolicy)) {
        throw new Error('hostPolicy 只能是 follow_origin_domain / follow_hostname / none');
      }
      allowed.hostPolicy = hostPolicy;
    }
    if ('proxied' in body) {
      const p = body.proxied;
      if (p !== true && p !== false && p !== 'true' && p !== 'false') {
        throw new Error('proxied 必须是 true/false');
      }
      allowed.proxied = p === true || p === 'true';
    }
    if ('ttl' in body) {
      const ttl = Number(body.ttl);
      // ESA 合法值：1（自动）或 30..86400 整数
      if (!Number.isInteger(ttl) || !(ttl === 1 || (ttl >= 30 && ttl <= 86400))) {
        throw new Error('ttl 必须是 1（自动）或 30~86400 的整数');
      }
      allowed.ttl = ttl;
    }
    if ('sourceType' in body) {
      const sourceType = String(body.sourceType || '');
      if (!['Domain', 'OSS', 'S3', 'LB', 'OP'].includes(sourceType)) {
        throw new Error('sourceType 只能是 Domain / OSS / S3 / LB / OP');
      }
      allowed.sourceType = sourceType;
    }
    if ('bizName' in body) {
      const bizName = String(body.bizName || '');
      if (!['web', 'video_image', 'api'].includes(bizName)) {
        throw new Error('bizName 只能是 web / video_image / api');
      }
      allowed.bizName = bizName;
    }
    if ('comment' in body) allowed.comment = String(body.comment);
    if (Object.keys(allowed).length === 0) {
      throw new Error('没有可编辑的字段（value/hostPolicy/proxied/ttl/sourceType/bizName/comment）');
    }
    allowed.recordId = recordId;
    // 先查当前值（用于返回 preview / 实际对比）
    const client = getEsaClient(config.esa);
    const siteId = Number(config.esa.siteId);
    if (!siteId) throw new Error('请先选择 ESA 站点');
    const currentList = await esaListDomains(client, siteId);
    const current = currentList.find((r) => Number(r.id) === recordId);
    if (!current) {
      return res.json({ ok: false, error: `未找到 recordId=${recordId} 对应的 ESA 记录`, dryRun });
    }
    // ESA 拒绝缺失 data 字段（CNAME 记录的 data.value 是回源地址，必须保留）
    if (!('data' in allowed) && current.value) {
      allowed.data = { value: current.value };
    }
    // CNAME 接入类型 ESA 强制 proxied=true；主动拒绝 false 避免报错 + 回滚
    if (current.type === 'CNAME' && 'proxied' in allowed && !allowed.proxied) {
      return res.json({
        ok: false,
        error: 'CNAME 接入类型 ESA 强制开启加速（proxied 必须为 true），无法关闭。如需彻底下线加速请删除该 ESA 记录（调用 DELETE /api/apps/:id?purge=1）',
        dryRun,
      });
    }
    const before = {
      recordId,
      name: current.name,
      type: current.type,
      value: current.value,
      recordCname: current.recordCname || '',
      proxied: !!current.proxied,
      hostPolicy: current.hostPolicy || '',
      ttl: current.ttl,
      sourceType: current.sourceType || '',
      bizName: current.bizName || '',
      comment: current.comment || '',
    };
    const after = {
      ...before,
      ...(allowed.data ? { value: allowed.data.value } : {}),
      ...('hostPolicy' in allowed ? { hostPolicy: allowed.hostPolicy } : {}),
      ...('proxied' in allowed ? { proxied: allowed.proxied } : {}),
      ...('ttl' in allowed ? { ttl: allowed.ttl } : {}),
      ...('sourceType' in allowed ? { sourceType: allowed.sourceType } : {}),
      ...('bizName' in allowed ? { bizName: allowed.bizName } : {}),
    };
    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        before,
        after,
        message: 'dryRun 模式：以下变更将发生；不带 dryRun=1 才会真正执行',
      });
    }
    const request = new UpdateRecordRequest(allowed);
    await client.updateRecord(request);
    // 重新拉取确认
    const refreshed = await esaListDomains(client, siteId);
    const afterPut = refreshed.find((r) => Number(r.id) === recordId) || current;
    res.json({
      ok: true,
      before,
      after: {
        recordId,
        name: afterPut.name,
        type: afterPut.type,
        value: afterPut.value,
        recordCname: afterPut.recordCname || '',
        proxied: !!afterPut.proxied,
        hostPolicy: afterPut.hostPolicy || '',
        ttl: afterPut.ttl,
        sourceType: afterPut.sourceType || '',
        bizName: afterPut.bizName || '',
        comment: afterPut.comment || '',
      },
      message: 'ESA 记录已更新',
    });
  }),
);

// 删除单条 ESA 加速域名记录（保留应用，仅删加速域名）
// ?purgeDdns=1 连带删除 Lucky DDNS 任务中对应的 .cdn CNAME 记录
// ?dryRun=1 预览待删项
app.delete(
  '/api/esa/record/:recordId',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const recordId = Number(req.params.recordId);
    if (!Number.isInteger(recordId) || recordId <= 0) {
      throw new Error('缺少 recordId（recordId 必须是正整数）');
    }
    const purgeDdns = String(req.query.purgeDdns || '') === '1';
    const dryRun = String(req.query.dryRun || '') === '1';

    const client = getEsaClient(config.esa);
    const siteId = Number(config.esa.siteId);
    if (!siteId) throw new Error('请先选择 ESA 站点');
    const currentList = await esaListDomains(client, siteId);
    const current = currentList.find((r) => Number(r.id) === recordId);
    if (!current) {
      return res.json({ ok: false, error: `未找到 recordId=${recordId} 对应的 ESA 记录`, dryRun });
    }

    const plan = {
      recordId,
      name: current.name,
      type: current.type,
      value: current.value,
      recordCname: current.recordCname || '',
      purgeDdns,
    };

    // 关联的 DDNS CNAME 子域（如 aiusage.cdn）。dryRun 时无条件暴露给前端询问是否连带删除；
    // 实际连带删除只在 purgeDdns=1 时执行，且 ESA-only 语义只清 CNAME，绝不动 nas AAAA。
    let ddnsRoot = '';
    let ddnsTargets = [];
    if (current.name) {
      const m = current.name.match(/^(.+)\.cdn\.(.+)$/);
      if (m) {
        ddnsRoot = normalizeDomain(m[2]);
        plan.ddnsSub = `${m[1]}.cdn`;
      } else {
        plan.ddnsSub = null;
      }
    }
    if (purgeDdns && ddnsRoot && plan.ddnsSub) {
      ddnsTargets = [{ sub: plan.ddnsSub, type: 'CNAME' }];
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        willRemove: plan,
        message: `dryRun 模式：将删除 ESA 加速域名 ${current.name}${ddnsTargets.length ? ` + DDNS CNAME ${ddnsTargets[0].sub}` : ''}；不带 dryRun=1 才会真正执行`,
      });
    }

    const logs = [];
    // 先清理 DDNS，再删除 ESA：DDNS 失败则中止并保留 ESA 记录，
    // 原 recordId 仍可查得 → 同一请求重试即可补齐；ESA 删除失败同理可重试。
    let ddnsRemoved = 0;
    if (purgeDdns && ddnsTargets.length) {
      if (!(config.lucky.openToken || (config.lucky.account && config.lucky.password))) {
        return res.json({
          ok: false,
          deleted: false,
          error: '无法连带清理 DDNS：未配置 Lucky 凭据。ESA 记录已保留，配置凭据后可重试',
          purgeDdns,
          dryRun,
        });
      }
      try {
        const ddnsResult = await deleteDdnsRecords(config, ddnsRoot, ddnsTargets);
        ddnsRemoved = ddnsResult.count;
        logs.push({
          step: 'Lucky DDNS CNAME',
          status: ddnsResult.count ? 'ok' : 'warn',
          detail: ddnsResult.count ? `已删除 ${ddnsTargets[0].sub} CNAME` : `未找到 ${ddnsTargets[0].sub} 记录`,
        });
      } catch (error) {
        return res.json({
          ok: false,
          deleted: false,
          error: `DDNS 清理失败，ESA 记录已保留（可重试）: ${error.message}`,
          purgeDdns,
          dryRun,
          ddnsRemoved,
          logs,
        });
      }
    }

    let esaDeleted = false;
    try {
      // 按 recordId 删除并重试（避免按 name 重试时误删同名其他类型记录）
      const result = await disableEsaDomain(config, current.name, { recordId: current.id });
      esaDeleted = !!result.deleted;
      logs.push({
        step: 'ESA 加速域名',
        status: result.deleted ? 'ok' : 'warn',
        detail: result.deleted ? `已删除 ${current.name}` : `未删除 ${current.name}（${result.reason}）`,
      });
    } catch (error) {
      logs.push({ step: 'ESA 加速域名', status: 'error', detail: error.message });
    }

    for (const item of logs) pushServerLog(item.step, item.status, item.detail);
    const failed = logs.some((l) => l.status === 'error');
    res.json({
      ok: !failed,
      deleted: esaDeleted,
      purgeDdns,
      ddnsRemoved,
      logs,
      error: failed
        ? `部分失败：${logs.filter((l) => l.status === 'error').map((l) => `${l.step}: ${l.detail}`).join('；')}`
        : undefined,
      message: failed
        ? `部分失败：${logs.filter((l) => l.status === 'error').map((l) => `${l.step}: ${l.detail}`).join('；')}`
        : esaDeleted
          ? `已删除 ${current.name}${ddnsRemoved ? '（含 DDNS CNAME）' : ''}`
          : `未删除 ${current.name}（${(logs[0] || {}).detail || '未知原因'}）`,
    });
  }),
);

const LIVE_CHECK_INTERVAL_MS = 10000;
const LIVE_CHECK_MAX_ATTEMPTS = 30; // 5 分钟

const liveCheckState = new Map(); // appId -> { timer, attempts, lastUrl, lastError, lastCheckedAt }

function findAppById(config, appId) {
  return (config.apps || []).find((a) => a.id === appId) || null;
}

async function setAppStatus(appId, status, extras = {}) {
  const config = readConfig();
  const app = findAppById(config, appId);
  if (!app) return;
  const prev = app.status;
  app.status = status;
  if (extras.lastCheckedAt) app.lastCheckedAt = extras.lastCheckedAt;
  if (extras.lastError !== undefined) app.lastError = extras.lastError;
  if (extras.cdnUrl) app.cdnUrl = extras.cdnUrl;
  writeConfig(config);
  if (prev !== status) {
    pushServerLog(
      '应用状态',
      status === 'failed' ? 'error' : 'ok',
      `${app.name || app.prefix}：${prev || 'pending'} → ${status}${extras.lastError ? `（${extras.lastError}）` : ''}`,
    );
  }
}

// 启动后台轮询；setImmediate 触发一次后 timer 每 10s 重试
function scheduleLiveCheck(appId) {
  // 防重入：已有 timer 就续上，不重复启动
  const existing = liveCheckState.get(appId);
  if (existing && existing.timer) {
    return;
  }
  const state = existing || { timer: null, attempts: 0, lastUrl: '', lastError: '', lastCheckedAt: '' };
  liveCheckState.set(appId, state);
  const tick = async () => {
    state.attempts += 1;
    state.lastCheckedAt = new Date().toISOString();
    let config = readConfig();
    let app = findAppById(config, appId);
    if (!app) {
      // 应用被删：清掉 timer
      state.timer && clearTimeout(state.timer);
      liveCheckState.delete(appId);
      return;
    }
    const cdn = cdnDomainOf(app, config);
    if (!cdn || app.esaEnabled === false) {
      // 没有 cdn 域名 / 关闭 ESA：保持当前状态（多为 pending），不强行标 live
      await setAppStatus(appId, app.status === 'building' ? 'building' : app.status, { lastCheckedAt: state.lastCheckedAt });
      state.timer && clearTimeout(state.timer);
      liveCheckState.delete(appId);
      return;
    }
    state.lastUrl = `https://${cdn}`;
    const result = await probeUrl(state.lastUrl);
    state.lastError = result.ok ? '' : (result.error || `HTTP ${result.status}`);
    if (result.ok) {
      await setAppStatus(appId, 'live', { lastCheckedAt: state.lastCheckedAt, cdnUrl: state.lastUrl });
      state.timer && clearTimeout(state.timer);
      liveCheckState.delete(appId);
      return;
    }
    // 探测失败：记录 latest 错误，未超上限则继续
    await setAppStatus(appId, state.attempts >= LIVE_CHECK_MAX_ATTEMPTS ? 'failed' : 'building', {
      lastCheckedAt: state.lastCheckedAt,
      lastError: state.lastError,
      cdnUrl: state.lastUrl,
    });
    if (state.attempts >= LIVE_CHECK_MAX_ATTEMPTS) {
      state.timer && clearTimeout(state.timer);
      liveCheckState.delete(appId);
      return;
    }
    state.timer = setTimeout(tick, LIVE_CHECK_INTERVAL_MS);
  };
  // 立即跑一次
  tick();
}

// 应用状态查询：返回每个应用的 status + cdnUrl + lastError + lastCheckedAt
app.get(
  '/api/apps/status',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const items = (config.apps || []).map((app) => ({
      id: app.id,
      name: app.name || app.prefix,
      prefix: app.prefix,
      status: app.status || 'pending',
      cdnUrl: app.cdnUrl || (app.esaEnabled !== false ? `https://${cdnDomainOf(app, config)}` : ''),
      lastError: app.lastError || '',
      lastCheckedAt: app.lastCheckedAt || '',
    }));
    res.json({ ok: true, items });
  }),
);

// 手动重试：清掉旧 timer 重新探测
app.post(
  '/api/apps/status/recheck',
  asyncHandler(async (req, res) => {
    const appId = String(req.body?.appId || '');
    if (!appId) throw new Error('缺少 appId');
    const existing = liveCheckState.get(appId);
    if (existing && existing.timer) {
      clearTimeout(existing.timer);
    }
    liveCheckState.delete(appId);
    await setAppStatus(appId, 'building');
    scheduleLiveCheck(appId);
    res.json({ ok: true, message: '已重新探测' });
  }),
);

// 应用连通性自检：仅探测 cdn 域名可达性。
// nas.*子域是局域网域名（指向 Lucky 反代），从面板所在环境探测无意义（外网不通/内网恒通），
// 故不探测，仅展示 cdn 公网加速域名的健康度。
app.get(
  '/api/apps/health',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const apps = (config.apps || []).filter((a) => a.prefix);
    const results = await Promise.all(
      apps.map(async (app) => {
        const cdn = cdnDomainOf(app, config);
        const checks = [];
        if (cdn && app.esaEnabled !== false) {
          checks.push({ label: 'cdn', url: `https://${cdn}`, ...(await probeUrl(`https://${cdn}`)) });
        }
        return { id: app.id, name: app.name || app.prefix, prefix: app.prefix, group: app.group || '', checks };
      }),
    );
    appendHealthHistory(results, new Date().toISOString());
    res.json({ ok: true, results, checkedAt: new Date().toISOString() });
  }),
);

app.get(
  '/api/health/history',
  asyncHandler(async (req, res) => {
    const data = readHealthHistory();
    res.json({ ok: true, series: data.series || {}, maxPoints: HEALTH_H_MAX_POINTS });
  }),
);

// 端口冲突预检：列出 Lucky 规则中重复监听端口 + 网关端口占用
app.get(
  '/api/precheck/ports',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const { rules } = await getLuckyRules(config);
    const map = new Map();
    for (const rule of rules || []) {
      const key = `${rule.ListenPort || '?'}/${rule.Network || '?'}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(rule.RuleName || '未命名');
    }
    const conflicts = [...map.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([key, names]) => ({ listen: key, rules: [...new Set(names)] }));
    const gatewayPort = Number(config.gateway.listenPort) || 8443;
    const gatewayClash = (rules || [])
      .filter(
        (r) =>
          Number(r.ListenPort) === gatewayPort &&
          r.RuleName !== GATEWAY_RULE_NAME &&
          !(config.gateway.ruleKey && r.RuleKey === config.gateway.ruleKey),
      )
      .map((r) => r.RuleName || '未命名');
    res.json({ ok: true, conflicts, gatewayClash, gatewayPort });
  }),
);

// 一键修复巡检差异：重查差异后按应用补齐 Lucky 子规则 / ESA 加速域名 + 回源规则
// purgeOrphans 默认 dryRun=1：返回将被删除的孤儿清单；要真删带 confirm="yes-i-am-sure"
app.post(
  '/api/audit/fix',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const logs = [];
    const targetAppId = req.body?.appId || null;
    const purgeOrphans = !!req.body?.purgeOrphans;
    const purgeOrphansDryRun = purgeOrphans && req.body?.confirm !== 'yes-i-am-sure';
    const rootDomain = String(config.esa?.rootDomain || '').toLowerCase();
    const { rules } = await getLuckyRules(config);
    const allProxies = (rules || []).flatMap((r) => r.ProxyList || []);
    // 收集面板 apps 期望的子规则 Key
    const managedKeys = new Set((config.apps || []).map((a) => managedProxyKey(a.id)));
    // 孤儿：Lucky 上存在但面板已已删除（无对应 app）的 lucky-esa-* 子规则
    const orphans = allProxies.filter((p) => isManagedProxyKey(p.Key) && !managedKeys.has(p.Key));
    if (purgeOrphansDryRun && orphans.length > 0) {
      return res.json({
        ok: true,
        dryRun: true,
        willRemove: orphans.map((o) => ({ key: o.Key, domains: o.Domains, locations: o.Locations })),
        message: `dryRun 模式：${orphans.length} 条孤儿将被删除。要真删请带 confirm="yes-i-am-sure"`,
      });
    }
    if (purgeOrphans && orphans.length > 0) {
      // 找出 Lucky 主规则（带 ProxyList 的那条），从 ProxyList 里过滤掉孤儿，回写
      const gatewayPort = Number(config.gateway.listenPort) || 8443;
      const gatewayRule =
        rules.find(
          (r) =>
            (config.gateway.ruleKey && r.RuleKey === config.gateway.ruleKey) ||
            r.RuleName === GATEWAY_RULE_NAME ||
            Number(r.ListenPort) === gatewayPort,
        ) || null;
      if (gatewayRule) {
        const orphanKeys = orphans.map((o) => o.Key);
        const before = gatewayRule.ProxyList.length;
        gatewayRule.ProxyList = gatewayRule.ProxyList.filter((p) => !orphanKeys.includes(p.Key));
        try {
          const { baseUrl, token } = await luckyLogin(config);
          await luckyRequest(baseUrl, token, 'PUT', `/api/webservice/rule/${gatewayRule.RuleKey}`, gatewayRule);
          logs.push({
            step: '孤儿 Lucky 子规则',
            status: 'ok',
            detail: `已删除 ${orphanKeys.length} 条孤儿（${before} → ${gatewayRule.ProxyList.length}）：${orphanKeys.join(', ')}`,
          });
        } catch (error) {
          logs.push({ step: '孤儿 Lucky 子规则', status: 'error', detail: error.message });
        }
      } else {
        logs.push({ step: '孤儿 Lucky 子规则', status: 'warn', detail: '未找到 Lucky 主规则，无法清理' });
      }
    }
    // 立即把 orphan 处理日志刷到服务端环形缓冲（fixable 为 0 时不会走到下面 pushServerLog）
    for (const item of logs) pushServerLog(item.step, item.status, item.detail);

    let esaNames = new Set();
    if (config.esa?.siteId) {
      const client = getEsaClient(config.esa);
      esaNames = new Set((await esaListDomains(client, config.esa.siteId)).map((d) => d.name));
    }
    // 收集 Lucky DDNS 已存在的 .cdn CNAME 子域；用于判断 lucky-cname-missing
    let luckyCdnCnameSet = new Set();
    if (config.lucky?.baseUrl && (config.lucky?.openToken || (config.lucky?.account && config.lucky?.password))) {
      try {
        const tasks = await getLuckyDdnsTasks(config);
        for (const task of tasks || []) {
          for (const r of task.Records || []) {
            if (r.Type === 'CNAME' && String(r.SubDomain || '').endsWith('.cdn')) {
              luckyCdnCnameSet.add(String(r.SubDomain).toLowerCase());
            }
          }
        }
      } catch {}
    }
    const fixable = [];
    for (const app of config.apps || []) {
      if (targetAppId && app.id !== targetAppId) continue;
      const nas = nasDomainOf(app, config);
      const proxy = nas ? allProxies.find((p) => (p.Domains || []).includes(nas)) : null;
      const luckyNeedsFix = !!nas && (!proxy || proxy.Enable !== (app.luckyEnabled !== false));
      const cdn = `${app.prefix}.cdn.${rootDomain}`.toLowerCase();
      const cdnSub = `${app.prefix}.cdn`.toLowerCase();
      const esaEnabled = app.esaEnabled !== false && !!config.esa?.siteId && !!rootDomain;
      const esaMissing = esaEnabled && !esaNames.has(cdn);
      const cnameMissing = esaEnabled && !luckyCdnCnameSet.has(cdnSub);
      // 任何 ESA 维度（加速域名缺失 或 Lucky CNAME 缺失）都触发幂等 enableEsaDomain
      const esaNeedsFix = esaEnabled && (esaMissing || cnameMissing);
      if (luckyNeedsFix || esaNeedsFix) {
        fixable.push({ app, luckyNeedsFix, esaNeedsFix, esaMissing, cnameMissing });
      }
    }
    if (fixable.length === 0) {
      return res.json({ ok: true, fixed: [], errors: [], logs: [], message: '未发现可修复的差异' });
    }
    const fixed = [];
    const errors = [];
    for (const { app, luckyNeedsFix, esaNeedsFix } of fixable) {
      const label = app.name || app.prefix;
      try {
        if (luckyNeedsFix) {
          await applyLucky(config, logs, app.id);
        }
        if (esaNeedsFix) {
          const nas = nasDomainOf(app, config);
          const cdn = `${app.prefix}.cdn.${rootDomain}`.toLowerCase();
          const r = await enableEsaDomain(config, cdn, nas, `面板修复 ${label}`);
          logs.push({ step: '修复 ESA', status: 'ok', detail: r.message });
        }
        fixed.push(label);
      } catch (error) {
        errors.push({ app: label, message: error.message });
        logs.push({ step: '修复', status: 'error', detail: `${label}: ${error.message}` });
      }
    }
    for (const item of logs) {
      pushServerLog(item.step, item.status, item.detail);
    }
    res.json({ ok: true, fixed, errors, logs, message: fixed.length ? `已修复 ${fixed.join('、')}` : '修复未完成' });
  }),
);

// 删除应用：config 移除 + Lucky 子规则同步删除（lucky-esa-<id>）+ 重 PUT 主规则。
// ESA 加速域名保留不删（用户可能还想用），DDNS CNAME 保留不删（同理）。
// 热更单应用字段（prefix/target/name/group/认证/开关）：写 config 后立即部署该 app
// query ?migrate=1 同时把旧 prefix 的 ESA 加速域名 + DDNS CNAME 也迁过去（默认丢弃旧域名）
app.patch(
  '/api/apps/:id',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const appId = String(req.params.id || '');
    const migrate = String(req.query.migrate || '') === '1';
    const preview = String(req.query.preview || '') === '1' || req.body?.preview === true;
    const idx = (config.apps || []).findIndex((a) => a.id === appId);
    if (idx < 0) throw new Error(`找不到应用: ${appId}`);
    const app = config.apps[idx];
    const before = { ...app };
    const editable = ['name', 'prefix', 'target', 'group', 'luckyEnabled', 'esaEnabled', 'webAuth'];
    for (const k of editable) {
      if (k in (req.body || {})) {
        if (k === 'prefix') {
          app.prefix = normalizeDomain(req.body.prefix);
        } else if (k === 'target') {
          app.target = normalizeTarget(req.body.target);
        } else if (k === 'luckyEnabled' || k === 'esaEnabled') {
          app[k] = !!req.body[k];
        } else if (k === 'webAuth') {
          app.webAuth = !!req.body.webAuth;
        } else {
          app[k] = req.body[k];
        }
      }
    }
    validateLuckySelfReference(app, config);
    if (preview) {
      const plan = {
        before,
        after: { ...app },
        changed: Object.keys(req.body || {}).filter((k) => editable.includes(k) && before[k] !== app[k]),
        willDeleteOldCdn: before.prefix !== app.prefix && !!before.prefix && !!config.esa?.siteId,
        willDeleteOldDdnsCname: before.prefix !== app.prefix && !!before.prefix,
        willDeploy: !!(app.luckyEnabled !== false || (app.esaEnabled !== false && config.esa?.siteId)),
        message: 'preview 模式：以下变更将发生；不带 preview=1 才会真正执行',
      };
      return res.json({ ok: true, preview: true, plan });
    }
    config.apps[idx] = app;
    writeConfig(config);

    const logs = [];
    // 仅当 prefix/target 实际变更时迁移
    const prefixChanged = before.prefix !== app.prefix;
    if (prefixChanged && !migrate) {
      // 默认：丢弃旧 prefix 的 ESA 域名 + DDNS CNAME，避免残留
      if (before.prefix && config.esa?.siteId && config.esa?.rootDomain) {
        const oldCdn = `${before.prefix}.cdn.${config.esa.rootDomain}`.toLowerCase();
        try {
          const r = await disableEsaDomain(config, oldCdn);
          logs.push({
            step: 'ESA 旧域名',
            status: r.deleted ? 'ok' : 'warn',
            detail: r.deleted ? `已删除旧 ESA 域名 ${oldCdn}` : `未删除 ${oldCdn}（${r.reason}）`,
          });
        } catch (error) {
          logs.push({ step: 'ESA 旧域名', status: 'error', detail: error.message });
        }
      }
      if (before.prefix && config.esa?.rootDomain) {
        try {
          const tasks = await getLuckyDdnsTasks(config);
          const target = tasks.find((t) => ((t.DNS || {}).Name || '') === 'alidns') || tasks[0];
          if (target) {
            const { baseUrl, token } = await luckyLogin(config);
            const detail = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${target.TaskKey}`);
            const task = detail.task || detail.data;
            const before2 = (task.Records || []).length;
            const oldSub = `${before.prefix}.cdn`;
            task.Records = (task.Records || []).filter((r) => {
              const sd = (r.SyncRecordData && r.SyncRecordData.SubDomainName) || r.SubDomain || '';
              return String(sd).toLowerCase() !== oldSub.toLowerCase();
            });
            await luckyRequest(baseUrl, token, 'PUT', `/api/ddns?key=${target.TaskKey}`, task);
            logs.push({
              step: 'DDNS 旧 CNAME',
              status: task.Records.length < before2 ? 'ok' : 'warn',
              detail: task.Records.length < before2 ? `已删除 ${oldSub}` : `未找到 ${oldSub}`,
            });
          }
        } catch (error) {
          logs.push({ step: 'DDNS 旧 CNAME', status: 'error', detail: error.message });
        }
      }
    }

    // 单应用 deploy（lucky + esa 二选一根据开关）
    const parts = [];
    if (app.luckyEnabled !== false) parts.push('lucky');
    if (app.esaEnabled !== false && config.esa?.siteId) parts.push('esa');
    if (parts.length > 0) {
      try {
        await deploy(config, app.id, parts, logs);
      } catch (error) {
        logs.push({ step: '部署', status: 'error', detail: error.message });
      }
    }

    for (const item of logs) pushServerLog(item.step, item.status, item.detail);
    res.json({
      ok: true,
      before,
      app,
      logs,
      config: sanitizeConfig(config),
      message: `应用 ${app.prefix} 已更新` + (logs.some((l) => l.status === 'error') ? '（部分失败）' : ''),
    });
  }),
);

app.delete(
  '/api/apps/:id',
  asyncHandler(async (req, res) => {
    const config = readConfig();
    const appId = String(req.params.id || '');
    const purge = String(req.query.purge || '') === '1';
    const dryRun = String(req.query.dryRun || '') === '1' || req.body?.dryRun === true;
    const confirm = String(req.query.confirm || '') === String(appId) || req.body?.confirm === String(appId);
    const idx = (config.apps || []).findIndex((a) => a.id === appId);
    if (idx < 0) throw new Error(`找不到应用: ${appId}`);
    const removed = config.apps[idx];
    // purge 时将要精确删除的 DDNS 记录（root+sub+type 匹配，预览与实际删除用同一份目标）
    const ddnsPurgeTargets = (prefix, rootDomain) => {
      if (!prefix || !rootDomain) return [];
      const root = normalizeDomain(rootDomain);
      return [
        { sub: `${prefix}.cdn`, type: 'CNAME' },
        { sub: `${prefix}.nas`, type: 'AAAA' },
      ];
    };
    // dryRun：返回将被删除的 Lucky 子规则 / ESA 加速域名 / DDNS 记录，但不执行
    if (dryRun) {
      const plan = { appId, prefix: removed.prefix, name: removed.name, willRemove: { luckySubRule: null, esaDomain: null, ddnsRecord: null }, purge, confirmRequired: true };
      try {
        const { rules } = await getLuckyRules(config);
        const gatewayPort = Number(config.gateway.listenPort) || 8443;
        const existing = rules.find((r) => (config.gateway.ruleKey && r.RuleKey === config.gateway.ruleKey) || r.RuleName === GATEWAY_RULE_NAME || Number(r.ListenPort) === gatewayPort);
        if (existing) {
          const proxy = (existing.ProxyList || []).find((p) => p.Key === managedProxyKey(appId));
          if (proxy) plan.willRemove.luckySubRule = { key: proxy.Key, domains: proxy.Domains, locations: proxy.Locations };
        }
      } catch (error) { plan.luckyLookupError = error.message; }
      if (purge && removed.esaEnabled !== false && config.esa?.siteId && config.esa?.rootDomain && removed.prefix) {
        const cdn = `${removed.prefix}.cdn.${config.esa.rootDomain}`.toLowerCase();
        plan.willRemove.esaDomain = cdn;
      }
      if (purge) {
        const targets = ddnsPurgeTargets(removed.prefix, config.esa?.rootDomain);
        if (targets.length) {
          plan.willRemove.ddnsRecord = targets.map((t) => `${t.sub} (${t.type})`).join(' + ');
        }
      }
      plan.confirmToken = appId;
      plan.message = `dryRun 模式：以下条目将被删除。要继续，请带 confirm=${appId}`;
      return res.json({ ok: true, dryRun: true, plan });
    }
    if (!confirm) {
      throw new Error(`删除操作是破坏性的，必须带 confirm=${appId} 参数（或 dryRun=1 先预览）`);
    }
    const logs = [];

    let luckyRemoved = false;
    try {
      const { rules } = await getLuckyRules(config);
      const gatewayPort = Number(config.gateway.listenPort) || 8443;
      const existing =
        rules.find(
          (r) =>
            (config.gateway.ruleKey && r.RuleKey === config.gateway.ruleKey) ||
            r.RuleName === GATEWAY_RULE_NAME ||
            Number(r.ListenPort) === gatewayPort,
        ) || null;
      if (existing && (existing.ProxyList || []).some((p) => p.Key === managedProxyKey(appId))) {
        const before = existing.ProxyList.length;
        existing.ProxyList = existing.ProxyList.filter((p) => p.Key !== managedProxyKey(appId));
        const { baseUrl, token } = await luckyLogin(config);
        await luckyRequest(baseUrl, token, 'PUT', `/api/webservice/rule/${existing.RuleKey}`, existing);
        luckyRemoved = true;
        logs.push({ step: 'Lucky 子规则', status: 'ok', detail: `已删除 ${managedProxyKey(appId)}（${before} → ${existing.ProxyList.length}）` });
      } else {
        logs.push({ step: 'Lucky 子规则', status: 'ok', detail: 'Lucky 上未发现该子规则（无需删除）' });
      }
    } catch (error) {
      // Lucky 删除失败：仅警告，不阻断——配置层删除后 deploy 会重新同步
      logs.push({ step: 'Lucky 子规则', status: 'warn', detail: `Lucky 子规则删除失败：${error.message}。可手动 deploy 重新同步` });
    }

    let esaRemoved = false;
    let ddnsRemoved = false;
    if (purge) {
      // ESA 加速域名删除
      if (removed.esaEnabled !== false && config.esa?.siteId && config.esa?.rootDomain && removed.prefix) {
        try {
          const cdn = `${removed.prefix}.cdn.${config.esa.rootDomain}`.toLowerCase();
          const r = await disableEsaDomain(config, cdn);
          esaRemoved = !!r.deleted;
          logs.push({
            step: 'ESA 加速域名',
            status: r.deleted ? 'ok' : 'warn',
            detail: r.deleted ? `已删除 ${cdn}` : `未删除 ${cdn}（${r.reason}）`,
          });
        } catch (error) {
          logs.push({ step: 'ESA 加速域名', status: 'error', detail: error.message });
        }
      }
      // DDNS 记录删除：精确匹配 root+sub+type（复用 deleteDdnsRecords / recordMatches）
      const targets = ddnsPurgeTargets(removed.prefix, config.esa?.rootDomain);
      if (targets.length && (config.lucky.openToken || (config.lucky.account && config.lucky.password))) {
        try {
          const ddnsResult = await deleteDdnsRecords(config, normalizeDomain(config.esa.rootDomain), targets);
          ddnsRemoved = ddnsResult.count > 0;
          logs.push({
            step: 'Lucky DDNS',
            status: ddnsResult.count ? 'ok' : 'warn',
            detail: ddnsResult.count
              ? `已删除 ${targets.map((t) => `${t.sub} (${t.type})`).join(' / ')}`
              : `未找到 ${targets.map((t) => t.sub).join(' / ')} 记录`,
          });
        } catch (error) {
          logs.push({ step: 'Lucky DDNS', status: 'error', detail: error.message });
        }
      }
    }

    // purge 清理失败：保留应用配置以便重试（不 splice、不写盘）；Lucky warn 不算失败
    const purgeFailed = logs.some((l) => l.status === 'error');
    if (purgeFailed) {
      for (const item of logs) pushServerLog(item.step, item.status, item.detail);
      const errorMsg =
        `清理失败，应用「${removed.prefix || removed.name}」配置已保留，可修复后重试。` +
        logs.filter((l) => l.status === 'error').map((l) => `${l.step}: ${l.detail}`).join('；');
      res.status(500).json({
        ok: false,
        retained: true,
        appId,
        logs,
        config: sanitizeConfig(config),
        error: errorMsg,
        message: errorMsg,
      });
      return;
    }

    // 重新读取最新配置再移除该应用：避免在异步清理期间其他编辑被旧快照整体覆盖
    const latest = readConfig();
    const latestIdx = (latest.apps || []).findIndex((a) => a.id === appId);
    if (latestIdx >= 0) {
      latest.apps.splice(latestIdx, 1);
      writeConfig(latest);
    }
    for (const item of logs) pushServerLog(item.step, item.status, item.detail);
    res.json({
      ok: true,
      removed: { id: appId, prefix: removed.prefix, name: removed.name },
      luckyRemoved,
      esaRemoved,
      ddnsRemoved,
      purge,
      logs,
      config: sanitizeConfig(config),
      message: `应用 ${removed.prefix || removed.name} 已删除` +
        (luckyRemoved ? '（含 Lucky 子规则）' : '') +
        (purge && esaRemoved ? ' + ESA 加速域名' : '') +
        (purge && ddnsRemoved ? ' + DDNS 记录' : ''),
    });
  }),
);

const port = Number(process.env.PORT) || 8787;
const host = process.env.HOST || '0.0.0.0';
if (require.main === module) {
  app.listen(port, host, () => {
    console.log(`Lucky ESA panel listening on http://${host}:${port}`);
  });
}

module.exports = {
  defaultConfig,
  mergeConfig,
  sanitizeConfig,
  readConfig,
  writeConfig,
  normalizeApp,
  normalizeDomain,
  normalizeTarget,
  normalizeBaseUrl,
  normalizeApiPrefix,
  luckyApiBase,
  buildLuckyRule,
  buildLuckyProxy,
  validateDeployConfig,
  validateLuckySelfReference,
  certificateCoversDomain,
  findEsaDdnsTask,
  findDdnsTaskByType,
  recordMatchesCname,
  recordMatches,
  readRecordDetail,
  readRecordContent,
  generateRecordKey,
  addDdnsRecord,
  addDdnsCnameRecord,
  addDdnsAaaaRecord,
  disableEsaDomain,
  deleteDdnsRecords,
  scheduleLiveCheck,
  setAppStatus,
  liveCheckState,
  app,
};
