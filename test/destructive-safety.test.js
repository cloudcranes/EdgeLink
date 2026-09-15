// 锁定"破坏性操作补救措施"已落到代码里（防止后续被无意删掉）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, '..', 'server.js'), 'utf8');
const appsJs = readFileSync(join(__dirname, '..', 'public', 'js', 'apps.js'), 'utf8');
const apiJs = readFileSync(join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');
const ddnsJs = readFileSync(join(__dirname, '..', 'public', 'js', 'ddns.js'), 'utf8');
const mainJs = readFileSync(join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
const indexHtml = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('record-delete 必须要求 recordKey，禁止按 subDomain 批量', () => {
  assert.match(src, /record-delete[\s\S]{0,800}缺少 recordKey/);
});

test('record-delete 支持 dryRun=1', () => {
  assert.match(src, /record-delete[\s\S]{0,1200}dryRun/);
});

test('DELETE /api/apps/:id 必须带 confirm 或 dryRun', () => {
  assert.match(src, /必须带 confirm[\s\S]{0,100}或 dryRun/);
});

test('DELETE /api/apps/:id dryRun 返回 plan', () => {
  assert.match(src, /dryRun[\s\S]{0,400}willRemove/);
});

test('audit/fix purgeOrphans 默认 dryRun，confirm="yes-i-am-sure" 才真删', () => {
  assert.match(src, /purgeOrphansDryRun[\s\S]{0,500}confirm="yes-i-am-sure"/);
});

test('PATCH /api/apps/:id 支持 preview=1 不写盘', () => {
  assert.match(src, /preview[\s\S]{0,300}plan/);
});

test('前端 deleteApp 先 dryRun 再 confirm 流程', () => {
  assert.match(appsJs, /api\.deleteApp\(id, \{ dryRun: true, purge \}\)/);
  assert.match(appsJs, /api\.deleteApp\(id, \{ purge, confirm: id \}\)/);
});

test('api.js deleteApp 透传 dryRun / confirm / purge query', () => {
  assert.match(apiJs, /dryRun[\s\S]{0,200}confirm/);
  assert.match(apiJs, /purge/);
});

test('api.js 新增 patchApp（应用保存后自动 deploy）', () => {
  assert.match(apiJs, /patchApp:[\s\S]{0,300}preview[\s\S]{0,200}PATCH/);
});

test('apps.js addOrUpdateApp 保存后调 patchApp preview + 确认 + 真正 deploy', () => {
  assert.match(appsJs, /patchApp\(targetId, previewBody, \{ preview: true \}\)/);
  assert.match(appsJs, /confirmDialog\(\{[\s\S]{0,300}配置已保存[\s\S]{0,200}同步到 Lucky/);
  assert.match(appsJs, /patchApp\(targetId, previewBody\)/);
});

test('清除公网解析残留：后端端点 + alidns 直连 + dryRun + 前端工具（首页已改为纯展示，UI 入口可能迁移）', () => {
  // 后端端点
  assert.match(src, /cleanup-residue/);
  assert.match(src, /alidnsListRecords/);
  assert.match(src, /alidnsDeleteRecord/);
  assert.match(src, /cleanup-residue[\s\S]{0,2500}dryRun/);
  // api.js
  assert.match(apiJs, /cleanupResidue:/);
  // ddns.js 前端函数（供未来重新接 UI 时复用）
  assert.match(ddnsJs, /export async function cleanupResidue/);
  assert.match(ddnsJs, /cleanupResidue\(\{ rrPrefix, domainName: root \}, \{ dryRun: true \}\)/);
});