import { api, getToken } from './api.js';
import { addOrUpdateApp, closeAppDetailModal, closeDrawer, closeQrModal, deleteApp, deployApps, editApp, openAppDetailModal, openDrawer, renderApps, runAppHealth, showQrModal } from './apps.js';
import { renderPerfLineChart } from './charts.js';
import { fillFormFromConfig, gatherConfig, loadConfig, renderSiteSelect, saveConfig, state } from './state.js';
import { refreshStatus } from './status.js';
import { appendLog, clearLogs, confirmDialog, copyText, openDomain, refreshIcons, setSaveState, showBanner, showToast } from './ui.js';
import { importLuckyRule, enableEsaForRule, enableAllEsa, editEsaRecord, deleteEsaRecord, loadExistingRules, renderExistingRules } from './existing.js';
import { refreshQuickStart } from './quickstart.js';
import { refreshSummary } from './summary.js';
import { bindDdnsDeleteHandler, refreshDdns } from './ddns.js';
import { closeExistingEsaModal, closeExistingLuckyModal, openExistingEsaModal, openExistingLuckyModal } from './existing.js';
import { bindMaintenance, fixAudit, refreshSnapshots, runAudit, runPortPrecheck } from './maintenance.js';
import { initBasicAuth, renderBasicAuth } from './settings.js';

// 与 server.js 中 PROXY_KEY_PREFIX + managedProxyKey 对齐：lucky-esa-<appId>
const PROXY_KEY_PREFIX = 'lucky-esa-';
const managedProxyKey = (id) => `${PROXY_KEY_PREFIX}${id}`;

let dirty = false;

const THEME_KEY = 'lucky-esa-theme';
const VALID_THEMES = ['neon', 'aurora', 'brutal-sun', 'brutal-ocean', 'brutal-berry', 'terminal'];

function applyTheme(theme) {
  if (!VALID_THEMES.includes(theme)) theme = 'brutal-sun';
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.querySelector('#theme-toggle i');
  if (icon) {
    // 用调色板标识多主题切换入口
    icon.dataset.lucide = 'palette';
    window.lucide?.createIcons();
  }
  document.querySelectorAll('.theme-option').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
    if (btn.dataset.theme === theme) btn.setAttribute('aria-checked', 'true');
    else btn.removeAttribute('aria-checked');
  });
}

