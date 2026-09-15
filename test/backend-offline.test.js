// 离线行为测试：不触网、不改真实 config.json。
// 通过 LUCKY_ESA_CONFIG_PATH 把配置指向临时目录；Module._load 拦截两个阿里云 SDK；
// global.fetch 只 mock Lucky API（测试服务器自身的 HTTP 走真实 fetch）。
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucky-esa-test-'));
const CFG = path.join(tmpDir, 'config.json');
process.env.LUCKY_ESA_CONFIG_PATH = CFG;

// ---- 共享 mock 状态（每个测试 beforeEach 重置） ----
const state = {
  records: [],
  sites: [],
  originRules: [],
  certificates: [],
  tasks: [],
  taskDetailByKey: {},
  taskDetail: null,
  rules: [],
  deleteRecordImpl: null,
  calls: { deleteRecord: [], updateRecord: [], createRecord: [], ddnsPuts: [], rulePuts: [], listRecords: [], alidnsDelete: [] },
  fetchCalls: [],
};

class MockReq {
  constructor(opts = {}) {
    Object.assign(this, opts);
  }
}

class MockEsaClient {
  async listSites() {
    return { body: { sites: state.sites } };
  }
  async listOriginRules() {
    return { body: { configs: state.originRules } };
  }
  async listRecords() {
    state.calls.listRecords.push(1);
    return { body: { records: state.records } };
  }
  async listCertificates() {
    return { body: { result: state.certificates } };
  }
  async createRecord(req) {
    state.calls.createRecord.push(req);
    return { body: {} };
  }
  async updateRecord(req) {
    state.calls.updateRecord.push(req);
    return { body: {} };
  }
  async deleteRecord(req) {
    state.calls.deleteRecord.push(req);
    if (state.deleteRecordImpl) return state.deleteRecordImpl(req);
    return { body: {} };
  }
}

class MockAlidnsClient {
  async describeDomainRecords() {
    return { body: { domainRecords: { record: state.alidnsRecords || [] } } };
  }
  async deleteDomainRecord(req) {
    state.calls.alidnsDelete.push(req);
    return { body: {} };
  }
}

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@alicloud/esa20240910') {
    return {
      default: MockEsaClient,
      ListSitesRequest: MockReq,
      ListOriginRulesRequest: MockReq,
      ListRecordsRequest: MockReq,
      ListCertificatesRequest: MockReq,
      CreateRecordRequest: MockReq,
      UpdateRecordRequest: MockReq,
      DeleteRecordRequest: MockReq,
    };
  }
  if (request === '@alicloud/alidns20150109') {
    return {
      default: MockAlidnsClient,
      DescribeDomainRecordsRequest: MockReq,
      DeleteDomainRecordRequest: MockReq,
    };
  }
  return origLoad.apply(this, arguments);
};

const server = require('../server.js');

// ---- fetch mock：测试服务器自身请求走真实 fetch，其余当 Lucky API ----
let serverOrigin = null;
const realFetch = global.fetch;

async function mockFetch(url, opts = {}) {
  const u = new URL(String(url));
  if (serverOrigin && u.origin === serverOrigin) {
    return realFetch(url, opts);
  }
  const method = (opts.method || 'GET').toUpperCase();
  state.fetchCalls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : undefined });
  // Lucky 接口路径带 pathPrefix（如 /master/api/...），剥离出 /api/... 后再匹配
  const api = u.pathname.includes('/api') ? u.pathname.slice(u.pathname.indexOf('/api')) : u.pathname;
  let payload = { ret: 0 };
  if (api === '/api/info') {
    payload = { ret: 0 };
  } else if (api === '/api/ddnstasklist') {
    payload = { ret: 0, data: state.tasks };
  } else if (/^\/api\/ddns\/task\//.test(api)) {
    const key = decodeURIComponent(api.split('/').pop());
    payload = { ret: 0, task: state.taskDetailByKey[key] || state.taskDetail || { TaskKey: key, Records: [] } };
  } else if (api === '/api/ddns' && method === 'PUT') {
    if (state.ddnsPutFail) {
      return { status: 500, text: async () => JSON.stringify({ ret: 1, msg: 'Lucky 不可用' }) };
    }
    state.calls.ddnsPuts.push(JSON.parse(opts.body));
    payload = { ret: 0 };
  } else if (api === '/api/webservice/rules') {
    payload = { ret: 0, ruleList: state.rules };
  } else if (/^\/api\/webservice\/rule\//.test(api) && method === 'PUT') {
    state.calls.rulePuts.push(JSON.parse(opts.body));
    if (state.onRulePut) await state.onRulePut(JSON.parse(opts.body));
    payload = { ret: 0 };
  } else if (/^\/api\/login/.test(api)) {
    payload = { ret: 0, token: 'mock-token' };
  } else {
    payload = { ret: 0 };
  }
  return { status: 200, text: async () => JSON.stringify(payload) };
}

