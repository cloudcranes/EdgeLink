// 总览统计：应用数 / Lucky 子规则 / ESA 域名 / DDNS / 证书
const { readConfig } = require('../lib/config');
const { getLuckyRules, isManagedProxyKey, luckyLogin, luckyRequest } = require('../lib/lucky');
const { getEsaClient, esaListDomains, esaListCertificates } = require('../lib/esa');
const { getLuckyDdnsTasks, hasNasDdnsRecords, parseSyncRecord } = require('../lib/ddns');
const { asyncHandler } = require('../utils/http');

function register(app) {
  app.get(
    '/api/summary',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const summary = {
        apps: (config.apps || []).length,
        luckySubRules: 0,
        luckyPanelProxies: 0,
        esaDomains: 0,
        esaPanelDomains: 0,
        luckyDdnsTasks: 0,
        luckyDdnsNasTask: false,
        luckySsl: 0,
        luckyNasSsl: false,
        esaCertificates: 0,
        esaNasCertificate: false,
        rootDomain: config.esa?.rootDomain || '',
        configured: {
          lucky: !!config.lucky?.baseUrl && (!!config.lucky?.openToken || !!(config.lucky?.account && config.lucky?.password)),
          esa: !!config.esa?.accessKeyId && !!config.esa?.accessKeySecret && !!config.esa?.siteId,
        },
      };
      try {
        const { rules } = await getLuckyRules(config);
        const allProxies = (rules || []).flatMap((r) => r.ProxyList || []);
        summary.luckySubRules = allProxies.length;
        summary.luckyPanelProxies = allProxies.filter((p) => isManagedProxyKey(p.Key)).length;
      } catch {}
      // 直接复用现有 ESA 域名获取
      try {
        if (config.esa?.siteId) {
          const client = getEsaClient(config.esa);
          const domains = await esaListDomains(client, config.esa.siteId);
          summary.esaDomains = domains.length;
          summary.esaPanelDomains = domains.filter((d) => d.name && d.name.endsWith('.cdn.' + summary.rootDomain)).length;
          const certs = await esaListCertificates(client, config.esa.siteId, '');
          summary.esaCertificates = certs.length;
          if (summary.rootDomain) {
            // 修：原代码查的是 `.cdn.` 包含（命名是 nas 但逻辑是 cdn），现与 nas-check 对齐查 `*.nas.${root}` SAN
            const target = `*.nas.${summary.rootDomain}`.toLowerCase();
            summary.esaNasCertificate = certs.some((c) =>
              Array.isArray(c.sans) && c.sans.some((s) => String(s).toLowerCase() === target),
            );
          }
        }
      } catch {}
      try {
        const tasks = await getLuckyDdnsTasks(config);
        summary.luckyDdnsTasks = tasks.length;
        summary.luckyDdnsNasTask = hasNasDdnsRecords(tasks, summary.rootDomain);
      } catch {}
      try {
        if (config.lucky?.baseUrl && (config.lucky?.openToken || (config.lucky?.account && config.lucky?.password))) {
          const { baseUrl, token } = await luckyLogin(config);
          const data = await luckyRequest(baseUrl, token, 'GET', '/api/ssl');
          const list = data.list || [];
          summary.luckySsl = list.length;
          if (summary.rootDomain) {
            const target = `*.nas.${summary.rootDomain}`.toLowerCase();
            // 与 /api/lucky/ssl/nas-check 对齐：SAN + Remark 双匹配（v2.27.2 SAN 常空，靠 Remark 兜底）
            summary.luckyNasSsl = list.some((cert) => {
              const ext = parseSyncRecord(cert.ExtParams) || {};
              const info = parseSyncRecord(cert.CertsInfo) || {};
              const sans = [
                ...(ext.SubDomainList || []),
                ...(info.SAN ? [info.SAN] : []),
                ...(ext.acmeDomains || []),
              ];
              if (sans.some((s) => String(s).toLowerCase() === target)) return true;
              if (String(cert.Remark || '').toLowerCase() === target) return true;
              return false;
            });
          }
        }
      } catch {}
      res.json({ ok: true, summary });
    }),
  );
}

module.exports = { register };