function initTheme() {
  // 优先 localStorage（瞬时加载），随后由 loadConfig 用服务端值覆盖
  const saved = localStorage.getItem(THEME_KEY);
  if (saved && VALID_THEMES.includes(saved)) {
    applyTheme(saved);
  }
  const toggle = document.getElementById('theme-toggle');
  const menu = document.getElementById('theme-menu');
  if (toggle && menu) {
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu.querySelectorAll('.theme-option').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const theme = btn.dataset.theme;
        if (!VALID_THEMES.includes(theme)) return;
        applyTheme(theme);
        menu.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        localStorage.setItem(THEME_KEY, theme);
        try {
          await api.patchPanelTheme(theme);
        } catch (error) {
          appendLog('主题切换', 'error', `持久化失败：${error.message}`);
        }
      });
    });
    // 点击外部/ Esc 关闭
    document.addEventListener('click', (event) => {
      if (!menu.contains(event.target) && event.target !== toggle) {
        menu.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.classList.contains('open')) {
        menu.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }
}

function markDirty() {
  if (!dirty) {
    dirty = true;
    setSaveState('未保存', false);
  }
}

async function testLucky() {
  appendLog('Lucky 连接', 'ok', '正在验证');
  try {
    await api.testLucky(gatherConfig());
    appendLog('Lucky 连接', 'ok', '连接成功');
    showBanner('Lucky 连接成功', 'ok');
  } catch (error) {
    appendLog('Lucky 连接', 'error', error.message);
    showBanner(error.message, 'err');
  }
}

async function loadSites() {
  appendLog('ESA 站点', 'ok', '正在拉取站点列表');
  try {
    const data = await api.loadSites(gatherConfig());
    state.sites = data.sites || [];
    renderSiteSelect();
    appendLog('ESA 站点', 'ok', `找到 ${state.sites.length} 个站点`);
  } catch (error) {
    appendLog('ESA 站点', 'error', error.message);
    showBanner(error.message, 'err');
  }
}

async function regenerateToken() {
  if (!(await confirmDialog({ title: '生成新口令', message: '生成新口令？旧口令将立即失效，当前页面需用新口令重新访问。', okLabel: '生成' }))) {
    return;
  }
  try {
    const data = await api.regenerateToken();
    showBanner(`新口令：${data.token}（请复制保存，刷新后使用）`, 'ok');
    refreshPanelTokenStatus();
  } catch (error) {
    showBanner(error.message, 'err');
  }
}

async function clearPanelToken() {
  if (!(await confirmDialog({ title: '关闭访问口令', message: '关闭访问口令？之后局域网任何人可访问面板。', okLabel: '关闭', danger: true }))) {
    return;
  }
  try {
    await api.clearToken();
    showBanner('已关闭访问口令', 'ok');
    refreshPanelTokenStatus();
  } catch (error) {
    showBanner(error.message, 'err');
  }
}

function refreshPanelTokenStatus() {
  const status = document.getElementById('panel-token-status');
  if (!status) {
    return;
  }
  status.value = state.config?.panel?.token ? '已开启（token 已保存）' : '未开启';
}

async function exportConfig() {
  appendLog('导出配置', 'ok', '正在导出…');
  try {
    const data = await api.exportConfig();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `edgelink-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    appendLog('导出配置', 'ok', '配置已下载（含凭据，请妥善保存）');
    showBanner('配置已导出', 'ok');
  } catch (error) {
    appendLog('导出配置', 'error', error.message);
    showBanner(error.message, 'err');
  }
}

async function importConfigFromFile(file) {
  if (!file) {
    return;
  }
  if (!(await confirmDialog({ title: '导入配置', message: '导入配置将覆盖当前所有设置与凭据，确定继续？', okLabel: '导入', danger: true }))) {
    return;
  }
  appendLog('导入配置', 'ok', `正在导入 ${file.name}…`);
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('配置文件格式无效');
    }
    const data = await api.importConfig(parsed);
    showBanner('配置已导入，页面刷新中…', 'ok');
    appendLog('导入配置', 'ok', '配置已导入');
    // 重新加载配置到表单
    state.config = data.config;
    fillFormFromConfig(data.config);
    renderApps();
    refreshQuickStart();
    refreshSummary();
    refreshPanelTokenStatus();
    setSaveState('已保存', true);
  } catch (error) {
    appendLog('导入配置', 'error', error.message);
    showBanner(`导入失败：${error.message}`, 'err');
  }
}

function navigate() {
  const route = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
  const page = document.querySelector(`.page[data-page="${route}"]`);
  const target = page ? route : 'overview';
  document.querySelectorAll('.page').forEach((el) => {
    el.hidden = el.dataset.page !== target;
  });
  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = item.dataset.route === target;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });
  // 顶栏标题跟随路由（Lucky 风格顶栏）
  const titleMap = { overview: '概览', apps: '应用管理', settings: '设置', logs: '日志' };
  const titleEl = document.getElementById('topbar-title');
  if (titleEl) titleEl.textContent = titleMap[target] || 'EdgeLink';
  window.scrollTo({ top: 0 });
}

function closeAllRowMenus() {
  document.querySelectorAll('.row-menu-pop:not(.hidden)').forEach((pop) => {
    pop.classList.add('hidden');
  });
}

function bindEvents() {
  window.addEventListener('hashchange', navigate);
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.row-menu')) {
      closeAllRowMenus();
    }
  });
  document.getElementById('app-form').addEventListener('submit', addOrUpdateApp);
  document.getElementById('save-config').addEventListener('click', () =>
    saveConfig().catch((error) => appendLog('保存配置', 'error', error.message)),
  );
  document.getElementById('export-config').addEventListener('click', exportConfig);
  document.getElementById('audit-run').addEventListener('click', runAudit);
  document.getElementById('snapshots-refresh').addEventListener('click', refreshSnapshots);
  bindMaintenance(document.getElementById('snapshot-list'));
  document.getElementById('import-config').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });
  document.getElementById('import-file').addEventListener('change', (event) => {
    importConfigFromFile(event.target.files[0]);
    event.target.value = '';
  });
  document.getElementById('lucky-test').addEventListener('click', testLucky);
  document.getElementById('esa-load-sites').addEventListener('click', loadSites);
  document.getElementById('clear-logs').addEventListener('click', clearLogs);
  document.getElementById('refresh-status')?.addEventListener('click', refreshStatus);
  document.getElementById('esa-site-select').addEventListener('change', (event) => {
    document.getElementById('esa-site-id').value = event.target.value;
  });
  document.getElementById('gateway-origin-scheme').addEventListener('change', (event) => {
    if (event.target.value === 'https') {
      document.getElementById('gateway-enable-tls').checked = true;
    }
  });
  document.getElementById('app-cards').addEventListener('click', async (event) => {
    // 卡内按钮：重试 / 三点菜单
    const cardAction = event.target.closest('[data-card-action]');
    if (cardAction) {
      event.stopPropagation();
      const action = cardAction.dataset.cardAction;
      const id = cardAction.dataset.id;
      if (action === 'retest') {
        // 直接调重试 API（保留旧 render 状态避免闪烁）
        try {
          const r = await api.appRecheck(id);
          if (r.ok) {
            showToast(`已重新探测：${id}`, 'ok');
            renderApps();
          } else {
            showToast(r.error || '重试失败', 'err');
          }
        } catch (error) {
          showToast(`重试失败：${error.message}`, 'err');
        }
      } else if (action === 'menu') {
        // 打开抽屉（含所有操作）
        openAppDetailModal(id);
      }
      return;
    }
    // 卡片其余区域：打开抽屉
    const card = event.target.closest('.app-card');
    if (card) {
      openAppDetailModal(card.dataset.appId);
    }
  });
  // 侧边抽屉：应用开关（反代/加速/网页认证）
  document.getElementById('drawer-body').addEventListener('change', async (event) => {
    const input = event.target.closest('input[data-app-toggle]');
    if (!input) return;
    const field = input.dataset.appToggle;
    const id = input.dataset.id;
    const apps = state.config?.apps || [];
    const app = apps.find((a) => a.id === id);
    if (!app) return;
    const previous = app[field];
    app[field] = input.checked;
    try {
      await saveConfig(false);
      setSaveState('已保存', true);
      appendLog('应用开关', 'ok', `${app.name || app.prefix}：${field === 'luckyEnabled' ? '反代' : field === 'esaEnabled' ? '加速' : '网页认证'} ${input.checked ? '开' : '关'}`);
      if (field === 'webAuth' || field === 'luckyEnabled') {
        try {
          await api.toggleLuckyProxy(managedProxyKey(id), field, input.checked);
          appendLog('Lucky 子规则', 'ok', `${app.name || app.prefix}：${field === 'luckyEnabled' ? '反代' : '网页认证'} 已即时同步到 Lucky`);
        } catch (error) {
          input.checked = previous;
          app[field] = previous;
          appendLog('Lucky 子规则', 'error', `${app.name || app.prefix}：${error.message}`);
        }
      }
      renderApps();
    } catch (error) {
      input.checked = !input.checked;
      appendLog('应用开关', 'error', error.message);
    }
  });
  // 侧边抽屉：内嵌动作按钮（复制/打开/同步/二维码/编辑/删除）
  document.getElementById('drawer-foot').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-drawer-action]');
    if (!btn) return;
    const action = btn.dataset.drawerAction;
    const id = btn.dataset.id;
    const domain = btn.dataset.domain;
    if (action === 'copy' && domain) {
      const ok = await copyText(domain);
      if (ok) showToast(`已复制 ${domain}`, 'ok');
      else showToast('复制失败', 'err');
    } else if (action === 'open' && domain) {
      // 弹新窗（不离开当前页）
      const port = btn.dataset.port || '';
      const url = port ? `https://${domain}:${port}` : `https://${domain}`;
      window.open(url, '_blank', 'noopener');
    } else if (action === 'deploy') {
      closeDrawer();
      deployApps(id);
    } else if (action === 'qr') {
      closeDrawer();
      showQrModal(id);
    } else if (action === 'edit') {
      closeDrawer();
      editApp(id);
    } else if (action === 'delete') {
      closeDrawer();
      deleteApp(id);
    }
  });
  // 抽屉关闭（背景 / 关闭按钮 / Esc）
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDrawer();
      closeQrModal();
      closeDdnsRecordModal();
    }
  });
  // 异常悬浮按钮 → 切换到应用 tab 并打开第一个异常 app 的抽屉
  document.getElementById('exception-fab').addEventListener('click', () => {
    const firstError = (state.config?.apps || []).find((a) => a.status === 'failed' || (a.lastError && (a.status === 'building' || a.status === 'pending')));
    if (firstError) {
      // 切换到应用 tab
      if (location.hash !== '#/apps') location.hash = '#/apps';
      openAppDetailModal(firstError.id);
    }
  });
  // 主页待处理条 → 同样跳到第一个异常
  document.getElementById('pending-banner-action').addEventListener('click', () => {
    const firstError = (state.config?.apps || []).find((a) => a.status === 'failed' || (a.lastError && (a.status === 'building' || a.status === 'pending')));
    if (firstError) {
      if (location.hash !== '#/apps') location.hash = '#/apps';
      openAppDetailModal(firstError.id);
    }
  });
  // 性能图时间范围切换
  document.querySelectorAll('.perf-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const range = btn.dataset.perfRange;
      document.querySelectorAll('.perf-range-btn').forEach((b) => b.classList.toggle('active', b === btn));
      // 触发刷新
      if (typeof window.__perfSetRange === 'function') window.__perfSetRange(range);
    });
  });
  document.getElementById('existing-refresh').addEventListener('click', loadExistingRules);
  document.getElementById('existing-enable-all').addEventListener('click', enableAllEsa);

  // 应用搜索/分组过滤
  document.getElementById('app-search').addEventListener('input', renderApps);
  document.getElementById('app-group-filter').addEventListener('change', renderApps);
  document.getElementById('app-health-btn').addEventListener('click', runAppHealth);

  // 维护：端口预检 + 巡检差异一键修复（按钮在 audit-result 内动态渲染，用委托）
  document.getElementById('port-precheck').addEventListener('click', runPortPrecheck);
  document.getElementById('audit-result').addEventListener('click', (event) => {
    if (event.target.closest('#audit-fix-btn')) {
      fixAudit();
    }
  });

  // 性能图表：60s 自动刷新（首页纯展示，无手动按钮）

  // 二维码弹窗：关闭（按钮/遮罩/Esc）、复制链接
  document.getElementById('qr-modal').addEventListener('click', (event) => {
    if (event.target.id === 'qr-modal' || event.target.closest('[data-close-qr]')) {
      closeQrModal();
    }
  });
  document.getElementById('qr-modal-body').addEventListener('click', async (event) => {
    const copyBtn = event.target.closest('button[data-qr-copy]');
    const openBtn = event.target.closest('button[data-qr-open]');
    if (copyBtn) {
      const ok = await copyText(copyBtn.dataset.qrCopy);
      if (ok) showToast('链接已复制', 'ok');
      else showToast('复制失败', 'err');
    } else if (openBtn) {
      window.open(openBtn.dataset.qrOpen, '_blank', 'noopener');
    }
  });
  // DDNS 解析记录弹窗：关闭（按钮/遮罩）
  document.getElementById('ddns-record-modal').addEventListener('click', (event) => {
    if (event.target.id === 'ddns-record-modal' || event.target.closest('[data-close-ddns-record]')) {
      closeDdnsRecordModal();
    }
  });
  document.getElementById('existing-rules-body').addEventListener('change', async (event) => {
    const input = event.target.closest('input[data-ex-switch]');
    if (!input) return;
    const field = input.dataset.exSwitch;
    const value = input.checked;
    try {
      if (field === 'esaEnabled') {
        const domain = input.dataset.domain;
        const r = await api.toggleEsaDomain(domain, value);
        appendLog('加速开关', 'ok', r.message);
        if (window.lucide) window.lucide.createIcons();
      } else {
        const key = input.dataset.key;
        const r = await api.toggleLuckyProxy(key, field, value);
        appendLog('现存规则开关', 'ok', r.message);
      }
    } catch (error) {
      input.checked = !value;
      appendLog('现存规则开关', 'error', error.message);
    }
  });
  document.getElementById('existing-rules-body').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-existing-action]');
    if (!button) {
      // 行级弹窗入口：非按钮/开关区域点击触发详情（开关通过 change 事件独立处理）
      const luckyRow = event.target.closest('tr[data-existing-lucky-key]');
      if (luckyRow && !event.target.closest('.app-switches')) {
        openExistingLuckyModal(luckyRow.dataset.existingLuckyKey);
        return;
      }
      const esaRow = event.target.closest('tr[data-existing-esa-record-id]');
      if (esaRow && !event.target.closest('.app-switches')) {
        openExistingEsaModal(esaRow.dataset.existingEsaRecordId);
        return;
      }
      return;
    }
    const action = button.dataset.existingAction;
    if (action === 'import') {
      importLuckyRule(button.dataset.key);
    } else if (action === 'enable-esa') {
      enableEsaForRule(button.dataset.accel, button.dataset.target);
    } else if (action === 'edit-esa') {
      editEsaRecord(button.dataset.recordId, button.dataset.domain);
    } else if (action === 'del-esa') {
      deleteEsaRecord(button.dataset.recordId, button.dataset.domain);
    } else if (action === 'copy') {
      const ok = await copyText(button.dataset.domain);
      if (ok) showToast(`已复制 ${button.dataset.domain}`, 'ok');
      else showToast('复制失败', 'err');
    } else if (action === 'open') {
      openDomain(button.dataset.domain, button.dataset.port);
    }
  });
  // 现存规则抽屉内嵌动作按钮：委托到 #drawer-foot（因为现有规则的按钮与 app 详情共用同一 drawer）
  document.getElementById('drawer-foot').addEventListener('click', async (event) => {
    const existingBtn = event.target.closest('button[data-existing-detail-action], button[data-existing-esa-detail-action]');
    if (!existingBtn) return; // 让非现有规则的按钮（data-drawer-action）由 app-cards 监听器处理
    if (existingBtn.dataset.existingDetailAction) {
      const action = existingBtn.dataset.existingDetailAction;
      if (action === 'copy' && existingBtn.dataset.domain) {
        const ok = await copyText(existingBtn.dataset.domain);
        if (ok) showToast(`已复制 ${existingBtn.dataset.domain}`, 'ok');
        else showToast('复制失败', 'err');
      } else if (action === 'open' && existingBtn.dataset.domain) {
        // 弹新窗（与 app 详情一致）
        const port = existingBtn.dataset.port || '';
        const url = port ? `https://${existingBtn.dataset.domain}:${port}` : `https://${existingBtn.dataset.domain}`;
        window.open(url, '_blank', 'noopener');
      } else if (action === 'import') {
        closeDrawer();
        importLuckyRule(existingBtn.dataset.key);
      } else if (action === 'enable-esa') {
        closeDrawer();
        enableEsaForRule(existingBtn.dataset.accel, existingBtn.dataset.target);
      }
      return;
    }
    if (existingBtn.dataset.existingEsaDetailAction) {
      const action = existingBtn.dataset.existingEsaDetailAction;
      if (action === 'copy' && existingBtn.dataset.domain) {
        const ok = await copyText(existingBtn.dataset.domain);
        if (ok) showToast(`已复制 ${existingBtn.dataset.domain}`, 'ok');
        else showToast('复制失败', 'err');
      } else if (action === 'open' && existingBtn.dataset.domain) {
        window.open(`https://${existingBtn.dataset.domain}`, '_blank', 'noopener');
      } else if (action === 'edit') {
        closeDrawer();
        editEsaRecord(existingBtn.dataset.recordId, existingBtn.dataset.domain);
      } else if (action === 'delete') {
        closeDrawer();
        deleteEsaRecord(existingBtn.dataset.recordId, existingBtn.dataset.domain);
      }
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeExistingLuckyModal();
      closeExistingEsaModal();
    }
  });
  document.querySelectorAll('input[name="existing-source"]').forEach((input) => {
    input.addEventListener('change', renderExistingRules);
  });
  document.querySelectorAll('.segmented button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.segmented button').forEach((item) => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
      });
    });
  });
  document.getElementById('panel-token-gen').addEventListener('click', regenerateToken);
  document.getElementById('panel-token-clear').addEventListener('click', clearPanelToken);

  // H3：设置页改动标记「未保存」
  document
    .querySelectorAll('#page-settings input, #page-settings select')
    .forEach((field) => {
      field.addEventListener('input', markDirty);
      field.addEventListener('change', markDirty);
    });
  window.addEventListener('beforeunload', (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  bindDdnsDeleteHandler();
  initTheme();
  navigate();
  document.addEventListener('config-changed', renderApps);
  document.addEventListener('config-changed', refreshQuickStart);
  document.addEventListener('config-changed', () => {
    dirty = false;
    refreshPanelTokenStatus();
  });
  clearLogs();
  try {
    await loadConfig();
    // 服务端持久化主题优先：覆盖 localStorage 初始值
    const serverTheme = state.config?.panel?.theme;
    if (serverTheme && VALID_THEMES.includes(serverTheme)) {
      applyTheme(serverTheme);
      localStorage.setItem(THEME_KEY, serverTheme);
    }
  } catch (error) {
    appendLog('加载配置', 'error', error.message);
  }
  renderApps();
  refreshQuickStart();
  refreshSummary();
  refreshDdns();
  initBasicAuth();
  renderBasicAuth(state.config);
  loadExistingRules();
  refreshIcons();
  refreshSnapshots();
  refreshStatus();
  startAutoRefresh();
  fetchLogHistory();
  startLogStream();
  refreshPerf();
  refreshDdnsStatus();
});

