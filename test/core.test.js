const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeConfig,
  normalizeTarget,
  normalizeApiPrefix,
  luckyApiBase,
  buildLuckyRule,
  validateDeployConfig,
  certificateCoversDomain,
  findEsaDdnsTask,
  recordMatchesCname,
  readRecordDetail,
  generateRecordKey,
} = require('../server.js');

function validConfig() {
  return {
    lucky: {
      baseUrl: 'http://127.0.0.1:16601',
      account: 'admin',
      password: 'secret',
    },
    esa: {
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      siteId: '123',
    },
    gateway: {
      listenIp: '::',
      listenPort: 8443,
      originScheme: 'http',
      enableTls: false,
      originVerify: false,
      originReadTimeout: 30,
    },
    apps: [
      {
        id: 'app1',
        name: '博客',
        externalDomain: 'blog.example.com',
        originDomain: 'home.example.com',
        originHostHeader: 'blog.example.com',
        target: '192.168.1.5:8080',
        enabled: true,
      },
    ],
  };
}

test('normalizeTarget adds scheme and keeps port', () => {
  assert.equal(normalizeTarget('192.168.1.5:8080'), 'http://192.168.1.5:8080');
  assert.equal(normalizeTarget('https://nas.local:9443/'), 'https://nas.local:9443');
});

test('lucky path prefix is normalized and joined to the base URL', () => {
  const config = validConfig();
  config.lucky.pathPrefix = 'safe-abc';
  assert.equal(normalizeApiPrefix('/safe-abc/'), '/safe-abc');
  assert.equal(normalizeApiPrefix(''), '');
  assert.equal(luckyApiBase(config), 'http://127.0.0.1:16601/safe-abc');
});

test('mergeConfig keeps masked secret and accepts new secret', () => {
  const existing = validConfig();
  const masked = mergeConfig(existing, { esa: { accessKeySecret: '********' } });
  assert.equal(masked.esa.accessKeySecret, 'sk');
  const replaced = mergeConfig(existing, { esa: { accessKeySecret: 'new-sk' } });
  assert.equal(replaced.esa.accessKeySecret, 'new-sk');
});

test('mergeConfig keeps masked OpenToken and accepts new one', () => {
  const existing = validConfig();
  existing.lucky.openToken = 'tok-1';
  const masked = mergeConfig(existing, { lucky: { openToken: '********' } });
  assert.equal(masked.lucky.openToken, 'tok-1');
  const replaced = mergeConfig(existing, { lucky: { openToken: 'tok-2' } });
  assert.equal(replaced.lucky.openToken, 'tok-2');
});

test('buildLuckyRule creates one managed proxy on the gateway port', () => {
  const config = validConfig();
  const proxy = buildLuckyProxyForTest(config.apps[0]);
  const rule = buildLuckyRule(config, [proxy], 'gateway-key');
  assert.equal(rule.RuleName, '');
  assert.equal(rule.Network, 'tcp6');
  assert.equal(rule.ListenPort, 8443);
  assert.equal(rule.Enable, true);
  assert.equal(rule.ProxyList[0].Key, 'lucky-esa-app1');
  assert.deepEqual(rule.ProxyList[0].Domains, ['blog.example.com']);
});

test('validateDeployConfig accepts valid config and rejects duplicate domains', () => {
  assert.doesNotThrow(() => validateDeployConfig(validConfig()));
  const duplicate = validConfig();
  duplicate.apps.push({ ...duplicate.apps[0], id: 'app2' });
  assert.throws(() => validateDeployConfig(duplicate), /外网域名不能重复/);
});

test('certificateCoversDomain matches exact and single-level wildcard only', () => {
  // 大小写归一
  assert.equal(certificateCoversDomain('Agent.Cdn.AlanMaster.Top', 'agent.cdn.alanmaster.top'), true);
  // 通配匹配单级子域
  assert.equal(certificateCoversDomain('*.cdn.alanmaster.top', 'agent.cdn.alanmaster.top'), true);
  // 通配不匹配多级子域
  assert.equal(certificateCoversDomain('*.cdn.alanmaster.top', 'a.b.cdn.alanmaster.top'), false);
  // 通配不匹配裸域
  assert.equal(certificateCoversDomain('*.cdn.alanmaster.top', 'cdn.alanmaster.top'), false);
  // 完全不相关
  assert.equal(certificateCoversDomain('*.example.com', 'agent.cdn.alanmaster.top'), false);
  // 精确不等于（san 不带 *）
  assert.equal(certificateCoversDomain('cdn.alanmaster.top', 'agent.cdn.alanmaster.top'), false);
  // 空输入
  assert.equal(certificateCoversDomain('', 'agent.cdn.alanmaster.top'), false);
  assert.equal(certificateCoversDomain('*.cdn.alanmaster.top', ''), false);
});

function buildLuckyProxyForTest(app) {
  return {
    Key: 'lucky-esa-' + app.id,
    Enable: app.enabled,
    Domains: [app.externalDomain],
    Locations: [app.target],
  };
}

