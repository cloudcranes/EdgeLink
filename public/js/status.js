import { api } from './api.js';
import { appendLog, refreshIcons } from './ui.js';

function setStatus(id, text, tone) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `status-value ${tone || ''}`.trim();
  el.title = tone === 'err' ? text : '';
}

function renderStatus(status) {
  const { lucky, esa, gateway } = status;

  if (!lucky.configured) {
    setStatus('status-lucky', '未配置');
  } else if (lucky.ok) {
    setStatus('status-lucky', `已连接 · ${lucky.managedProxies} 条子规则`, 'ok');
  } else {
    setStatus('status-lucky', '连接失败', 'err');
  }

  if (!esa.configured) {
    setStatus('status-esa', '未配置');
  } else if (esa.ok) {
    setStatus('status-esa', `已连接 · ${esa.managedRules} 条回源规则`, 'ok');
  } else {
    setStatus('status-esa', '连接失败', 'err');
  }

  const port = document.getElementById('gateway-listen-port').value || 8443;
  if (gateway.listening) {
    setStatus('status-gateway', `监听中 · 端口 ${port}`, 'ok');
  } else {
    setStatus('status-gateway', gateway.error || '未监听', 'warn');
  }
}

export async function refreshStatus() {
  const button = document.getElementById('refresh-status');
  const icon = button ? button.querySelector('i') : null;
  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
    if (icon) icon.dataset.lucide = 'loader-circle';
    refreshIcons();
  }
  try {
    const data = await api.fetchStatus();
    renderStatus(data.status);
  } catch (error) {
    appendLog('运行状态', 'error', error.message);
    // 失败时也要更新状态条（若存在），否则一直停在「检测中…」
    const errText = `检测失败：${error.message}`;
    setStatus('status-lucky', errText, 'err');
    setStatus('status-esa', errText, 'err');
    setStatus('status-gateway', errText, 'err');
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('is-loading');
      icon.dataset.lucide = 'refresh-cw';
      refreshIcons();
    }
  }
}
