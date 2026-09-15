// Lucky DDNS 任务操作：通过 Lucky 反代 API 写入/更新/跳过 CNAME/TXT 子域（不直连 alidns）。
// 依赖：./lucky（luckyLogin / luckyRequest）、./normalize（normalizeTarget）、node:crypto。
// 无全局状态。

const crypto = require('crypto');
const { luckyLogin, luckyRequest } = require('./lucky');
const { normalizeTarget } = require('./normalize');

async function getLuckyDdnsTasks(config) {
  const { baseUrl, token } = await luckyLogin(config);
  const data = await luckyRequest(baseUrl, token, 'GET', '/api/ddnstasklist');
  return data.data || data.list || [];
}

// 从任务列表中挑选"用于写入 cdn CNAME 的 Lucky DDNS 任务"
// 优先级：1) 已有 .cdn CNAME 的任务；2) 含 .nas AAAA 的 alidns 任务；3) 任意 alidns 任务
function findEsaDdnsTask(tasks) {
  const hasCdnCname = (task) =>
    (task.Records || []).some((record) => {
      const sub = String(record.SubDomain || '');
      return record.Type === 'CNAME' && sub.endsWith('.cdn');
    });
  const hasNasAaaa = (task) =>
    (task.Records || []).some((record) => {
      const sub = String(record.SubDomain || '');
      return record.Type === 'AAAA' && sub.endsWith('.nas');
    });
  const isAlidns = (task) => ((task.DNS || {}).Name || '') === 'alidns';
  return (
    tasks.find((task) => hasCdnCname(task)) ||
    tasks.find((task) => isAlidns(task) && hasNasAaaa(task)) ||
    tasks.find((task) => isAlidns(task)) ||
    null
  );
}

// 按 recordType + 用户配置的 ddnsTasks 映射选任务
// recordType 分类：AAAA/A → ipv6 任务；CNAME → esa 任务；TXT/其它 → other 任务
// 用户没配置对应 taskKey → 回退到 findEsaDdnsTask（兼容旧部署）
function findDdnsTaskByType(tasks, recordType, configured) {
  const target = (() => {
    if (recordType === 'AAAA' || recordType === 'A') return configured.ipv6;
    if (recordType === 'CNAME') return configured.esa;
    if (recordType === 'TXT' || recordType === 'SRV' || recordType === 'CAA' || recordType === 'NS' || recordType === 'MX') return configured.other;
    return '';
  })();
  if (target) {
    const found = tasks.find((t) => t.TaskKey === target);
    if (found) return found;
  }
  return findEsaDdnsTask(tasks);
}

// 解析 Lucky SyncRecordData 字符串（PowerShell hashtable 格式：@{k=v; k2=v2}）
function parseSyncRecord(syncRecordData) {
  if (!syncRecordData) return null;
  if (typeof syncRecordData === 'object') return syncRecordData;
  const text = String(syncRecordData);
  const parsed = {};
  for (const match of text.matchAll(/([A-Za-z]+)=([^;]+)/g)) {
    parsed[match[1]] = match[2].trim();
  }
  return parsed;
}

// 抽取一条 record 的语义字段（兼容 Lucky LIST 扁平结构与 DETAIL 的嵌套 SyncRecordData）
function readRecordDetail(record) {
  const sd = record && record.SyncRecordData && typeof record.SyncRecordData === 'object'
    ? record.SyncRecordData
    : null;
  return {
    type: (sd?.type ?? record?.Type ?? '').toString().toUpperCase(),
    domainName: (sd?.DomainName ?? record?.DomainName ?? '').toString().toLowerCase(),
    subDomainName: (sd?.SubDomainName ?? record?.SubDomain ?? '').toString().toLowerCase(),
    fullDomainName: (sd?.fullDomainName ?? record?.fullDomainName ?? '').toString().toLowerCase(),
    cnameContent: (sd?.CNAMEContent ?? record?.CNAMEContent ?? '').toString(),
    line: (sd?.line ?? record?.line ?? '').toString(),
    ttl: sd?.ttl ?? record?.ttl ?? 0,
    remark: (sd?.remark ?? record?.remark ?? '').toString(),
    bizName: (sd?.BizName ?? record?.BizName ?? 'web').toString(),
  };
}

// 比较 record 与期望 sub/siteRoot 是否精确匹配该记录
// recordType 限定 'CNAME' / 'TXT' / 其它；contentField 指示同步的内容字段（CNAMEContent / TXTContent）
function recordMatches(record, subDomain, siteRoot, recordType, contentField, contentValue) {
  const d = readRecordDetail(record);
  if (d.type !== recordType) return false;
  if (d.domainName !== siteRoot) return false;
  if (d.subDomainName !== subDomain) return false;
  if (contentField === 'CNAMEContent') return d.cnameContent === contentValue;
  if (contentField === 'TXTContent') {
    const txt = (record.SyncRecordData?.TXTContent ?? record?.TXTContent ?? '').toString();
    return txt === contentValue;
  }
  return true;
}

