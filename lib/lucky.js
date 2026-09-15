// Lucky HTTP API 客户端 + 反代规则构建。
// 依赖：./constants（PROXY_KEY_PREFIX）、./normalize（nasDomainOf、luckyApiBase、normalizeBaseUrl）。
// 模块级单例：内部函数互相调用，无全局状态。

const { PROXY_KEY_PREFIX } = require('./constants');
const {
  nasDomainOf,
  luckyApiBase,
  normalizeBaseUrl,
} = require('./normalize');

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

// 用于内部 luckyLogin 解析响应（与 server.js 原 readJsonResponse 等价）
async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回非 JSON (HTTP ${response.status}): ${text.slice(0, 120)}`);
  }
}

module.exports = {
  luckyLogin,
  luckyRequest,
  getLuckyRules,
  isManagedProxyKey,
  managedProxyKey,
  buildOtherParams,
  buildLuckyProxy,
  buildLuckyRule,
  keepExistingProxies,
};
