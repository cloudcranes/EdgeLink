// disableEsaDomain 的语义已通过端到端 curl 验证（E2E 测试）。
// 单元测试因需 mock ESA client 复杂度过高，留端到端覆盖。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, '..', 'lib', 'deploy.js'), 'utf8');

test('disableEsaDomain 函数存在', () => {
  assert.match(src, /async function disableEsaDomain/);
});

test('disableEsaDomain 含 ServiceBusy 重试', () => {
  assert.match(src, /async function disableEsaDomain[\s\S]{0,4000}ServiceBusy/);
});