// 状态自动刷新：概览页可见时每 60s 刷新摘要/DDNS/状态，页面隐藏时暂停
let autoRefreshTimer = null;

/* ---------- 服务端日志实时流（SSE over fetch，携带口令头） ---------- */

function appendServerEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  appendLog(
    entry.step || '服务端',
    entry.status === 'error' ? 'error' : entry.status === 'warn' ? 'warn' : 'ok',
    entry.detail || '',
  );
}

async function fetchLogHistory() {
  try {
    const data = await api.fetchLogs();
    (data.logs || []).forEach(appendServerEntry);
  } catch {
    // 历史拉取失败不阻断，流式连接会重试
  }
}

function startLogStream() {
  let retryDelay = 3000;
  let stopped = false;

  const connect = async () => {
    if (stopped) return;
    try {
      const res = await fetch('/api/logs/stream', {
        headers: { 'X-Panel-Token': getToken() },
      });
      if (!res.ok || !res.body) {
        throw new Error(`stream ${res.status}`);
      }
      retryDelay = 3000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            try {
              appendServerEntry(JSON.parse(line.slice(6)));
            } catch {
              // 忽略坏帧
            }
          }
        }
      }
    } catch {
      // 连接断开：指数退避重连
    }
    if (!stopped) {
      window.setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    }
  };

  window.addEventListener('beforeunload', () => {
    stopped = true;
  });
  connect();
}

