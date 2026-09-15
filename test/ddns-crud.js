// 临时端到端 DDNS CRUD 验证：add → update → skip → delete
// 用法：node test/ddns-crud.js
const { addDdnsCnameRecord, defaultConfig, mergeConfig } = require('../server.js');
const fs = require('fs');
const path = require('path');

const config = mergeConfig(defaultConfig(), JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')));
const rootDomain = config.esa.rootDomain;
const SUB = '__test_ddns_audit_' + Date.now();
const CNAME1 = 'audit-target-1.example.com';
const CNAME2 = 'audit-target-2.example.com';

async function getTasks() {
  const { luckyLogin, luckyRequest } = require('../server.js');
}

(async () => {
  const api = require('../server.js');
  // 1) add
  const a = await api.addDdnsCnameRecord(config, SUB, CNAME1, rootDomain, 'audit-1');
  console.log('ADD:', JSON.stringify(a));
  // 2) update (same sub, different cname)
  const u = await api.addDdnsCnameRecord(config, SUB, CNAME2, rootDomain, 'audit-2');
  console.log('UPDATE:', JSON.stringify(u));
  // 3) skip (same sub+remark)
  const s = await api.addDdnsCnameRecord(config, SUB, CNAME2, rootDomain, 'audit-2');
  console.log('SKIP:', JSON.stringify(s));
  // 4) cleanup: 删除刚加的测试记录
  const tasks = await api.getLuckyDdnsTasks(config);
  const tasksArr = await tasks;
  const candidate = tasks.find((task) => task.TaskKey === (tasksArr[0] || {}).TaskKey) || tasks[0];
  const { baseUrl, token } = await api.luckyLogin(config);
  const detail = await api.luckyRequest(baseUrl, token, 'GET', '/api/ddns/task/' + (tasks[0].TaskKey));
  const task = detail.task || detail.data;
  const before = (task.Records || []).length;
  task.Records = (task.Records || []).filter((r) => {
    const sd = (r.SyncRecordData && r.SyncRecordData.SubDomainName) || r.SubDomain;
    return sd !== SUB;
  });
  const after = task.Records.length;
  await api.luckyRequest(baseUrl, token, 'PUT', '/api/ddns?key=' + tasks[0].TaskKey, task);
  console.log(`DELETE: records ${before} -> ${after}`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });