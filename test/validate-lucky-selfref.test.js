const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateLuckySelfReference, validateDeployConfig } = require('../server.js');

const baseConfig = () => ({
  lucky: { baseUrl: 'http://192.168.1.107:16601', pathPrefix: '/master', openToken: 't', account: '', password: '' },
  esa: { accessKeyId: 'a', accessKeySecret: 's', siteId: '1', siteName: 'x', rootDomain: 'alanmaster.top' },
  gateway: { listenIp: '::', listenPort: 8443, originScheme: 'http', originHttpPort: 8000, enableTls: false },
  panel: {},
  apps: [],
});

test('lucky-prefix target 与 lucky.baseUrl 一致：放行', () => {
  const c = baseConfig();
  const app = { id: '1', name: 'Lucky', prefix: 'lucky', target: 'http://192.168.1.107:16601', luckyEnabled: true, esaEnabled: true };
  assert.doesNotThrow(() => validateLuckySelfReference(app, c));
});

test('lucky-prefix target 与 lucky.baseUrl 端口不一致：阻断', () => {
  const c = baseConfig();
  const app = { id: '1', name: 'Lucky', prefix: 'lucky', target: 'http://192.168.1.107:16602', luckyEnabled: true, esaEnabled: true };
  assert.throws(() => validateLuckySelfReference(app, c), /不一致/);
});

test('lucky-prefix target host 不同：阻断', () => {
  const c = baseConfig();
  const app = { id: '1', name: 'Lucky', prefix: 'lucky', target: 'http://192.168.1.99:16601', luckyEnabled: true, esaEnabled: true };
  assert.throws(() => validateLuckySelfReference(app, c), /不一致/);
});

test('非 lucky-prefix：跳过校验', () => {
  const c = baseConfig();
  const app = { id: '1', name: 'Other', prefix: 'emby', target: 'http://192.168.1.170:8097', luckyEnabled: true, esaEnabled: true };
  assert.doesNotThrow(() => validateLuckySelfReference(app, c));
});

test('validateDeployConfig 在 lucky-prefix 不一致时整体失败', () => {
  const c = baseConfig();
  c.apps = [
    { id: '1', name: 'Lucky', prefix: 'lucky', target: 'http://192.168.1.107:16602', luckyEnabled: true, esaEnabled: true },
  ];
  assert.throws(() => validateDeployConfig(c, ['lucky', 'esa']), /不一致/);
});

// 锁定：面板认证走网页认证（WebAuth），不使用 BasicAuth。
// （Lucky v2.27.2 认证信息统一存 BasicAuthUserList；浏览器走登录页，非浏览器回退 BasicAuth）
const { buildLuckyProxy, buildLuckyRule } = require('../server.js');
test('buildLuckyProxy 关认证时清空认证信息', () => {
  const c = baseConfig();
  c.lucky.basicAuth = { enabled: false, users: [{ username: 'u', password: 'p' }] };
  const app = { id: 'x', name: 'A', prefix: 'a', target: 'http://127.0.0.1:1', luckyEnabled: true, esaEnabled: true, webAuth: false };
  const p = buildLuckyProxy(app, c);
  assert.equal(p.WebAuth, false, 'WebAuth 应关闭');
  assert.equal(p.EnableBasicAuth, false, 'EnableBasicAuth 始终 false');
  assert.equal(p.BasicAuthUser, '');
  assert.equal(p.BasicAuthPasswd, '');
  assert.equal(p.BasicAuthUserList, '');
});

test('buildLuckyProxy 开认证时写入 BasicAuthUserList 且不启用 BasicAuth', () => {
  const c = baseConfig();
  c.lucky.basicAuth = { enabled: false, users: [{ username: 'a', password: '1' }, { username: 'b', password: '2' }] };
  const app = { id: 'x', name: 'A', prefix: 'a', target: 'http://127.0.0.1:1', luckyEnabled: true, esaEnabled: true, webAuth: true };
  const p = buildLuckyProxy(app, c);
  assert.equal(p.WebAuth, true, '顶层 WebAuth 应为 true');
  assert.equal(p.OtherParams.WebAuth, true, 'OtherParams.WebAuth 应为 true');
  assert.equal(p.EnableBasicAuth, false, '不应启用 BasicAuth（浏览器不应弹原生密码框）');
  assert.equal(p.BasicAuthUserList, 'a:1\nb:2', '多用户写入 BasicAuthUserList');
});

test('buildLuckyProxy 默认打开 EasyLucky/AutoProxyLocation/RecordAccessLogs', () => {
  const c = baseConfig();
  const app = { id: 'x', name: 'A', prefix: 'a', target: 'http://127.0.0.1:1', luckyEnabled: true, esaEnabled: true, webAuth: false };
  const p = buildLuckyProxy(app, c);
  // 顶层（Lucky UI 从顶层读取）
  assert.equal(p.EasyLucky, true, '万事大吉应默认开启（顶层）');
  assert.equal(p.AutoProxyLocation, true, '自动反代重定向应默认开启（顶层）');
  assert.equal(p.EnableAccessLog, true, '记录访问日志应默认开启（顶层 EnableAccessLog）');
  // OtherParams 兜底
  assert.equal(p.OtherParams.EasyLucky, true, '万事大吉应默认开启');
  assert.equal(p.OtherParams.AutoProxyLocation, true, '自动反代重定向应默认开启');
  assert.equal(p.OtherParams.RecordAccessLogs, true, '记录访问日志应默认开启');
});

test('DefaultProxy 也带三个默认开关', () => {
  const c = baseConfig();
  const app = { id: 'x', name: 'A', prefix: 'a', target: 'http://127.0.0.1:1', luckyEnabled: true, esaEnabled: true, webAuth: false };
  const proxies = [buildLuckyProxy(app, c)];
  const rule = buildLuckyRule(c, proxies, 'k');
  assert.equal(rule.DefaultProxy.OtherParams.EasyLucky, true);
  assert.equal(rule.DefaultProxy.OtherParams.AutoProxyLocation, true);
  assert.equal(rule.DefaultProxy.OtherParams.RecordAccessLogs, true);
});

test('buildLuckyProxy 认证用网页认证：WebAuth=true 而非 EnableBasicAuth', () => {
  const c = baseConfig();
  c.lucky.basicAuth = { enabled: true, users: [{ username: 'u', password: 'p' }] };
  const app = { id: 'x', name: 'A', prefix: 'a', target: 'http://127.0.0.1:1', luckyEnabled: true, esaEnabled: true, webAuth: true };
  const p = buildLuckyProxy(app, c);
  assert.equal(p.WebAuth, true, '顶层 WebAuth 应为 true');
  assert.equal(p.OtherParams.WebAuth, true, 'OtherParams.WebAuth 应为 true');
  assert.equal(p.EnableBasicAuth, false, '不应启用 BasicAuth');
  assert.equal(p.BasicAuthUserList, 'u:p', '认证信息写入 BasicAuthUserList');
});

test('buildLuckyProxy 关闭认证时 WebAuth=false 且认证信息清空', () => {
  const c = baseConfig();
  c.lucky.basicAuth = { enabled: true, users: [{ username: 'u', password: 'p' }] };
  const app = { id: 'x', name: 'A', prefix: 'a', target: 'http://127.0.0.1:1', luckyEnabled: true, esaEnabled: true, webAuth: false };
  const p = buildLuckyProxy(app, c);
  assert.equal(p.WebAuth, false);
  assert.equal(p.OtherParams.WebAuth, false);
  assert.equal(p.EnableBasicAuth, false);
  assert.equal(p.BasicAuthUserList, '');
});