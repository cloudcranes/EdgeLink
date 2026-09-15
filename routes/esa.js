// ESA 业务路由：域名加速开关 / 证书 / 规则 / 站点 / 记录编辑与删除 / 部署预检
const { ListRecordsRequest, UpdateRecordRequest } = require('@alicloud/esa20240910');
const { ESA_RULE_PREFIX } = require('../lib/constants');
const { readConfig, mergeConfig } = require('../lib/config');
const { normalizeDomain, certificateCoversDomain } = require('../lib/normalize');
const { luckyLogin, luckyRequest } = require('../lib/lucky');
const {
  getEsaClient,
  esaListSites,
  esaListOriginRules,
  extractEsaDomain,
  esaListDomains,
  esaListCertificates,
} = require('../lib/esa');
const { getLuckyDdnsTasks, hasNasDdnsRecords, parseSyncRecord } = require('../lib/ddns');
const { enableEsaDomain, disableEsaDomain, deleteDdnsRecords } = require('../lib/deploy');
const { pushServerLog } = require('../lib/logs');
const { asyncHandler } = require('../utils/http');

function register(app) {
  app.post(
    '/api/esa/domain/toggle',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const domain = normalizeDomain(req.body.domain);
      const proxied = !!req.body.value;
      if (!domain) throw new Error('缺少域名');
      const client = getEsaClient(config.esa);
      const siteId = Number(config.esa.siteId);
      if (!siteId) throw new Error('请先选择 ESA 站点');
      const records = await client.listRecords(new ListRecordsRequest({ siteId, pageSize: 500 }));
      const rec = (records.body?.records || []).find((r) => normalizeDomain(r.recordName) === domain);
      if (!rec) throw new Error('ESA 未找到该加速域名');
      await client.updateRecord(
        new UpdateRecordRequest({
          siteId,
          recordId: rec.recordId,
          recordName: rec.recordName,
          type: rec.recordType,
          data: rec.data,
          proxied,
          hostPolicy: rec.hostPolicy,
          sourceType: rec.recordSourceType,
          ttl: rec.ttl,
        }),
      );
      res.json({ ok: true, message: domain + (proxied ? ' 已开启加速' : ' 已关闭加速') });
    }),
  );

  app.get(
    '/api/esa/certificates',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const client = getEsaClient(config.esa);
      const siteId = Number(config.esa.siteId);
      if (!siteId) {
        throw new Error('请先选择 ESA 站点');
      }
      const keyword = String(req.query.keyword || '').trim();
      const certs = await esaListCertificates(client, siteId, keyword);
      res.json({ ok: true, certificates: certs });
    }),
  );

  // 应用部署预检：DNS nas 记录 / Lucky SSL / ESA SSL
  app.get(
    '/api/app/precheck',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const rootDomain = String(config.esa?.rootDomain || '').trim().toLowerCase();
      const prefix = String(req.query.prefix || '').trim().toLowerCase();
      const result = {
        prefix,
        rootDomain,
        dns: { ok: false, message: '' },
        luckySsl: { ok: false, message: '' },
        esaSsl: { ok: false, message: '' },
        ready: false,
      };
      if (!prefix || !rootDomain) {
        result.dns.message = '缺少域名前缀或站点根域';
        return res.json({ ok: true, precheck: result });
      }

      // DNS：检查主域下是否已有 nas 子域 DDNS 记录（不要求 *.nas 通配；逐条子域亦可）
      try {
        const tasks = await getLuckyDdnsTasks(config);
        if (hasNasDdnsRecords(tasks, rootDomain)) {
          result.dns.ok = true;
          result.dns.message = `主域 ${rootDomain} 下已有 nas 子域 DDNS 记录`;
        } else {
          result.dns.message = `主域 ${rootDomain} 下尚未发现 nas 子域 DDNS 记录，请到 Lucky 后台 DDNS 任务中添加（如 ${prefix}.nas.${rootDomain} 的 AAAA 记录）`;
        }
      } catch (error) {
        result.dns.message = `DDNS 检查失败：${error.message}`;
      }

      // Lucky SSL：检查 *.nas.{root} 证书
      try {
        const { baseUrl, token } = await luckyLogin(config);
        const data = await luckyRequest(baseUrl, token, 'GET', '/api/ssl');
        const list = data.list || [];
        const target = `*.nas.${rootDomain}`;
        const found = list.find((cert) => {
          const ext = parseSyncRecord(cert.ExtParams) || {};
          const info = parseSyncRecord(cert.CertsInfo) || {};
          const sans = [...(ext.SubDomainList || []), ...(info.SAN ? [info.SAN] : [])];
          return sans.some((s) => String(s).toLowerCase() === target);
        });
        if (found) {
          result.luckySsl.ok = true;
          result.luckySsl.message = `${target} SSL 证书已就绪`;
        } else {
          result.luckySsl.message = `未找到 ${target} SSL 证书，请到 Lucky 后台申请 ACME 证书`;
        }
      } catch (error) {
        result.luckySsl.message = `Lucky SSL 检查失败：${error.message}`;
      }

      // ESA SSL：检查覆盖 *.cdn.{root}（或精确子域）的证书（仅检查，部署前要求用户手动在 ESA 控制台申请）
      const siteId = Number(config.esa.siteId);
      if (siteId) {
        try {
          const client = getEsaClient(config.esa);
          const cdnKeyword = `*.cdn.${rootDomain}`;
          const cdnExact = `${prefix}.cdn.${rootDomain}`;
          const certs = await esaListCertificates(client, siteId, cdnKeyword);
          const matched = certs.find((c) => {
            if (!Array.isArray(c.sans)) return false;
            return c.sans.some((s) => certificateCoversDomain(s, cdnExact));
          });
          if (matched) {
            result.esaSsl.ok = true;
            result.esaSsl.message = `${cdnExact} ESA 证书已就绪（含 SAN ${cdnKeyword}）`;
          } else {
            result.esaSsl.message = `未找到覆盖 ${cdnExact} 的 ESA 证书（需要 SAN ${cdnKeyword} 或精确域名），请到 ESA 控制台申请后再部署`;
          }
        } catch (error) {
          result.esaSsl.message = `ESA 证书检查失败：${error.message}`;
        }
      } else {
        result.esaSsl.message = '未选择 ESA 站点，跳过证书检查';
      }

      result.ready = result.dns.ok && result.luckySsl.ok && result.esaSsl.ok;
      res.json({ ok: true, precheck: result });
    }),
  );

  app.get(
    '/api/esa/rules',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const client = getEsaClient(config.esa);
      const siteId = Number(config.esa.siteId);
      if (!siteId) {
        throw new Error('请先选择 ESA 站点');
      }
      const rules = await esaListOriginRules(client, siteId);
      const list = (rules || []).map((rule) => ({
        configId: rule.configId,
        managed: String(rule.ruleName || '').startsWith(ESA_RULE_PREFIX),
        ruleName: rule.ruleName,
        domain: extractEsaDomain(rule.rule),
        dnsRecord: rule.dnsRecord,
        originHost: rule.originHost,
        originHttpPort: rule.originHttpPort,
        originHttpsPort: rule.originHttpsPort,
        enabled: rule.ruleEnable === 'on',
      }));
      const domains = await esaListDomains(client, siteId);
      res.json({ ok: true, rules: list, domains });
    }),
  );

  app.post(
    '/api/esa/sites',
    asyncHandler(async (req, res) => {
      const current = readConfig();
      const candidate = mergeConfig(current, req.body || {});
      const sites = await esaListSites(candidate.esa);
      res.json({ ok: true, sites });
    }),
  );

  // 创建 ESA 加速域名记录 + 同步 alidns CNAME（enable-domain 与巡检修复共用）
  app.post(
    '/api/esa/enable-domain',
    asyncHandler(async (req, res) => {
      const config = mergeConfig(readConfig(), req.body.config || req.body);
      const siteId = Number(config.esa.siteId);
      if (!siteId) {
        throw new Error('请先选择 ESA 站点');
      }
      const domain = normalizeDomain(req.body.domain);
      const target = normalizeDomain(req.body.target);
      if (!domain || !target) {
        throw new Error('缺少域名或回源目标');
      }
      const result = await enableEsaDomain(config, domain, target, req.body.remark || '');
      // 推送两条服务端日志：ESA 加速域名状态、Lucky DDNS CNAME 状态
      pushServerLog(
        'ESA 加速域名',
        result.esa?.existed ? 'ok' : 'ok',
        result.esa?.existed ? `${domain} ESA 加速域名已存在` : `${domain} ESA 加速域名已创建 -> ${result.cnameTarget}`,
      );
      const ddns = result.ddns || {};
      if (ddns.error) {
        pushServerLog('Lucky DDNS CNAME', 'error', `${domain} Lucky DDNS CNAME 失败：${ddns.error}`);
      } else if (ddns.added) {
        pushServerLog('Lucky DDNS CNAME', 'ok', `${domain} Lucky DDNS CNAME added -> ${result.cnameTarget}`);
      } else if (ddns.updated) {
        pushServerLog('Lucky DDNS CNAME', 'ok', `${domain} Lucky DDNS CNAME updated -> ${result.cnameTarget}`);
      } else {
        pushServerLog('Lucky DDNS CNAME', 'ok', `${domain} Lucky DDNS CNAME skipped（已存在且一致）`);
      }
      res.json({ ok: true, ...result });
    }),
  );

  // 编辑 ESA 加速域名记录（单条）：支持修改回源值/hostPolicy/proxied/ttl/sourceType/bizName
  // ?dryRun=1 返回预览（不真改）
  app.patch(
    '/api/esa/record/:recordId',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const recordId = Number(req.params.recordId);
      if (!Number.isInteger(recordId) || recordId <= 0) {
        throw new Error('缺少 recordId（recordId 必须是正整数）');
      }
      const dryRun = String(req.query.dryRun || '') === '1' || req.body?.dryRun === true;
      const body = req.body || {};
      // 允许的字段白名单 + 严格边界校验（拒绝 NaN/越界/非法枚举/空 value）
      const allowed = {};
      if ('value' in body) {
        const value = String(body.value).trim();
        if (!value) throw new Error('value 不能为空');
        allowed.data = { value };
      }
      if ('hostPolicy' in body) {
        const hostPolicy = String(body.hostPolicy || '');
        if (!['follow_origin_domain', 'follow_hostname', 'none'].includes(hostPolicy)) {
          throw new Error('hostPolicy 只能是 follow_origin_domain / follow_hostname / none');
        }
        allowed.hostPolicy = hostPolicy;
      }
      if ('proxied' in body) {
        const p = body.proxied;
        if (p !== true && p !== false && p !== 'true' && p !== 'false') {
          throw new Error('proxied 必须是 true/false');
        }
        allowed.proxied = p === true || p === 'true';
      }
      if ('ttl' in body) {
        const ttl = Number(body.ttl);
        // ESA 合法值：1（自动）或 30..86400 整数
        if (!Number.isInteger(ttl) || !(ttl === 1 || (ttl >= 30 && ttl <= 86400))) {
          throw new Error('ttl 必须是 1（自动）或 30~86400 的整数');
        }
        allowed.ttl = ttl;
      }
      if ('sourceType' in body) {
        const sourceType = String(body.sourceType || '');
        if (!['Domain', 'OSS', 'S3', 'LB', 'OP'].includes(sourceType)) {
          throw new Error('sourceType 只能是 Domain / OSS / S3 / LB / OP');
        }
        allowed.sourceType = sourceType;
      }
      if ('bizName' in body) {
        const bizName = String(body.bizName || '');
        if (!['web', 'video_image', 'api'].includes(bizName)) {
          throw new Error('bizName 只能是 web / video_image / api');
        }
        allowed.bizName = bizName;
      }
      if ('comment' in body) allowed.comment = String(body.comment);
      if (Object.keys(allowed).length === 0) {
        throw new Error('没有可编辑的字段（value/hostPolicy/proxied/ttl/sourceType/bizName/comment）');
      }
      allowed.recordId = recordId;
      // 先查当前值（用于返回 preview / 实际对比）
      const client = getEsaClient(config.esa);
      const siteId = Number(config.esa.siteId);
      if (!siteId) throw new Error('请先选择 ESA 站点');
      const currentList = await esaListDomains(client, siteId);
      const current = currentList.find((r) => Number(r.id) === recordId);
      if (!current) {
        return res.json({ ok: false, error: `未找到 recordId=${recordId} 对应的 ESA 记录`, dryRun });
      }
      // ESA 拒绝缺失 data 字段（CNAME 记录的 data.value 是回源地址，必须保留）
      if (!('data' in allowed) && current.value) {
        allowed.data = { value: current.value };
      }
      // CNAME 接入类型 ESA 强制 proxied=true；主动拒绝 false 避免报错 + 回滚
      if (current.type === 'CNAME' && 'proxied' in allowed && !allowed.proxied) {
        return res.json({
          ok: false,
          error: 'CNAME 接入类型 ESA 强制开启加速（proxied 必须为 true），无法关闭。如需彻底下线加速请删除该 ESA 记录（调用 DELETE /api/apps/:id?purge=1）',
          dryRun,
        });
      }
      const before = {
        recordId,
        name: current.name,
        type: current.type,
        value: current.value,
        recordCname: current.recordCname || '',
        proxied: !!current.proxied,
        hostPolicy: current.hostPolicy || '',
        ttl: current.ttl,
        sourceType: current.sourceType || '',
        bizName: current.bizName || '',
        comment: current.comment || '',
      };
      const after = {
        ...before,
        ...(allowed.data ? { value: allowed.data.value } : {}),
        ...('hostPolicy' in allowed ? { hostPolicy: allowed.hostPolicy } : {}),
        ...('proxied' in allowed ? { proxied: allowed.proxied } : {}),
        ...('ttl' in allowed ? { ttl: allowed.ttl } : {}),
        ...('sourceType' in allowed ? { sourceType: allowed.sourceType } : {}),
        ...('bizName' in allowed ? { bizName: allowed.bizName } : {}),
      };
      if (dryRun) {
        return res.json({
          ok: true,
          dryRun: true,
          before,
          after,
          message: 'dryRun 模式：以下变更将发生；不带 dryRun=1 才会真正执行',
        });
      }
      const request = new UpdateRecordRequest(allowed);
      await client.updateRecord(request);
      // 重新拉取确认
      const refreshed = await esaListDomains(client, siteId);
      const afterPut = refreshed.find((r) => Number(r.id) === recordId) || current;
      res.json({
        ok: true,
        before,
        after: {
          recordId,
          name: afterPut.name,
          type: afterPut.type,
          value: afterPut.value,
          recordCname: afterPut.recordCname || '',
          proxied: !!afterPut.proxied,
          hostPolicy: afterPut.hostPolicy || '',
          ttl: afterPut.ttl,
          sourceType: afterPut.sourceType || '',
          bizName: afterPut.bizName || '',
          comment: afterPut.comment || '',
        },
        message: 'ESA 记录已更新',
      });
    }),
  );

  // 删除单条 ESA 加速域名记录（保留应用，仅删加速域名）
  // ?purgeDdns=1 连带删除 Lucky DDNS 任务中对应的 .cdn CNAME 记录
  // ?dryRun=1 预览待删项
  app.delete(
    '/api/esa/record/:recordId',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const recordId = Number(req.params.recordId);
      if (!Number.isInteger(recordId) || recordId <= 0) {
        throw new Error('缺少 recordId（recordId 必须是正整数）');
      }
      const purgeDdns = String(req.query.purgeDdns || '') === '1';
      const dryRun = String(req.query.dryRun || '') === '1';

      const client = getEsaClient(config.esa);
      const siteId = Number(config.esa.siteId);
      if (!siteId) throw new Error('请先选择 ESA 站点');
      const currentList = await esaListDomains(client, siteId);
      const current = currentList.find((r) => Number(r.id) === recordId);
      if (!current) {
        return res.json({ ok: false, error: `未找到 recordId=${recordId} 对应的 ESA 记录`, dryRun });
      }

      const plan = {
        recordId,
        name: current.name,
        type: current.type,
        value: current.value,
        recordCname: current.recordCname || '',
        purgeDdns,
      };

      // 关联的 DDNS CNAME 子域（如 aiusage.cdn）。dryRun 时无条件暴露给前端询问是否连带删除；
      // 实际连带删除只在 purgeDdns=1 时执行，且 ESA-only 语义只清 CNAME，绝不动 nas AAAA。
      let ddnsRoot = '';
      let ddnsTargets = [];
      if (current.name) {
        const m = current.name.match(/^(.+)\.cdn\.(.+)$/);
        if (m) {
          ddnsRoot = normalizeDomain(m[2]);
          plan.ddnsSub = `${m[1]}.cdn`;
        } else {
          plan.ddnsSub = null;
        }
      }
      if (purgeDdns && ddnsRoot && plan.ddnsSub) {
        ddnsTargets = [{ sub: plan.ddnsSub, type: 'CNAME' }];
      }

      if (dryRun) {
        return res.json({
          ok: true,
          dryRun: true,
          willRemove: plan,
          message: `dryRun 模式：将删除 ESA 加速域名 ${current.name}${ddnsTargets.length ? ` + DDNS CNAME ${ddnsTargets[0].sub}` : ''}；不带 dryRun=1 才会真正执行`,
        });
      }

      const logs = [];
      // 先清理 DDNS，再删除 ESA：DDNS 失败则中止并保留 ESA 记录，
      // 原 recordId 仍可查得 → 同一请求重试即可补齐；ESA 删除失败同理可重试。
      let ddnsRemoved = 0;
      if (purgeDdns && ddnsTargets.length) {
        if (!(config.lucky.openToken || (config.lucky.account && config.lucky.password))) {
          return res.json({
            ok: false,
            deleted: false,
            error: '无法连带清理 DDNS：未配置 Lucky 凭据。ESA 记录已保留，配置凭据后可重试',
            purgeDdns,
            dryRun,
          });
        }
        try {
          const ddnsResult = await deleteDdnsRecords(config, ddnsRoot, ddnsTargets);
          ddnsRemoved = ddnsResult.count;
          logs.push({
            step: 'Lucky DDNS CNAME',
            status: ddnsResult.count ? 'ok' : 'warn',
            detail: ddnsResult.count ? `已删除 ${ddnsTargets[0].sub} CNAME` : `未找到 ${ddnsTargets[0].sub} 记录`,
          });
        } catch (error) {
          return res.json({
            ok: false,
            deleted: false,
            error: `DDNS 清理失败，ESA 记录已保留（可重试）: ${error.message}`,
            purgeDdns,
            dryRun,
            ddnsRemoved,
            logs,
          });
        }
      }

      let esaDeleted = false;
      try {
        // 按 recordId 删除并重试（避免按 name 重试时误删同名其他类型记录）
        const result = await disableEsaDomain(config, current.name, { recordId: current.id });
        esaDeleted = !!result.deleted;
        logs.push({
          step: 'ESA 加速域名',
          status: result.deleted ? 'ok' : 'warn',
          detail: result.deleted ? `已删除 ${current.name}` : `未删除 ${current.name}（${result.reason}）`,
        });
      } catch (error) {
        logs.push({ step: 'ESA 加速域名', status: 'error', detail: error.message });
      }

      for (const item of logs) pushServerLog(item.step, item.status, item.detail);
      const failed = logs.some((l) => l.status === 'error');
      res.json({
        ok: !failed,
        deleted: esaDeleted,
        purgeDdns,
        ddnsRemoved,
        logs,
        error: failed
          ? `部分失败：${logs.filter((l) => l.status === 'error').map((l) => `${l.step}: ${l.detail}`).join('；')}`
          : undefined,
        message: failed
          ? `部分失败：${logs.filter((l) => l.status === 'error').map((l) => `${l.step}: ${l.detail}`).join('；')}`
          : esaDeleted
            ? `已删除 ${current.name}${ddnsRemoved ? '（含 DDNS CNAME）' : ''}`
            : `未删除 ${current.name}（${(logs[0] || {}).detail || '未知原因'}）`,
      });
    }),
  );
}

module.exports = { register };
