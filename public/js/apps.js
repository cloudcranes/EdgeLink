import { api } from './api.js';
import { cdnDomainFor, fillFormFromConfig, getRootDomain, nasDomainFor, saveConfig, setConfig, state } from './state.js';
import { appendLog, confirmDialog, copyText, escapeHtml, refreshIcons, setSaveState, showBanner, showToast } from './ui.js';
import { refreshSummary } from './summary.js';

const $ = (id) => document.getElementById(id);

// 应用状态 badge：live=已就绪 ok / building=部署中 warn / failed=失败 danger / pending=待同步 muted
function renderAppStatusBadge(status) {
  const map = {
    live: { cls: 'ok', text: '已就绪', icon: 'check-circle-2' },
    building: { cls: 'warn', text: '部署中', icon: 'loader-circle' },
    failed: { cls: 'danger', text: '失败', icon: 'x-circle' },
    pending: { cls: 'muted', text: '待同步', icon: 'circle-dashed' },
  };
  const s = map[status] || map.pending;
  return `<span class="badge sm ${s.cls}"><i data-lucide="${s.icon}" class="badge-icon"></i>${s.text}</span>`;
}

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
  const body = $('app-table-body');
  if (visible.length === 0) {
    body.innerHTML = `
      <tr class="empty-row"><td colspan="5">
        <div class="empty-state">
          <i data-lucide="${apps.length === 0 ? 'inbox' : 'search-x'}"></i>
          <span>${apps.length === 0 ? '还没有应用，先在上方添加一个域名。' : '没有匹配的应用，换个关键词或分组试试。'}</span>
        </div>
      </td></tr>`;
    refreshIcons();
    return;
  }
  body.innerHTML = visible
    .map((app) => {
      const luckyOn = app.luckyEnabled !== false;
      const esaOn = app.esaEnabled !== false;
      return `
        <tr data-app-id="${escapeHtml(app.id)}" class="app-row-clickable">
          <td data-label="状态">${renderAppStatusBadge(app.status || 'pending')}</td>
          <td data-label="开关">
            <div class="app-switches">
              <label class="mini-toggle" title="是否反代（写入 Lucky 子规则）">
                <input type="checkbox" data-switch="luckyEnabled" data-id="${escapeHtml(app.id)}" ${luckyOn ? 'checked' : ''} />
                <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
                <span class="mini-toggle-label">反代</span>
              </label>
              <label class="mini-toggle" title="是否加速（ESA 加速域名 + 回源）">
                <input type="checkbox" data-switch="esaEnabled" data-id="${escapeHtml(app.id)}" ${esaOn ? 'checked' : ''} />
                <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
                <span class="mini-toggle-label">加速</span>
              </label>
              <label class="mini-toggle" title="仅控制本子规则 BasicAuth。若 Lucky 服务端全局 WebUI 鉴权开启，仍会弹窗（请到 Lucky 后台「系统设置-安全」关闭）">
                <input type="checkbox" data-switch="webAuth" data-id="${escapeHtml(app.id)}" ${app.webAuth === true ? 'checked' : ''} />
                <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
                <span class="mini-toggle-label">认证</span>
              </label>
            </div>
          </td>
          <td class="primary" data-label="应用">${escapeHtml(app.name)}</td>
          <td class="row-detail-hint" data-label="">
            <span class="row-detail-hint-icon"><i data-lucide="chevron-right"></i></span>
          </td>
          <td data-label="操作">
            <div class="row-actions">
              <button class="btn" type="button" data-action="copy" data-domain="${escapeHtml(cdnDomainFor(app, getRootDomain(state.config)))}" title="复制 cdn 加速域名">
                <i data-lucide="copy"></i>
                <span>复制</span>
              </button>
              <button class="btn" type="button" data-action="open" data-domain="${escapeHtml(nasDomainFor(app, getRootDomain(state.config)))}" data-port="${escapeHtml(state.config?.gateway?.listenPort || '')}" title="访问 nas 域名（带 Lucky 端口）">
                <i data-lucide="external-link"></i>
              </button>
              <button class="btn" type="button" data-action="deploy" data-id="${escapeHtml(app.id)}" title="同步此应用">
                <i data-lucide="refresh-cw"></i>
                <span>同步</span>
              </button>
              <div class="row-menu">
                <button class="btn" type="button" data-action="menu" title="更多操作" aria-label="更多操作">
                  <i data-lucide="more-horizontal"></i>
                </button>
                <div class="row-menu-pop hidden" data-menu="${escapeHtml(app.id)}">
                  <button type="button" data-action="copy" data-domain="${escapeHtml(nasDomainFor(app, getRootDomain(state.config)))}">复制 nas 域名</button>
                  <button type="button" data-action="qr" data-id="${escapeHtml(app.id)}">访问二维码</button>
                  <button type="button" data-action="edit" data-id="${escapeHtml(app.id)}">编辑</button>
                  <button type="button" data-action="delete" data-id="${escapeHtml(app.id)}" class="danger">删除</button>
                </div>
              </div>
            </div>
          </td>
        </tr>`;
    })
    .join('');
  refreshIcons();
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
    return window.QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#111827', light: '#ffffff' } });
  } catch {
    return null;
  }
}