function startAutoRefresh() {
  if (autoRefreshTimer) {
    return;
  }
  const tick = () => {
    if (document.hidden) {
      return;
    }
    const route = (location.hash.replace(/^#\/?/, '') || 'overview').split('?')[0];
    if (route === 'overview') {
      refreshSummary();
      refreshDdns();
      refreshStatus();
      refreshPerf();
      refreshDdnsStatus();
    }
  };
  autoRefreshTimer = window.setInterval(tick, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tick();
    }
  });
}

/* ---------- Lucky DDNS 状态（只读诊断：Lucky 任务 vs 公网权威记录） ---------- */

let ddnsStatusBusy = false;

async function refreshDdnsStatus() {
  if (ddnsStatusBusy) return;
  ddnsStatusBusy = true;
  const list = document.getElementById('ddns-status-list');
  const summary = document.getElementById('ddns-status-summary');
  // 首次加载（还没有数据）才显示"查询中"；后续自动刷新保留旧数据不闪烁
  const hasData = list && list.dataset.loaded === 'true';
  if (list && !hasData) {
    list.innerHTML = '<div class="empty-state"><i data-lucide="loader-circle"></i><span>查询中…</span></div>';
    refreshIcons();
  }
  if (summary) summary.textContent = '更新中…';
  try {
    const data = await api.fetchDdnsStatus();
    renderDdnsStatus(data);
    if (list) list.dataset.loaded = 'true';
    if (summary) {
      const total = (data.items || []).length;
      const ok = (data.items || []).filter((i) => i.status === 'ok').length;
      const pending = (data.items || []).filter((i) => i.status === 'pending').length;
      const wild = (data.items || []).filter((i) => i.status === 'wildcard').length;
      const parts = [];
      if (total) parts.push(`共 ${total}`);
      if (ok) parts.push(`已解析 ${ok}`);
      if (pending) parts.push(`待解析 ${pending}`);
      if (wild) parts.push(`通配 ${wild}`);
      summary.textContent = parts.length ? parts.join(' · ') : (data.message || 'Lucky 中暂无 nas 子域任务');
    }
  } catch (error) {
    if (list) {
      // 错误时如果已有数据，保留旧数据，仅在 summary 提示失败
      if (!hasData) {
        list.innerHTML = `<div class="audit-item error"><i data-lucide="x-circle"></i><span>${escapeHtml(error.message)}</span></div>`;
        refreshIcons();
      }
    }
    if (summary) summary.textContent = hasData ? `${summary.textContent}（更新失败）` : '查询失败';
  } finally {
    ddnsStatusBusy = false;
  }
}