function testConfig() {
  return {
    lucky: {
      baseUrl: 'http://192.168.1.107:16601',
      pathPrefix: '/master',
      openToken: 'mock-token',
      account: '',
      password: '',
      publicIPv6: '',
      ddnsTasks: { ipv6: '', esa: '', other: '' },
    },
    esa: {
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      siteId: 123,
      siteName: 'test',
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
    panel: { token: '' },
    apps: [],
  };
}

function writeCfg(cfg) {
  fs.writeFileSync(CFG, JSON.stringify(cfg), 'utf8');
}

function writeCfgWithApp() {
  const cfg = testConfig();
  cfg.apps = [
    {
      id: 'app-1',
      prefix: 'app1',
      name: 'App One',
      target: 'http://192.168.1.50:8080',
      luckyEnabled: true,
      esaEnabled: true,
      webAuth: false,
      status: 'live',
    },
  ];
  writeCfg(cfg);
}

function setupDdnsFixtures() {
  state.tasks = [
    { TaskKey: 'T_IPV6', DNS: { Name: 'alidns', ID: 'id', Secret: 'sec' } },
    { TaskKey: 'T_ESA', DNS: { Name: 'alidns', ID: 'id', Secret: 'sec' } },
  ];
  state.taskDetailByKey = {
    T_IPV6: {
      TaskKey: 'T_IPV6',
      Name: 'IPv6 任务',
      Records: [
        { Key: 'k-nas', SyncRecordData: { type: 'AAAA', DomainName: 'alanmaster.top', SubDomainName: 'app1.nas', remark: '' } },
        { Key: 'k-nas-other', SyncRecordData: { type: 'AAAA', DomainName: 'alanmaster.top', SubDomainName: 'other.nas', remark: '' } },
      ],
    },
    T_ESA: {
      TaskKey: 'T_ESA',
      Name: 'ESA 任务',
      Records: [
        { Key: 'k-cdn', SyncRecordData: { type: 'CNAME', DomainName: 'alanmaster.top', SubDomainName: 'app1.cdn', CNAMEContent: 'app1.cdn.esa.com', remark: '' } },
        { Key: 'k-wrong-root', SyncRecordData: { type: 'CNAME', DomainName: 'wrongroot.com', SubDomainName: 'app1.cdn', CNAMEContent: 'x', remark: '' } },
        { Key: 'k-wrong-type', SyncRecordData: { type: 'TXT', DomainName: 'alanmaster.top', SubDomainName: 'app1.cdn', TXTContent: 'x', remark: '' } },
      ],
    },
  };
}

function setupCdnEsaRecord() {
  state.records = [
    {
      recordId: 9001,
      recordName: 'app1.cdn.alanmaster.top',
      recordType: 'CNAME',
      data: { value: 'app1.nas.alanmaster.top' },
      recordCname: 'app1.cdn.esa.com',
      proxied: true,
      hostPolicy: 'follow_origin_domain',
      ttl: 600,
      recordSourceType: 'Domain',
      bizName: 'web',
      comment: 'panel',
    },
  ];
}

let httpServer = null;
let baseUrl = '';

before(async () => {
  global.fetch = mockFetch;
  await new Promise((resolve) => {
    httpServer = server.app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
      serverOrigin = baseUrl;
      resolve();
    });
  });
});

after(() => new Promise((resolve) => httpServer.close(resolve)));

beforeEach(() => {
  Object.assign(state, {
    records: [],
    sites: [],
    originRules: [],
    certificates: [],
    tasks: [],
    taskDetailByKey: {},
    taskDetail: null,
    rules: [],
    deleteRecordImpl: null,
  });
  state.calls = {
    deleteRecord: [],
    updateRecord: [],
    createRecord: [],
    ddnsPuts: [],
    rulePuts: [],
    listRecords: [],
    alidnsDelete: [],
  };
  state.fetchCalls = [];
  state.ddnsPutFail = false;
  state.onRulePut = null;
  writeCfg(testConfig());
});

