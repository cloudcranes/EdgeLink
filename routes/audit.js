// 一致性巡检：面板配置 vs 实际 Lucky/ESA 状态 + 一键修复
const { GATEWAY_RULE_NAME } = require('../lib/constants');
const { readConfig } = require('../lib/config');
const { nasDomainOf, cdnDomainOf, validateLuckySelfReference } = require('../lib/normalize');
const { getLuckyRules, managedProxyKey, isManagedProxyKey, luckyLogin, luckyRequest } = require('../lib/lucky');
const { getEsaClient, esaListDomains } = require('../lib/esa');
const { getLuckyDdnsTasks } = require('../lib/ddns');
const { applyLucky, enableEsaDomain } = require('../lib/deploy');
const { pushServerLog } = require('../lib/logs');
const { asyncHandler } = require('../utils/http');

function register(app) {
  // 一致性巡检：面板配置 vs 实际 Lucky/ESA 状态
  app.get(
    '/api/audit',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const rootDomain = String(config.esa?.rootDomain || '').toLowerCase();
      const issues = [];
      const summary = { apps: 0, luckyRules: 0, esaDomains: 0, checkedAt: new Date().toISOString() };

      summary.apps = (config.apps || []).length;

      // 1. Lucky 子规则对比
      try {
        const { rules } = await getLuckyRules(config);
        const allProxies = (rules || []).flatMap((r) => r.ProxyList || []);
        summary.luckyRules = allProxies.length;
        const luckyDomains = new Set(allProxies.map((p) => (p.Domains || [])[0]).filter(Boolean));
        for (const app of config.apps || []) {
          const nas = nasDomainOf(app, config);
          if (!nas) continue;
          const proxy = allProxies.find((p) => (p.Domains || []).includes(nas));
          if (!proxy) {
            issues.push({ type: 'lucky-missing', level: 'error', app: app.name, detail: `Lucky 缺少 ${nas} 的反代子规则` });
          } else if (proxy.Enable !== (app.luckyEnabled !== false)) {
            issues.push({ type: 'lucky-enabled', level: 'warn', app: app.name, detail: `${nas} 反代开关不一致（Lucky=${proxy.Enable}, 面板=${app.luckyEnabled !== false}）` });
          }
          // 认证一致性：面板用网页认证（WebAuth），Lucky 上 WebAuth 或 EnableBasicAuth 任一开启都算"开"
          const proxyAuthOn = proxy.WebAuth === true || (proxy.EnableBasicAuth === true && !!proxy.BasicAuthUser);
          const appAuthOn = app.webAuth === true;
          if (proxyAuthOn !== appAuthOn) {
            issues.push({
              type: 'lucky-auth-mismatch',
              level: 'warn',
              app: app.name,
              detail: `${nas} 认证状态不一致（Lucky=${proxyAuthOn ? '开' : '关'}，面板=${appAuthOn ? '开' : '关'}）。请在面板重新点击「同步」或在 Lucky 后台手动调整`,
            });
          }
        }
        // lucky-prefix 专项：target 必须与 lucky.baseUrl host:port 一致，否则反代命中错误
        for (const app of config.apps || []) {
          if (app.prefix !== 'lucky') continue;
          try {
            validateLuckySelfReference(app, config);
          } catch (error) {
            issues.push({ type: 'lucky-self-misroute', level: 'error', app: app.name, detail: error.message });
          }
        }
        // 端口冲突扫描（跨所有 Lucky 规则）
        const portMap = new Map();
        for (const rule of rules || []) {
          const key = `${rule.ListenPort || '?'}/${rule.Network || '?'}`;
          if (!portMap.has(key)) portMap.set(key, []);
          portMap.get(key).push(rule.RuleName || '未命名');
        }
        for (const [key, names] of portMap) {
          if (names.length > 1) {
            issues.push({ type: 'port-conflict', level: 'warn', detail: `监听端口 ${key} 被多个规则占用：${[...new Set(names)].join('、')}` });
          }
        }
      } catch (error) {
        issues.push({ type: 'lucky-error', level: 'error', detail: `Lucky 读取失败：${error.message}` });
      }

      // 2. ESA 加速域名对比
      try {
        if (config.esa?.siteId) {
          const client = getEsaClient(config.esa);
          const domains = await esaListDomains(client, config.esa.siteId);
          summary.esaDomains = domains.length;
          const esaNames = new Set(domains.map((d) => d.name));
          for (const app of config.apps || []) {
            if (app.esaEnabled === false) continue;
            const cdn = cdnDomainOf(app, config).toLowerCase();
            if (!cdn) continue;
            if (!esaNames.has(cdn)) {
              issues.push({ type: 'esa-missing', level: 'error', app: app.name, detail: `ESA 缺少加速域名 ${cdn}` });
            }
          }
        } else {
          issues.push({ type: 'esa-not-configured', level: 'info', detail: '未选择 ESA 站点，跳过 ESA 对比' });
        }
      } catch (error) {
        issues.push({ type: 'esa-error', level: 'error', detail: `ESA 读取失败：${error.message}` });
      }

      // 3. Lucky DDNS CNAME 对比：ESA 域名已存在但 Lucky 任务里缺少对应的 .cdn CNAME
      try {
        if (config.lucky?.baseUrl && (config.lucky?.openToken || (config.lucky?.account && config.lucky?.password)) && rootDomain) {
          const tasks = await getLuckyDdnsTasks(config);
          const cdnCnameSet = new Set();
          for (const task of tasks || []) {
            for (const r of task.Records || []) {
              if (r.Type === 'CNAME' && String(r.SubDomain || '').endsWith('.cdn')) {
                cdnCnameSet.add(String(r.SubDomain).toLowerCase());
              }
            }
          }
          for (const app of config.apps || []) {
            if (app.esaEnabled === false) continue;
            const cdnSub = `${app.prefix}.cdn`.toLowerCase();
            if (!cdnCnameSet.has(cdnSub)) {
              issues.push({
                type: 'lucky-cname-missing',
                level: 'warn',
                app: app.name,
                detail: `Lucky DDNS 缺少 ${cdnSub} 的 CNAME 记录`,
              });
            }
          }
        }
      } catch (error) {
        issues.push({ type: 'lucky-dns-error', level: 'warn', detail: `Lucky DDNS 读取失败：${error.message}` });
      }

      issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
      res.json({ ok: true, summary, issues });
    }),
  );

  // 一键修复巡检差异：重查差异后按应用补齐 Lucky 子规则 / ESA 加速域名 + 回源规则
  // purgeOrphans 默认 dryRun=1：返回将被删除的孤儿清单；要真删带 confirm="yes-i-am-sure"
  app.post(
    '/api/audit/fix',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const logs = [];
      const targetAppId = req.body?.appId || null;
      const purgeOrphans = !!req.body?.purgeOrphans;
      const purgeOrphansDryRun = purgeOrphans && req.body?.confirm !== 'yes-i-am-sure';
      const rootDomain = String(config.esa?.rootDomain || '').toLowerCase();
      const { rules } = await getLuckyRules(config);
      const allProxies = (rules || []).flatMap((r) => r.ProxyList || []);
      // 收集面板 apps 期望的子规则 Key
      const managedKeys = new Set((config.apps || []).map((a) => managedProxyKey(a.id)));
      // 孤儿：Lucky 上存在但面板已已删除（无对应 app）的 lucky-esa-* 子规则
      const orphans = allProxies.filter((p) => isManagedProxyKey(p.Key) && !managedKeys.has(p.Key));
      if (purgeOrphansDryRun && orphans.length > 0) {
        return res.json({
          ok: true,
          dryRun: true,
          willRemove: orphans.map((o) => ({ key: o.Key, domains: o.Domains, locations: o.Locations })),
          message: `dryRun 模式：${orphans.length} 条孤儿将被删除。要真删请带 confirm="yes-i-am-sure"`,
        });
      }
      if (purgeOrphans && orphans.length > 0) {
        // 找出 Lucky 主规则（带 ProxyList 的那条），从 ProxyList 里过滤掉孤儿，回写
        const gatewayPort = Number(config.gateway.listenPort) || 8443;
        const gatewayRule =
          rules.find(
            (r) =>
              (config.gateway.ruleKey && r.RuleKey === config.gateway.ruleKey) ||
              r.RuleName === GATEWAY_RULE_NAME ||
              Number(r.ListenPort) === gatewayPort,
          ) || null;
        if (gatewayRule) {
          const orphanKeys = orphans.map((o) => o.Key);
          const before = gatewayRule.ProxyList.length;
          gatewayRule.ProxyList = gatewayRule.ProxyList.filter((p) => !orphanKeys.includes(p.Key));
          try {
            const { baseUrl, token } = await luckyLogin(config);
            await luckyRequest(baseUrl, token, 'PUT', `/api/webservice/rule/${gatewayRule.RuleKey}`, gatewayRule);
            logs.push({
              step: '孤儿 Lucky 子规则',
              status: 'ok',
              detail: `已删除 ${orphanKeys.length} 条孤儿（${before} → ${gatewayRule.ProxyList.length}）：${orphanKeys.join(', ')}`,
            });
          } catch (error) {
            logs.push({ step: '孤儿 Lucky 子规则', status: 'error', detail: error.message });
          }
        } else {
          logs.push({ step: '孤儿 Lucky 子规则', status: 'warn', detail: '未找到 Lucky 主规则，无法清理' });
        }
      }
      // 立即把 orphan 处理日志刷到服务端环形缓冲（fixable 为 0 时不会走到下面 pushServerLog）
      for (const item of logs) pushServerLog(item.step, item.status, item.detail);

      let esaNames = new Set();
      if (config.esa?.siteId) {
        const client = getEsaClient(config.esa);
        esaNames = new Set((await esaListDomains(client, config.esa.siteId)).map((d) => d.name));
      }
      // 收集 Lucky DDNS 已存在的 .cdn CNAME 子域；用于判断 lucky-cname-missing
      let luckyCdnCnameSet = new Set();
      if (config.lucky?.baseUrl && (config.lucky?.openToken || (config.lucky?.account && config.lucky?.password))) {
        try {
          const tasks = await getLuckyDdnsTasks(config);
          for (const task of tasks || []) {
            for (const r of task.Records || []) {
              if (r.Type === 'CNAME' && String(r.SubDomain || '').endsWith('.cdn')) {
                luckyCdnCnameSet.add(String(r.SubDomain).toLowerCase());
              }
            }
          }
        } catch {}
      }
      const fixable = [];
      for (const app of config.apps || []) {
        if (targetAppId && app.id !== targetAppId) continue;
        const nas = nasDomainOf(app, config);
        const proxy = nas ? allProxies.find((p) => (p.Domains || []).includes(nas)) : null;
        const luckyNeedsFix = !!nas && (!proxy || proxy.Enable !== (app.luckyEnabled !== false));
        const cdn = `${app.prefix}.cdn.${rootDomain}`.toLowerCase();
        const cdnSub = `${app.prefix}.cdn`.toLowerCase();
        const esaEnabled = app.esaEnabled !== false && !!config.esa?.siteId && !!rootDomain;
        const esaMissing = esaEnabled && !esaNames.has(cdn);
        const cnameMissing = esaEnabled && !luckyCdnCnameSet.has(cdnSub);
        // 任何 ESA 维度（加速域名缺失 或 Lucky CNAME 缺失）都触发幂等 enableEsaDomain
        const esaNeedsFix = esaEnabled && (esaMissing || cnameMissing);
        if (luckyNeedsFix || esaNeedsFix) {
          fixable.push({ app, luckyNeedsFix, esaNeedsFix, esaMissing, cnameMissing });
        }
      }
      if (fixable.length === 0) {
        return res.json({ ok: true, fixed: [], errors: [], logs: [], message: '未发现可修复的差异' });
      }
      const fixed = [];
      const errors = [];
      for (const { app, luckyNeedsFix, esaNeedsFix } of fixable) {
        const label = app.name || app.prefix;
        try {
          if (luckyNeedsFix) {
            await applyLucky(config, logs, app.id);
          }
          if (esaNeedsFix) {
            const nas = nasDomainOf(app, config);
            const cdn = `${app.prefix}.cdn.${rootDomain}`.toLowerCase();
            const r = await enableEsaDomain(config, cdn, nas, `面板修复 ${label}`);
            logs.push({ step: '修复 ESA', status: 'ok', detail: r.message });
          }
          fixed.push(label);
        } catch (error) {
          errors.push({ app: label, message: error.message });
          logs.push({ step: '修复', status: 'error', detail: `${label}: ${error.message}` });
        }
      }
      for (const item of logs) {
        pushServerLog(item.step, item.status, item.detail);
      }
      res.json({ ok: true, fixed, errors, logs, message: fixed.length ? `已修复 ${fixed.join('、')}` : '修复未完成' });
    }),
  );
}

module.exports = { register };
