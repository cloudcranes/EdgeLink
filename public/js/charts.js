// 纯 SVG / DOM 渲染：延迟柱状图（当前快照）+ 折线图（历史）
// 无外部依赖，主题色全部走 CSS 变量。

import { escapeHtml } from './ui.js';

const SPARK_W = 120;
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
  // 失败点用红色描点（status >= 400 || ok=false）
  const dotAttrs = opts.className ? `class="${opts.className}"` : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">` +
    `<polyline ${dotAttrs} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" points="${pts}"/>` +
    '</svg>';
}

/* ---------- 折线区（每应用一行：名称 + cdn 折线 + 当前延迟） ---------- */
export function renderSparklines(container, series, appsMeta = {}) {
  if (!container) return;
  const keys = Object.keys(series || {});
  if (keys.length === 0) {
    container.innerHTML = '<div class="empty-state"><i data-lucide="activity"></i><span>暂无历史数据，先点击「连通自检」若干次后将自动累计。</span></div>';
    return;
  }
  // 按 appId 分组，保持应用维度（仅 cdn 序列）
  const byApp = new Map();
  for (const key of keys) {
    const sepIdx = key.lastIndexOf(':');
    const appId = key.slice(0, sepIdx);
    const label = key.slice(sepIdx + 1);
    if (!byApp.has(appId)) byApp.set(appId, []);
    byApp.get(appId).push({ label, points: series[key] });
  }
  const rows = [];
  for (const [appId, lines] of byApp) {
    const meta = appsMeta[appId] || { name: appId.slice(0, 8) };
    const cdnLine = lines.find((l) => l.label === 'cdn');
    const lastCdn = cdnLine?.points?.[cdnLine.points.length - 1];
    rows.push(`
      <div class="spark-row">
        <span class="spark-name">${escapeHtml(meta.name)}</span>
        <span class="spark-line cdn">${cdnLine ? buildSparkline(cdnLine.points, { className: 'spark-cdn' }) : '<span class="spark-empty">—</span>'}<span class="spark-cap">cdn ${lastCdn ? lastCdn.latency + 'ms' : ''}</span></span>
      </div>`);
  }
  container.innerHTML = rows.join('');
}

/* ---------- 柱状图（当前连通自检快照） ---------- */
export function renderLatencyBars(container, results) {
  if (!container) return;
  if (!results || results.length === 0) {
    container.innerHTML = '<div class="empty-state"><i data-lucide="inbox"></i><span>暂无应用，先在「应用管理」添加。</span></div>';
    return;
  }
  // 归一化上限
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