const http = (url, opts = {}) => fetch(`${baseUrl}${url}`, opts).then(async (r) => ({ status: r.status, data: await r.json() }));

// ---------- 配置安全 ----------

test('config.json 损坏时 readConfig 抛错并保留原文件（不静默回退默认值）', () => {
  fs.writeFileSync(CFG, '{ broken json', 'utf8');
  assert.throws(() => server.readConfig(), /解析失败/);
  assert.equal(fs.readFileSync(CFG, 'utf8'), '{ broken json');
  const backups = fs.readdirSync(tmpDir).filter((n) => n.includes('.corrupt-'));
  assert.ok(backups.length >= 1, '应有 corrupt 备份文件');
});

test('writeConfig 两次写入生成两个不同备份名（防同秒覆盖）', () => {
  writeCfg({ v: 1 });
  server.writeConfig({ v: 2 });
  server.writeConfig({ v: 3 });
  const backups = fs.readdirSync(tmpDir).filter((n) => n.includes('.backup-'));
  assert.equal(backups.length, 2);
  assert.notEqual(backups[0], backups[1]);
});

test('备份失败时 writeConfig 拒绝覆盖原配置', () => {
  writeCfg({ keep: true });
  const before = fs.readFileSync(CFG, 'utf8');
  mock.method(fs, 'copyFileSync', () => {
    throw new Error('disk full');
  });
  try {
    assert.throws(() => server.writeConfig({ keep: false }), /disk full/);
  } finally {
    mock.restoreAll();
  }
  assert.equal(fs.readFileSync(CFG, 'utf8'), before);
});

// ---------- ESA 记录编辑：严格校验 + 字段保留 ----------

test('PATCH 非法 recordId 被拒绝', async () => {
  const r = await http('/api/esa/record/abc', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x' }),
  });
  assert.equal(r.status, 500);
  assert.match(r.data.error, /缺少 recordId/);
});

test('PATCH recordId 不存在返回 ok:false', async () => {
  state.records = [{ recordId: 9001, recordName: 'a.cdn.alanmaster.top', recordType: 'CNAME', data: { value: 'v' }, proxied: true }];
  const r = await http('/api/esa/record/9999', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 300 }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /未找到 recordId/);
});

test('PATCH 严格校验 ttl/hostPolicy/proxied/value/sourceType/bizName', async () => {
  state.records = [
    {
      recordId: 9001,
      recordName: 'a.cdn.alanmaster.top',
      recordType: 'CNAME',
      data: { value: 'origin.local' },
      recordCname: 'a.esa.com',
      proxied: true,
      hostPolicy: 'follow_origin_domain',
      ttl: 600,
      recordSourceType: 'Domain',
      bizName: 'web',
    },
  ];
  const patch = (body) =>
    http('/api/esa/record/9001', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let d = await patch({ ttl: 0 });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /ttl 必须是/);
  d = await patch({ ttl: 2 });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /ttl 必须是/);
  d = await patch({ ttl: -5 });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /ttl/);
  d = await patch({ ttl: 'abc' });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /ttl/);
  d = await patch({ hostPolicy: 'bogus' });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /hostPolicy 只能是/);
  d = await patch({ proxied: 'banana' });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /proxied 必须是/);
  d = await patch({ value: '   ' });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /value 不能为空/);
  d = await patch({ sourceType: 'Weird' });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /sourceType 只能是/);
  d = await patch({ bizName: 'weird' });
  assert.equal(d.data.ok, false);
  assert.match(d.data.error, /bizName 只能是/);
});

test('PATCH 成功：只改 value，保留 hostPolicy/ttl/sourceType/bizName/comment', async () => {
  state.records = [
    {
      recordId: 9001,
      recordName: 'a.cdn.alanmaster.top',
      recordType: 'CNAME',
      data: { value: 'old.local' },
      recordCname: 'a.esa.com',
      proxied: true,
      hostPolicy: 'follow_hostname',
      ttl: 300,
      recordSourceType: 'Domain',
      bizName: 'api',
      comment: 'keep-me',
    },
  ];
  const r = await http('/api/esa/record/9001', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'new.local' }),
  });
  assert.equal(r.data.ok, true);
  assert.equal(state.calls.updateRecord.length, 1);
  assert.equal(state.calls.updateRecord[0].data.value, 'new.local');
  assert.equal(state.calls.updateRecord[0].recordId, 9001);
  assert.equal(r.data.after.hostPolicy, 'follow_hostname');
  assert.equal(r.data.after.ttl, 300);
  assert.equal(r.data.after.sourceType, 'Domain');
  assert.equal(r.data.after.bizName, 'api');
  assert.equal(r.data.after.comment, 'keep-me');
});

