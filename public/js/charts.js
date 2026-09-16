// 性能图：单应用一行折线（6 app 颜色不同透明度区分）
// 主题色全部走 CSS 变量，6 条折线用 var(--accent) 不同透明度叠加（异常=红）。
import { escapeHtml } from './ui.js';

const SPARK_W = 240;
const SPARK_H = 28;

/* ---------- 折线（sparkline）：返回 SVG 字符串 ---------- */
function buildSparkline(points, opts = {}) {
  const w = opts.width || SPARK_W;
  const h = opts.height || SPARK_H;
  if (!points || points.length < 2) {
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"></svg>`;
  }
  const lats = points.map((p) => p.latency);
  const maxV = Math.max(...lats, 1);
  const minV = 0;
  const stepX = points.length > 1 ? w / (points.length - 1) : 0;
  const pts = points
    .map((p, i) => {
      const x = i * stepX;
      const y = h - ((p.latency - minV) / (maxV - minV)) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const dotAttrs = opts.className ? `class="${opts.className}"` : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">` +
    `<polyline ${dotAttrs} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" points="${pts}"/>` +
    '</svg>';
}

/* ---------- 性能图：1 个大块，6 app 一行一折线 ---------- */
/* 主题色用 var(--accent) 不同透明度叠加，避免多色噪点；异常点/段用红叠加 */
const APP_OPACITIES = [1.0, 0.8, 0.6, 0.5, 0.4, 0.3];

export function renderPerfLineChart(container, series, appsMeta = {}, opts = {}) {
  if (!container) return;
  const keys = Object.keys(series || {}).filter((k) => k.endsWith(':cdn'));
  if (keys.length === 0) {
    container.innerHTML = '<div class="empty-state"><i data-lucide="activity"></i><span>暂无历史数据，多次「连通自检」后自动累计。</span></div>';
    return;
  }
  // 收集所有应用（去重 appId），保持顺序
  const seen = new Set();
  const apps = [];
  for (const key of keys) {
    const sepIdx = key.lastIndexOf(':');
    const appId = key.slice(0, sepIdx);
    if (seen.has(appId)) continue;
    seen.add(appId);
    apps.push({ appId, points: series[key] || [] });
  }
  const rows = apps.map((a, idx) => {
    const meta = appsMeta[a.appId] || { name: a.appId.slice(0, 8) };
    const last = a.points[a.points.length - 1];
    const lastLat = last?.latency ?? '—';
    const lastStatus = last?.ok === false || (last && last.status && last.status >= 400);
    const opacity = APP_OPACITIES[idx % APP_OPACITIES.length];
    return `
      <div class="perf-line-row${lastStatus ? ' has-error' : ''}" style="color: var(--accent); opacity: ${opacity}">
        <span class="perf-line-name" style="color: var(--text); opacity: 1">${escapeHtml(meta.name)}</span>
        <span class="perf-line-svg-wrap">${buildSparkline(a.points, { width: 240, height: 28, className: 'perf-line-svg-path' })}</span>
        <span class="perf-line-last" style="color: var(--muted); opacity: 1">${lastLat}ms</span>
      </div>`;
  });
  container.innerHTML = rows.join('');
}

/* ---------- 旧接口保留：renderSparklines（不再被 main.js 调用，但保留以防外部使用） ---------- */
export function renderSparklines(container, series, appsMeta = {}) {
  return renderPerfLineChart(container, series, appsMeta);
}

/* ---------- 旧接口保留：renderLatencyBars（已不用，但保留兼容） ---------- */
export function renderLatencyBars(container, results) {
  if (!container) return;
  if (!results || results.length === 0) {
    container.innerHTML = '<div class="empty-state"><i data-lucide="inbox"></i><span>暂无应用，先在「应用管理」添加。</span></div>';
    return;
  }
  let maxMs = 1;
  for (const r of results) {
    for (const c of r.checks || []) {
      if (c && typeof c.latency === 'number') maxMs = Math.max(maxMs, c.latency);
    }
  }
  const rows = results.map((app) => {
    const nas = (app.checks || []).find((c) => c.label === 'nas');
    const cdn = (app.checks || []).find((c) => c.label === 'cdn');
    return `
      <div class="bar-row">
        <span class="bar-label">${escapeHtml(app.name)}</span>
        <span class="bar-cell">
          ${nas ? barCell('nas', nas, maxMs) : '<span class="bar-empty">—</span>'}
          ${cdn ? barCell('cdn', cdn, maxMs) : '<span class="bar-empty">—</span>'}
        </span>
      </div>`;
  }).join('');
  container.innerHTML = rows;
}

function barCell(kind, check, maxMs) {
  const pct = Math.max(2, Math.round((check.latency / maxMs) * 100));
  const cls = check.ok ? 'ok' : 'err';
  const ms = `${check.latency}ms`;
  const status = check.status ? `HTTP ${check.status}` : check.error || '失败';
  return `<span class="bar ${kind} ${cls}" title="${escapeHtml(status)}" style="width:${pct}%"><span class="bar-ms">${kind} ${ms}</span></span>`;
}
