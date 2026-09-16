// 系统健康度仪表盘：中央大数字（健康率）+ 4 周围小指标 + 异常悬浮按钮 + 待处理条
import { api } from './api.js';
import { cdnDomainFor, getRootDomain, nasDomainFor, state } from './state.js';
import { refreshIcons } from './ui.js';

function setText(id, text, tone, title) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `health-metric-value ${tone || ''}`.trim();
  if (title) el.title = title;
}

function numFlash(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('num-flash');
  void el.offsetWidth; // reflow 重启动画
  el.classList.add('num-flash');
}

export async function refreshSummary() {
  try {
    const [data, diagItems] = await Promise.all([
      api.fetchSummary(),
      fetchEsaCnameDiagnostics(),
    ]);
    const s = data.summary;
    const apps = state.config?.apps || [];
    const rootDomain = getRootDomain(state.config);
    const fixableCname = diagItems.filter((i) => i.fixable);

    // 健康率 = 已就绪应用 / 应用总数
    const total = apps.length;
    const live = apps.filter((a) => a.status === 'live').length;
    const failed = apps.filter((a) => a.status === 'failed').length;
    const building = apps.filter((a) => a.status === 'building').length;
    const pending = apps.filter((a) => a.status === 'pending').length;
    const healthRate = total > 0 ? Math.round((live / total) * 100) : null;
    const errorApps = apps.filter((a) => a.status === 'failed' || (a.lastError && (a.status === 'building' || a.status === 'pending')));

    // 中央大数字
    const big = document.getElementById('health-rate');
    if (big) {
      big.textContent = healthRate === null ? '—' : String(healthRate);
      big.parentElement.classList.toggle('warn', healthRate !== null && healthRate < 90);
      big.parentElement.classList.toggle('danger', healthRate !== null && healthRate < 70);
      numFlash('health-rate');
    }
    const suffix = document.getElementById('health-rate-suffix');
    if (suffix) suffix.textContent = total > 0 ? `${live}/${total} 应用已就绪` : '尚未配置应用';

    // 4 周围小指标
    setText('health-metric-apps', total > 0 ? `${total}${errorApps.length ? ` / ${errorApps.length} 异常` : ''}` : '—', errorApps.length ? 'warn' : 'ok');
    setText('health-metric-cdn', s.esaPanelDomains ? `${s.esaPanelDomains} 加速` : '—', s.esaPanelDomains ? 'ok' : 'muted');
    setText('health-metric-lucky', s.lucky?.ok ? 'OK' : (s.lucky?.error ? '异常' : '—'), s.lucky?.ok ? 'ok' : (s.lucky?.error ? 'danger' : 'muted'));
    const certOk = s.esaNasCertificate && s.luckyNasSsl && s.luckyDdnsNasTask;
    const certDetail = [
      s.esaNasCertificate ? '✓ ESA' : '✗ ESA',
      s.luckyNasSsl ? '✓ SSL' : '✗ SSL',
      s.luckyDdnsNasTask ? '✓ DDNS' : '✗ DDNS',
    ].join(' ');
    setText('health-metric-cert', certOk ? '齐备' : '缺失', certOk ? 'ok' : 'warn', certDetail);

    // 异常悬浮按钮
    const fab = document.getElementById('exception-fab');
    const fabCount = document.getElementById('exception-fab-count');
    if (fab && fabCount) {
      if (errorApps.length > 0) {
        fab.hidden = false;
        requestAnimationFrame(() => fab.classList.add('show'));
        fabCount.textContent = String(errorApps.length);
      } else {
        fab.classList.remove('show');
        setTimeout(() => { fab.hidden = true; }, 200);
      }
    }

    // 主页待处理条
    const banner = document.getElementById('pending-banner');
    const bannerText = document.getElementById('pending-banner-text');
    const bannerAction = document.getElementById('pending-banner-action');
    const failedMenu = document.getElementById('pending-failed-menu');
    const failedSummaryText = document.getElementById('pending-failed-summary-text');
    const failedList = document.getElementById('pending-failed-list');
    if (banner && bannerText) {
      const errors = errorApps.length > 0;
      const cnameMissing = fixableCname.length > 0;
      const hasFailedRetries = failedItems.length > 0;
      if (errors || cnameMissing) {
        banner.hidden = false;
        if (errors) {
          const names = errorApps.slice(0, 3).map((a) => a.name || a.prefix).join('、');
          const more = errorApps.length > 3 ? ` 等 ${errorApps.length} 个` : '';
          bannerText.innerHTML = `<strong>${errorApps.length}</strong> 个应用需要关注：${escapeHtml(names)}${escapeHtml(more)} · 最近失败：${escapeHtml(errorApps[0]?.lastError || '查看详情')}`;
        } else if (hasFailedRetries) {
          bannerText.innerHTML = `<strong>${failedItems.length}</strong> 项 ESA 修复失败，点击右侧「重试 N 项失败」单独处理`;
        } else {
          const names = fixableCname.slice(0, 3).map((i) => i.name || i.prefix).join('、');
          const more = fixableCname.length > 3 ? ` 等 ${fixableCname.length} 个` : '';
          bannerText.innerHTML = `<strong>${fixableCname.length}</strong> 个应用 ESA CNAME 未配置（${escapeHtml(names)}${escapeHtml(more)}），点击右侧一键修复`;
        }
        if (bannerAction) {
          // 有失败项待重试：主按钮切到「重试」；否则保持一键修复
          if (hasFailedRetries) {
            bannerAction.hidden = false;
            bannerAction.innerHTML = `<i data-lucide="rotate-cw"></i><span>重试 ${failedItems.length} 项</span>`;
            bannerAction.dataset.mode = 'fix-cname-retry';
          } else if (cnameMissing && !errors) {
            bannerAction.hidden = false;
            bannerAction.innerHTML = '<i data-lucide="wand-2"></i><span>一键修复</span>';
            bannerAction.dataset.mode = 'fix-cname';
          } else {
            bannerAction.hidden = false;
            bannerAction.innerHTML = '<i data-lucide="arrow-right"></i><span>查看</span>';
            bannerAction.dataset.mode = 'view-apps';
          }
        }
        // 失败下拉：只有 hasFailedRetries 时显示
        if (failedMenu && failedSummaryText && failedList) {
          if (hasFailedRetries) {
            failedMenu.hidden = false;
            failedSummaryText.textContent = `失败 ${failedItems.length} 项 ▾`;
            failedList.innerHTML = failedItems.map((f) => `
              <button type="button" class="pending-failed-item" data-failed-app="${escapeHtml(f.appId)}" title="${escapeHtml(f.error || '')}">
                <span class="pending-failed-item-domain">${escapeHtml(f.domain)}</span>
                <span class="pending-failed-item-error">${escapeHtml(f.error || '')}</span>
              </button>
            `).join('');
          } else {
            failedMenu.hidden = true;
            failedMenu.removeAttribute('open');
            failedList.innerHTML = '';
          }
        }
        refreshIcons();
      } else {
        banner.hidden = true;
        if (bannerAction) bannerAction.hidden = true;
        if (failedMenu) { failedMenu.hidden = true; failedMenu.removeAttribute('open'); }
        if (failedList) failedList.innerHTML = '';
      }
    }

    return { healthRate, errorApps, total, live, fixableCname };
  } catch (error) {
    return { healthRate: null, errorApps: [], total: 0, live: 0, error: error.message };
  }
}

// 自愈诊断：扫描 ESA 加速域名 vs alidns CNAME 一致性
export async function fetchEsaCnameDiagnostics() {
  try {
    const data = await api.fetchEsaCnameDiagnostics();
    return data.items || [];
  } catch {
    return [];
  }
}

export async function fixEsaCname(appId) {
  await api.fixEsaCname(appId);
}

// 失败项管理：模块作用域，render 失败下拉 + 单条 retry
let failedItems = [];
export function setFailedItems(list) { failedItems = Array.isArray(list) ? list : []; }
export function getFailedItems() { return failedItems; }
export function removeFailedItem(appId) {
  failedItems = failedItems.filter((f) => f.appId !== appId);
}
export function addFailedItem(item) {
  const idx = failedItems.findIndex((f) => f.appId === item.appId);
  if (idx >= 0) failedItems[idx] = item; // 已存在则覆盖（更新 error 信息）
  else failedItems.push(item);
}
export function clearFailedItems() { failedItems = []; }

// 单独刷新异常悬浮按钮（renderApps 之后调用，因为 renderApps 可能改了 status）
export function refreshExceptionFab() {
  return refreshSummary();
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