test('PATCH dryRun=1 返回 before/after 预览但不调用 updateRecord', async () => {
  state.records = [
    {
      recordId: 9001,
      recordName: 'a.cdn.alanmaster.top',
      recordType: 'CNAME',
      data: { value: 'old.local' },
      recordCname: 'a.esa.com',
      proxied: true,
      hostPolicy: 'follow_hostname',
      ttl: 300,
      recordSourceType: 'Domain',
      bizName: 'api',
      comment: 'keep-me',
    },
  ];
  const r = await http('/api/esa/record/9001?dryRun=1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'new.local' }),
  });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.before.value, 'old.local');
  assert.equal(r.data.after.value, 'new.local');
  assert.equal(r.data.after.hostPolicy, 'follow_hostname');
  assert.equal(r.data.after.ttl, 300);
  assert.equal(r.data.after.bizName, 'api');
  assert.equal(r.data.after.comment, 'keep-me');
  assert.equal(state.calls.updateRecord.length, 0, 'dryRun 不应真正调用 ESA');
});

test('PATCH 非 CNAME 记录可关 proxied（严格布尔解析 "false" 字符串）', async () => {
  state.records = [
    { recordId: 9002, recordName: 'a.alanmaster.top', recordType: 'A', data: { value: '1.2.3.4' }, proxied: true },
  ];
  const r = await http('/api/esa/record/9002', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxied: 'false' }),
  });
  assert.equal(r.data.ok, true);
  assert.equal(state.calls.updateRecord[0].proxied, false);
});

test('PATCH CNAME + proxied false 被拒绝（ESA 服务端限制）', async () => {
  state.records = [{ recordId: 9001, recordName: 'a.cdn.alanmaster.top', recordType: 'CNAME', data: { value: 'v' }, proxied: true }];
  const r = await http('/api/esa/record/9001', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxied: false }),
  });
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /proxied 必须为 true/);
});

test('GET /api/esa/rules domains 保留 hostPolicy/ttl/sourceType/bizName/comment', async () => {
  state.records = [
    {
      recordId: 9001,
      recordName: 'a.cdn.alanmaster.top',
      recordType: 'CNAME',
      data: { value: 'v' },
      recordCname: 'c',
      proxied: true,
      hostPolicy: 'follow_origin_domain',
      ttl: 600,
      recordSourceType: 'Domain',
      bizName: 'web',
      comment: 'hi',
    },
  ];
  const r = await http('/api/esa/rules');
  assert.equal(r.data.ok, true);
  assert.equal(r.data.domains[0].hostPolicy, 'follow_origin_domain');
  assert.equal(r.data.domains[0].ttl, 600);
  assert.equal(r.data.domains[0].sourceType, 'Domain');
  assert.equal(r.data.domains[0].bizName, 'web');
  assert.equal(r.data.domains[0].comment, 'hi');
});

// ---------- 记录删除：ESA-only 只清 CNAME，DDNS 精确匹配 ----------

test('DELETE /api/esa/record dryRun 无条件返回 ddnsSub（供前端询问连带删除）', async () => {
  setupCdnEsaRecord();
  const r = await http('/api/esa/record/9001?dryRun=1', { method: 'DELETE' });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.willRemove.ddnsSub, 'app1.cdn');
});

test('DELETE /api/esa/record/:id?purgeDdns=1 只删匹配的 .cdn CNAME，不删 nas AAAA，root+type 精确', async () => {
  setupCdnEsaRecord();
  setupDdnsFixtures();
  const r = await http('/api/esa/record/9001?purgeDdns=1', { method: 'DELETE' });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.deleted, true);
  // 按 recordId 删除：deleteRecord 收到 9001，且未再按 name 查找
  assert.equal(state.calls.deleteRecord[0].recordId, 9001);
  assert.equal(state.calls.listRecords.length, 1, '只应有一次列表查询（路由查找，删除走 recordId）');
  // 只改了 T_ESA 任务（app1.cdn CNAME），T_IPV6（nas AAAA）不动
  assert.equal(state.calls.ddnsPuts.length, 1);
  const keptKeys = state.calls.ddnsPuts[0].Records.map((x) => x.Key);
  assert.ok(!keptKeys.includes('k-cdn'), 'app1.cdn CNAME 应被删除');
  assert.ok(keptKeys.includes('k-wrong-root'), '不同根域不删');
  assert.ok(keptKeys.includes('k-wrong-type'), '不同类型不删');
});