function renderDdnsStatus(data) {
  const list = document.getElementById('ddns-status-list');
  if (!list) return;
  const items = data.items || [];
  if (items.length === 0) {
    list.innerHTML = '<div class="empty-state"><i data-lucide="info"></i><span>Lucky 中尚未发现 nas 子域 DDNS 任务（先在 Lucky 后台添加）</span></div>';
    return;
  }
  // 紧凑行：域名（mono）+ 类型徽章 + 状态徽章；点击行弹窗显示完整信息
  list.innerHTML = items
    .map((it, idx) => {
      const enabled = (it.tasks || []).every((t) => t.enable);
      const enableBadge = enabled ? '<span class="ddns-badge on">启用</span>' : '<span class="ddns-badge off">停用</span>';
      const statusMap = { ok: '<span class="ddns-badge on">已解析</span>', pending: '<span class="ddns-badge warn">待解析</span>', wildcard: '<span class="ddns-badge info">通配</span>' };
      const status = statusMap[it.status] || it.status;
      const typeBadge = `<span class="ddns-badge">${escapeHtml(it.type || 'A')}</span>`;
      // 整个 dataset 存到 row 的 data-idx，弹窗按 idx 查找
      return `
        <div class="ddns-status-row" data-ddns-record-idx="${idx}" role="button" tabindex="0" title="点击查看完整信息">
          <span class="ddns-domain mono" data-label="域名">${escapeHtml(it.fullDomain)}</span>
          <span class="ddns-type-badge">${typeBadge}</span>
          <span class="ddns-state">${status}</span>
          <span class="ddns-state-icon"><i data-lucide="chevron-right"></i></span>
        </div>`;
    })
    .join('');
  // 在 list 上委托点击/键盘事件，避免每行单独绑定
  list.onclick = (e) => {
    const row = e.target.closest('[data-ddns-record-idx]');
    if (row) openDdnsRecordModal(items[Number(row.dataset.ddnsRecordIdx)]);
  };
  list.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-ddns-record-idx]');
    if (row) {
      e.preventDefault();
      openDdnsRecordModal(items[Number(row.dataset.ddnsRecordIdx)]);
    }
  };
  refreshIcons();
}

