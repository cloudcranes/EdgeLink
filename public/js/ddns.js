import { api } from './api.js';
import { appendLog, confirmDialog, escapeHtml, refreshIcons, showToast } from './ui.js';

// 清除公网解析残留：按前缀直连 alidns 删除对应解析记录
// 用于清理「已删除应用/ESA 记录后仍残留的 alidns 解析」
export async function cleanupResidue(rrPrefix, domainName) {
  if (!rrPrefix) {
    appendLog('清除残留', 'error', '请输入域名前缀');
    return;
  }
  const root = domainName || '';
  try {
    const dry = await api.cleanupResidue({ rrPrefix, domainName: root }, { dryRun: true });
    if (!dry.ok) {
      appendLog('清除残留', 'error', dry.error || '预览失败');
      return;
    }
    const will = dry.willDelete || [];
    const notFound = dry.notFound || [];
    const lines = [
      `主域：${dry.domainName}`,
      `将删除 ${will.length} 条解析记录：`,
      ...will.map((r) => `  ${r.rr}.${dry.domainName} (${r.type})`),
      notFound.length ? `未找到 ${notFound.length} 条：${notFound.map((r) => r.rr).join('、')}` : '',
    ].filter(Boolean).join('\n');
    if (!(await confirmDialog({
      title: '清除公网解析残留',
      message: `清除公网解析残留？\n\n${lines}\n\n确认执行？`,
      okLabel: '清除',
      danger: true,
    }))) {
      appendLog('清除残留', 'warn', `用户取消：${rrPrefix}`);
      return;
    }
    const real = await api.cleanupResidue({ rrPrefix, domainName: root });
    (real.deleted || []).forEach((r) => {
      appendLog('清除残留', 'ok', `已删除 ${r.rr}.${dry.domainName} (${r.type})`);
    });
    (real.errors || []).forEach((r) => {
      appendLog('清除残留', 'error', `${r.rr}: ${r.error}`);
    });
    if (real.notFound?.length) {
      appendLog('清除残留', 'warn', `未找到：${real.notFound.map((r) => r.rr).join('、')}`);
    }
    appendLog('清除残留', 'ok', real.message || `清除完成`);
  } catch (error) {
    appendLog('清除残留', 'error', error.message, { 前缀: rrPrefix });
  }
}

function renderTaskCard(task) {
  const records = task.records || [];
  // 每条记录共享同一个主域，去掉表格里的"主域"列，把主域放到 task summary 标签里
  const recordRows = records
    .map(
      (r) => `<tr>
        <td class="mono" title="子域" data-label="子域">${escapeHtml(r.subDomain || '')}</td>
        <td class="mono" title="类型" data-label="类型">${escapeHtml(r.type || '')}</td>
        <td class="mono" title="recordKey=${escapeHtml(r.key || '')}" data-label="recordKey"><span class="mono-key">${escapeHtml(r.key || '—')}</span></td>
        <td class="ddns-action" data-label="操作">
          <button type="button" class="btn" data-ddns-record-delete data-task-key="${escapeHtml(task.taskKey || '')}" data-record-key="${escapeHtml(r.key || '')}" data-sub-domain="${escapeHtml(r.subDomain || '')}" data-domain-name="${escapeHtml(r.domainName || '')}" data-type="${escapeHtml(r.type || '')}" title="从 Lucky DDNS 任务中移除此记录（不删 alidns 公网解析）">
            <i data-lucide="trash-2"></i>
          </button>
        </td>
      </tr>`,
    )
    .join('');
  const summary = records
    .map((r) => escapeHtml(r.subDomain || ''))
    .filter(Boolean)
    .slice(0, 6)
    .join(', ');
  const more = records.length > 6 ? ` 等 ${records.length} 条` : '';
  // 同一 task 内所有记录共享的 rootDomain，取自首条记录
  const sharedRoot = records[0]?.domainName || task.dnsProvider || '';
  return `
    <details class="ddns-task">
      <summary>
        <span class="ddns-task-name"><i data-lucide="${task.enable ? 'toggle-right' : 'toggle-left'}"></i>${escapeHtml(task.taskName || '(未命名)')}</span>
        <span class="ddns-task-meta">
          <span class="tag">${escapeHtml(task.taskType || '')}</span>
          <span class="tag">${escapeHtml(task.dnsProvider || '')}</span>
          ${sharedRoot ? `<span class="tag">${escapeHtml(sharedRoot)}</span>` : ''}
          <span class="tag">${records.length} 条</span>
          ${task.hasNasWildcard ? '<span class="tag nas-tag">含 *.nas 通配</span>' : ''}
        </span>
        <span class="ddns-task-preview">${escapeHtml(summary + more)}</span>
      </summary>
      <table class="ddns-records">
        <thead><tr><th>子域</th><th>类型</th><th>recordKey</th><th class="ddns-action-th">操作</th></tr></thead>
        <tbody>${recordRows}</tbody>
      </table>
    </details>`;
}