test('ESA 删除失败时仍执行 DDNS 清理并报告部分失败', async () => {
  setupCdnEsaRecord();
  setupDdnsFixtures();
  state.deleteRecordImpl = async () => {
    throw new Error('ESA 服务端拒绝');
  };
  const r = await http('/api/esa/record/9001?purgeDdns=1', { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.deleted, false);
  assert.ok(state.calls.ddnsPuts.length >= 1, 'ESA 失败后 DDNS 仍应清理');
  const keptKeys = state.calls.ddnsPuts[0].Records.map((x) => x.Key);
  assert.ok(!keptKeys.includes('k-cdn'));
  assert.match(r.data.message, /部分失败/);
});

test('DDNS 清理失败时中止并保留 ESA 记录（同 recordId 可重试）', async () => {
  setupCdnEsaRecord();
  setupDdnsFixtures();
  state.ddnsPutFail = true;
  const r = await http('/api/esa/record/9001?purgeDdns=1', { method: 'DELETE' });
  assert.equal(r.data.ok, false);
  assert.equal(r.data.deleted, false, 'DDNS 失败时不得删除 ESA');
  assert.match(r.data.error, /已保留（可重试）/);
  // ESA 删除未被调用 → 记录仍在，重试可达
  assert.equal(state.calls.deleteRecord.length, 0);
});

test('purgeDdns=1 但未配置 Lucky 凭据：拒绝执行并保留 ESA 记录', async () => {
  setupCdnEsaRecord();
  // 清空 Lucky 凭据
  const cfg = testConfig();
  cfg.lucky.openToken = '';
  cfg.lucky.account = '';
  cfg.lucky.password = '';
  writeCfg(cfg);
  const r = await http('/api/esa/record/9001?purgeDdns=1', { method: 'DELETE' });
  assert.equal(r.data.ok, false);
  assert.equal(r.data.deleted, false);
  assert.match(r.data.error, /未配置 Lucky 凭据/);
  assert.equal(state.calls.deleteRecord.length, 0);
});

// ---------- disableEsaDomain 按 recordId 重试 ----------

test('disableEsaDomain 按 recordId 重试（busy→成功），不做 name 查找', async () => {
  let busy = 2;
  state.deleteRecordImpl = async () => {
    if (busy-- > 0) {
      throw new Error('ServiceBusy, please try again later');
    }
    return { body: {} };
  };
  state.calls.listRecords.length = 0;
  const result = await server.disableEsaDomain(testConfig(), 'app1.cdn.alanmaster.top', { recordId: 9001, retries: 3, delayMs: 1 });
  assert.equal(result.deleted, true);
  assert.equal(result.recordId, 9001);
  assert.equal(state.calls.deleteRecord.length, 3);
  assert.equal(state.calls.listRecords.length, 0, '传 recordId 时不应按 name 查找');
  for (const c of state.calls.deleteRecord) {
    assert.equal(c.recordId, 9001);
  }
});

// ---------- 应用删除：preview/actual 一致 + 清理失败保留配置 ----------

test('DELETE /api/apps/:id dryRun 预览列出 .cdn CNAME + .nas AAAA', async () => {
  writeCfgWithApp();
  state.rules = [
    {
      RuleKey: 'gw-rule',
      RuleName: 'lucky-esa-gateway',
      ListenPort: 8443,
      Network: 'tcp',
      ProxyList: [{ Key: 'lucky-esa-app-1', Domains: ['app1.nas.alanmaster.top'], Locations: ['/'], Enable: true }],
    },
  ];
  const r = await http('/api/apps/app-1?purge=1&dryRun=1', { method: 'DELETE' });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.dryRun, true);
  assert.equal(r.data.plan.willRemove.esaDomain, 'app1.cdn.alanmaster.top');
  assert.equal(r.data.plan.willRemove.ddnsRecord, 'app1.cdn (CNAME) + app1.nas (AAAA)');
  assert.equal(r.data.plan.willRemove.luckySubRule.key, 'lucky-esa-app-1');
});

