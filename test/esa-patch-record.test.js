// 锁定 ESA 记录编辑 PATCH 端点：dryRun 预览、字段白名单、字段缺失报错
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const src = readFileSync(join(__dirname, '..', 'routes', 'esa.js'), 'utf8');
const appsJs = readFileSync(join(__dirname, '..', 'public', 'js', 'apps.js'), 'utf8');
const existingJs = readFileSync(join(__dirname, '..', 'public', 'js', 'existing.js'), 'utf8');
const apiJs = readFileSync(join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');

test('PATCH /api/esa/record/:recordId 路由存在', () => {
  assert.match(src, /app\.patch\(\s*'\/api\/esa\/record\/:recordId'/);
});

test('PATCH ESA 端点支持 dryRun=1 预览', () => {
  assert.match(src, /record\/:recordId'[\s\S]{0,5000}dryRun[\s\S]{0,3000}before/);
  assert.match(src, /record\/:recordId'[\s\S]{0,5000}after/);
});

test('PATCH ESA 字段白名单（仅允许 value/hostPolicy/proxied/ttl/sourceType/bizName/comment）', () => {
  const allowed = ["'value'", "'hostPolicy'", "'proxied'", "'ttl'", "'sourceType'", "'bizName'", "'comment'"];
  for (const k of allowed) {
    assert.ok(src.includes(`if (${k} in body)`), `缺字段白名单检查: ${k}`);
  }
});

test('PATCH ESA 缺 recordId 应抛错', () => {
  assert.match(src, /缺少 recordId/);
});

test('PATCH ESA 字段全空时应抛错', () => {
  assert.match(src, /没有可编辑的字段/);
});

test('PATCH ESA 拒绝 CNAME + proxied=false（ESA 服务端限制）', () => {
  assert.match(src, /CNAME 接入类型 ESA 强制开启加速[\s\S]{0,100}proxied 必须为 true/);
});

test('api.js patchEsaRecord 透传 dryRun', () => {
  assert.match(apiJs, /patchEsaRecord[\s\S]{0,200}dryRun/);
});

test('existing.js editEsaRecord 函数存在且走 dryRun + 真改', () => {
  assert.match(existingJs, /export async function editEsaRecord/);
  assert.match(existingJs, /patchEsaRecord\(recordId, [\s\S]{0,40}dryRun/);
});

test('existing.js editEsaRecord 用 index.html 已有 modal 容器，不用 dialog 也不用 prompt', () => {
  // 只检查 editEsaRecord 函数体内不用 window.prompt、不用 document.createElement('dialog')（避免兼容问题）
  const fnMatch = existingJs.match(/export async function editEsaRecord[\s\S]+?\n\}\n/);
  assert.ok(fnMatch, 'editEsaRecord 函数未找到');
  const fnNoComments = fnMatch[0].replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(fnNoComments, /window\.prompt/);
  assert.doesNotMatch(fnNoComments, /createElement\(['"]dialog['"]\)/);
  // 用现成的 #esa-modal 容器
  assert.match(existingJs, /getElementById\(['"]esa-modal['"]\)/);
  // 操作流程：cancel / dryRun / save 三按钮
  assert.match(existingJs, /data-esa-act="cancel"/);
  assert.match(existingJs, /data-esa-act="dry"/);
  assert.match(existingJs, /data-esa-act="save"/);
});

test('index.html 含 #esa-modal 容器', () => {
  const indexHtml = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(indexHtml, /id="esa-modal"/);
});

test('main.js 必须 import editEsaRecord（避免 undefined call）', () => {
  const mainJs = readFileSync(join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  assert.match(mainJs, /import[\s\S]{0,300}editEsaRecord[\s\S]{0,200}from\s+['"]\.\/existing\.js['"]/);
});

test('DELETE /api/esa/record/:recordId 端点存在且支持 dryRun / purgeDdns', () => {
  assert.match(src, /app\.delete\(\s*'\/api\/esa\/record\/:recordId'/);
  assert.match(src, /record\/:recordId'[\s\S]{0,1500}purgeDdns/);
  assert.match(src, /record\/:recordId'[\s\S]{0,1500}dryRun/);
});

test('existing.js 有 del-esa 按钮 + deleteEsaRecord 函数（dryRun→confirm→执行）', () => {
  assert.match(existingJs, /data-existing-action="del-esa"/);
  assert.match(existingJs, /export async function deleteEsaRecord/);
  assert.match(existingJs, /deleteEsaRecord\(recordId, \{ dryRun: true \}\)/);
  assert.match(existingJs, /purgeDdns/);
});

test('main.js 必须 import deleteEsaRecord', () => {
  const mainJs = readFileSync(join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  assert.match(mainJs, /import[\s\S]{0,300}deleteEsaRecord[\s\S]{0,200}from\s+['"]\.\/existing\.js['"]/);
});

test('existing.js ESA 加速开关显示为"已启用"且 disabled（CNAME 接入不允许关闭 proxied）', () => {
  assert.match(existingJs, /已启用/);
  assert.match(existingJs, /checked disabled/);
});

test('existing.js hostPolicy 用 select 选项（3 选 1）', () => {
  // 弹窗表单里 hostPolicy 字段是 <select> 而非 <input>
  const formMatch = existingJs.match(/<label>hostPolicy[\s\S]+?<\/label>/);
  assert.ok(formMatch, 'hostPolicy 表单字段未找到');
  assert.match(formMatch[0], /<select\s+name="hostPolicy">/);
  assert.match(formMatch[0], /follow_origin_domain/);
  assert.match(formMatch[0], /follow_hostname/);
  assert.match(formMatch[0], /<option[^>]*value="none"/);
  assert.doesNotMatch(formMatch[0], /<input\s+name="hostPolicy"/);
});

test('existing.js sourceType/bizName 用 select（高级字段也选项化）', () => {
  const sourceMatch = existingJs.match(/<label>sourceType[\s\S]+?<\/label>/);
  assert.ok(sourceMatch, 'sourceType 字段未找到');
  assert.match(sourceMatch[0], /<select\s+name="sourceType">/);
  const bizMatch = existingJs.match(/<label>bizName[\s\S]+?<\/label>/);
  assert.ok(bizMatch, 'bizName 字段未找到');
  assert.match(bizMatch[0], /<select\s+name="bizName">/);
});

test('existing.js proxied 用 select（true/false 两选一），不用 input', () => {
  const proxMatch = existingJs.match(/<label>proxied[\s\S]+?<\/label>/);
  assert.ok(proxMatch, 'proxied 字段未找到');
  assert.match(proxMatch[0], /<select\s+name="proxied">/);
  assert.match(proxMatch[0], /<option[^>]*value="true"/);
  assert.match(proxMatch[0], /<option[^>]*value="false"/);
  assert.doesNotMatch(proxMatch[0], /<input\s+name="proxied"/);
});

test('existing.js ESA 行有 edit-esa 按钮且 HTML 结构正确（一个 data-label="操作" td）', () => {
  assert.match(existingJs, /data-existing-action="edit-esa"/);
  assert.match(existingJs, /data-record-id=/);
  // 编辑按钮与 copy/open 按钮应在同一个 <td data-label="操作"> 里
  const esaRow = existingJs.match(/edit-esa[\s\S]{0,2000}复制域名/);
  assert.ok(esaRow, 'edit-esa 按钮与复制按钮应在同一行');
});