/* ---------- DDNS 记录删除：dryRun 预览 → 确认 → 真删 ---------- */

async function handleDdnsRecordDelete(btn) {
  const recordKey = btn.dataset.recordKey;
  const subDomain = btn.dataset.subDomain;
  const domainName = btn.dataset.domainName;
  const type = btn.dataset.type;
  if (!recordKey) {
    showToast('记录缺少 recordKey，无法删除', 'err');
    return;
  }
  const fqdn = subDomain && domainName ? `${subDomain}.${domainName}` : recordKey;
  // 第一步：dryRun 预览（后端 record-delete 支持 ?dryRun=1 返回将移除的记录数 + 详情，不写盘）
  let preview;
  try {
    preview = await api.recordDeleteDdns(recordKey, { dryRun: true });
  } catch (error) {
    appendLog('DDNS 记录删除', 'error', error.message, { 记录: fqdn });
    showToast(`预览失败：${error.message}`, 'err');
    return;
  }
  if (!preview.ok) {
    appendLog('DDNS 记录删除', 'error', preview.error || '预览失败', { 记录: fqdn });
    showToast(preview.error || '预览失败', 'err');
    return;
  }
  const lines = [
    `Lucky 任务：${preview.taskKey || '—'}`,
    `将移除 ${preview.records?.length || 0} 条匹配记录：`,
    ...(preview.records || []).map((r) => `  · ${r.subDomain || ''}.${domainName || r.domain || ''} (${r.type || type || ''})`),
    '',
    '提示：仅清理 Lucky DDNS 任务条目，不会删除 alidns 公网解析。',
  ].filter((l) => l !== '' || true).join('\n');
  const ok = await confirmDialog({
    title: '从 Lucky DDNS 任务中移除记录',
    message: `确认移除以下 DDNS 记录？\n\n${lines}\n\n继续？`,
    okLabel: '移除',
    danger: true,
  });
  if (!ok) {
    appendLog('DDNS 记录删除', 'warn', '用户取消', { 记录: fqdn });
    return;
  }
  // 第二步：真删
  try {
    const result = await api.recordDeleteDdns(recordKey);
    appendLog('DDNS 记录删除', 'ok', `已移除 ${result.removed || 0} 条`, { 记录: fqdn });
    showToast(`已移除 ${result.removed || 0} 条 DDNS 记录`, 'ok');
    refreshDdns();
  } catch (error) {
    appendLog('DDNS 记录删除', 'error', error.message, { 记录: fqdn });
    showToast(`删除失败：${error.message}`, 'err');
  }
}

export async function refreshDdns() {
  const container = document.getElementById('ddns-tasks');
  if (!container) return;
  try {
    const json = await api.fetchLuckyDdns();
    const tasks = json.tasks || [];
    if (tasks.length === 0) {
      container.innerHTML = `<div class="empty-state"><i data-lucide="folder-open"></i><span>暂无 Lucky DDNS 任务（在 Lucky 后台手动创建，DDNS 任务 Key 填到「设置 → Lucky → DDNS 任务」即可自动匹配）</span></div>`;
      window.lucide?.createIcons();
      return;
    }
    container.innerHTML = tasks.map(renderTaskCard).join('');
    window.lucide?.createIcons();
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><span>DDNS 任务加载失败：${escapeHtml(error.message)}</span></div>`;
    window.lucide?.createIcons();
  }
}

// 记录删除按钮：事件委托（每次刷新后重绑——刷新时 innerHTML 被替换，原监听丢失）
export function bindDdnsDeleteHandler() {
  const container = document.getElementById('ddns-tasks');
  if (!container || container._deleteBound) return;
  container._deleteBound = true;
  container.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-ddns-record-delete]');
    if (!btn) return;
    handleDdnsRecordDelete(btn);
  });
}
