// 部署编排：Lucky 反代规则 + ESA 加速域名 + DDNS 记录的组合业务。
// 依赖：./lucky、./esa、./ddns、./config、./snapshots、./normalize、node:crypto。
// 无全局状态（readConfig/writeConfig 每次读最新，避免快照陈旧）。

const crypto = require('crypto');
const { getEsaClient, esaListDomains } = require('./esa');
const {
  getLuckyRules,
  luckyRequest,
  luckyLogin,
  buildLuckyProxy,
  buildLuckyRule,
  keepExistingProxies,
  isManagedProxyKey,
  managedProxyKey,
} = require('./lucky');
const {
  getLuckyDdnsTasks,
  recordMatches,
  addDdnsCnameRecord,
  addDdnsAaaaRecord,
} = require('./ddns');
const { readConfig, writeConfig } = require('./config');
const { saveSnapshot } = require('./snapshots');
const { GATEWAY_RULE_NAME } = require('./constants');
const { normalizeDomain, cdnDomainOf, nasDomainOf, validateDeployConfig } = require('./normalize');
const { scheduleLiveCheck } = require('./health');
const { DeleteRecordRequest, CreateRecordRequest } = require('@alicloud/esa20240910');

async function applyLucky(config, logs, appId) {
  const { baseUrl, token, rules } = await getLuckyRules(config);
  const gatewayPort = Number(config.gateway.listenPort) || 8443;
  const existing =
    rules.find(
      (rule) =>
        (config.gateway.ruleKey && rule.RuleKey === config.gateway.ruleKey) ||
        rule.RuleName === GATEWAY_RULE_NAME ||
        Number(rule.ListenPort) === gatewayPort,
    ) || null;
  const ruleKey = existing?.RuleKey || config.gateway.ruleKey || crypto.randomBytes(8).toString('hex');
  config.gateway.ruleKey = ruleKey;

  // 端口冲突预检：网关端口不得被其它 Lucky 规则占用
  const clash = (rules || []).find(
    (r) =>
      Number(r.ListenPort) === gatewayPort &&
      r.RuleKey !== (existing?.RuleKey || '') &&
      r.RuleName !== GATEWAY_RULE_NAME,
  );
  if (clash) {
    throw new Error(`网关端口 ${gatewayPort} 与 Lucky 规则「${clash.RuleName}」监听冲突，请先到 Lucky 调整`);
  }

  const apps = appId ? config.apps.filter((app) => app.id === appId) : config.apps;
  if (appId && apps.length === 0) {
    throw new Error(`找不到应用: ${appId}`);
  }

  const generatedProxies = apps.map((app) => buildLuckyProxy(app, config));
  const preservedProxies = keepExistingProxies(existing, appId);
  // Lucky PUT 拒绝任何重复的 host：新建托管子规则若与既有非托管子规则同 domain，
  // 会被 `has exist [...]` 拒掉。先把冲突的非托管子规则从 preservedProxies 里过滤掉。
  const generatedDomains = new Set(generatedProxies.flatMap((p) => p.Domains || []));
  const conflictsRemoved = [];
  const conflictFree = preservedProxies.filter((proxy) => {
    if (isManagedProxyKey(proxy.Key)) return true; // 托管子规则我们自己管
    const overlap = (proxy.Domains || []).some((d) => generatedDomains.has(d));
    if (overlap) conflictsRemoved.push(`${proxy.Key} (${(proxy.Domains || []).join(',')})`);
    return !overlap;
  });
  if (conflictsRemoved.length > 0) {
    logs.push({
      step: 'Lucky 冲突清理',
      status: 'ok',
      detail: `已移除 ${conflictsRemoved.length} 条与新建子规则同域名的手动规则：${conflictsRemoved.join('；')}`,
    });
  }
  const proxyList = [...conflictFree, ...generatedProxies];
  const rule = buildLuckyRule(config, proxyList, ruleKey);

  if (existing) {
    await luckyRequest(baseUrl, token, 'PUT', `/api/webservice/rule/${ruleKey}`, rule);
    logs.push({ step: 'Lucky 反向代理', status: 'ok', detail: `已更新 ${GATEWAY_RULE_NAME} 监听 ${rule.ListenIP}:${rule.ListenPort}` });
  } else {
    const created = await luckyRequest(baseUrl, token, 'POST', '/api/webservice/rules', rule);
    if (created.ruleKey && created.ruleKey !== ruleKey) {
      config.gateway.ruleKey = created.ruleKey;
    }
    logs.push({ step: 'Lucky 反向代理', status: 'ok', detail: `已创建 ${GATEWAY_RULE_NAME} 监听 ${rule.ListenIP}:${rule.ListenPort}` });
  }
  logs.push({ step: 'Lucky 子规则', status: 'ok', detail: `${proxyList.length} 条规则（含非面板规则 ${preservedProxies.length} 条）` });
}

