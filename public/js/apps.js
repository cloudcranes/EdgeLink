import { api } from './api.js';
import { cdnDomainFor, fillFormFromConfig, getRootDomain, nasDomainFor, saveConfig, setConfig, state } from './state.js';
import { appendLog, confirmDialog, copyText, escapeHtml, refreshIcons, setSaveState, showBanner, showToast } from './ui.js';
import { refreshSummary } from './summary.js';
const $ = (id) => document.getElementById(id);

// 侧边抽屉：openDrawer/closeDrawer 供 apps.js / existing.js / 后续模块复用
export function openDrawer() {
  const drawer = $('drawer');
  const backdrop = $('drawer-backdrop');
  if (!drawer || !backdrop) return;
  drawer.hidden = false;
  backdrop.hidden = false;
  // 强制 reflow 触发动画
  drawer.offsetHeight; // eslint-disable-line no-unused-expressions
  backdrop.offsetHeight;
  requestAnimationFrame(() => {
    drawer.classList.add('open');
    backdrop.classList.add('open');
    document.body.classList.add('drawer-open');
  });
}
export function closeDrawer() {
  const drawer = $('drawer');
  const backdrop = $('drawer-backdrop');
  if (!drawer || !backdrop) return;
  drawer.classList.remove('open');
  backdrop.classList.remove('open');
  document.body.classList.remove('drawer-open');
  setTimeout(() => {
    drawer.hidden = true;
    backdrop.hidden = true;
  }, 250);
}
export function isDrawerOpen() {
  return !!$('drawer')?.classList.contains('open');
}

// 应用状态文本 + 图标
const APP_STATUS_TEXT = { live: '已就绪', building: '部署中', failed: '失败', pending: '待同步' };
const APP_STATUS_ICON = { live: 'check-circle-2', building: 'loader-circle', failed: 'x-circle', pending: 'circle-dashed' };

