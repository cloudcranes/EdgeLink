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
    const data = await api.fetchSummary();
    const s = data.summary;
    const apps = state.config?.apps || [];
    const rootDomain = getRootDomain(state.config);

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
    if (banner && bannerText) {
      if (errorApps.length > 0) {
        banner.hidden = false;
        const names = errorApps.slice(0, 3).map((a) => a.name || a.prefix).join('、');
        const more = errorApps.length > 3 ? ` 等 ${errorApps.length} 个` : '';
        bannerText.innerHTML = `<strong>${errorApps.length}</strong> 个应用需要关注：${escapeHtml(names)}${escapeHtml(more)} · 最近失败：${escapeHtml(errorApps[0]?.lastError || '查看详情')}`;
        refreshIcons();
      } else {
        banner.hidden = true;
      }
    }

    return { healthRate, errorApps, total, live };
  } catch (error) {
    return { healthRate: null, errorApps: [], total: 0, live: 0, error: error.message };
  }
}

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
