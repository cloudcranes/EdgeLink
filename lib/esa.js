// 阿里云 ESA SDK 封装：站点/回源规则/加速域名/证书的查询。
// 依赖：@alicloud/esa20240910（顶层 require）。
// 无全局状态。

const {
  default: EsaClient,
  ListSitesRequest,
  ListOriginRulesRequest,
  ListRecordsRequest,
  ListCertificatesRequest,
} = require('@alicloud/esa20240910');

function getEsaClient(esaConfig) {
  if (!esaConfig.accessKeyId || !esaConfig.accessKeySecret) {
    throw new Error('请先填写阿里云 ESA AccessKey ID 和 Secret');
  }
  return new EsaClient({
    accessKeyId: esaConfig.accessKeyId,
    accessKeySecret: esaConfig.accessKeySecret,
    regionId: 'cn-hangzhou',
    endpoint: 'esa.cn-hangzhou.aliyuncs.com',
  });
}

function esaErrorMessage(error) {
  const code = error && (error.code || error.Code);
  const message = error && (error.message || error.Message || error.data?.Message || String(error));
  return code ? `${code}: ${message}` : String(message || error);
}

async function esaListSites(creds) {
  const client = getEsaClient(creds);
  const request = new ListSitesRequest({ pageSize: 500 });
  const response = await client.listSites(request);
  return response.body?.sites || [];
}

async function esaListOriginRules(client, siteId) {
  const request = new ListOriginRulesRequest({
    siteId: Number(siteId),
    configType: 'rule',
    pageSize: 500,
  });
  const response = await client.listOriginRules(request);
  return response.body?.configs || [];
}

function extractEsaDomain(ruleExpression) {
  const match = String(ruleExpression || '').match(/http\.host\s+eq\s+"([^"]+)"/);
  return match ? match[1] : '';
}

async function esaListDomains(client, siteId) {
  const request = new ListRecordsRequest({
    siteId: Number(siteId),
    pageSize: 500,
  });
  const response = await client.listRecords(request);
  return (response.body?.records || []).map((record) => ({
    id: record.recordId,
    name: record.recordName,
    type: record.recordType,
    value: record.data?.value || '',
    recordCname: record.recordCname || '',
    proxied: !!record.proxied,
    hostPolicy: record.hostPolicy || record.HostPolicy || '',
    ttl: record.ttl ?? record.TTL ?? 0,
    sourceType: record.recordSourceType || record.SourceType || '',
    bizName: record.bizName || record.BizName || 'web',
    comment: record.comment || record.Comment || '',
  }));
}

async function esaListCertificates(client, siteId, keyword) {
  const request = new ListCertificatesRequest({
    siteId: Number(siteId),
    pageSize: 500,
    keyword: keyword || '',
  });
  const response = await client.listCertificates(request);
  const list = (response.body?.result || response.body?.certificates || response.body?.data || []).map((cert) => {
    // ESA 返回 SAN 字段类型不稳定：可能是字符串（单个域名）、数组、或 SANs/dnsNames 数组
    const rawSans = cert.sans ?? cert.SANs ?? cert.dnsNames ?? cert.SAN;
    const sans = Array.isArray(rawSans)
      ? rawSans
      : typeof rawSans === 'string' && rawSans
        ? rawSans.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    return {
      id: cert.id || cert.certId || cert.certificateId,
      name: cert.name,
      commonName: cert.commonName,
      type: cert.type,
      sans,
      notAfter: cert.notAfter || cert.NotAfter,
      notBefore: cert.notBefore || cert.NotBefore,
      status: cert.status,
    };
  });
  return list;
}

module.exports = {
  getEsaClient,
  esaErrorMessage,
  esaListSites,
  esaListOriginRules,
  extractEsaDomain,
  esaListDomains,
  esaListCertificates,
};