export function renderApps() {
  const apps = state.config?.apps || [];
  const root = getRootDomain(state.config);
  const search = ($('app-search')?.value || '').trim().toLowerCase();
  const group = $('app-group-filter')?.value || '';

  // 分组下拉选项（保留当前选择）
  const filter = $('app-group-filter');
  if (filter) {
    const current = filter.value;
    const groups = [...new Set(apps.map((a) => (a.group || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    filter.innerHTML = '<option value="">全部分组</option>' + groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
    filter.value = current;
  }

  const visible = apps.filter((app) => {
    if (group && (app.group || '') !== group) return false;
    if (!search) return true;
    const hay = [app.name, app.prefix, app.target, app.group, nasDomainFor(app, root), cdnDomainFor(app, root)]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(search);
  });

  $('app-count').textContent = apps.length > 0 && visible.length !== apps.length ? `${visible.length}/${apps.length} 个` : `${apps.length} 个`;
  const grid = $('app-cards');
  if (!grid) return;
  if (visible.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i data-lucide="${apps.length === 0 ? 'inbox' : 'search-x'}"></i>
        <span>${apps.length === 0 ? '还没有应用，先在上方添加一个域名。' : '没有匹配的应用，换个关键词或分组试试。'}</span>
      </div>`;
    refreshIcons();
    return;
  }
  grid.innerHTML = visible
    .map((app, idx) => {
      const status = app.status || 'pending';
      const isError = status === 'failed' || (app.lastError && (status === 'building' || status === 'pending'));
      const nas = nasDomainFor(app, root);
      const cdn = cdnDomainFor(app, root);
      const showDomain = cdn || nas || app.target || '—';
      const statusText = APP_STATUS_TEXT[status] || APP_STATUS_TEXT.pending;
      return `
        <div class="app-card status-${status}${isError ? ' has-error' : ''}" data-app-id="${escapeHtml(app.id)}" style="animation-delay:${idx * 50}ms" role="button" tabindex="0" title="点击查看详情">
          <div class="app-card-head">
            <h3 class="app-card-name">
              <span class="app-card-name-dot"></span>
              <span>${escapeHtml(app.name || app.prefix || '(未命名)')}</span>
            </h3>
            <span class="app-card-status-badge ${status}"><i data-lucide="${APP_STATUS_ICON[status] || APP_STATUS_ICON.pending}"></i>${statusText}</span>
          </div>
          <div class="app-card-domain" title="${escapeHtml(showDomain)}">${escapeHtml(showDomain)}</div>
          ${app.lastError ? `<div class="app-card-error"><i data-lucide="alert-circle"></i>${escapeHtml(app.lastError)}</div>` : ''}
          <div class="app-card-foot">
            <button type="button" class="app-card-retest" data-card-action="retest" data-id="${escapeHtml(app.id)}" title="重新探测 cdn 可达性">
              <i data-lucide="refresh-cw"></i><span>重试</span>
            </button>
            <button type="button" class="app-card-menu" data-card-action="menu" data-id="${escapeHtml(app.id)}" title="更多操作" aria-label="更多操作">
              <i data-lucide="more-horizontal"></i>
            </button>
          </div>
        </div>`;
    })
    .join('');
  refreshIcons();
  // 同步刷新异常悬浮按钮（依赖 app.status / lastError）
  refreshSummary().catch(() => {});
}

export async function addOrUpdateApp(event) {
  event.preventDefault();
  const name = $('app-name').value.trim();
  const prefix = $('app-prefix').value.trim().toLowerCase().replace(/\.+$/, '');
  const target = $('app-target').value.trim();
  const luckyEnabled = $('app-lucky-enabled').checked;
  const esaEnabled = $('app-esa-enabled').checked;
  const webAuth = $('app-web-auth').checked;
  if (!prefix || !target) {
    appendLog('添加应用', 'error', '域名前缀和内网服务不能为空', { 前缀: prefix || '(空)', 目标: target || '(空)' });
    return;
  }

  const apps = state.config?.apps || [];
  // 统一用派生 nas 域名（无根域时退回 prefix/externalDomain）识别同一域名，表单与导入共用
  const root = getRootDomain(state.config);
  const domainKey = (app) => nasDomainFor(app, root) || app.prefix || app.externalDomain;
  if (state.editingId) {
    const index = apps.findIndex((app) => app.id === state.editingId);
    if (index >= 0) {
      const prev = apps[index];
      apps[index] = {
        ...prev,
        name: name || prefix,
        prefix,
        target,
        group: $('app-group').value.trim(),
        luckyEnabled,
        esaEnabled,
        webAuth,
      };
      // 旧导入模型字段（externalDomain/originDomain/originHostHeader）优先于 prefix，
      // 改前缀时清掉，否则派生域名不变
      if ((prev.prefix || prev.externalDomain) !== prefix) {
        delete apps[index].externalDomain;
        delete apps[index].originDomain;
        delete apps[index].originHostHeader;
      }
    }
  } else {
    if (apps.some((app) => domainKey(app) === domainKey({ prefix }))) {
      appendLog('添加应用', 'error', `域名前缀 ${prefix} 已存在`, { 前缀: prefix });
      return;
    }
    apps.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      name: name || prefix,
      prefix,
      target,
      group: $('app-group').value.trim(),
      luckyEnabled,
      esaEnabled,
      webAuth,
    });
  }

  // 记录要同步到 Lucky 的应用 id（编辑模式用 editingId；新增模式用刚 push 的 app id）
  const savedId = state.editingId || (apps[apps.length - 1]?.id);
  state.editingId = null;
  $('app-form').reset();
  $('add-app-submit-label').textContent = '添加';
  try {
    await saveConfig(false);
    appendLog('保存配置', 'ok', `应用 ${prefix} 已保存`, {
      前缀: prefix,
      名称: name || prefix,
      内网服务: target,
      nas域名: nasDomainFor({ prefix }, state.config?.esa?.rootDomain),
    });
  } catch (error) {
    appendLog('保存配置', 'error', error.message, { 前缀: prefix });
    return;
  }
  // 保存后预览是否需要同步到 Lucky
  const targetId = state.editingIdAfterSave || savedId;
  if (!targetId) return;
  try {
    const previewBody = {
      name: name || prefix,
      prefix,
      target,
      group: $('app-group').value.trim(),
      luckyEnabled,
      esaEnabled,
      webAuth,
    };
    const dry = await api.patchApp(targetId, previewBody, { preview: true });
    const plan = dry.plan || {};
    if (!plan.willDeploy) {
      appendLog('同步预览', 'warn', `应用 ${prefix} lucky/esa 开关均关闭，无需同步`);
      return;
    }
    const lines = [
      `应用：${plan.after?.name || prefix}（${plan.after?.prefix || prefix}）`,
      `目标：${plan.after?.target}`,
      `Lucky 反代：${plan.after?.luckyEnabled !== false ? '开' : '关'}`,
      `ESA 加速：${plan.after?.esaEnabled !== false ? '开' : '关'}`,
      `网页认证：${plan.after?.webAuth === true ? '开' : '关'}`,
      plan.willDeleteOldCdn ? `⚠️ 将删除旧 ESA 加速域名` : null,
      plan.willDeleteOldDdnsCname ? `⚠️ 将删除旧 DDNS CNAME` : null,
    ].filter(Boolean).join('\n');
    if (!(await confirmDialog({
      title: '同步到 Lucky',
      message: `配置已保存。是否同步到 Lucky？\n\n${lines}\n\n确认执行？`,
      okLabel: '同步',
    }))) {
      appendLog('同步预览', 'warn', `用户取消同步：${prefix}`);
      return;
    }
    const real = await api.patchApp(targetId, previewBody);
    if (real.config) setConfig(real.config);
    if (real.config) fillFormFromConfig(real.config);
    (real.logs || []).forEach((l) => {
      appendLog('同步应用', l.status === 'error' ? 'error' : 'ok', `${l.step}: ${l.detail}`);
    });
    appendLog('同步应用', 'ok', `${prefix} 已同步到 Lucky`);
  } catch (error) {
    appendLog('同步应用', 'error', error.message, { 前缀: prefix });
  }
}

export function editApp(id) {
  const app = (state.config?.apps || []).find((item) => item.id === id);
  if (!app) {
    return;
  }
  state.editingId = id;
  $('app-name').value = app.name;
  $('app-prefix').value = app.prefix || app.externalDomain || '';
  $('app-target').value = app.target;
  $('app-group').value = app.group || '';
  // 向后兼容旧 `enabled` 字段：新字段各自独立判断，仅老数据（无新字段）用 enabled 兜底
  const legacyOn =
    app.luckyEnabled === undefined && app.esaEnabled === undefined
      ? app.enabled !== false
      : true;
  $('app-lucky-enabled').checked = app.luckyEnabled !== false && legacyOn;
  $('app-esa-enabled').checked = app.esaEnabled !== false && legacyOn;
  $('app-web-auth').checked = app.webAuth === true;
  $('add-app-submit-label').textContent = '更新';
  $('app-name').focus();
}

export async function deleteApp(id, { purge = false } = {}) {
  const app = (state.config?.apps || []).find((item) => item.id === id);
  if (!app) return;
  const label = app.prefix || app.externalDomain;
  const action = purge ? '删除（purge=1，连带 ESA 加速域名 + DDNS CNAME）' : '删除（Lucky 子规则同步）';
  if (!(await confirmDialog({
    title: '删除应用',
    message: `${action}：${label}？此操作不可撤销，建议先 dryRun 预览。`,
    okLabel: '继续',
    danger: true,
  }))) {
    return;
  }
  // 1) dryRun 预览
  let plan;
  try {
    const dry = await api.deleteApp(id, { dryRun: true, purge });
    plan = dry.plan;
    const planText = [
      `应用：${plan.name}（${plan.prefix}）`,
      plan.willRemove.luckySubRule && `Lucky 子规则：${plan.willRemove.luckySubRule.key} → ${(plan.willRemove.luckySubRule.domains||[]).join(',')}`,
      plan.willRemove.esaDomain && `ESA 加速域名：${plan.willRemove.esaDomain}`,
      plan.willRemove.ddnsRecord && `Lucky DDNS CNAME：${plan.willRemove.ddnsRecord}`,
    ].filter(Boolean).join('\n');
    if (!(await confirmDialog({
      title: '确认删除',
      message: `dryRun 预览：\n${planText}\n\n确认执行？`,
      okLabel: '删除',
      danger: true,
    }))) {
      appendLog('删除应用', 'warn', `dryRun 预览后取消：${label}`);
      return;
    }
  } catch (error) {
    appendLog('删除应用', 'error', `dryRun 失败：${error.message}`, { 前缀: label });
    return;
  }
  // 2) 乐观更新：先本地剔除，失败再回滚
  const previousApps = state.config.apps.slice();
  state.config.apps = state.config.apps.filter((item) => item.id !== id);
  if (state.editingId === id) {
    state.editingId = null;
    $('app-form').reset();
    $('add-app-submit-label').textContent = '添加';
  }
  try {
    const r = await api.deleteApp(id, { purge, confirm: id });
    setConfig(r.config || state.config);
    fillFormFromConfig(state.config);
    appendLog(
      '删除应用',
      'ok',
      `${label} 已删除${r.luckyRemoved ? '（含 Lucky 子规则）' : ''}${purge && r.esaRemoved ? ' + ESA 加速域名' : ''}${purge && r.ddnsRemoved ? ' + DDNS CNAME' : ''}`,
      { 前缀: label },
    );
  } catch (error) {
    state.config.apps = previousApps;
    appendLog('删除应用', 'error', error.message, { 前缀: label });
  }
}

function currentParts() {
  const active = document.querySelector('.segmented button.active');
  return active && active.dataset.parts !== 'both' ? [active.dataset.parts] : null;
}

function setDeployLoading(loading) {
  const button = $('deploy-all');
  if (!button) {
    return;
  }
  button.disabled = loading;
  button.classList.toggle('is-loading', loading);
  const icon = button.querySelector('i');
  if (icon) {
    icon.dataset.lucide = loading ? 'loader-circle' : 'zap';
  }
  refreshIcons();
}

export async function deployApps(appId = null) {
  const config = gatherConfig();
  const parts = currentParts();
  const startedAt = new Date();
  const scopeText = appId
    ? `同步 ${appId}`
    : parts
      ? `部署（${parts.join(' + ')}）`
      : '一键部署全部';
  const targetApps = appId
    ? config.apps.filter((a) => a.id === appId)
    : config.apps;
  const ctxBase = {
    范围: parts ? parts.join(' + ') : '全部',
    应用数: targetApps.length,
    网关: `${config.gateway.listenIp}:${config.gateway.listenPort}`,
    回源: config.gateway.originScheme,
  };
  // ESA 证书预检（门控 ESA 部署，避免无证书时创建无效加速域名）
  const includesEsa = !parts || parts.includes('esa');
  if (includesEsa) {
    const blocked = [];
    for (const a of targetApps) {
      if (!a.prefix || a.esaEnabled === false) continue;
      try {
        const r = await api.appPrecheck(a.prefix);
        const pc = r.precheck;
        if (!pc.esaSsl.ok) {
          blocked.push({ prefix: a.prefix, message: pc.esaSsl.message });
        }
      } catch (error) {
        // 预检失败不阻断（可能 ESA 未配置），后端 /api/deploy 还会再查
        appendLog('部署预检', 'warn', `应用 ${a.prefix} 预检失败：${error.message}`);
      }
    }
    if (blocked.length > 0) {
      const msg = `ESA 证书未就绪：${blocked.map((b) => b.prefix).join('、')}。请先到 ESA 控制台申请对应泛域名证书。`;
      appendLog(scopeText, 'error', msg, { ...ctxBase, 阻塞: 'ESA 证书缺失', 应用: blocked.map((b) => b.prefix).join('、') });
      showBanner(msg, 'err');
      return;
    }
  }
  appendLog(scopeText, 'ok', '开始执行', ctxBase);
  if (!appId) {
    setDeployLoading(true);
  }
  try {
    const data = await api.deploy(config, appId, parts);
    setConfig(data.config);
    fillFormFromConfig(data.config);
    // 部署步骤日志由服务端 SSE 实时推送，避免重复；此处仅保留摘要
    setSaveState('已保存', true);
    refreshSummary();
    const lastLog = data.logs[data.logs.length - 1];
    showBanner(lastLog ? lastLog.detail : '同步完成', 'ok');
    const cost = ((new Date() - startedAt) / 1000).toFixed(1);
    appendLog(scopeText, 'ok', `完成（耗时 ${cost}s，${data.logs.length} 步）`);
  } catch (error) {
    appendLog(scopeText, 'error', error.message, ctxBase);
    showBanner(error.message, 'err');
  } finally {
    if (!appId) {
      setDeployLoading(false);
    }
  }
}

/* ---------- 访问二维码 ---------- */

function buildQrSvg(text) {
  try {
    if (!window.QRCode || typeof window.QRCode.toString !== 'function') return null;
    // margin:0 让 QR 节点尺寸更紧凑（去掉白边）；CSS 用固定宽度 96px
    return window.QRCode.toString(text, { type: 'svg', margin: 0, color: { dark: '#111827', light: '#ffffff' } });
  } catch {
    return null;
  }
}

function qrBlock(label, url) {
  const svg = buildQrSvg(url);
  return `
    <div class="qr-block">
      <div class="qr-block-code">${svg || '<span class="qr-error">二维码生成失败</span>'}</div>
      <div class="qr-block-info">
        <span class="qr-label">${escapeHtml(label)}</span>
        <span class="qr-url" title="${escapeHtml(url)}">${escapeHtml(url)}</span>
        <div class="qr-block-actions">
          <button type="button" class="btn" data-qr-open="${escapeHtml(url)}" title="新窗打开链接">
            <i data-lucide="external-link"></i><span>打开</span>
          </button>
          <button type="button" class="btn" data-qr-copy="${escapeHtml(url)}" title="复制链接">
            <i data-lucide="copy"></i><span>复制</span>
          </button>
        </div>
      </div>
    </div>`;
}

export function showQrModal(appId) {
  const app = (state.config?.apps || []).find((a) => a.id === appId);
  if (!app) return;
  const root = getRootDomain(state.config);
  const port = state.config?.gateway?.listenPort || '';
  const blocks = [];
  const nas = nasDomainFor(app, root);
  if (nas) {
    blocks.push(qrBlock('nas 域名（直连 Lucky）', `https://${nas}${port ? `:${port}` : ''}`));
  }
  const cdn = cdnDomainFor(app, root);
  if (cdn) {
    blocks.push(qrBlock('cdn 加速域名（走 ESA）', `https://${cdn}`));
  }
  const body = $('qr-modal-body');
  body.innerHTML = blocks.join('') || '<div class="qr-url">未配置域名</div>';
  $('qr-modal').classList.remove('hidden');
  refreshIcons();
}

export function closeQrModal() {
  $('qr-modal')?.classList.add('hidden');
}

/* ---------- 应用详情侧边抽屉 ---------- */

export function openAppDetailModal(appId) {
  const app = (state.config?.apps || []).find((a) => a.id === appId);
  if (!app) return;
  const root = getRootDomain(state.config);
  const nas = nasDomainFor(app, root);
  const cdn = cdnDomainFor(app, root);
  const port = state.config?.gateway?.listenPort || '';
  $('drawer-title-text').textContent = app.name || app.prefix || '应用详情';
  // 切换标题图标为 layout-grid（drawer 默认）
  const titleIcon = document.querySelector('#drawer-title svg');
  if (titleIcon) titleIcon.setAttribute('data-lucide', 'layout-grid');
  $('drawer-body').innerHTML = `
    <dl class="kv">
      <dt>状态</dt><dd>${`<span class="app-card-status-badge ${app.status || 'pending'}"><i data-lucide="${APP_STATUS_ICON[app.status] || APP_STATUS_ICON.pending}"></i>${APP_STATUS_TEXT[app.status] || APP_STATUS_TEXT.pending}</span>`} ${app.lastError ? `<span class="ddns-badge warn" style="margin-left:6px">${escapeHtml(app.lastError)}</span>` : ''}</dd>
      <dt>上次探测</dt><dd>${escapeHtml(app.lastCheckedAt || '—')}</dd>
      <dt>分组</dt><dd>${escapeHtml(app.group || '—')}</dd>
      <dt>域名前缀</dt><dd class="mono">${escapeHtml(app.prefix || '')}</dd>
      <dt>nas 域名</dt><dd class="mono">${escapeHtml(nas || '—')}</dd>
      <dt>cdn 加速域名</dt><dd class="mono">${escapeHtml(cdn || '—')}</dd>
      <dt>内网服务</dt><dd class="mono">${escapeHtml(app.target || '')}</dd>
    </dl>
    <h4 class="drawer-section-title">开关</h4>
    <div class="drawer-toggles">
      <label class="mini-toggle" title="是否反代（写入 Lucky 子规则）">
        <input type="checkbox" data-app-toggle="luckyEnabled" data-id="${escapeHtml(app.id)}" ${app.luckyEnabled !== false ? 'checked' : ''} />
        <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
        <span class="mini-toggle-label">反代</span>
      </label>
      <label class="mini-toggle" title="是否加速（ESA 加速域名 + 回源）">
        <input type="checkbox" data-app-toggle="esaEnabled" data-id="${escapeHtml(app.id)}" ${app.esaEnabled !== false ? 'checked' : ''} />
        <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
        <span class="mini-toggle-label">加速</span>
      </label>
      <label class="mini-toggle" title="仅控制本子规则 BasicAuth">
        <input type="checkbox" data-app-toggle="webAuth" data-id="${escapeHtml(app.id)}" ${app.webAuth === true ? 'checked' : ''} />
        <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
        <span class="mini-toggle-label">网页认证</span>
      </label>
    </div>
  `;
  $('drawer-foot').innerHTML = `
    <button type="button" class="btn" data-drawer-action="copy" data-domain="${escapeHtml(nas || '')}" title="复制 nas 域名">
      <i data-lucide="copy"></i><span>复制 nas</span>
    </button>
    <button type="button" class="btn" data-drawer-action="copy" data-domain="${escapeHtml(cdn || '')}" title="复制 cdn 域名">
      <i data-lucide="copy"></i><span>复制 cdn</span>
    </button>
    <button type="button" class="btn" data-drawer-action="open" data-domain="${escapeHtml(nas || '')}" data-port="${escapeHtml(port)}" title="打开 nas（新窗）" ${nas ? '' : 'disabled'}>
      <i data-lucide="external-link"></i><span>打开 nas</span>
    </button>
    <button type="button" class="btn" data-drawer-action="qr" data-id="${escapeHtml(app.id)}" title="访问二维码">
      <i data-lucide="qr-code"></i><span>二维码</span>
    </button>
    <button type="button" class="btn" data-drawer-action="deploy" data-id="${escapeHtml(app.id)}" title="同步到 Lucky + ESA">
      <i data-lucide="refresh-cw"></i><span>同步</span>
    </button>
    <button type="button" class="btn" data-drawer-action="edit" data-id="${escapeHtml(app.id)}" title="编辑">
      <i data-lucide="edit-3"></i><span>编辑</span>
    </button>
    <button type="button" class="btn btn-danger" data-drawer-action="delete" data-id="${escapeHtml(app.id)}" title="删除（破坏性 — 会弹确认）">
      <i data-lucide="trash-2"></i><span>删除</span>
    </button>
  `;
  openDrawer();
  refreshIcons();
}

export function closeAppDetailModal() {
  closeDrawer();
}

/* ---------- 连通性自检 ---------- */

export async function runAppHealth() {
  const box = $('app-health-results');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = '<div class="empty-state"><i data-lucide="loader-circle"></i><span>正在探测各域名…</span></div>';
  refreshIcons();
  try {
    const data = await api.appHealth();
    const rows = (data.results || [])
      .map((app) => {
        const chips = (app.checks || [])
          .map((c) => {
            if (c.ok) {
              return `<span class="health-chip on" title="${escapeHtml(c.url)}">${escapeHtml(c.label)} ${c.status} ${c.latency}ms</span>`;
            }
            return `<span class="health-chip off" title="${escapeHtml(c.url)}">${escapeHtml(c.label)} ✗ ${escapeHtml(c.error)}</span>`;
          })
          .join('');
        return `<div class="health-row"><span class="health-name">${escapeHtml(app.name)}</span><span class="health-chips">${chips || '<span class="health-chip off">未配置域名</span>'}</span></div>`;
      })
      .join('');
    box.innerHTML = rows || '<div class="empty-state"><i data-lucide="inbox"></i><span>暂无应用，先添加一个。</span></div>';
    appendLog('连通自检', 'ok', `已探测 ${(data.results || []).length} 个应用`);
  } catch (error) {
    box.innerHTML = `<div class="audit-item error"><i data-lucide="x-circle"></i><span>${escapeHtml(error.message)}</span></div>`;
    appendLog('连通自检', 'error', error.message);
  }
  refreshIcons();
}
