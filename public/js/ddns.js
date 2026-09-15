import { api } from './api.js';
import { appendLog, confirmDialog, escapeHtml } from './ui.js';

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
  const recordRows = records
    .map(
      (r) => `<tr>
        <td class="mono" title="子域" data-label="子域">${escapeHtml(r.subDomain || '')}</td>
        <td class="mono" title="主域" data-label="主域">${escapeHtml(r.domainName || '')}</td>
        <td class="mono" title="类型" data-label="类型">${escapeHtml(r.type || '')}</td>
        <td class="mono" title="recordKey=${escapeHtml(r.key || '')}" data-label="recordKey"><span class="mono-key">${escapeHtml(r.key || '—')}</span></td>
      </tr>`,
    )
    .join('');
  const summary = records
    .map((r) => escapeHtml(r.subDomain || ''))
    .filter(Boolean)
    .slice(0, 6)
    .join(', ');
  const more = records.length > 6 ? ` 等 ${records.length} 条` : '';
  return `
    <details class="ddns-task" open>
      <summary>
        <span class="ddns-task-name"><i data-lucide="${task.enable ? 'toggle-right' : 'toggle-left'}"></i>${escapeHtml(task.taskName || '(未命名)')}</span>
        <span class="ddns-task-meta">
          <span class="tag">${escapeHtml(task.taskType || '')}</span>
          <span class="tag">${escapeHtml(task.dnsProvider || '')}</span>
          <span class="tag">${records.length} 条记录</span>
          ${task.hasNasWildcard ? '<span class="tag nas-tag">含 *.nas 通配</span>' : ''}
        </span>
        <span class="ddns-task-preview">${escapeHtml(summary + more)}</span>
      </summary>
      <table class="ddns-records">
        <thead><tr><th>子域</th><th>主域</th><th>类型</th><th>recordKey</th></tr></thead>
        <tbody>${recordRows}</tbody>
      </table>
    </details>`;
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
