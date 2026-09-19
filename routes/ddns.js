// Lucky DDNS 业务路由：任务 / nas 通配 / 记录维护 / 残留清理 / TXT
const { readConfig } = require('../lib/config');
const { luckyLogin, luckyRequest } = require('../lib/lucky');
const { getLuckyDdnsTasks, createNasDdnsTask, addDdnsRecord } = require('../lib/ddns');
const { alidnsListRecords, alidnsDeleteRecord } = require('../lib/alidns');
const { pushServerLog } = require('../lib/logs');
const { asyncHandler } = require('../utils/http');

// 取一个 task 的明细 records（含 SyncRecordData.content）
async function getTaskDetailRecords(config, taskKey) {
  if (!taskKey) return [];
  try {
    const { baseUrl, token } = await luckyLogin(config);
    const detail = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${taskKey}`);
    const task = detail.task || detail.data || {};
    return task.Records || [];
  } catch {
    return [];
  }
}

// 提取记录值（CNAMEContent / IPv6Addr / Value / content，兼容旧版 Lucky）
function extractRecordContent(r) {
  if (!r) return '';
  const srd = r.SyncRecordData && typeof r.SyncRecordData === 'object' ? r.SyncRecordData : null;
  return (
    srd?.CNAMEContent || srd?.ipv6Address || srd?.Value || srd?.content ||
    r.CNAMEContent || r.Value || r.Content || r.content || ''
  );
}

function register(app) {
  app.get(
    '/api/lucky/ddns/tasks',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const tasks = await getLuckyDdnsTasks(config);
      const rootDomain = String(config.esa?.rootDomain || '').toLowerCase();
      // list 端点不带 content，并发拉每个 task 的 detail 补全 content 字段
      const detailMap = new Map();
      await Promise.all(
        tasks.map(async (task) => {
          if (!task.TaskKey) return;
          const records = await getTaskDetailRecords(config, task.TaskKey);
          detailMap.set(task.TaskKey, records);
        }),
      );
      const summary = tasks.map((task) => ({
        taskKey: task.TaskKey,
        taskName: task.TaskName,
        taskType: task.TaskType,
        enable: task.Enable !== false,
        dnsProvider: (task.DNS || {}).Name || '',
        recordCount: (task.Records || []).length,
        records: (task.Records || []).map((r) => {
          // 在 detail records 中按 Key 找匹配的 content
          const detailRecs = detailMap.get(task.TaskKey) || [];
          const matched = detailRecs.find((d) => d.Key === r.Key) || {};
          const content =
            extractRecordContent(matched) ||
            extractRecordContent(r) ||
            '';
          return {
            key: r.Key || '',
            subDomain: r.SubDomain || '',
            domainName: r.DomainName || '',
            type: r.Type || '',
            content,
          };
        }),
        hasNasWildcard:
          rootDomain &&
          (task.Records || []).some(
            (r) =>
              r.Type === 'AAAA' &&
              String(r.SubDomain || '') === '*.nas' &&
              String(r.DomainName || '').toLowerCase() === rootDomain,
          ),
      }));
      res.json({ ok: true, rootDomain, tasks: summary });
    }),
  );

  app.post(
    '/api/lucky/ddns/nas-task',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const rootDomain = String(req.body?.rootDomain || config.esa?.rootDomain || '').trim().toLowerCase();
      if (!rootDomain) {
        throw new Error('缺少站点根域');
      }
      const result = await createNasDdnsTask(config, rootDomain);
      res.json({ ok: true, created: result.created, manual: !!result.manual, message: result.message });
    }),
  );

  // DDNS 维护：删除单条记录（按 subDomain 匹配整条 Lucky DDNS 任务里的任意 alidns 记录）
  // 用途：用户手动维护 DDNS 记录（如退役一条旧子域）；不替代面板自动写路径
  // 强制要求 recordKey（不再按 subDomain 一刀切，避免误删多条同名记录）
  // ?dryRun=1 返回待删记录清单但不动 Lucky
  app.post(
    '/api/lucky/ddns/record-delete',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const recordKey = String(req.body?.recordKey || '').trim();
      if (!recordKey) throw new Error('缺少 recordKey（必须精确指定一条记录，禁止按 subDomain 批量删除）');
      const dryRun = String(req.query.dryRun || '') === '1' || req.body?.dryRun === true;
      const tasks = await getLuckyDdnsTasks(config);
      const target = tasks.find((t) => ((t.DNS || {}).Name || '') === 'alidns') || tasks[0];
      if (!target) throw new Error('未找到 DDNS 任务');
      const { baseUrl, token } = await luckyLogin(config);
      const detail = await luckyRequest(baseUrl, token, 'GET', `/api/ddns/task/${target.TaskKey}`);
      const task = detail.task || detail.data;
      const before = (task.Records || []).length;
      const matched = (task.Records || []).filter((r) => r.Key === recordKey);
      if (matched.length === 0) {
        return res.json({ ok: false, error: `Lucky 任务中未找到 recordKey=${recordKey}`, removed: 0, dryRun, taskKey: target.TaskKey });
      }
      const matchedView = matched.map((r) => ({
        key: r.Key,
        subDomain: (r.SyncRecordData && r.SyncRecordData.SubDomainName) || r.SubDomain || '',
        domain: (r.SyncRecordData && r.SyncRecordData.DomainName) || r.DomainName || '',
        type: (r.SyncRecordData && r.SyncRecordData.type) || r.Type || '',
        content: (r.SyncRecordData && (r.SyncRecordData.CNAMEContent || r.SyncRecordData.TXTContent || r.SyncRecordData.Value)) || '',
        remark: (r.SyncRecordData && r.SyncRecordData.remark) || '',
      }));
      if (dryRun) {
        return res.json({ ok: true, dryRun: true, willRemove: matchedView.length, records: matchedView, taskKey: target.TaskKey });
      }
      task.Records = (task.Records || []).filter((r) => r.Key !== recordKey);
      await luckyRequest(baseUrl, token, 'PUT', `/api/ddns?key=${target.TaskKey}`, task);
      res.json({ ok: true, removed: before - task.Records.length, records: matchedView, taskKey: target.TaskKey });
    }),
  );

  // 清除公网解析残留：直连 alidns 删除指定主域下的解析记录（如已删除应用遗留的 aiusage.nas / aiusage.cdn）
  // body: { domainName: "alanmaster.top", records: [{ rr, type, value }] } 或 { rrPrefix: "aiusage" } 按前缀匹配
  // ?dryRun=1 只预览不删
  // 非 dryRun 必须 confirm='yes-i-am-sure'（body 或 query 都可），否则拒绝执行——这是公网解析真实删除。
  const CLEANUP_CONFIRM = 'yes-i-am-sure';
  app.post(
    '/api/lucky/ddns/cleanup-residue',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const dryRun = String(req.query.dryRun || '') === '1' || req.body?.dryRun === true;
      if (!dryRun) {
        const confirm = req.body?.confirm || req.query.confirm;
        if (confirm !== CLEANUP_CONFIRM) {
          const err = new Error(`非 dryRun 必须 confirm='${CLEANUP_CONFIRM}'（可放 body.confirm 或 ?confirm=）；请先 dryRun 预览后再确认真删`);
          err.status = 400;
          throw err;
        }
      }
      const domainName = String(req.body?.domainName || config.esa?.rootDomain || '').trim().toLowerCase();
      if (!domainName) throw new Error('缺少 domainName（站点根域）');
      const explicit = Array.isArray(req.body?.records) ? req.body.records : null;
      const rrPrefix = String(req.body?.rrPrefix || '').trim().toLowerCase();

      // 拉取 alidns 全部记录
      let all;
      try {
        all = await alidnsListRecords(config, domainName);
      } catch (error) {
        return res.json({ ok: false, error: `alidns 查询失败：${error.message}`, dryRun });
      }

      // 筛选待删：显式列表 或 rrPrefix 前缀匹配
      let targets = [];
      if (explicit) {
        targets = explicit.map((r) => ({
          recordId: String(r.recordId || ''),
          RR: String(r.rr || '').toLowerCase(),
          type: String(r.type || '').toUpperCase(),
          value: String(r.value || ''),
          matched: false,
        }));
      } else if (rrPrefix) {
        targets = all
          .filter((r) => String(r.RR || '').toLowerCase() === rrPrefix || String(r.RR || '').toLowerCase().startsWith(rrPrefix + '.'))
          .map((r) => ({ ...r, matched: false }));
      } else {
        throw new Error('需提供 records 列表或 rrPrefix');
      }

      // 从 alidns 现有记录中找 recordId（显式列表可能没给 recordId）
      for (const t of targets) {
        if (t.recordId) continue;
        const found = all.find((r) => r.RR === t.RR && r.type === t.type && (!t.value || r.value === t.value));
        if (found) {
          t.recordId = String(found.recordId);
          t.matched = true;
        }
      }
      const withId = targets.filter((t) => t.recordId);
      const notFound = targets.filter((t) => !t.recordId);

      if (dryRun) {
        return res.json({
          ok: true,
          dryRun: true,
          domainName,
          willDelete: withId.map((t) => ({ recordId: t.recordId, rr: t.RR, type: t.type, value: t.value })),
          notFound: notFound.map((t) => ({ rr: t.RR, type: t.type, value: t.value })),
          message: `dryRun 模式：将删除 ${withId.length} 条，${notFound.length} 条未找到；不带 dryRun=1 才会真正执行`,
        });
      }

      const deleted = [];
      const errors = [];
      for (const t of withId) {
        try {
          await alidnsDeleteRecord(config, t.recordId);
          deleted.push({ recordId: t.recordId, rr: t.RR, type: t.type, value: t.value });
        } catch (error) {
          errors.push({ rr: t.RR, type: t.type, error: error.message });
        }
      }
      for (const item of deleted) {
        pushServerLog('清理解析残留', 'ok', `已删除 ${item.rr}.${domainName} (${item.type})`);
      }
      for (const item of errors) {
        pushServerLog('清理解析残留', 'error', `${item.rr}.${domainName} (${item.type})：${item.error}`);
      }
      res.json({
        ok: true,
        domainName,
        deleted,
        notFound: notFound.map((t) => ({ rr: t.RR, type: t.type })),
        errors,
        message: `已删除 ${deleted.length} 条残留${errors.length ? `，${errors.length} 条失败` : ''}${notFound.length ? `，${notFound.length} 条未找到` : ''}`,
      });
    }),
  );

  // 向 Lucky DDNS 任务追加 / 更新 TXT 记录（用于证书 DNS-01 校验等场景）
  // Lucky v3 alidns provider: params.Set("Type", recordType) 原样转发给 alidns API，
  // 故写入 type='TXT' + TXTContent 即可让 Lucky 引擎代为写公网 TXT 解析。
  app.post(
    '/api/lucky/ddns/txt',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const subDomain = String(req.body?.subDomain || '').trim().toLowerCase();
      const content = String(req.body?.content || '');
      const siteRoot = String(req.body?.siteRoot || config.esa?.rootDomain || '').trim().toLowerCase();
      const remark = String(req.body?.remark || `面板写入 ${new Date().toISOString().slice(0, 10)}`);
      if (!/^[a-z0-9_.*-]*$/.test(subDomain)) {
        throw new Error(`subDomain 含非法字符: ${subDomain}`);
      }
      if (!content) {
        throw new Error('缺少 TXT 内容');
      }
      if (!siteRoot) {
        throw new Error('缺少站点根域（siteRoot）');
      }
      const result = await addDdnsRecord(config, subDomain, 'TXT', 'TXTContent', content, siteRoot, remark);
      res.json({ ok: true, ...result });
    }),
  );
}

module.exports = { register };
