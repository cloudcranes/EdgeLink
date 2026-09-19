// 可靠性测试：normalize 协议白名单、Lucky 超时错误字段、snapshot 路径跟随 config 目录。
// 不依赖外部服务；用临时 LUCKY_ESA_CONFIG_PATH 隔离配置；不启动 HTTP 服务器。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucky-esa-reliability-'));
process.env.LUCKY_ESA_CONFIG_PATH = path.join(tmpDir, 'config.json');

const { normalizeTarget } = require('../lib/normalize');
// 先置入 LUCKY_ESA_CONFIG_PATH，再加载 config/snapshots（它们的常量在模块顶部求值）
const { CONFIG_PATH } = require('../lib/config');
const { SNAPSHOT_DIR, saveSnapshot } = require('../lib/snapshots');
const { readConfig, writeConfig } = require('../lib/config');
const lucky = require('../lib/lucky');

// ---------- P0-1 normalizeTarget 仅允许 http/https ----------

test('normalizeTarget http: 接受', () => {
  assert.equal(normalizeTarget('192.168.1.5:8080'), 'http://192.168.1.5:8080');
  assert.equal(normalizeTarget('http://nas.local:9443'), 'http://nas.local:9443');
  assert.equal(normalizeTarget('https://nas.local:9443/'), 'https://nas.local:9443');
});

test('normalizeTarget 拒绝 file: 等非 http/https 协议，错误消息含"仅支持 http/https"', () => {
  assert.throws(() => normalizeTarget('file:///etc/passwd'), /仅支持 http\/https/);
  assert.throws(() => normalizeTarget('ftp://nas.local:21'), /仅支持 http\/https/);
  // ws: 同样要拒（new URL 能解析 ws，但协议不是 http/https）
  assert.throws(() => normalizeTarget('ws://nas.local:80'), /仅支持 http\/https/);
});

test('normalizeTarget 空值仍按"不能为空"抛错', () => {
  assert.throws(() => normalizeTarget(''), /不能为空/);
});

// ---------- P0-2 Lucky 超时错误字段 ----------

function makeConfig() {
  return {
    lucky: {
      baseUrl: 'http://192.168.1.107:16601',
      pathPrefix: '',
      openToken: '',
      account: 'admin',
      password: 'secret',
    },
    esa: { accessKeyId: 'ak', accessKeySecret: 'sk', siteId: '123' },
    gateway: {},
    apps: [],
  };
}

test('luckyRequest GET 超时抛 ETIMEDOUT + status=504 + 消息含方法/路径/超时', async () => {
  // mock：收到 options.signal（AbortSignal.timeout 注入的 AbortSignal 实例）后立即抛 TimeoutError，
  // 模拟 AbortSignal.timeout 触发；不真等 10s（mock 不监听 signal 会永久挂住）。
  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (_url, options = {}) => {
    captured = options;
    assert.ok(options.signal, 'luckyRequest 必须传 AbortSignal');
    assert.ok(options.signal instanceof AbortSignal, 'options.signal 必须是 AbortSignal 实例');
    const e = new Error('The operation timed out');
    e.name = 'TimeoutError';
    throw e;
  };
  try {
    await assert.rejects(
      () => lucky.luckyRequest('http://x', 't', 'GET', '/api/webservice/rules'),
      (err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.status, 504);
        assert.match(err.message, /GET/);
        assert.match(err.message, /\/api\/webservice\/rules/);
        assert.match(err.message, /超时/);
        return true;
      },
    );
    assert.ok(captured && captured.signal, 'fetch 应被调用且带 signal');
  } finally {
    global.fetch = realFetch;
  }
});

test('luckyRequest POST 超时抛 ETIMEDOUT + status=504', async () => {
  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (_url, options = {}) => {
    captured = options;
    assert.ok(options.signal, 'luckyRequest POST 必须传 AbortSignal');
    const e = new Error('The operation timed out');
    e.name = 'TimeoutError';
    throw e;
  };
  try {
    await assert.rejects(
      () => lucky.luckyRequest('http://x', 't', 'POST', '/api/ddns', { foo: 1 }),
      (err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.status, 504);
        assert.match(err.message, /POST/);
        assert.match(err.message, /\/api\/ddns/);
        assert.match(err.message, /超时/);
        return true;
      },
    );
    assert.ok(captured && captured.signal);
  } finally {
    global.fetch = realFetch;
  }
});

test('luckyLogin 探活 GET 超时冒泡 ETIMEDOUT（不会误降级走 /api/login）', async () => {
  const realFetch = global.fetch;
  let infoCalls = 0;
  global.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.pathname.includes('/api/info')) {
      infoCalls += 1;
      assert.ok(options.signal, '/api/info 探活也必须带 signal');
      const e = new Error('The operation timed out');
      e.name = 'TimeoutError';
      throw e;
    }
    return { status: 200, text: async () => JSON.stringify({ ret: 0, token: 'fallback' }) };
  };
  try {
    const cfg = makeConfig();
    cfg.lucky.openToken = 'old-token';
    await assert.rejects(
      () => lucky.luckyLogin(cfg),
      (err) => err.code === 'ETIMEDOUT' && err.status === 504,
    );
    assert.equal(infoCalls, 1, '超时直接抛出，不应回退到 /api/login');
  } finally {
    global.fetch = realFetch;
  }
});