function qrBlock(label, url) {
  const svg = buildQrSvg(url);
  return `
    <div class="qr-block">
      <span class="qr-label">${escapeHtml(label)}</span>
      ${svg ? svg : '<span class="qr-url">二维码生成失败</span>'}
      <span class="qr-url">${escapeHtml(url)}</span>
      <button type="button" class="btn" data-qr-copy="${escapeHtml(url)}">
        <i data-lucide="copy"></i><span>复制链接</span>
      </button>
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

/* ---------- 应用详情弹窗 ---------- */

export function openAppDetailModal(appId) {
  const app = (state.config?.apps || []).find((a) => a.id === appId);
  if (!app) return;
  const root = getRootDomain(state.config);
  const nas = nasDomainFor(app, root);
  const cdn = cdnDomainFor(app, root);
  const port = state.config?.gateway?.listenPort || '';
  $('app-detail-modal-title').textContent = app.name || app.prefix || '应用详情';
  const body = $('app-detail-modal-body');
  body.innerHTML = `
    <dl class="kv">
      <dt>状态</dt><dd>${renderAppStatusBadge(app.status || 'pending')} ${app.lastError ? `<span class="ddns-badge warn" style="margin-left:6px">${escapeHtml(app.lastError)}</span>` : ''}</dd>
      <dt>上次探测</dt><dd>${escapeHtml(app.lastCheckedAt || '—')}</dd>
      <dt>分组</dt><dd>${escapeHtml(app.group || '—')}</dd>
      <dt>域名前缀</dt><dd class="mono">${escapeHtml(app.prefix || '')}</dd>
      <dt>nas 域名</dt><dd class="mono">${escapeHtml(nas || '—')}</dd>
      <dt>cdn 加速域名</dt><dd class="mono">${escapeHtml(cdn || '—')}</dd>
      <dt>内网服务</dt><dd class="mono">${escapeHtml(app.target || '')}</dd>
    </dl>
    <div class="modal-actions">
      <button type="button" class="btn" data-app-detail-action="copy" data-target="nas" data-domain="${escapeHtml(nas || '')}" title="复制 nas 域名">
        <i data-lucide="copy"></i><span>复制 nas</span>
      </button>
      <button type="button" class="btn" data-app-detail-action="copy" data-target="cdn" data-domain="${escapeHtml(cdn || '')}" title="复制 cdn 域名">
        <i data-lucide="copy"></i><span>复制 cdn</span>
      </button>
      <button type="button" class="btn" data-app-detail-action="open" data-domain="${escapeHtml(nas || '')}" data-port="${escapeHtml(port)}" title="打开 nas（带端口）" ${nas ? '' : 'disabled'}>
        <i data-lucide="external-link"></i><span>打开 nas</span>
      </button>
      <button type="button" class="btn" data-app-detail-action="qr" data-id="${escapeHtml(app.id)}" title="访问二维码">
        <i data-lucide="qr-code"></i><span>二维码</span>
      </button>
      <button type="button" class="btn" data-app-detail-action="deploy" data-id="${escapeHtml(app.id)}" title="同步到 Lucky + ESA">
        <i data-lucide="refresh-cw"></i><span>同步</span>
      </button>
      <button type="button" class="btn" data-app-detail-action="edit" data-id="${escapeHtml(app.id)}" title="编辑">
        <i data-lucide="edit-3"></i><span>编辑</span>
      </button>
      <button type="button" class="btn btn-danger" data-app-detail-action="delete" data-id="${escapeHtml(app.id)}" title="删除">
        <i data-lucide="trash-2"></i><span>删除</span>
      </button>
    </div>
  `;
  $('app-detail-modal').classList.remove('hidden');
  refreshIcons();
}

export function closeAppDetailModal() {
  $('app-detail-modal')?.classList.add('hidden');
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