async function deploy(config, appId, parts, logs) {
  const selected = new Set(
    Array.isArray(parts) && parts.length > 0 ? parts.filter((part) => part === 'lucky' || part === 'esa') : ['lucky', 'esa'],
  );
  validateDeployConfig(config, selected);
  // 部署前快照（可回滚）
  const scopeLabel = appId ? `同步应用 ${appId}` : '全量部署';
  const snapFile = saveSnapshot(config, scopeLabel);
  if (snapFile) {
    logs.push({ step: '配置快照', status: 'ok', detail: `已保存部署前快照 ${snapFile.split(/[\\/]/).pop()}（可在设置页回滚）` });
  }
  const errors = [];
  if (selected.has('lucky')) {
    try {
      await applyLucky(config, logs, appId);
    } catch (error) {
      errors.push({ part: 'lucky', message: error.message });
      logs.push({ step: 'Lucky 反向代理', status: 'error', detail: error.message });
    }
  }
  if (selected.has('esa')) {
    // ESA 加速域名 + Lucky DDNS CNAME：CNAME 是公网可访问前提，必须先于回源规则
    const esaTargets = (appId ? config.apps.filter((a) => a.id === appId) : config.apps)
      .filter((app) => app.esaEnabled !== false);
    for (const app of esaTargets) {
      try {
        const result = await enableEsaDomain(
          config,
          cdnDomainOf(app, config),
          nasDomainOf(app, config),
          `EdgeLink ${app.name}`,
        );
        logs.push({ step: 'ESA 加速域名', status: 'ok', detail: result.esa?.existed
          ? `${app.name} ESA 加速域名已存在`
          : `${app.name} ESA 加速域名已创建` });
        const ddns = result.ddns || {};
        const ddnsStatus = ddns.error ? 'error' : 'ok';
        const ddnsDetail = ddns.error
          ? `${app.name} Lucky DDNS CNAME 失败：${ddns.error}`
          : ddns.added
            ? `${app.name} Lucky DDNS CNAME added -> ${result.cnameTarget}`
            : ddns.updated
              ? `${app.name} Lucky DDNS CNAME updated -> ${result.cnameTarget}`
              : `${app.name} Lucky DDNS CNAME skipped（已存在且一致）`;
        logs.push({ step: 'Lucky DDNS CNAME', status: ddnsStatus, detail: ddnsDetail });
        if (ddns.error) {
          throw new Error(`Lucky DDNS CNAME 同步失败：${ddns.error}`);
        }
        // nas AAAA 写入结果（Lucky 动态 IPv6 占位符 {ipv6Addr}）
        if (result.nasAaaa && (result.nasAaaa.added || result.nasAaaa.updated || result.nasAaaa.skipped || result.nasAaaa.error)) {
          if (result.nasAaaa.error) {
            logs.push({ step: 'Lucky DDNS nas AAAA', status: 'warn', detail: `${app.name} ${result.nasAaaa.error}` });
          } else {
            const action = result.nasAaaa.added ? 'added' : result.nasAaaa.updated ? 'updated' : 'skipped';
            logs.push({ step: 'Lucky DDNS nas AAAA', status: 'ok', detail: `${app.name} ${nasDomainOf(app, config)} AAAA ${action}` });
          }
        }
      } catch (error) {
        errors.push({ part: 'esa', message: error.message });
        logs.push({ step: 'Lucky DDNS CNAME', status: 'error', detail: error.message });
        break;
      }
    }
    try {
      logs.push({
        step: 'ESA 回源规则',
        status: 'ok',
        detail: '用户统一管理，本次未创建、更新或删除',
      });
    } catch (error) {
      errors.push({ part: 'esa', message: error.message });
      logs.push({ step: 'ESA 回源规则', status: 'error', detail: error.message });
    }
    // ESA 成功完成后启动该应用的后台 CDN 健康探测
    if (errors.length === 0) {
      for (const app of esaTargets) {
        if (typeof scheduleLiveCheck === 'function') {
          app.status = 'building';
          scheduleLiveCheck(app.id);
          logs.push({ step: 'cdn 健康探测', status: 'ok', detail: `${app.name} 已启动后台轮询（每 10s，最多 5 分钟）` });
        }
      }
    }
  }
  // 写回：不整体覆盖旧快照（异步窗口内其他编辑会被冲掉），
  // 只把 deploy 自己改的状态字段合并进最新配置：app.status='building' + gateway.ruleKey（部署中从 Lucky 学到）
  const persistDeployState = () => {
    const latest = readConfig();
    const statusChanges = (config.apps || [])
      .filter((a) => a.status === 'building')
      .map((a) => ({ id: a.id, status: 'building' }));
    let changed = false;
    for (const { id, status } of statusChanges) {
      const target = (latest.apps || []).find((x) => x.id === id);
      if (target && target.status !== status) {
        target.status = status;
        changed = true;
      }
    }
    if (config.gateway && config.gateway.ruleKey && latest.gateway?.ruleKey !== config.gateway.ruleKey) {
      latest.gateway = { ...latest.gateway, ruleKey: config.gateway.ruleKey };
      changed = true;
    }
    if (changed) writeConfig(latest);
  };
  if (errors.length === 0) {
    persistDeployState();
  } else if (selected.size === errors.length) {
    throw new Error(`同步失败：${errors.map((e) => e.message).join('；')}`);
  } else {
    persistDeployState();
  }

  // ESA 健康探测启动已移入 ESA 块（避免 lucky 抛错时 esaTargets 未定义）

  // 完整性自检：所有 luckyEnabled 应用都应在 Lucky 上有托管子规则
  if (errors.length === 0) {
    try {
      const { rules: refreshedRules } = await getLuckyRules(config);
      const refreshedProxies = (refreshedRules || []).flatMap((r) => r.ProxyList || []);
      const refreshedKeys = new Set(refreshedProxies.map((p) => p.Key));
      const missing = [];
      for (const app of (appId ? config.apps.filter((a) => a.id === appId) : config.apps)) {
        if (app.luckyEnabled === false) continue;
        const key = managedProxyKey(app.id);
        if (!refreshedKeys.has(key)) missing.push(`${key} (${nasDomainOf(app, config)})`);
      }
      if (missing.length > 0) {
        logs.push({
          step: 'Lucky 自检',
          status: 'warn',
          detail: `检测到以下应用缺少托管子规则（deploy 阶段未被 Lucky 接受）：${missing.join('、')}。可能是 Lucky 限流，建议稍后重试 /api/audit/fix`,
        });
      }
    } catch (e) {
      // 自检失败不阻断
    }
  }

  const scopeText = selected.has('lucky') && selected.has('esa') ? '全部' : selected.has('lucky') ? 'Lucky' : 'ESA';
  if (errors.length === 0) {
    logs.push({ step: '完成', status: 'ok', detail: `${scopeText}同步完成，配置已保存，DNS 记录请继续由 Lucky DDNS 自动更新` });
  } else {
    logs.push({ step: '完成', status: 'error', detail: `${scopeText}同步部分失败（${errors.map((e) => e.part).join('、')}），配置已保存` });
  }
}