// ---------- Lucky DDNS CNAME 写入相关纯函数 ----------

test('readRecordDetail parses both flat and nested record formats', () => {
  const flat = readRecordDetail({ Type: 'CNAME', SubDomain: 'agent.cdn', DomainName: 'alanmaster.top', CNAMEContent: 'x.a.com' });
  assert.equal(flat.type, 'CNAME');
  assert.equal(flat.subDomainName, 'agent.cdn');
  assert.equal(flat.domainName, 'alanmaster.top');
  assert.equal(flat.cnameContent, 'x.a.com');

  const nested = readRecordDetail({
    Key: 'abcd',
    SyncRecordData: {
      type: 'CNAME',
      SubDomainName: 'agent.cdn',
      DomainName: 'alanmaster.top',
      CNAMEContent: 'y.a.com',
      BizName: 'web',
      fullDomainName: 'agent.cdn.alanmaster.top',
      remark: 'note',
      ttl: 0,
      line: '',
    },
  });
  assert.equal(nested.type, 'CNAME');
  assert.equal(nested.subDomainName, 'agent.cdn');
  assert.equal(nested.domainName, 'alanmaster.top');
  assert.equal(nested.cnameContent, 'y.a.com');
  assert.equal(nested.bizName, 'web');
  assert.equal(nested.fullDomainName, 'agent.cdn.alanmaster.top');
});

test('recordMatchesCname matches only exact (sub, siteRoot) CNAME', () => {
  const hit = {
    Type: 'CNAME',
    SubDomain: 'agent.cdn',
    DomainName: 'alanmaster.top',
    CNAMEContent: 'x.a.com',
  };
  const otherSub = { ...hit, SubDomain: 'blog.cdn' };
  const otherDomain = { ...hit, DomainName: 'other.com' };
  const aaaa = { ...hit, Type: 'AAAA' };
  assert.equal(recordMatchesCname(hit, 'agent.cdn', 'alanmaster.top'), true);
  assert.equal(recordMatchesCname(otherSub, 'agent.cdn', 'alanmaster.top'), false);
  assert.equal(recordMatchesCname(otherDomain, 'agent.cdn', 'alanmaster.top'), false);
  assert.equal(recordMatchesCname(aaaa, 'agent.cdn', 'alanmaster.top'), false);
  // 嵌套结构同样命中
  const nested = {
    Key: 'k',
    SyncRecordData: {
      type: 'CNAME',
      SubDomainName: 'agent.cdn',
      DomainName: 'alanmaster.top',
      CNAMEContent: 'x.a.com',
    },
  };
  assert.equal(recordMatchesCname(nested, 'agent.cdn', 'alanmaster.top'), true);
});

test('findEsaDdnsTask priority: cdn CNAME > alidns+nas AAAA > any alidns', () => {
  const nasOnly = {
    TaskKey: 'k-nas',
    DNS: { Name: 'alidns' },
    Records: [
      { Type: 'AAAA', SubDomain: 'agent.nas', DomainName: 'alanmaster.top' },
      { Type: 'AAAA', SubDomain: 'ql.nas', DomainName: 'alanmaster.top' },
    ],
  };
  const cdnTask = {
    TaskKey: 'k-cdn',
    DNS: { Name: 'alidns' },
    Records: [
      { Type: 'CNAME', SubDomain: 'agent.cdn', DomainName: 'alanmaster.top', CNAMEContent: 'x.a.com' },
    ],
  };
  const alidnsNoNas = {
    TaskKey: 'k-other',
    DNS: { Name: 'alidns' },
    Records: [{ Type: 'A', SubDomain: 'home', DomainName: 'alanmaster.top' }],
  };
  const cloudflare = {
    TaskKey: 'k-cf',
    DNS: { Name: 'cloudflare' },
    Records: [{ Type: 'AAAA', SubDomain: 'agent.nas', DomainName: 'alanmaster.top' }],
  };

  // 1) 已存在 .cdn CNAME 的任务优先
  assert.equal(findEsaDdnsTask([nasOnly, cdnTask, cloudflare]).TaskKey, 'k-cdn');
  // 2) 含 .nas AAAA 的 alidns 任务次之
  assert.equal(findEsaDdnsTask([nasOnly, cloudflare, alidnsNoNas]).TaskKey, 'k-nas');
  // 3) 任意 alidns 任务兜底
  assert.equal(findEsaDdnsTask([cloudflare, alidnsNoNas]).TaskKey, 'k-other');
  // 没有 alidns 任务时为 null
  assert.equal(findEsaDdnsTask([cloudflare]), null);
  assert.equal(findEsaDdnsTask([]), null);
});

test('generateRecordKey returns 16-char base64url', () => {
  for (let i = 0; i < 5; i += 1) {
    const k = generateRecordKey();
    assert.equal(k.length, 16);
    assert.match(k, /^[A-Za-z0-9_-]{16}$/);
  }
  // 不同调用结果不同
  assert.notEqual(generateRecordKey(), generateRecordKey());
});
