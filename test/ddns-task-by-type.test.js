// 锁定 findDdnsTaskByType 的 recordType → 任务选择逻辑
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findDdnsTaskByType, findEsaDdnsTask } = require('../server.js');

const mkTask = (key, records) => ({
  TaskKey: key,
  DNS: { Name: 'alidns' },
  Records: records || [],
});

const mkAaaa = (sub) => ({ SubDomain: sub, Type: 'AAAA' });
const mkCname = (sub) => ({ SubDomain: sub, Type: 'CNAME' });
const mkTxt = (sub) => ({ SubDomain: sub, Type: 'TXT' });

test('A/AAAA 优先 ipv6 任务', () => {
  const ipv6 = mkTask('T_IPV6', [mkAaaa('lucky.nas')]);
  const esa = mkTask('T_ESA', [mkCname('agent.cdn')]);
  const tasks = [esa, ipv6];
  const got = findDdnsTaskByType(tasks, 'AAAA', { ipv6: 'T_IPV6', esa: 'T_ESA' });
  assert.equal(got.TaskKey, 'T_IPV6');
});

test('CNAME 优先 esa 任务', () => {
  const ipv6 = mkTask('T_IPV6', [mkAaaa('lucky.nas')]);
  const esa = mkTask('T_ESA', [mkCname('agent.cdn')]);
  const tasks = [ipv6, esa];
  const got = findDdnsTaskByType(tasks, 'CNAME', { ipv6: 'T_IPV6', esa: 'T_ESA' });
  assert.equal(got.TaskKey, 'T_ESA');
});

test('TXT 优先 other 任务', () => {
  const other = mkTask('T_OTHER', [mkTxt('debug')]);
  const tasks = [other];
  const got = findDdnsTaskByType(tasks, 'TXT', { other: 'T_OTHER' });
  assert.equal(got.TaskKey, 'T_OTHER');
});

test('未配置 taskKey 时回退 findEsaDdnsTask', () => {
  const fallback = mkTask('T_FALLBACK', [mkCname('agent.cdn')]);
  const got = findDdnsTaskByType([fallback], 'AAAA', { ipv6: '', esa: '', other: '' });
  assert.equal(got.TaskKey, 'T_FALLBACK');
});

test('配置的 taskKey 在任务列表里找不到时回退 findEsaDdnsTask', () => {
  const fallback = mkTask('T_FALLBACK', [mkCname('agent.cdn')]);
  const got = findDdnsTaskByType([fallback], 'AAAA', { ipv6: 'T_NONEXIST' });
  assert.equal(got.TaskKey, 'T_FALLBACK');
});

test('SRV/CAA/MX 走 other 任务', () => {
  const other = mkTask('T_OTHER');
  for (const t of ['SRV', 'CAA', 'NS', 'MX']) {
    const got = findDdnsTaskByType([other], t, { other: 'T_OTHER' });
    assert.equal(got.TaskKey, 'T_OTHER', `${t} 应走 other`);
  }
});

test('defaultConfig 包含 lucky.ddnsTasks 字段', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /ddnsTasks:\s*\{[\s\S]*?ipv6:[\s\S]*?esa:[\s\S]*?other:[\s\S]*?\}/);
});