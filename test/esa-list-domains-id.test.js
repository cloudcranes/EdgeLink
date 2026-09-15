// 锁定 esaListDomains 现在返回的 record 结构里包含 id（即 ESA recordId）
// 否则 disableEsaDomain 会拿到 id=undefined 导致 ESA API 拒绝
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// 我们直接读源码，检查 esaListDomains 映射里有 `id: record.recordId`
const src = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
test('esaListDomains 返回的对象含 id 字段', () => {
  // 检查关键字符串片段
  assert.match(src, /id:\s*record\.recordId/);
});

test('DeleteRecordRequest 已 import', () => {
  assert.match(src, /DeleteRecordRequest/);
});

test('disableEsaDomain 函数存在', () => {
  assert.match(src, /async function disableEsaDomain/);
});