// 删除 ESA 加速域名记录：仅删 ESA 记录，DDNS CNAME 不动
// ESA 记录创建后短时间内可能处于"配置中"状态（ServiceBusy），加轻量重试
// 传 recordId 时按 recordId 删除并重试（不按 name 查找），避免 name 重试误删同名其他类型记录
async function disableEsaDomain(config, domain, { retries = 4, delayMs = 1500, recordId = 0 } = {}) {
  const client = getEsaClient(config.esa);
  const siteId = Number(config.esa.siteId);
  if (!siteId) throw new Error('缺少 ESA siteId');
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let recId = recordId;
    if (!recId) {
      const list = await esaListDomains(client, siteId);
      const rec = list.find((r) => normalizeDomain(r.name) === domain);
      if (!rec) {
        return { deleted: false, reason: 'not_found', domain };
      }
      if (!rec.id) {
        return { deleted: false, reason: 'no_record_id', domain };
      }
      recId = rec.id;
    }
    try {
      await client.deleteRecord(new DeleteRecordRequest({ recordId: recId }));
      return { deleted: true, domain, recordId: recId, attempts: attempt + 1 };
    } catch (error) {
      const msg = String(error?.message || error);
      const busy = /ServiceBusy|being configured|Try again later/i.test(msg);
      if (busy && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw error;
    }
  }
  return { deleted: false, reason: 'exhausted_retries', domain };
}

