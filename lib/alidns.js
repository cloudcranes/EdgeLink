// alidns 直连（仅用于清理脏解析残留；日常 DNS 写入仍由 Lucky DDNS 负责）。
// 依赖：@alicloud/alidns20150109。
// getAlidnsClient 接受 getDdnsTasks 回调以避免与 lib/ddns.js 形成循环依赖。

const {
  default: AlidnsClient,
  DescribeDomainRecordsRequest,
  DeleteDomainRecordRequest,
} = require('@alicloud/alidns20150109');

async function getAlidnsClient(config, { preferLucky = true, getDdnsTasks } = {}) {
  let id = '';
  let secret = '';
  if (preferLucky && typeof getDdnsTasks === 'function') {
    try {
      const tasks = await getDdnsTasks(config);
      const t = tasks.find((x) => ((x.DNS || {}).Name || '') === 'alidns' && x.DNS.ID && x.DNS.Secret);
      if (t) {
        id = t.DNS.ID;
        secret = t.DNS.Secret;
      }
    } catch {
      // Lucky 不可用则回退
    }
  }
  if (!id || !secret) {
    id = config.esa.accessKeyId;
    secret = config.esa.accessKeySecret;
  }
  if (!id || !secret) throw new Error('缺少 alidns 凭据（Lucky DDNS 任务或 ESA AccessKey）');
  return new AlidnsClient({ accessKeyId: id, accessKeySecret: secret, endpoint: 'alidns.cn-hangzhou.aliyuncs.com' });
}

// 查某主域下所有解析记录（返回精简结构）
async function alidnsListRecords(config, domainName, { getDdnsTasks } = {}) {
  const client = await getAlidnsClient(config, { getDdnsTasks });
  const req = new DescribeDomainRecordsRequest({ domainName, pageSize: 500 });
  const res = await client.describeDomainRecords(req);
  const list = res.body?.domainRecords?.record || [];
  return list.map((r) => ({
    recordId: r.recordId,
    domainName: r.domainName,
    RR: r.RR,
    type: r.type,
    value: r.value,
    ttl: r.TTL,
    line: r.line,
    status: r.status,
    locked: r.locked === true,
    weight: r.weight,
  }));
}

async function alidnsDeleteRecord(config, recordId, { getDdnsTasks } = {}) {
  const client = await getAlidnsClient(config, { getDdnsTasks });
  await client.deleteDomainRecord(new DeleteDomainRecordRequest({ recordId: String(recordId) }));
}

module.exports = {
  getAlidnsClient,
  alidnsListRecords,
  alidnsDeleteRecord,
};
