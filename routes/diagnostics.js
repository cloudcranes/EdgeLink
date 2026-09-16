// 自愈诊断：扫描所有 *.cdn.${root} 应用，检测 ESA 加速域名 vs alidns CNAME 的一致性
// 返回结构供前端"一键修复"按钮使用：
//   - status: 'ok' | 'cname-missing' | 'esa-missing' | 'cname-mismatch'
//   - fixable: true 表示可以调用 /api/esa/enable-domain 自愈
const { readConfig } = require('../lib/config');
const { normalizeDomain } = require('../lib/normalize');
const { getEsaClient, esaListDomains } = require('../lib/esa');
const { alidnsListRecords } = require('../lib/alidns');
const { enableEsaDomain } = require('../lib/deploy');
const { pushServerLog } = require('../lib/logs');
const { asyncHandler } = require('../utils/http');

function register(app) {
  // GET /api/diagnostics/esa-cname?appId=xxx
  // 不传 appId：扫描所有 esaEnabled=true 的应用
  app.get(
    '/api/diagnostics/esa-cname',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const rootDomain = String(config.esa?.rootDomain || '').trim().toLowerCase();
      const siteId = Number(config.esa?.siteId);
      const apps = Array.isArray(config.apps) ? config.apps : [];
      const targets = req.query.appId
        ? apps.filter((a) => a.id === req.query.appId)
        : apps.filter((a) => a.esaEnabled !== false && a.prefix);
      if (!rootDomain) {
        return res.json({ ok: true, rootDomain: '', items: [], message: '未配置站点根域' });
      }
      if (!siteId) {
        return res.json({ ok: true, rootDomain, items: targets.map((a) => ({
          appId: a.id, prefix: a.prefix, name: a.name, domain: `${a.prefix}.cdn.${rootDomain}`, status: 'esa-missing', message: '未选择 ESA 站点', fixable: false,
        })), message: '未选择 ESA 站点' });
      }

      let esaList = [];
      let dnsList = [];
      try {
        const client = getEsaClient(config.esa);
        esaList = await esaListDomains(client, siteId);
      } catch (error) {
        return res.json({ ok: true, rootDomain, items: [], message: `ESA 列表查询失败：${error.message}` });
      }
      try {
        dnsList = await alidnsListRecords(config, rootDomain);
      } catch (error) {
        // alidns 查不到不阻断（用户可能没在 ESA 配 AccessKey），后续 status 用 dnsUnknown 标记
        pushServerLog('自愈诊断', 'warn', `alidns 解析查询失败：${error.message}`);
      }

      const items = targets.map((app) => {
        const domain = `${app.prefix}.cdn.${rootDomain}`.toLowerCase();
        const target = normalizeDomain(app.target);
        const esaRec = esaList.find((r) => normalizeDomain(r.name) === domain) || null;
        const cnameTarget = (esaRec && esaRec.recordCname) || '';
        // alidns 中找与该域名同名的 CNAME 记录
        const dnsRec = dnsList.find((r) => {
          const fqdn = r.RR && r.RR !== '@'
            ? `${r.RR}.${r.domainName}`.toLowerCase()
            : (r.domainName || '').toLowerCase();
          return fqdn === domain && (r.type || '').toUpperCase() === 'CNAME';
        });
        const dnsValue = dnsRec ? String(dnsRec.value || '').toLowerCase() : '';
        const expectedCname = cnameTarget.toLowerCase();

        let status, message, fixable = false;
        if (!esaRec) {
          status = 'esa-missing';
          message = 'ESA 加速域名未创建';
          fixable = true;
        } else if (!cnameTarget) {
          status = 'esa-no-cname';
          message = 'ESA 记录缺少接入 CNAME（控制台异常）';
          fixable = false;
        } else if (!dnsRec) {
          status = 'cname-missing';
          message = `alidns 无 CNAME 解析（应指向 ${cnameTarget}）`;
          fixable = true;
        } else if (dnsValue && dnsValue !== expectedCname) {
          status = 'cname-mismatch';
          message = `alidns CNAME 指向错误：${dnsValue}（应指向 ${expectedCname}）`;
          fixable = true;
        } else {
          status = 'ok';
          message = 'ESA 加速域名 + alidns CNAME 一致';
        }
        return {
          appId: app.id,
          prefix: app.prefix,
          name: app.name,
          target,
          domain,
          cnameTarget,
          dnsValue: dnsValue || '',
          status,
          message,
          fixable,
        };
      });
      res.json({ ok: true, rootDomain, items });
    }),
  );

  // POST /api/diagnostics/esa-cname/fix { appId }
  // 幂等：调 enableEsaDomain，自动跳过已存在记录、补 CNAME
  app.post(
    '/api/diagnostics/esa-cname/fix',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const appId = String(req.body?.appId || '');
      const app = (config.apps || []).find((a) => a.id === appId);
      if (!app) throw new Error('找不到应用');
      if (app.esaEnabled === false) throw new Error('该应用未启用 ESA 加速');
      const rootDomain = String(config.esa?.rootDomain || '').trim().toLowerCase();
      const siteId = Number(config.esa?.siteId);
      if (!siteId) throw new Error('未选择 ESA 站点');
      const domain = `${app.prefix}.cdn.${rootDomain}`.toLowerCase();
      const target = normalizeDomain(app.target);
      if (!domain || !target) throw new Error('缺少域名或回源目标');
      const result = await enableEsaDomain(config, domain, target, '');
      pushServerLog(
        '自愈修复 ESA CNAME',
        result.ddns?.error ? 'error' : 'ok',
        `${domain}：ESA ${result.esa?.existed ? '已存在' : '已创建'} + DDNS CNAME ${
          result.ddns?.added ? '已补' : (result.ddns?.updated ? '已更新' : '已存在')
        }${result.ddns?.error ? `（${result.ddns.error}）` : ''}`,
      );
      res.json({ ok: true, ...result, fixedAppId: appId, fixedDomain: domain });
    }),
  );
}

module.exports = { register };
