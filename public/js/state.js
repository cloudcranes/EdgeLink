import { api } from './api.js';
import { escapeHtml, setSaveState } from './ui.js';
import { renderBasicAuth } from './settings.js';
export const state = {
  config: null,
  sites: [],
  editingId: null,
};

// 域名前缀模型派生：{prefix}.nas.{root} / {prefix}.cdn.{root} / {prefix}.{root}
// 兼容旧字段：若 app 有 externalDomain（旧），优先用旧字段
export function nasDomainFor(app, rootDomain) {
  if (!app) return '';
  if (app.originDomain) return app.originDomain;
  if (!app.prefix || !rootDomain) return '';
  return `${app.prefix}.nas.${rootDomain}`;
}

export function cdnDomainFor(app, rootDomain) {
  if (!app) return '';
  if (app.externalDomain) return app.externalDomain;
  if (!app.prefix || !rootDomain) return '';
  return `${app.prefix}.cdn.${rootDomain}`;
}

export function originHostFor(app, rootDomain) {
  if (!app) return '';
  if (app.originHostHeader) return app.originHostHeader;
  return nasDomainFor(app, rootDomain);
}

export function getRootDomain(config) {
  return config?.esa?.rootDomain || '';
}

export function gatherConfig() {
  return {
    lucky: {
      baseUrl: document.getElementById('lucky-base-url').value.trim(),
      pathPrefix: document.getElementById('lucky-path-prefix').value.trim(),
      openToken: document.getElementById('lucky-open-token').value,
      account: document.getElementById('lucky-account').value.trim(),
      password: document.getElementById('lucky-password').value,
      basicAuth: readBasicAuthFromForm(),
    },
    esa: {
      accessKeyId: document.getElementById('esa-access-key-id').value.trim(),
      accessKeySecret: document.getElementById('esa-access-key-secret').value,
      siteId:
        document.getElementById('esa-site-select').value ||
        document.getElementById('esa-site-id').value.trim(),
      siteName: (() => {
        const selectedId =
          document.getElementById('esa-site-select').value ||
          document.getElementById('esa-site-id').value.trim();
        if (selectedId) {
          const found = state.sites.find((site) => String(site.siteId) === String(selectedId));
          if (found?.siteName) {
            return found.siteName;
          }
        }
        // sites 未加载或未匹配：保留已保存的站点名，绝不取占位符
        return state.config?.esa?.siteName || '';
      })(),
      rootDomain: document.getElementById('esa-root-domain')?.value.trim() || state.config?.esa?.rootDomain || 'alanmaster.top',
    },
    gateway: {
      listenIp: document.getElementById('gateway-listen-ip').value.trim() || '::',
      listenPort: Number(document.getElementById('gateway-listen-port').value) || 8443,
      originScheme: document.getElementById('gateway-origin-scheme').value,
      originHttpPort: Number(document.getElementById('gateway-origin-http-port').value) || 8000,
      enableTls: document.getElementById('gateway-enable-tls').checked,
      originVerify: document.getElementById('gateway-origin-verify').checked,
      originReadTimeout: Number(document.getElementById('gateway-read-timeout').value) || 30,
    },
    apps: state.config?.apps || [],
  };
}
function readBasicAuthUsers() {
  const wrap = document.getElementById('basic-auth-users');
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll('.basic-auth-user')).map((row) => ({
    username: row.querySelector('.basic-auth-user-name')?.value.trim() || '',
    password: row.querySelector('.basic-auth-user-pass')?.value || '',
  })).filter((u) => u.username);
}

export function fillFormFromConfig(config) {
  document.getElementById('lucky-base-url').value = config.lucky.baseUrl || '';
  document.getElementById('lucky-path-prefix').value = config.lucky.pathPrefix || '';
  document.getElementById('lucky-open-token').value = config.lucky.openToken || '';
  document.getElementById('lucky-account').value = config.lucky.account || '';
  document.getElementById('lucky-password').value = config.lucky.password || '';
  document.getElementById('esa-access-key-id').value = config.esa.accessKeyId || '';
  document.getElementById('esa-access-key-secret').value = config.esa.accessKeySecret || '';
  document.getElementById('esa-site-id').value = config.esa.siteId || '';
  document.getElementById('esa-root-domain').value = config.esa.rootDomain || 'alanmaster.top';
  document.getElementById('gateway-listen-ip').value = config.gateway.listenIp || '::';
  document.getElementById('gateway-listen-port').value = config.gateway.listenPort || 8443;
  document.getElementById('gateway-origin-scheme').value = config.gateway.originScheme || 'http';
  document.getElementById('gateway-origin-http-port').value = config.gateway.originHttpPort || 8000;
  document.getElementById('gateway-enable-tls').checked = !!config.gateway.enableTls;
  document.getElementById('gateway-origin-verify').checked = !!config.gateway.originVerify;
  document.getElementById('gateway-read-timeout').value = config.gateway.originReadTimeout ?? '';
  renderBasicAuth(config);
}

export function renderSiteSelect() {
  const select = document.getElementById('esa-site-select');
  const previous = select.value || state.config?.esa?.siteId;
  select.innerHTML =
    '<option value="">选择站点</option>' +
    state.sites
      .map(
        (site) =>
          `<option value="${escapeHtml(site.siteId)}">${escapeHtml(site.siteName)} · ${escapeHtml(site.accessType)} · ${escapeHtml(site.status)}</option>`,
      )
      .join('');
  if (previous && state.sites.some((site) => String(site.siteId) === String(previous))) {
    select.value = String(previous);
    document.getElementById('esa-site-id').value = String(previous);
  }
}

export function setConfig(config) {
  state.config = config;
  document.dispatchEvent(new CustomEvent('config-changed'));
}

export async function loadConfig() {
  const data = await api.loadConfig();
  setConfig(data.config);
  fillFormFromConfig(data.config);
  setSaveState(data.config.esa.siteId ? '已保存' : '未保存', !!data.config.esa.siteId);
}

export async function saveConfig(showSaved = true) {
  const data = await api.saveConfig(gatherConfig());
  setConfig(data.config);
  if (showSaved) {
    setSaveState('已保存', true);
  }
  return data.config;
}

function readBasicAuthFromForm() {
  return {
    enabled: document.getElementById('basic-auth-enabled')?.checked === true,
    users: Array.from(document.querySelectorAll('.basic-auth-user')).map((row) => ({
      username: row.querySelector('.basic-auth-user-name')?.value.trim() || '',
      password: row.querySelector('.basic-auth-user-pass')?.value || '',
    })).filter((u) => u.username),
  };
}