test('luckyRequest 非超时错误不被吞，原样抛', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => {
    const e = new Error('DNS bad');
    e.cause = { code: 'ENOTFOUND' };
    throw e;
  };
  try {
    await assert.rejects(
      () => lucky.luckyRequest('http://x', 't', 'GET', '/api/x'),
      (err) => {
        assert.notEqual(err.code, 'ETIMEDOUT');
        assert.equal(err.message, 'DNS bad');
        return true;
      },
    );
  } finally {
    global.fetch = realFetch;
  }
});

// ---------- P1-5 SNAPSHOT_DIR 跟随 CONFIG_PATH 所在目录 ----------

test('SNAPSHOT_DIR 与 CONFIG_PATH 同目录的 snapshots 子目录', () => {
  // CONFIG_PATH 由 LUCKY_ESA_CONFIG_PATH 解析得到（在我们 tmpDir 下）
  assert.ok(CONFIG_PATH.startsWith(tmpDir), 'CONFIG_PATH 应在 tmpDir 内');
  assert.equal(
    path.dirname(SNAPSHOT_DIR),
    path.dirname(CONFIG_PATH),
    'SNAPSHOT_DIR 应位于 CONFIG_PATH 同级',
  );
  assert.equal(path.basename(SNAPSHOT_DIR), 'snapshots');
});

test('saveSnapshot 写入到跟随 config 的 snapshots 目录', () => {
  const cfg = makeConfig();
  writeConfig(cfg);
  const file = saveSnapshot(cfg, 'reliability-test');
  assert.ok(file && file.startsWith(path.dirname(CONFIG_PATH)), `写入位置应在 config 目录内, 实际=${file}`);
  assert.ok(file.endsWith('.json'));
  // 清理快照
  fs.unlinkSync(file);
});

// ---------- P1-7 setAppStatus 减少写盘 + status API 合并内存值 ----------

test('setAppStatus 重复 building 不写盘；终态 live 写盘并落 lastError/cdnUrl', async () => {
  const Module = require('module');
  // mock alidns/esa SDK，避免 server.js 顶层 require 失败
  class MockEsa {}
  class MockAlidns {}
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === '@alicloud/esa20240910') return { default: MockEsa };
    if (req === '@alicloud/alidns20150109') return { default: MockAlidns };
    return origLoad.apply(this, arguments);
  };
  let server;
  try {
    server = require('../server.js');
  } finally {
    Module._load = origLoad;
  }

  const appId = 'app-rel';

  // 备份文件计数法：writeConfig 内部会生成一份 .backup- 文件，统计增量即可。
  const dir = path.dirname(CONFIG_PATH);
  const countBackups = () =>
    fs.readdirSync(dir).filter((n) => n.startsWith('config.json.backup-')).length;

  // 写一个 app 进 config (此调用本身会写盘 + 生成一份 backup)
  const cfg = server.readConfig();
  cfg.apps = [{ id: appId, name: 'Rel', prefix: 'rel', target: 'http://127.0.0.1:80', status: 'pending' }];
  server.writeConfig(cfg);
  const backupBase = countBackups();

  // 第一次 building：首次进入，应写盘（备份数 +1）
  await server.setAppStatus(appId, 'building', { lastCheckedAt: '2026-01-01T00:00:00Z', lastError: '' });
  assert.equal(countBackups(), backupBase + 1, '首次 building 应写盘');

  // 第二次 building：相同 status，skipPersist=true，不写盘，备份数不变
  server.liveCheckState.set(appId, { timer: null, attempts: 1, lastUrl: '', lastError: '', lastCheckedAt: '' });
  await new Promise((r) => setTimeout(r, 5));
  await server.setAppStatus(appId, 'building', { lastCheckedAt: '2026-01-01T00:00:10Z', lastError: '探测超时（>8s）' });
  assert.equal(countBackups(), backupBase + 1, '重复 building 必须不写盘（备份数不变）');
  const mem = server.liveCheckState.get(appId);
  assert.equal(mem.lastError, '探测超时（>8s）', '内存 lastError 必须在 building 窗口被持续刷新');
  assert.equal(mem.lastCheckedAt, '2026-01-01T00:00:10Z');

  // 终态 live：写盘 + extras(cdnUrl, lastError='') 持久化
  await new Promise((r) => setTimeout(r, 5));
  await server.setAppStatus(appId, 'live', { lastCheckedAt: '2026-01-01T00:00:20Z', cdnUrl: 'https://rel.cdn.example', lastError: '' });
  assert.equal(countBackups(), backupBase + 2, '终态 live 必须写盘');
  const reloaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const app = reloaded.apps.find((a) => a.id === appId);
  assert.equal(app.status, 'live');
  assert.equal(app.cdnUrl, 'https://rel.cdn.example');

  // 清理
  const state = server.liveCheckState.get(appId);
  if (state && state.timer) clearTimeout(state.timer);
  server.liveCheckState.delete(appId);
});

