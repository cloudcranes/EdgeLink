// EdgeLink 全局常量：跨模块复用的字符串/数值/正则/集合。
// 不依赖任何 lib/；可被任意模块 require。

const GATEWAY_RULE_NAME = 'lucky-esa-gateway';
const PROXY_KEY_PREFIX = 'lucky-esa-';
const ESA_RULE_PREFIX = 'lucky-esa-';
const MASK = '********';

// 域名合法性校验：1-253 字符，每段 0-9 a-z A-Z -（首尾非 -），至少两级 TLD
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

// 配置备份保留份数
const CONFIG_BACKUP_LIMIT = 10;
// 配置快照保留份数
const SNAPSHOT_LIMIT = 10;
// 连通性历史每个应用每个 label 最多保留点数
const HEALTH_H_MAX_POINTS = 100;
// 连通性后台轮询周期 + 最大尝试次数（5 分钟）
const LIVE_CHECK_INTERVAL_MS = 10_000;
const LIVE_CHECK_MAX_ATTEMPTS = 30;
// DoH 缓存 TTL（避免 1.1.1.1 慢/限流时反复转圈）
const DOH_CACHE_TTL_MS = 60_000;

// 主题白名单（与 server.js PATCH /api/panel/theme 校验共享）
const PANEL_THEMES = new Set([
  'neon', 'aurora', 'brutal-sun', 'brutal-ocean', 'brutal-berry', 'terminal',
]);

// 服务端日志环形缓冲条数
const SERVER_LOG_LIMIT = 500;

module.exports = {
  GATEWAY_RULE_NAME,
  PROXY_KEY_PREFIX,
  ESA_RULE_PREFIX,
  MASK,
  DOMAIN_RE,
  CONFIG_BACKUP_LIMIT,
  SNAPSHOT_LIMIT,
  HEALTH_H_MAX_POINTS,
  LIVE_CHECK_INTERVAL_MS,
  LIVE_CHECK_MAX_ATTEMPTS,
  DOH_CACHE_TTL_MS,
  PANEL_THEMES,
  SERVER_LOG_LIMIT,
};
