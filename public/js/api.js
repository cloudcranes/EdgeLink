import { promptDialog } from './ui.js';

const TOKEN_KEY = 'lucky-esa-panel-token';

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export { getToken };

export function setToken(token) {
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  } else {
    sessionStorage.removeItem(TOKEN_KEY);
  }
}

async function request(path, options = {}, timeoutMs = 60000) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) {
    headers['X-Panel-Token'] = token;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时，请重试');
    }
    throw new Error(`网络错误: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    // 访问口令缺失/无效：清除可能失效的旧 token，让用户输入或取消
    setToken('');
    const input = await promptDialog({
      title: '需要访问口令',
      message: '面板访问口令缺失或已失效，请输入访问口令（取消则跳过本次请求）。',
      placeholder: '访问口令',
      inputType: 'password',
      okLabel: '确认',
    });
    if (input) {
      setToken(input);
      return request(path, options, timeoutMs);
    }
    throw new Error(data.error || '需要访问口令');
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.msg || `请求失败 (${response.status})`);
  }
  return data;
}

export const api = {
  loadConfig: () => request('/api/config'),
  saveConfig: (config) => request('/api/config', { method: 'POST', body: JSON.stringify({ config }) }),
  deploy: (config, appId, parts) =>
    request('/api/deploy', { method: 'POST', body: JSON.stringify({ config, appId, parts }) }),
  loadSites: (config) => request('/api/esa/sites', { method: 'POST', body: JSON.stringify({ config }) }),
  testLucky: (config) => request('/api/lucky/test', { method: 'POST', body: JSON.stringify({ config }) }),
  fetchStatus: () => request('/api/status'),
  fetchLuckyRules: () => request('/api/lucky/rules'),
  fetchLuckyDdns: () => request('/api/lucky/ddns/tasks'),
  recordDeleteDdns: (recordKey, opts = {}) => {
    const qs = opts.dryRun ? '?dryRun=1' : '';
    return request(`/api/lucky/ddns/record-delete${qs}`, {
      method: 'POST',
      body: JSON.stringify({ recordKey }),
    });
  },
  fetchEsaCnameDiagnostics: () => request('/api/diagnostics/esa-cname'),
  fixEsaCname: (appId) =>
    request('/api/diagnostics/esa-cname/fix', { method: 'POST', body: JSON.stringify({ appId }) }),
  fetchEsaRules: () => request('/api/esa/rules'),
  enableDomain: (domain, target) =>
    request('/api/esa/enable-domain', { method: 'POST', body: JSON.stringify({ domain, target }) }),
  patchEsaRecord: (recordId, body, opts = {}) => {
    const qs = opts.dryRun ? '?dryRun=1' : '';
    return request(`/api/esa/record/${recordId}${qs}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  deleteEsaRecord: (recordId, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.dryRun) params.set('dryRun', '1');
    if (opts.purgeDdns) params.set('purgeDdns', '1');
    const qs = params.toString();
    return request(`/api/esa/record/${recordId}${qs ? '?' + qs : ''}`, { method: 'DELETE' });
  },
  regenerateToken: () => request('/api/panel/token', { method: 'POST', body: JSON.stringify({}) }),
  clearToken: () => request('/api/panel/token', { method: 'POST', body: JSON.stringify({ clear: true }) }),
  patchPanelTheme: (theme) =>
    request('/api/panel/theme', { method: 'PATCH', body: JSON.stringify({ theme }) }),
  appPrecheck: (prefix) => request(`/api/app/precheck?prefix=${encodeURIComponent(prefix)}`),
  fetchSummary: () => request('/api/summary'),
  exportConfig: () => request('/api/config/export'),
  importConfig: (config) => request('/api/config/import', { method: 'POST', body: JSON.stringify({ config }) }),
  listSnapshots: () => request('/api/snapshots'),
  restoreSnapshot: (file) => request('/api/snapshots/restore', { method: 'POST', body: JSON.stringify({ file }) }),
  audit: () => request('/api/audit'),
  auditFix: (appId) => request('/api/audit/fix', { method: 'POST', body: JSON.stringify({ appId: appId || null }) }),
  appHealth: () => request('/api/apps/health'),
  appRecheck: (id) => request('/api/apps/status/recheck', { method: 'POST', body: JSON.stringify({ appId: id }) }),
  appRecheckAll: () => request('/api/apps/status/recheck', { method: 'POST', body: JSON.stringify({}) }),
  deleteApp: (id, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.purge) params.set('purge', '1');
    if (opts.dryRun) params.set('dryRun', '1');
    if (opts.confirm) params.set('confirm', String(opts.confirm));
    const qs = params.toString();
    const url = `/api/apps/${encodeURIComponent(id)}${qs ? '?' + qs : ''}`;
    return request(url, { method: 'DELETE', body: qs ? '{}' : undefined });
  },
  patchApp: (id, body, opts = {}) => {
    const params = new URLSearchParams();
    if (opts.preview) params.set('preview', '1');
    const qs = params.toString();
    const url = `/api/apps/${encodeURIComponent(id)}${qs ? '?' + qs : ''}`;
    return request(url, { method: 'PATCH', body: JSON.stringify(body) });
  },
  portPrecheck: () => request('/api/precheck/ports'),
  fetchLogs: () => request('/api/logs'),
  toggleLuckyProxy: (proxyKey, field, value) =>
    request('/api/lucky/proxy/toggle', { method: 'POST', body: JSON.stringify({ proxyKey, field, value }) }),
  toggleEsaDomain: (domain, value) =>
    request('/api/esa/domain/toggle', { method: 'POST', body: JSON.stringify({ domain, value }) }),
  cleanupResidue: (body, opts = {}) => {
    const qs = opts.dryRun ? '?dryRun=1' : '';
    return request(`/api/lucky/ddns/cleanup-residue${qs}`, { method: 'POST', body: JSON.stringify(body) });
  },
};