test('DELETE /api/apps/:id?purge=1&confirm=app-1 精确删除 DDNS 记录并从 config 移除', async () => {
  writeCfgWithApp();
  setupDdnsFixtures();
  setupCdnEsaRecord();
  state.rules = [
    {
      RuleKey: 'gw-rule',
      RuleName: 'lucky-esa-gateway',
      ListenPort: 8443,
      Network: 'tcp',
      ProxyList: [{ Key: 'lucky-esa-app-1', Domains: ['app1.nas.alanmaster.top'], Locations: ['/'], Enable: true }],
    },
  ];
  const r = await http('/api/apps/app-1?purge=1&confirm=app-1', { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.luckyRemoved, true);
  assert.equal(r.data.esaRemoved, true);
  assert.equal(r.data.ddnsRemoved, true);
  // app1.cdn CNAME + app1.nas AAAA 都删，其他记录保留
  const keptKeys = new Set(state.calls.ddnsPuts.flatMap((b) => b.Records.map((x) => x.Key)));
  assert.ok(!keptKeys.has('k-cdn'));
  assert.ok(!keptKeys.has('k-nas'));
  assert.ok(keptKeys.has('k-wrong-root'));
  assert.ok(keptKeys.has('k-wrong-type'));
  assert.ok(keptKeys.has('k-nas-other'));
  // config 已移除 app
  const cfg = await http('/api/config');
  assert.equal(cfg.data.config.apps.length, 0);
});

test('purge 清理失败时保留应用配置（HTTP 500 + retained，前端可回滚）', async () => {
  writeCfgWithApp();
  setupDdnsFixtures();
  setupCdnEsaRecord();
  state.rules = [
    {
      RuleKey: 'gw-rule',
      RuleName: 'lucky-esa-gateway',
      ListenPort: 8443,
      Network: 'tcp',
      ProxyList: [{ Key: 'lucky-esa-app-1', Domains: ['app1.nas.alanmaster.top'], Locations: ['/'], Enable: true }],
    },
  ];
  state.deleteRecordImpl = async () => {
    throw new Error('ESA 删除超时');
  };
  const r = await http('/api/apps/app-1?purge=1&confirm=app-1', { method: 'DELETE' });
  assert.equal(r.status, 500);
  assert.equal(r.data.ok, false);
  assert.equal(r.data.retained, true);
  // app 仍在 config（可重试）
  const cfg = await http('/api/config');
  assert.equal(cfg.data.config.apps.length, 1);
  // DDNS 部分成功（ESA 失败但 DDNS 仍清理）
  assert.ok(state.calls.ddnsPuts.length >= 1);
});

test('非 purge 删除应用不执行 ESA/DDNS 清理，直接移除', async () => {
  writeCfgWithApp();
  const r = await http('/api/apps/app-1?confirm=app-1', { method: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.purge, false);
  assert.equal(state.calls.deleteRecord.length, 0);
  assert.equal(state.calls.ddnsPuts.length, 0);
  const cfg = await http('/api/config');
  assert.equal(cfg.data.config.apps.length, 0);
});

test('PATCH 应用 deploy 期间并发编辑不被旧快照覆盖', async () => {
  // 场景：PATCH 先落盘（name=First），随后 deploy 的异步窗口内另一请求改配置
  // （name=Concurrent Edit）。旧实现 deploy 结束时整体 writeConfig(旧快照) 会回滚并发编辑。
  writeCfgWithApp();
  // 只走 lucky 分支，避免 scheduleLiveCheck 触发真实网络探测
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  cfg.apps[0].esaEnabled = false;
  writeCfg(cfg);
  // 让 applyLucky 走 PUT 分支（已有网关规则），从而触发 onRulePut 钩子
  state.rules = [
    {
      RuleKey: 'gw-rule',
      RuleName: 'lucky-esa-gateway',
      ListenPort: 8443,
      Network: 'tcp',
      ProxyList: [],
    },
  ];
  state.onRulePut = async () => {
    const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    c.apps[0].name = 'Concurrent Edit';
    writeCfg(c);
  };
  const r = await http('/api/apps/app-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'First' }),
  });
  assert.equal(r.status, 200);
  const after = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  assert.equal(after.apps[0].name, 'Concurrent Edit', '并发编辑必须保留');
});
