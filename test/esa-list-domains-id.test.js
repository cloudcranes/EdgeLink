// 锁定 esaListDomains 现在返回的 record 结构里包含 id（即 ESA recordId）
// 否则 disableEsaDomain 会拿到 id=undefined 导致 ESA API 拒绝
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// 直接读源码：esaListDomains 已迁移到 lib/esa.js
const srcEsa = readFileSync(join(__dirname, '..', 'lib', 'esa.js'), 'utf8');
const srcServer = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
const srcDeploy = readFileSync(join(__dirname, '..', 'lib', 'deploy.js'), 'utf8');

test('esaListDomains 返回的对象含 id 字段', () => {
  // 检查关键字符串片段（在 lib/esa.js 中）
  assert.match(srcEsa, /id:\s*record\.recordId/);
});

test('DeleteRecordRequest 已 import', () => {
  assert.match(srcServer, /DeleteRecordRequest/);
});

test('disableEsaDomain 函数存在', () => {
  assert.match(srcDeploy, /(?:async function|function)\s+disableEsaDomain/);
});