// 从所有 Lucky DDNS 任务中精确删除匹配记录（root+sub+type，复用 recordMatches）。
// targets: [{ sub, type }]；siteRoot 为站点根域（如 alanmaster.top）。
// 返回 { count, tasks }：count 为删除条数，tasks 为实际改写的任务 Key 列表。
async function deleteDdnsRecords(config, siteRoot, targets) {
  const removed = { count: 0, tasks: [] };
  const tasks = await getLuckyDdnsTasks(config);
  for (const t of tasks) {
    if (!t.TaskKey) continue;
    const { baseUrl, token } = await luckyLogin(config);
    const detail = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${t.TaskKey}`);
    const task = detail.task || detail.data;
    const before = (task.Records || []).length;
    task.Records = (task.Records || []).filter(
      (r) => !targets.some(({ sub, type }) => recordMatches(r, sub, siteRoot, type)),
    );
    if (task.Records.length < before) {
      await luckyRequest(baseUrl, token, 'PUT', `/api/ddns?key=${t.TaskKey}`, task);
      removed.count += before - task.Records.length;
      removed.tasks.push(t.TaskKey);
    }
  }
  return removed;
}

async function enableEsaDomain(config, domain, target, remark) {
  const client = getEsaClient(config.esa);
  const siteId = Number(config.esa.siteId);
  const messages = [];
  let created = false;
  let ddnsAdded = false;
  let ddnsSkipped = false;
  let nasAaaaAdded = false;
  let nasAaaaUpdated = false;
  let nasAaaaSkipped = false;
  let nasAaaaError = '';
  let ddnsError = '';
  let cnameTarget = '';
  let esaRecord = null;
  const existing = await esaListDomains(client, siteId);
  esaRecord = existing.find((record) => normalizeDomain(record.name) === domain) || null;
  if (esaRecord) {
    cnameTarget = esaRecord.recordCname || '';
    messages.push(`ESA 加速域名已存在（${domain}）`);
  } else {
    const request = new CreateRecordRequest({
      siteId,
      recordName: domain,
      type: 'CNAME',
      data: { value: target },
      proxied: true,
      hostPolicy: 'follow_origin_domain',
      sourceType: 'Domain',
      ttl: 1,
      bizName: 'web',
    });
    await client.createRecord(request);
    created = true;
    // 创建响应无 recordCname，重新查询获取 ESA 分配的接入节点
    const refreshed = await esaListDomains(client, siteId);
    esaRecord = refreshed.find((record) => normalizeDomain(record.name) === domain) || null;
    cnameTarget = esaRecord?.recordCname || '';
    messages.push(`已创建 ESA 加速域名 ${domain} -> ${target}`);
  }

  // 同步到 Lucky DDNS（CNAME 指向 ESA 节点 + nas AAAA 用动态占位符 {ipv6Addr}）
  if (!cnameTarget) {
    ddnsError = 'ESA 记录缺少 recordCname，无法同步 DDNS';
    messages.push(ddnsError);
  } else if (config.lucky.openToken || (config.lucky.account && config.lucky.password)) {
    const rootMatch = domain.match(/^[^.]+\.cdn\.(.+)$/);
    const siteRoot = normalizeDomain(rootMatch ? rootMatch[1] : domain.split('.').slice(-2).join('.'));
    const subDomain = domain.slice(0, -(siteRoot.length + 1));
    // subDomain 此时形如 "aiusage.cdn"；nas AAAA 的子域是 "{prefix}.nas"，要剥掉 .cdn 后缀
    const nasSub = subDomain.replace(/\.cdn$/, '');
    try {
      const ddnsResult = await addDdnsCnameRecord(config, subDomain, cnameTarget, siteRoot, remark || '');
      ddnsAdded = ddnsResult.added;
      ddnsSkipped = !ddnsResult.added;
      messages.push(ddnsResult.message);
    } catch (error) {
      ddnsError = error.message;
      messages.push(`Lucky DDNS 同步失败：${error.message}`);
    }
    // nas AAAA：写 Lucky 动态占位符 {ipv6Addr}，由 Lucky DDNS 引擎同步时取本机当前公网 IPv6
    // 替换——前缀变化自动跟随，无需再维护 config.lucky.publicIPv6 固定值
    if (siteRoot) {
      try {
        // nas AAAA 子域固定 "{prefix}.nas"，与 ESA 任务主域通过 cdn 任务的 cname 值共享 rootDomain，
        // 写入 IPv6 任务（aliyun alidns 同步），siteRoot 仍传 alanmaster.top 让 addDdnsRecord 内部
        // 把 DomainName 字段设为 "alanmaster.top"，SubDomainName 字段设为 "aiusage.nas"。
        const aaaaResult = await addDdnsAaaaRecord(config, `${nasSub}.nas`, siteRoot, remark || '');
        nasAaaaAdded = aaaaResult.added;
        nasAaaaUpdated = aaaaResult.updated;
        nasAaaaSkipped = !aaaaResult.added && !aaaaResult.updated;
        messages.push(`Lucky DDNS nas AAAA ${aaaaResult.added ? 'added' : aaaaResult.updated ? 'updated' : 'skipped'}: ${nasSub} -> {ipv6Addr}（Lucky 动态获取）`);
      } catch (error) {
        nasAaaaError = error.message;
        messages.push(`Lucky DDNS nas AAAA 同步失败：${error.message}`);
      }
    }
  } else {
    messages.push('未配置 Lucky，跳过 DNS CNAME 同步');
  }
  return { created, domain, cnameTarget, esa: { created, existed: !!esaRecord && !created }, ddns: { added: ddnsAdded, skipped: ddnsSkipped, error: ddnsError }, nasAaaa: { added: nasAaaaAdded, updated: nasAaaaUpdated, skipped: nasAaaaSkipped, error: nasAaaaError }, message: messages.join('；') };
}

module.exports = {
  applyLucky,
  deploy,
  disableEsaDomain,
  deleteDdnsRecords,
  enableEsaDomain,
};
