// Lucky 业务路由：规则 / 分组 / 子规则开关 / SSL / 连接测试
const { readConfig, mergeConfig } = require('../lib/config');
const { luckyLogin, luckyRequest, getLuckyRules, isManagedProxyKey } = require('../lib/lucky');
const { parseSyncRecord } = require('../lib/ddns');
const { asyncHandler } = require('../utils/http');

function register(app) {
  app.get(
    '/api/lucky/rules',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const { rules } = await getLuckyRules(config);
      const subRules = [];
      for (const rule of rules || []) {
        for (const proxy of rule.ProxyList || []) {
          subRules.push({
            key: proxy.Key,
            managed: isManagedProxyKey(proxy.Key),
            name: proxy.Remark,
            domains: proxy.Domains || [],
            locations: proxy.Locations || [],
            enabled: proxy.Enable !== false,
            enableBasicAuth: proxy.EnableBasicAuth === true,
            webAuth: proxy.WebAuth === true || (proxy.OtherParams && proxy.OtherParams.WebAuth === true),
            groupKey: proxy.GroupKey || '',
            ruleKey: rule.RuleKey,
            listenPort: rule.ListenPort,
          });
        }
      }
      res.json({ ok: true, rules: subRules });
    }),
  );

  // Lucky 分组列表：所有 group + 每个分组的子规则数
  app.get(
    '/api/lucky/groups',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const { baseUrl, token } = await luckyLogin(config);
      const data = await luckyRequest(baseUrl, token, 'GET', '/api/webservice/groups');
      const groups = data.list || data.groups || [];
      let counts = {};
      try {
        const c = await luckyRequest(baseUrl, token, 'GET', '/api/webservice/groups/subrulecount');
        counts = c.counts || c.data || {};
      } catch {
        counts = {};
      }
      res.json({ ok: true, groups, counts });
    }),
  );

  // Lucky 现存子规则开关（反代 Enable / 网页认证 BasicAuth）
  app.post(
    '/api/lucky/proxy/toggle',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const proxyKey = String(req.body.proxyKey || '');
      const field = String(req.body.field || '');
      const value = !!req.body.value;
      if (!proxyKey || !['luckyEnabled', 'webAuth'].includes(field)) {
        throw new Error('参数无效');
      }
      const { baseUrl, token, rules } = await getLuckyRules(config);
      const rule = (rules || []).find((r) =>
        (r.ProxyList || []).some((p) => p.Key === proxyKey),
      );
      if (!rule) throw new Error('未找到该子规则');
      const proxy = rule.ProxyList.find((p) => p.Key === proxyKey);
      if (field === 'luckyEnabled') {
        proxy.Enable = value;
      } else {
        // 网页认证（WebAuth）：浏览器走 Lucky 内置登录页，非浏览器回退 BasicAuth。
        // 用户要求"认证用网页认证不用 basic"：开启时写 WebAuth=true + BasicAuthUserList，
        // 关闭时清掉 WebAuth + 认证信息，EnableBasicAuth 始终为 false。
        const ba = config.lucky && config.lucky.basicAuth;
        const users = (ba && ba.users) || [];
        const first = users[0] || {};
        proxy.WebAuth = value;
        if (!proxy.OtherParams) proxy.OtherParams = {};
        proxy.OtherParams.WebAuth = value;
        proxy.EnableBasicAuth = false;
        proxy.BasicAuthUser = value ? (first.username || '') : '';
        proxy.BasicAuthPasswd = value ? (first.password || '') : '';
        proxy.BasicAuthUserList = value
          ? users.map((u) => (u.username || '') + ':' + (u.password || '')).filter((l) => l !== ':').join('\n')
          : '';
        // 定制模式高级开关：Lucky UI 从顶层读取，确保新创建/更新子规则带上
        if (proxy.EasyLucky === undefined) proxy.EasyLucky = true;
        if (proxy.AutoProxyLocation === undefined) proxy.AutoProxyLocation = true;
        if (proxy.EnableAccessLog === undefined) proxy.EnableAccessLog = true;
      }
      try {
        // Lucky 的 PUT /api/webservice/rule/{ruleKey} 期望整个主规则对象（含 RuleKey/DefaultProxy/ProxyList），
        // 不能只 PUT 单个子规则 proxy，否则 Lucky 返回 500。
        await luckyRequest(baseUrl, token, 'PUT', '/api/webservice/rule/' + rule.RuleKey, rule);
      } catch (error) {
        // 部分 Lucky 版本对未知字段严格返回 500，但实际已落盘——回读校验
        const refreshed = await luckyRequest(baseUrl, token, 'GET', '/api/webservice/rules');
        const recheck = (refreshed.ruleList || refreshed.list || []).flatMap((r) => r.ProxyList || []).find((p) => p.Key === proxyKey);
        const gotValue = field === 'luckyEnabled' ? recheck?.Enable : recheck?.WebAuth === true;
        const wantValue = field === 'luckyEnabled' ? value : value;
        if (gotValue === wantValue) {
          // 已落盘，500 是 Lucky 对 PUT 中未知字段的抱怨；放行
          res.json({ ok: true, message: (field === 'luckyEnabled' ? '反代' : '网页认证') + (value ? '已开启' : '已关闭') + '（Lucky 忽略部分字段警告，已生效）' });
          return;
        }
        throw error;
      }
      res.json({ ok: true, message: (field === 'luckyEnabled' ? '反代' : '网页认证') + (value ? '已开启' : '已关闭') });
    }),
  );

  app.get(
    '/api/lucky/ssl',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const { baseUrl, token } = await luckyLogin(config);
      const data = await luckyRequest(baseUrl, token, 'GET', '/api/ssl');
      const list = data.list || [];
      const parsed = list.map((cert) => {
        const ext = parseSyncRecord(cert.ExtParams) || {};
        const info = parseSyncRecord(cert.CertsInfo) || {};
        const sansFromExt = ext.SubDomainList || [];
        const sansFromInfo = info.SAN ? [info.SAN] : [];
        return {
          key: cert.Key,
          remark: cert.Remark,
          enable: cert.Enable !== false,
          addFrom: cert.AddFrom,
          san: sansFromExt.length ? sansFromExt : sansFromInfo,
          notBefore: info.NotBeforeTime || cert.NotBeforeTime,
          notAfter: info.NotAfterTime || cert.NotAfterTime,
          acmeDomains: ext.acmeDomains || [],
          acmeDNS: ext.acmeDNSServer,
          acmeRunning: cert.ACMEing === true,
        };
      });
      res.json({ ok: true, certificates: parsed });
    }),
  );

  app.get(
    '/api/lucky/ssl/nas-check',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const rootDomain = String(req.query.rootDomain || config.esa?.rootDomain || '').trim().toLowerCase();
      if (!rootDomain) {
        throw new Error('缺少站点根域');
      }
      const { baseUrl, token } = await luckyLogin(config);
      const data = await luckyRequest(baseUrl, token, 'GET', '/api/ssl');
      const list = data.list || [];
      const target = `*.nas.${rootDomain}`;
      // 同时按 SAN 字符串、证书 Remark、acmeDomains 三处匹配（SAN 字段在 v2.27.2 经常为空，靠 Remark 兜底）
      const found = list.find((cert) => {
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
      if (!found) {
        return res.json({
          ok: true,
          exists: false,
          target,
          message: `未找到 ${target} 的 SSL 证书，请到 Lucky 后台申请 ACME 证书（AddFrom=acme，SAN 包含 ${target}，DNS 验证选 alidns）`,
        });
      }
      const ext = parseSyncRecord(found.ExtParams) || {};
      const info = parseSyncRecord(found.CertsInfo) || {};
      return res.json({
        ok: true,
        exists: true,
        target,
        certificate: {
          key: found.Key,
          remark: found.Remark,
          notAfter: info.NotAfterTime || found.NotAfterTime,
          san: ext.SubDomainList || (info.SAN ? [info.SAN] : []),
          acmeDNS: ext.acmeDNSServer,
        },
      });
    }),
  );

  app.post(
    '/api/lucky/test',
    asyncHandler(async (req, res) => {
      const current = readConfig();
      const candidate = mergeConfig(current, req.body || {});
      await luckyLogin(candidate);
      res.json({ ok: true });
    }),
  );
}

module.exports = { register };