function openDdnsRecordModal(item) {
  const modal = document.getElementById('ddns-record-modal');
  if (!modal || !item) return;
  document.getElementById('ddns-record-modal-title').textContent = item.fullDomain || '解析记录详情';
  const taskNames = (item.tasks || []).map((t) => `${t.name}${t.enable ? '' : '（停用）'}`).join('、') || '—';
  const enabled = (item.tasks || []).every((t) => t.enable);
  const statusMap = { ok: '已解析', pending: '待解析', wildcard: '通配' };
  const aaaa = item.hasAAAA ? '✓ 存在' : '✗ 缺失';
  const a = item.hasA ? '✓ 存在' : '✗ 缺失';
  const body = document.getElementById('ddns-record-modal-body');
  body.innerHTML = `
    <dl class="kv">
      <dt>完整域名</dt><dd class="mono">${escapeHtml(item.fullDomain || '')}</dd>
      <dt>记录类型</dt><dd>${escapeHtml(item.type || 'A')}</dd>
      <dt>所属 DDNS 任务</dt><dd>${escapeHtml(taskNames)}</dd>
      <dt>任务状态</dt><dd>${enabled ? '<span class="ddns-badge on">启用</span>' : '<span class="ddns-badge off">停用</span>'}</dd>
      <dt>A 记录</dt><dd>${a}</dd>
      <dt>AAAA 记录</dt><dd>${aaaa}</dd>
      <dt>解析状态</dt><dd>${escapeHtml(statusMap[item.status] || item.status || '未知')}</dd>
    </dl>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" data-close-ddns-record>关闭</button>
    </div>
  `;
  modal.classList.remove('hidden');
  refreshIcons();
}

