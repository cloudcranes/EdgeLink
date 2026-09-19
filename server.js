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
// 业务模块（lib/）—— 单一职责；server.js 仅负责启动 + 路由注册
const {
  GATEWAY_RULE_NAME,
  PROXY_KEY_PREFIX,
  ESA_RULE_PREFIX,
  MASK,
  DOMAIN_RE,
  SNAPSHOT_LIMIT,
  HEALTH_H_MAX_POINTS,
  LIVE_CHECK_INTERVAL_MS,
  LIVE_CHECK_MAX_ATTEMPTS,
  DOH_CACHE_TTL_MS,
  PANEL_THEMES,
} = require('./lib/constants');

const {
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
} = require('./lib/normalize');

const config = require('./lib/config');
const {
  CONFIG_PATH,
  defaultConfig,
  readConfig,
  writeConfig,
  mergeConfig,
  sanitizeConfig,
} = config;


const logs = require('./lib/logs');
const { pushServerLog, subscribeLogClient, unsubscribeLogClient } = logs;

const snapshots = require('./lib/snapshots');
const { saveSnapshot, listSnapshots, loadSnapshot } = snapshots;

const lucky = require('./lib/lucky');
const {
  luckyLogin,
  luckyRequest,
  getLuckyRules,
  isManagedProxyKey,
  managedProxyKey,
  buildOtherParams,
  buildLuckyProxy,
  buildLuckyRule,
  keepExistingProxies,
} = lucky;

const esa = require('./lib/esa');
const {
  getEsaClient,
  esaErrorMessage,
  esaListSites,
  esaListOriginRules,
  extractEsaDomain,
  esaListDomains,
  esaListCertificates,
} = esa;

const alidns = require('./lib/alidns');
const { alidnsListRecords, alidnsDeleteRecord } = alidns;

const ddns = require('./lib/ddns');
const {
  getLuckyDdnsTasks,
  findEsaDdnsTask,
  findDdnsTaskByType,
  parseSyncRecord,
  readRecordDetail,
  recordMatches,
  readRecordContent,
  generateRecordKey,
  recordMatchesCname,
  addDdnsRecord,
  addDdnsCnameRecord,
  addDdnsAaaaRecord,
  findNasDdnsTask,
  hasNasDdnsRecords,
  createNasDdnsTask,
} = ddns;

const health = require('./lib/health');
const {
  HEALTH_HISTORY_FILE,
  liveCheckState,
  readHealthHistory,
  writeHealthHistory,
  appendHealthHistory,
  probeUrl,
  dohLookup,
  pooled,
  setAppStatus,
  scheduleLiveCheck,
} = health;

const deploy = require('./lib/deploy');
const {
  applyLucky,
  deploy: deployFn,
  disableEsaDomain,
  deleteDdnsRecords,
  enableEsaDomain,
} = deploy;







const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/lucide/dist/umd')));

// 访问口令（可选）：config.panel.token 非空时，/api/* 除 /api/health 外校验 X-Panel-Token
app.use('/api', require('./middleware/auth').apiAuth);

require('./routes/config').register(app);
require('./routes/panel').register(app);
require('./routes/snapshots').register(app);
require('./routes/summary').register(app);
require('./routes/status').register(app);
require('./routes/logs').register(app);
require('./routes/health').register(app);
require('./routes/maintenance').register(app);
require('./routes/lucky').register(app);
require('./routes/ddns').register(app);
require('./routes/esa').register(app);
require('./routes/audit').register(app);
require('./routes/apps').register(app);
require('./routes/diagnostics').register(app);

// 统一 JSON error 处理：放在所有路由注册之后，4 个参数签名 Express 才会识别为 error middleware。
// asyncHandler 已经把异常 next(err) 抛到这里；同步 throw 也被 express 直接转 next(err)。
app.use(require('./utils/http').errorMiddleware);

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