function readRecordContent(record, contentField) {
  if (contentField === 'TXTContent') {
    return (record.SyncRecordData?.TXTContent ?? record?.TXTContent ?? '').toString();
  }
  return readRecordDetail(record).cnameContent;
}

// 生成 Lucky Record Key（16 字符 base64url）
function generateRecordKey() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

// 向后兼容 CNAME 匹配：仅在 type==CNAME 且 sub/domain 匹配时为 true，不校验内容（addDdnsRecord 二次校验）
function recordMatchesCname(record, subDomain, siteRoot) {
  const d = readRecordDetail(record);
  return d.type === 'CNAME' && d.domainName === siteRoot && d.subDomainName === subDomain;
}

// 通过 Lucky DDNS 任务写入 / 更新 / 跳过 CNAME/TXT 子域（不直连 alidns API）
// recordType: 'CNAME' | 'TXT' | 其它（Value 原样转发到 alidns）
// contentField: 'CNAMEContent' | 'TXTContent'
async function addDdnsRecord(config, subDomain, recordType, contentField, contentValue, siteRoot, remark) {
  const tasks = await getLuckyDdnsTasks(config);
  const configured = (config.lucky && config.lucky.ddnsTasks) || {};
  const candidate = findDdnsTaskByType(tasks, recordType, configured);
  if (!candidate) {
    throw new Error('未找到 Lucky DDNS 任务（按 recordType 匹配失败，且无默认 alidns 任务）');
  }
  const taskKey = candidate.TaskKey;
  const { baseUrl, token } = await luckyLogin(config);
  const query = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${taskKey}`);
  const task = query.task || query.data || candidate;
  if (!Array.isArray(task.Records)) task.Records = [];

  const matched = task.Records.find((r) =>
    recordMatches(r, subDomain, siteRoot, recordType, contentField, contentValue),
  ) || task.Records.find((r) => {
    const d = readRecordDetail(r);
    return d.type === recordType && d.domainName === siteRoot && d.subDomainName === subDomain;
  }) || null;
  let action = 'added';
  let message = '';
  if (matched) {
    const currentContent = readRecordContent(matched, contentField);
    const currentRemark = readRecordDetail(matched).remark;
    if (currentContent === contentValue && currentRemark === (remark || '')) {
      action = 'skipped';
      message = `Lucky DDNS 已存在且一致 ${subDomain}.${siteRoot} ${recordType} -> ${contentValue}，触发 manualSync`;
    } else {
      if (typeof matched.SyncRecordData !== 'object' || matched.SyncRecordData === null) {
        matched.SyncRecordData = {};
      }
      matched.SyncRecordData[contentField] = contentValue;
      matched.SyncRecordData.fullDomainName = `${subDomain}.${siteRoot}`;
      matched.SyncRecordData.remark = remark || '';
      matched[contentField] = contentValue;
      matched.fullDomainName = `${subDomain}.${siteRoot}`;
      matched.remark = remark || '';
      action = 'updated';
      message = `Lucky DDNS 已更新 ${subDomain}.${siteRoot} ${recordType} -> ${contentValue}`;
    }
  } else {
    const newRecord = {
      SyncRecordData: {
        BizName: 'web',
        DomainName: siteRoot,
        SubDomainName: subDomain,
        fullDomainName: `${subDomain}.${siteRoot}`,
        line: '',
        remark: remark || '',
        ttl: 0,
        type: recordType,
      },
      Key: generateRecordKey(),
      Disable: false,
    };
    newRecord.SyncRecordData[contentField] = contentValue;
    task.Records.push(newRecord);
    message = `Lucky DDNS 已追加 ${subDomain}.${siteRoot} ${recordType} -> ${contentValue}`;
  }

  await luckyRequest(
    baseUrl,
    token,
    'PUT',
    `/api/ddns?key=${encodeURIComponent(taskKey)}`,
    task,
  );
  // manualSync 是 best-effort：Lucky PUT 后若引擎仍在同步会回 ret=isSyncing。
  // CNAME 已写入任务对象，公网最终一致性由 Lucky 引擎保证，不阻断。
  let manualSyncWarning = '';
  try {
    await luckyRequest(baseUrl, token, 'GET', `/api/ddns/manualSync/${taskKey}`);
  } catch (error) {
    if (/isSyncing/i.test(error.message)) {
      manualSyncWarning = '（Lucky 引擎同步未结束，公网生效等待其完成）';
    } else {
      throw error;
    }
  }

  return {
    added: action === 'added',
    updated: action === 'updated',
    skipped: action === 'skipped',
    taskKey,
    message: message + manualSyncWarning,
  };
}

// 向后兼容：CNAME 写入委托到通用记录接口
function addDdnsCnameRecord(config, subDomain, cnameContent, siteRoot, remark) {
  return addDdnsRecord(config, subDomain, 'CNAME', 'CNAMEContent', cnameContent, siteRoot, remark);
}

// AAAA 记录写入：Lucky SyncRecordData 字段名是 ipv6Address（不是 AAAA）。
// 写入 Lucky 动态占位符 {ipv6Addr}，由 Lucky DDNS 引擎同步时取本机当前公网 IPv6 替换，
// 前缀变化自动跟随——根治"写死 config.lucky.publicIPv6、IPv6 前缀变更后记录失联"问题。
function addDdnsAaaaRecord(config, subDomain, siteRoot, remark) {
  // nas AAAA 子域固定为 "{prefix}.nas"（无 siteRoot 拼接），与 addDdnsCnameRecord 行为不同
  // 内部走 addDdnsRecord 时用占位 siteRoot（不会被 fullDomainName 字符串用到）
  return addDdnsRecord(config, subDomain, 'AAAA', 'ipv6Address', '{ipv6Addr}', siteRoot, remark);
}

// 查找：主域下 nas 子域的 DDNS 记录（不要求 *.nas 通配，支持逐条子域）
function findNasDdnsTask(tasks, rootDomain, prefix) {
  if (!rootDomain) return null;
  const needle = prefix ? `${prefix}.nas.${rootDomain}`.toLowerCase() : `*.nas.${rootDomain}`;
  const suffix = `.nas.${rootDomain.toLowerCase()}`;
  return (
    tasks.find((task) =>
      (task.Records || []).some((record) => {
        const sdData = record.SyncRecordData || {};
        const sd = String(sdData.SubDomainName || record.SubDomain || '').toLowerCase();
        const dn = String(sdData.DomainName || record.DomainName || '').toLowerCase();
        const isNasRecord = dn === rootDomain.toLowerCase() && sd.endsWith('.nas');
        // 接受两种匹配：精确单条（如 ql.nas.alanmaster.top）或通配（*.nas.alanmaster.top）
        const exact = sd === (prefix ? `${prefix}.nas` : null);
        const wildcard = sd === '*.nas';
        const hasMatching = exact || wildcard || (prefix && isNasRecord && sd === `${prefix}.nas`);
        return hasMatching && needle.endsWith(suffix);
      }),
    ) || null
  );
}

// 简化判断：任务里有任何 .nas.{rootDomain} 子域记录即视为已就绪
function hasNasDdnsRecords(tasks, rootDomain) {
  if (!rootDomain) return false;
  const suffix = `.nas.${rootDomain.toLowerCase()}`;
  return tasks.some((task) =>
    (task.Records || []).some((record) => {
      const sdData = record.SyncRecordData || {};
      const sd = String(sdData.SubDomainName || record.SubDomain || '').toLowerCase();
      const dn = String(sdData.DomainName || record.DomainName || '').toLowerCase();
      return dn === rootDomain.toLowerCase() && sd.endsWith('.nas');
    }),
  );
}

// 创建 *.nas.{rootDomain} AAAA 泛解析 DDNS 任务
// 注：Lucky v3 POST /api/ddns 对 payload 校验严格且 500 响应无 body，难以程序化创建。
// 这里改为返回明确指引，提示用户在 Lucky 后台手动添加 *.nas.{rootDomain} AAAA 记录。
async function createNasDdnsTask(config, rootDomain) {
  return {
    created: false,
    manual: true,
    message: `请到 Lucky 后台 → DDNS 任务 → 在 alidns 任务下为每个应用前缀添加 AAAA 记录（SubDomain=<前缀>.nas, DomainName=${rootDomain}）。当前面板仅做预检，不写入 DDNS（Lucky v3 POST 校验接口限制）。`,
  };
}

module.exports = {
  getLuckyDdnsTasks,
  findEsaDdnsTask,
  findDdnsTaskByType,
  parseSyncRecord,
  readRecordDetail,
  recordMatches,
  readRecordContent,
  generateRecordKey,
  recordMatchesCname,
  addDdnsRecord,
  addDdnsCnameRecord,
  addDdnsAaaaRecord,
  findNasDdnsTask,
  hasNasDdnsRecords,
  createNasDdnsTask,
};