test('GET /api/apps/status 返回内存最新值（liveCheckState 优先于 config 落盘值）', async () => {
  const Module = require('module');
  class MockEsa {}
  class MockAlidns {}
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === '@alicloud/esa20240910') return { default: MockEsa };
    if (req === '@alicloud/alidns20150109') return { default: MockAlidns };
    return origLoad.apply(this, arguments);
  };
  let server;
  try {
    server = require('../server.js');
  } finally {
    Module._load = origLoad;
  }

  // 起一个最小 http 服务器（只挂载 status 路由）
  const express = require('express');
  const http = require('http');
  const apps = express();
  apps.use(express.json());
  require('../routes/apps').register(apps);
  const httpServer = await new Promise((resolve) => {
    const s = apps.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const appId = 'app-mem';
    const cfg = server.readConfig();
    cfg.apps = [{
      id: appId,
      name: 'Mem',
      prefix: 'mem',
      target: 'http://127.0.0.1:80',
      status: 'building',
      lastError: '陈旧落盘错误',
      lastCheckedAt: '2026-01-01T00:00:00Z',
    }];
    server.writeConfig(cfg);

    // 手动往 liveCheckState 塞一个比 config 新的内存值
    server.liveCheckState.set(appId, {
      timer: null,
      attempts: 2,
      lastUrl: 'https://mem.cdn.example',
      lastError: '探测超时（>8s）：mem.cdn.example',
      lastCheckedAt: '2026-01-01T00:01:00Z',
    });

    const status = await new Promise((resolve, reject) => {
      http.get(`${baseUrl}/api/apps/status`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    assert.equal(status.ok, true);
    const item = status.items.find((i) => i.id === appId);
    assert.ok(item, '应有 app-mem 项');
    assert.equal(item.lastCheckedAt, '2026-01-01T00:01:00Z', '内存 lastCheckedAt 应覆盖落盘值');
    assert.equal(item.lastError, '探测超时（>8s）：mem.cdn.example', '内存 lastError 应覆盖落盘值');
    assert.equal(item.status, 'building');
  } finally {
    await new Promise((r) => httpServer.close(r));
    // 清理残留 timer 后清空 Map，避免 open handle 让 Node 不退出
    for (const state of server.liveCheckState.values()) {
      if (state && state.timer) clearTimeout(state.timer);
    }
    server.liveCheckState.clear();
    // 还原 config，避免污染后续测试
    const cfg = server.readConfig();
    cfg.apps = [];
    server.writeConfig(cfg);
  }
});

// ---------- P? luckyLogin /api/login 10s 超时 ----------

test('luckyLogin 无 openToken 时 fetch options.signal 存在，POST 超时翻译为 >10s ETIMEDOUT', async () => {
  const realFetch = global.fetch;
  let loginCaptured = null;
  global.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    // 仅记录 /api/login 调用；其它走默认成功
    if (u.pathname.includes('/api/login')) {
      loginCaptured = options;
      const e = new Error('The operation timed out');
      e.name = 'TimeoutError';
      throw e;
    }
    return { status: 200, text: async () => JSON.stringify({ ret: 0 }) };
  };
  try {
    const cfg = makeConfig();
    cfg.lucky.openToken = ''; // 强制走 /api/login 分支
    await assert.rejects(
      () => lucky.luckyLogin(cfg),
      (err) => {
        assert.equal(err.code, 'ETIMEDOUT');
        assert.equal(err.status, 504);
        assert.match(err.message, /POST/);
        assert.match(err.message, /\/api\/login/);
        assert.match(err.message, />10s/, '登录超时应显示 10s 而非 20s');
        return true;
      },
    );
    assert.ok(loginCaptured, '/api/login 应被调用');
    assert.ok(loginCaptured.signal, 'fetch options.signal 必须存在（AbortSignal.timeout）');
    assert.ok(loginCaptured.signal instanceof AbortSignal);
  } finally {
    global.fetch = realFetch;
  }
});

// ---------- P? snapshots 同秒连续两次文件名不同 ----------

test('saveSnapshot 同秒连续两次产生不同文件（crypto 随机后缀）', () => {
  const cfg = makeConfig();
  writeConfig(cfg);
  const a = saveSnapshot(cfg, 'same-second-A');
  const b = saveSnapshot(cfg, 'same-second-B');
  try {
    assert.ok(a && b, '两次保存都应返回路径');
    assert.notEqual(a, b, '同秒内两条保存路径必须不同');
    assert.ok(/snapshot-.*-[0-9a-f]{6}\.json$/.test(path.basename(a)), `文件名应含 6 位 hex 后缀: ${a}`);
    assert.ok(/snapshot-.*-[0-9a-f]{6}\.json$/.test(path.basename(b)), `文件名应含 6 位 hex 后缀: ${b}`);
  } finally {
    // 清理两个文件
    try { fs.unlinkSync(a); } catch {}
    try { fs.unlinkSync(b); } catch {}
  }
});