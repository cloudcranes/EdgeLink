// 健康检查：连通性探测、状态机持久化、DoH 公网解析。
// 依赖：node:fs、node:path、./constants（HEALTH_H_MAX_POINTS / DOH_CACHE_TTL_MS）。
// 模块级单例：health-history Map、dohCache Map、dohInFlight Promise、liveCheckState Map。
//
// 包含路由不直接实现：路由 handler 由 routes/health.js 实现（在 Step 9 拆分）。
// 本文件提供 handler 调用的所有逻辑函数 + 状态。

const fs = require('fs');
const path = require('path');
const { HEALTH_H_MAX_POINTS, DOH_CACHE_TTL_MS } = require('./constants');

// 连通性自检历史持久化文件路径（按项目布局写到 data/health-history.json）
const HEALTH_HISTORY_FILE = path.join(__dirname, '..', 'data', 'health-history.json');

// 模块级状态
const liveCheckState = new Map(); // appId -> { timer, attempts, lastUrl, lastError, lastCheckedAt }
const dohCache = new Map(); // key: rootDomain -> { at, payload }
let dohInFlight = null; // 去重并发请求：同一时刻只跑一次实际查询

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

// 简单 HEAD/GET 探测：仅看连通性 + 延迟 + 状态码，不解析 body
// 部分 CDN 对 HEAD 请求返回 4xx（尤其根路径），故 HEAD 非 ok 时回落 GET 再判。
async function probeUrl(url) {
  const startedAt = Date.now();
  // 让 LibreSSL/openssl 误判的 https 也按失败处理而不是抛错
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    if (response.ok) {
      return { ok: true, status: response.status, latency: Date.now() - startedAt };
    }
    // HEAD 非 ok：不直接判失败，回落 GET
  } catch {
    // HEAD 网络错误：回落 GET
  }
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    return { ok: response.ok, status: response.status, latency: Date.now() - startedAt };
  } catch (error2) {
    // 把 Node fetch 的 TypeError（fetch failed / ENOTFOUND / ECONNREFUSED 等）翻译成可读提示
    const cause = error2.cause;
    let msg;
    if (cause?.code === 'ENOTFOUND') {
      msg = `DNS 未解析：${new URL(url).host}（检查 ESA 加速域名是否已配置 CNAME）`;
    } else if (cause?.code === 'ECONNREFUSED') {
      msg = `连接被拒绝：${new URL(url).host}`;
    } else if (error2.name === 'AbortError') {
      msg = `探测超时（>8s）：${new URL(url).host}`;
    } else {
      msg = `探测失败：${cause?.code || error2.message || String(error2)}`;
    }
    return { ok: false, error: msg, latency: Date.now() - startedAt };
  }
}

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

// 应用 CDN 探测 URL：Lucky 自引用应用（prefix==='lucky'）的根路径无内容，
// 必须带面板 pathPrefix（如 /master）探测，否则根路径 404 会被误判为失败。
function cdnProbeUrl(app, config) {
  const { cdnDomainOf } = require('./normalize');
  const cdn = cdnDomainOf(app, config);
  if (!cdn) return '';
  let url = `https://${cdn}`;
  if (app && app.prefix === 'lucky') {
    const prefix = String((config && config.lucky && config.lucky.pathPrefix) || '').replace(/\/+$/, '');
    if (prefix) url += prefix;
  }
  return url;
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

// 应用状态机（部署后由 deploy 调用 → building；后台轮询收敛到 live/failed）
async function setAppStatus(appId, status, extras = {}) {
  const { readConfig, writeConfig } = require('./config');
  const config = readConfig();
  const app = (config.apps || []).find((a) => a.id === appId);
  if (!app) return;
  const prev = app.status;
  app.status = status;
  if (extras.lastCheckedAt) app.lastCheckedAt = extras.lastCheckedAt;
  if (extras.lastError !== undefined) app.lastError = extras.lastError;
  if (extras.cdnUrl) app.cdnUrl = extras.cdnUrl;
  writeConfig(config);
  if (prev !== status) {
    const { pushServerLog } = require('./logs');
    pushServerLog(
      '应用状态',
      status === 'failed' ? 'error' : 'ok',
      `${app.name || app.prefix}：${prev || 'pending'} → ${status}${extras.lastError ? `（${extras.lastError}）` : ''}`,
    );
  }
}

function scheduleLiveCheck(appId) {
  const existing = liveCheckState.get(appId);
  if (existing && existing.timer) return;
  const state = existing || { timer: null, attempts: 0, lastUrl: '', lastError: '', lastCheckedAt: '' };
  liveCheckState.set(appId, state);
  const tick = async () => {
    state.attempts += 1;
    state.lastCheckedAt = new Date().toISOString();
    const { readConfig } = require('./config');
    const config = readConfig();
    const app = (config.apps || []).find((a) => a.id === appId);
    if (!app) {
      state.timer && clearTimeout(state.timer);
      liveCheckState.delete(appId);
      return;
    }
    const url = cdnProbeUrl(app, config);
    if (!url || app.esaEnabled === false) {
      await setAppStatus(appId, app.status === 'building' ? 'building' : app.status, { lastCheckedAt: state.lastCheckedAt });
      state.timer && clearTimeout(state.timer);
      liveCheckState.delete(appId);
      return;
    }
    state.lastUrl = url;
    const result = await probeUrl(state.lastUrl);
    state.lastError = result.ok ? '' : (result.error || `HTTP ${result.status}`);
    if (result.ok) {
      await setAppStatus(appId, 'live', { lastCheckedAt: state.lastCheckedAt, cdnUrl: state.lastUrl, lastError: '' });
      state.timer && clearTimeout(state.timer);
      liveCheckState.delete(appId);
      return;
    }
    await setAppStatus(
      appId,
      state.attempts >= (require('./constants').LIVE_CHECK_MAX_ATTEMPTS || 30) ? 'failed' : 'building',
      { lastCheckedAt: state.lastCheckedAt, lastError: state.lastError },
    );
    if (state.attempts < (require('./constants').LIVE_CHECK_MAX_ATTEMPTS || 30)) {
      state.timer = setTimeout(tick, require('./constants').LIVE_CHECK_INTERVAL_MS || 10000);
    } else {
      state.timer && clearTimeout(state.timer);
      liveCheckState.delete(appId);
    }
  };
  state.timer = setTimeout(tick, require('./constants').LIVE_CHECK_INTERVAL_MS || 10000);
}

module.exports = {
  HEALTH_HISTORY_FILE,
  liveCheckState,
  dohCache,
  dohInFlight,
  readHealthHistory,
  writeHealthHistory,
  appendHealthHistory,
  probeUrl,
  cdnProbeUrl,
  dohLookup,
  pooled,
  setAppStatus,
  scheduleLiveCheck,
};