function closeDdnsRecordModal() {
  document.getElementById('ddns-record-modal')?.classList.add('hidden');
}

let perfBusy = false;
// 性能图当前时间范围（默认 1h）
let perfRangeMs = 60 * 60 * 1000;
// 把切换器暴露成全局：charts.js 改完后 main.js 仍可触发局部重渲染
window.__perfSetRange = (range) => {
  const map = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 };
  perfRangeMs = map[range] || perfRangeMs;
  refreshPerf();
};

async function refreshPerf() {
  if (perfBusy) return;
  perfBusy = true;
  try {
    const [health, history] = await Promise.all([
      api.appHealth().catch(() => ({ results: [] })),
      fetch('/api/health/history', { headers: { 'X-Panel-Token': getToken() } })
        .then((r) => r.json())
        .catch(() => ({ series: {} })),
    ]);
    // 延迟历史只显示活跃应用的 cdn 折线（nas 不再探测，遗留 :nas 序列一律忽略）
    const activeIds = new Set();
    for (const r of health.results || []) {
      const cdn = (r.checks || []).find((c) => c.label === 'cdn');
      if (cdn && cdn.ok !== false && typeof cdn.latency === 'number') {
        activeIds.add(r.id);
      }
    }
    // 时间范围过滤 + 应用过滤
    const cutoff = Date.now() - perfRangeMs;
    const filteredSeries = {};
    for (const [key, points] of Object.entries(history.series || {})) {
      if (!key.endsWith(':cdn')) continue; // nas.* 序列不再展示
      const appId = key.slice(0, key.lastIndexOf(':'));
      if (!activeIds.has(appId)) continue;
      const recentPoints = (points || []).filter((p) => !p.t || p.t >= cutoff);
      if (recentPoints.length > 0) filteredSeries[key] = recentPoints;
    }
    const meta = {};
    for (const r of health.results || []) {
      meta[r.id] = { name: r.name };
    }
    renderPerfLineChart(document.getElementById('perf-line-chart'), filteredSeries, meta);
  } finally {
    perfBusy = false;
  }
}
