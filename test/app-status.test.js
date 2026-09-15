const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeApp } = require('../server.js');

test('normalizeApp 默认 status=pending', () => {
  const a = normalizeApp({ id: '1', name: 'demo', prefix: 'demo', target: 'http://127.0.0.1:80' });
  assert.equal(a.status, 'pending');
});

test('normalizeApp 保留已有合法 status', () => {
  const a = normalizeApp({ id: '1', name: 'demo', prefix: 'demo', target: 'http://127.0.0.1:80', status: 'live' });
  assert.equal(a.status, 'live');
});

test('normalizeApp 非法 status 回落 pending', () => {
  const a = normalizeApp({ id: '1', name: 'demo', prefix: 'demo', target: 'http://127.0.0.1:80', status: 'broken' });
  assert.equal(a.status, 'pending');
});

test('normalizeApp 仍清除旧 enabled 字段', () => {
  const a = normalizeApp({ id: '1', name: 'demo', prefix: 'demo', target: 'http://127.0.0.1:80', enabled: true });
  assert.equal(a.enabled, undefined);
});