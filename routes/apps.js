// 应用路由：部署 / 状态 / 热更 / 删除（含破坏性保护：dryRun/confirm）
const { GATEWAY_RULE_NAME } = require('../lib/constants');
const { readConfig, writeConfig, mergeConfig, sanitizeConfig } = require('../lib/config');
const { normalizeDomain, normalizeTarget, certificateCoversDomain, validateLuckySelfReference, cdnDomainOf } = require('../lib/normalize');
const { getLuckyRules, managedProxyKey, luckyLogin, luckyRequest } = require('../lib/lucky');
const { getEsaClient, esaListCertificates } = require('../lib/esa');
const { getLuckyDdnsTasks } = require('../lib/ddns');
const { deploy: deployFn, disableEsaDomain, deleteDdnsRecords } = require('../lib/deploy');
const { liveCheckState, setAppStatus, scheduleLiveCheck } = require('../lib/health');
const { pushServerLog } = require('../lib/logs');
const { asyncHandler } = require('../utils/http');

function register(app) {
  app.post(
    '/api/deploy',
    asyncHandler(async (req, res) => {
      const config = mergeConfig(readConfig(), req.body.config || req.body);
      const rootDomain = String(config.esa?.rootDomain || '').trim().toLowerCase();
      const siteId = Number(config.esa.siteId);
      const deployApps = req.body.appId
        ? config.apps.filter((app) => app.id === req.body.appId)
        : config.apps;
      const parts = req.body.parts || null;
      const selected = new Set(
        Array.isArray(parts) && parts.length > 0
          ? parts.filter((p) => p === 'lucky' || p === 'esa')
          : ['lucky', 'esa'],
      );
      if (selected.has('esa') && siteId && rootDomain) {
        const client = getEsaClient(config.esa);
        const certs = await esaListCertificates(client, siteId, '');
        const sansAll = [];
        for (const c of certs) {
          if (Array.isArray(c.sans)) {
            for (const s of c.sans) sansAll.push(String(s));
          }
        }
        const missing = [];
        for (const app of deployApps) {
          const cdn = `${app.prefix}.cdn.${rootDomain}`.toLowerCase();
          const covered = sansAll.some((s) => certificateCoversDomain(s, cdn));
          if (!covered) {
            missing.push(cdn);
          }
        }
        if (missing.length > 0) {
          throw new Error(
            `ESA 证书未覆盖：${missing.join('、')}。请到 ESA 控制台申请覆盖 *.cdn.${rootDomain} 的证书（含 SAN *.cdn.${rootDomain} 或精确域名）后再部署`,
          );
        }
      }
      const logs = [];
      const appId = req.body.appId || null;
      await deployFn(config, appId, parts, logs);
      for (const item of logs) {
        pushServerLog(item.step, item.status, item.detail);
      }
      res.json({ ok: true, logs, config: sanitizeConfig(config) });
    }),
  );

  // 应用状态查询：返回每个应用的 status + cdnUrl + lastError + lastCheckedAt
  app.get(
    '/api/apps/status',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const items = (config.apps || []).map((app) => ({
        id: app.id,
        name: app.name || app.prefix,
        prefix: app.prefix,
        status: app.status || 'pending',
        cdnUrl: app.cdnUrl || (app.esaEnabled !== false ? `https://${cdnDomainOf(app, config)}` : ''),
        lastError: app.lastError || '',
        lastCheckedAt: app.lastCheckedAt || '',
      }));
      res.json({ ok: true, items });
    }),
  );

  // 手动重试：清掉旧 timer 重新探测
  app.post(
    '/api/apps/status/recheck',
    asyncHandler(async (req, res) => {
      const appId = String(req.body?.appId || '');
      if (!appId) throw new Error('缺少 appId');
      const existing = liveCheckState.get(appId);
      if (existing && existing.timer) {
        clearTimeout(existing.timer);
      }
      liveCheckState.delete(appId);
      await setAppStatus(appId, 'building');
      scheduleLiveCheck(appId);
      res.json({ ok: true, message: '已重新探测' });
    }),
  );

  // 热更单应用字段（prefix/target/name/group/认证/开关）：写 config 后立即部署该 app
  // query ?migrate=1 同时把旧 prefix 的 ESA 加速域名 + DDNS CNAME 也迁过去（默认丢弃旧域名）
  app.patch(
    '/api/apps/:id',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const appId = String(req.params.id || '');
      const migrate = String(req.query.migrate || '') === '1';
      const preview = String(req.query.preview || '') === '1' || req.body?.preview === true;
      const idx = (config.apps || []).findIndex((a) => a.id === appId);
      if (idx < 0) throw new Error(`找不到应用: ${appId}`);
      const app = config.apps[idx];
      const before = { ...app };
      const editable = ['name', 'prefix', 'target', 'group', 'luckyEnabled', 'esaEnabled', 'webAuth'];
      for (const k of editable) {
        if (k in (req.body || {})) {
          if (k === 'prefix') {
            app.prefix = normalizeDomain(req.body.prefix);
          } else if (k === 'target') {
            app.target = normalizeTarget(req.body.target);
          } else if (k === 'luckyEnabled' || k === 'esaEnabled') {
            app[k] = !!req.body[k];
          } else if (k === 'webAuth') {
            app.webAuth = !!req.body.webAuth;
          } else {
            app[k] = req.body[k];
          }
        }
      }
      validateLuckySelfReference(app, config);
      if (preview) {
        const plan = {
          before,
          after: { ...app },
          changed: Object.keys(req.body || {}).filter((k) => editable.includes(k) && before[k] !== app[k]),
          willDeleteOldCdn: before.prefix !== app.prefix && !!before.prefix && !!config.esa?.siteId,
          willDeleteOldDdnsCname: before.prefix !== app.prefix && !!before.prefix,
          willDeploy: !!(app.luckyEnabled !== false || (app.esaEnabled !== false && config.esa?.siteId)),
          message: 'preview 模式：以下变更将发生；不带 preview=1 才会真正执行',
        };
        return res.json({ ok: true, preview: true, plan });
      }
      config.apps[idx] = app;
      writeConfig(config);

      const logs = [];
      // 仅当 prefix/target 实际变更时迁移
      const prefixChanged = before.prefix !== app.prefix;
      if (prefixChanged && !migrate) {
        // 默认：丢弃旧 prefix 的 ESA 域名 + DDNS CNAME，避免残留
        if (before.prefix && config.esa?.siteId && config.esa?.rootDomain) {
          const oldCdn = `${before.prefix}.cdn.${config.esa.rootDomain}`.toLowerCase();
          try {
            const r = await disableEsaDomain(config, oldCdn);
            logs.push({
              step: 'ESA 旧域名',
              status: r.deleted ? 'ok' : 'warn',
              detail: r.deleted ? `已删除旧 ESA 域名 ${oldCdn}` : `未删除 ${oldCdn}（${r.reason}）`,
            });
          } catch (error) {
            logs.push({ step: 'ESA 旧域名', status: 'error', detail: error.message });
          }
        }
        if (before.prefix && config.esa?.rootDomain) {
          try {
            const tasks = await getLuckyDdnsTasks(config);
            const target = tasks.find((t) => ((t.DNS || {}).Name || '') === 'alidns') || tasks[0];
            if (target) {
              const { baseUrl, token } = await luckyLogin(config);
              const detail = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${target.TaskKey}`);
              const task = detail.task || detail.data;
              const before2 = (task.Records || []).length;
              const oldSub = `${before.prefix}.cdn`;
              task.Records = (task.Records || []).filter((r) => {
                const sd = (r.SyncRecordData && r.SyncRecordData.SubDomainName) || r.SubDomain || '';
                return String(sd).toLowerCase() !== oldSub.toLowerCase();
              });
              await luckyRequest(baseUrl, token, 'PUT', `/api/ddns?key=${target.TaskKey}`, task);
              logs.push({
                step: 'DDNS 旧 CNAME',
                status: task.Records.length < before2 ? 'ok' : 'warn',
                detail: task.Records.length < before2 ? `已删除 ${oldSub}` : `未找到 ${oldSub}`,
              });
            }
          } catch (error) {
            logs.push({ step: 'DDNS 旧 CNAME', status: 'error', detail: error.message });
          }
        }
      }

      // 单应用 deploy（lucky + esa 二选一根据开关）
      const parts = [];
      if (app.luckyEnabled !== false) parts.push('lucky');
      if (app.esaEnabled !== false && config.esa?.siteId) parts.push('esa');
      if (parts.length > 0) {
        try {
          await deployFn(config, app.id, parts, logs);
        } catch (error) {
          logs.push({ step: '部署', status: 'error', detail: error.message });
        }
      }

      for (const item of logs) pushServerLog(item.step, item.status, item.detail);
      res.json({
        ok: true,
        before,
        app,
        logs,
        config: sanitizeConfig(config),
        message: `应用 ${app.prefix} 已更新` + (logs.some((l) => l.status === 'error') ? '（部分失败）' : ''),
      });
    }),
  );

  // 删除应用：config 移除 + Lucky 子规则同步删除（lucky-esa-<id>）+ 重 PUT 主规则。
  // ESA 加速域名保留不删（用户可能还想用），DDNS CNAME 保留不删（同理）。
  app.delete(
    '/api/apps/:id',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const appId = String(req.params.id || '');
      const purge = String(req.query.purge || '') === '1';
      const dryRun = String(req.query.dryRun || '') === '1' || req.body?.dryRun === true;
      const confirm = String(req.query.confirm || '') === String(appId) || req.body?.confirm === String(appId);
      const idx = (config.apps || []).findIndex((a) => a.id === appId);
      if (idx < 0) throw new Error(`找不到应用: ${appId}`);
      const removed = config.apps[idx];
      // purge 时将要精确删除的 DDNS 记录（root+sub+type 匹配，预览与实际删除用同一份目标）
      const ddnsPurgeTargets = (prefix, rootDomain) => {
        if (!prefix || !rootDomain) return [];
        const root = normalizeDomain(rootDomain);
        return [
          { sub: `${prefix}.cdn`, type: 'CNAME' },
          { sub: `${prefix}.nas`, type: 'AAAA' },
        ];
      };
      // dryRun：返回将被删除的 Lucky 子规则 / ESA 加速域名 / DDNS 记录，但不执行
      if (dryRun) {
        const plan = { appId, prefix: removed.prefix, name: removed.name, willRemove: { luckySubRule: null, esaDomain: null, ddnsRecord: null }, purge, confirmRequired: true };
        try {
          const { rules } = await getLuckyRules(config);
          const gatewayPort = Number(config.gateway.listenPort) || 8443;
          const existing = rules.find((r) => (config.gateway.ruleKey && r.RuleKey === config.gateway.ruleKey) || r.RuleName === GATEWAY_RULE_NAME || Number(r.ListenPort) === gatewayPort);
          if (existing) {
            const proxy = (existing.ProxyList || []).find((p) => p.Key === managedProxyKey(appId));
            if (proxy) plan.willRemove.luckySubRule = { key: proxy.Key, domains: proxy.Domains, locations: proxy.Locations };
          }
        } catch (error) { plan.luckyLookupError = error.message; }
        if (purge && removed.esaEnabled !== false && config.esa?.siteId && config.esa?.rootDomain && removed.prefix) {
          const cdn = `${removed.prefix}.cdn.${config.esa.rootDomain}`.toLowerCase();
          plan.willRemove.esaDomain = cdn;
        }
        if (purge) {
          const targets = ddnsPurgeTargets(removed.prefix, config.esa?.rootDomain);
          if (targets.length) {
            plan.willRemove.ddnsRecord = targets.map((t) => `${t.sub} (${t.type})`).join(' + ');
          }
        }
        plan.confirmToken = appId;
        plan.message = `dryRun 模式：以下条目将被删除。要继续，请带 confirm=${appId}`;
        return res.json({ ok: true, dryRun: true, plan });
      }
      if (!confirm) {
        throw new Error(`删除操作是破坏性的，必须带 confirm=${appId} 参数（或 dryRun=1 先预览）`);
      }
      const logs = [];

      let luckyRemoved = false;
      try {
        const { rules } = await getLuckyRules(config);
        const gatewayPort = Number(config.gateway.listenPort) || 8443;
        const existing =
          rules.find(
            (r) =>
              (config.gateway.ruleKey && r.RuleKey === config.gateway.ruleKey) ||
              r.RuleName === GATEWAY_RULE_NAME ||
              Number(r.ListenPort) === gatewayPort,
          ) || null;
        if (existing && (existing.ProxyList || []).some((p) => p.Key === managedProxyKey(appId))) {
          const before = existing.ProxyList.length;
          existing.ProxyList = existing.ProxyList.filter((p) => p.Key !== managedProxyKey(appId));
          const { baseUrl, token } = await luckyLogin(config);
          await luckyRequest(baseUrl, token, 'PUT', `/api/webservice/rule/${existing.RuleKey}`, existing);
          luckyRemoved = true;
          logs.push({ step: 'Lucky 子规则', status: 'ok', detail: `已删除 ${managedProxyKey(appId)}（${before} → ${existing.ProxyList.length}）` });
        } else {
          logs.push({ step: 'Lucky 子规则', status: 'ok', detail: 'Lucky 上未发现该子规则（无需删除）' });
        }
      } catch (error) {
        // Lucky 删除失败：仅警告，不阻断——配置层删除后 deploy 会重新同步
        logs.push({ step: 'Lucky 子规则', status: 'warn', detail: `Lucky 子规则删除失败：${error.message}。可手动 deploy 重新同步` });
      }

      let esaRemoved = false;
      let ddnsRemoved = false;
      if (purge) {
        // ESA 加速域名删除
        if (removed.esaEnabled !== false && config.esa?.siteId && config.esa?.rootDomain && removed.prefix) {
          try {
            const cdn = `${removed.prefix}.cdn.${config.esa.rootDomain}`.toLowerCase();
            const r = await disableEsaDomain(config, cdn);
            esaRemoved = !!r.deleted;
            logs.push({
              step: 'ESA 加速域名',
              status: r.deleted ? 'ok' : 'warn',
              detail: r.deleted ? `已删除 ${cdn}` : `未删除 ${cdn}（${r.reason}）`,
            });
          } catch (error) {
            logs.push({ step: 'ESA 加速域名', status: 'error', detail: error.message });
          }
        }
        // DDNS 记录删除：精确匹配 root+sub+type（复用 deleteDdnsRecords / recordMatches）
        const targets = ddnsPurgeTargets(removed.prefix, config.esa?.rootDomain);
        if (targets.length && (config.lucky.openToken || (config.lucky.account && config.lucky.password))) {
          try {
            const ddnsResult = await deleteDdnsRecords(config, normalizeDomain(config.esa.rootDomain), targets);
            ddnsRemoved = ddnsResult.count > 0;
            logs.push({
              step: 'Lucky DDNS',
              status: ddnsResult.count ? 'ok' : 'warn',
              detail: ddnsResult.count
                ? `已删除 ${targets.map((t) => `${t.sub} (${t.type})`).join(' / ')}`
                : `未找到 ${targets.map((t) => t.sub).join(' / ')} 记录`,
            });
          } catch (error) {
            logs.push({ step: 'Lucky DDNS', status: 'error', detail: error.message });
          }
        }
      }

      // purge 清理失败：保留应用配置以便重试（不 splice、不写盘）；Lucky warn 不算失败
      const purgeFailed = logs.some((l) => l.status === 'error');
      if (purgeFailed) {
        for (const item of logs) pushServerLog(item.step, item.status, item.detail);
        const errorMsg =
          `清理失败，应用「${removed.prefix || removed.name}」配置已保留，可修复后重试。` +
          logs.filter((l) => l.status === 'error').map((l) => `${l.step}: ${l.detail}`).join('；');
        res.status(500).json({
          ok: false,
          retained: true,
          appId,
          logs,
          config: sanitizeConfig(config),
          error: errorMsg,
          message: errorMsg,
        });
        return;
      }

      // 重新读取最新配置再移除该应用：避免在异步清理期间其他编辑被旧快照整体覆盖
      const latest = readConfig();
      const latestIdx = (latest.apps || []).findIndex((a) => a.id === appId);
      if (latestIdx >= 0) {
        latest.apps.splice(latestIdx, 1);
        writeConfig(latest);
      }
      for (const item of logs) pushServerLog(item.step, item.status, item.detail);
      res.json({
        ok: true,
        removed: { id: appId, prefix: removed.prefix, name: removed.name },
        luckyRemoved,
        esaRemoved,
        ddnsRemoved,
        purge,
        logs,
        config: sanitizeConfig(config),
        message: `应用 ${removed.prefix || removed.name} 已删除` +
          (luckyRemoved ? '（含 Lucky 子规则）' : '') +
          (purge && esaRemoved ? ' + ESA 加速域名' : '') +
          (purge && ddnsRemoved ? ' + DDNS 记录' : ''),
      });
    }),
  );
}

module.exports = { register };
