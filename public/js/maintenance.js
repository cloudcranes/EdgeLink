import { api } from './api.js';
import { appendLog, confirmDialog, escapeHtml, showBanner } from './ui.js';

const $ = (id) => document.getElementById(id);

function fmtTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export async function refreshSnapshots() {
  const container = $('snapshot-list');
  if (!container) return;
  try {
    const data = await api.listSnapshots();
    const snaps = data.snapshots || [];
    if (snaps.length === 0) {
      container.innerHTML = '<div class="empty-state"><i data-lucide="folder-open"></i><span>暂无快照（部署时自动创建）</span></div>';
      window.lucide?.createIcons();
      return;
    }
    container.innerHTML = snaps
      .map(
        (s) => `
      <div class="snapshot-item">
        <div class="snapshot-info">
          <strong>${escapeHtml(s.label || '部署前快照')}</strong>
          <span>${escapeHtml(fmtTime(s.time))} · ${s.apps} 个应用</span>
        </div>
        <button class="btn" type="button" data-restore="${escapeHtml(s.file)}" title="恢复到该快照">
          <i data-lucide="rotate-ccw"></i>
          <span>回滚</span>
        </button>
      </div>`,
      )
      .join('');
    window.lucide?.createIcons();
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><span>快照加载失败：${escapeHtml(error.message)}</span></div>`;
    window.lucide?.createIcons();
  }
}

export async function restoreSnapshot(file) {
  if (!(await confirmDialog({ title: '恢复快照', message: `恢复快照 ${file}？当前配置将被覆盖。`, okLabel: '恢复', danger: true }))) {
    return;
  }
  try {
    const data = await api.restoreSnapshot(file);
    appendLog('回滚快照', 'ok', data.message);
    showBanner('快照已恢复，正在重新加载…', 'ok');
    window.setTimeout(() => location.reload(), 800);
  } catch (error) {
    appendLog('回滚快照', 'error', error.message);
    showBanner(error.message, 'err');
  }
}

export async function runAudit() {
  const box = $('audit-result');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<div class="empty-state"><i data-lucide="loader-circle"></i><span>巡检中…</span></div>';
  window.lucide?.createIcons();
  try {
    const data = await api.audit();
    const { summary, issues } = data;
    const errs = issues.filter((i) => i.level === 'error');
    const warns = issues.filter((i) => i.level === 'warn');
    if (issues.length === 0) {
      box.innerHTML = `<div class="audit-ok"><i data-lucide="check-circle"></i><span>一致：${summary.apps} 个应用、${summary.luckyRules} 条 Lucky 子规则、${summary.esaDomains} 个 ESA 加速域名全部匹配</span></div>`;
      appendLog('一致性巡检', 'ok', `无差异（应用 ${summary.apps}，Lucky ${summary.luckyRules}，ESA ${summary.esaDomains}）`);
    } else {
      box.innerHTML = `
        <div class="audit-summary">发现 ${errs.length} 个问题、${warns.length} 个警告
          <button id="audit-fix-btn" class="btn btn-secondary" type="button" ${errs.length ? '' : 'disabled'} title="按面板配置补齐 Lucky 子规则、ESA 加速域名和 Lucky CNAME">
            <i data-lucide="wrench"></i><span>一键修复</span>
          </button>
        </div>
        ${issues
          .map(
            (i) => `<div class="audit-item ${i.level}">
              <i data-lucide="${i.level === 'error' ? 'x-circle' : i.level === 'warn' ? 'alert-triangle' : 'info'}"></i>
              <span>${escapeHtml(i.app ? `[${i.app}] ` : '')}${escapeHtml(i.detail)}</span>
            </div>`,
          )
          .join('')}`;
      appendLog('一致性巡检', errs.length ? 'error' : 'warn', `${errs.length} 问题 / ${warns.length} 警告`);
    }
    window.lucide?.createIcons();
  } catch (error) {
    box.innerHTML = `<div class="audit-item error"><i data-lucide="x-circle"></i><span>${escapeHtml(error.message)}</span></div>`;
    appendLog('一致性巡检', 'error', error.message);
    window.lucide?.createIcons();
  }
}

export async function fixAudit() {
  const box = $('audit-result');
  if (!box) return;
  const ok = await confirmDialog({ title: '一键修复', message: '按面板配置修复全部差异？会创建/更新 Lucky 子规则与 ESA 记录。', okLabel: '修复' });
  if (!ok) return;
  const btn = box.querySelector('#audit-fix-btn');
  if (btn) {
    btn.disabled = true;
    btn.querySelector('span').textContent = '修复中…';
  }
  try {
    const data = await api.auditFix(null);
    // 修复步骤日志由服务端 SSE 实时推送，避免重复
    showBanner(data.message || '修复完成', data.errors && data.errors.length ? 'err' : 'ok');
    if (data.fixed && data.fixed.length) {
      appendLog('一键修复', 'ok', `已修复：${data.fixed.join('、')}`);
    }
    if (data.errors && data.errors.length) {
      appendLog('一键修复', 'error', `失败：${data.errors.map((e) => `${e.app}: ${e.message}`).join('；')}`);
    }
    runAudit(); // 修复后重新巡检
  } catch (error) {
    box.innerHTML = `<div class="audit-item error"><i data-lucide="x-circle"></i><span>${escapeHtml(error.message)}</span></div>`;
    appendLog('一键修复', 'error', error.message);
    window.lucide?.createIcons();
  }
}

export async function runPortPrecheck() {
  const box = $('audit-result');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<div class="empty-state"><i data-lucide="loader-circle"></i><span>正在读取 Lucky 规则…</span></div>';
  window.lucide?.createIcons();
  try {
    const data = await api.portPrecheck();
    const parts = [];
    if (data.gatewayClash && data.gatewayClash.length) {
      parts.push(`<div class="audit-item error"><i data-lucide="x-circle"></i><span>网关端口 ${escapeHtml(String(data.gatewayPort))} 被 Lucky 规则「${escapeHtml(data.gatewayClash.join('、'))}」占用</span></div>`);
    } else {
      parts.push(`<div class="audit-ok"><i data-lucide="check-circle"></i><span>网关端口 ${escapeHtml(String(data.gatewayPort))} 无占用冲突</span></div>`);
    }
    for (const c of data.conflicts || []) {
      parts.push(`<div class="audit-item warn"><i data-lucide="alert-triangle"></i><span>端口 ${escapeHtml(c.listen)} 被多个规则占用：${escapeHtml(c.rules.join('、'))}</span></div>`);
    }
    box.innerHTML = parts.join('') || '<div class="audit-ok"><i data-lucide="check-circle"></i><span>未发现端口冲突</span></div>';
    appendLog('端口预检', data.gatewayClash && data.gatewayClash.length ? 'error' : 'ok', `网关 ${escapeHtml(String(data.gatewayPort))}${data.conflicts && data.conflicts.length ? `，另有 ${data.conflicts.length} 处重复端口` : ''}`);
    window.lucide?.createIcons();
  } catch (error) {
    box.innerHTML = `<div class="audit-item error"><i data-lucide="x-circle"></i><span>${escapeHtml(error.message)}</span></div>`;
    appendLog('端口预检', 'error', error.message);
    window.lucide?.createIcons();
  }
}

export function bindMaintenance(root) {
  root.addEventListener('click', (event) => {
    const restoreBtn = event.target.closest('button[data-restore]');
    if (restoreBtn) {
      restoreSnapshot(restoreBtn.dataset.restore);
    }
  });
}
