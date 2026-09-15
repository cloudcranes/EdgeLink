import { api } from './api.js';
import { escapeHtml } from './ui.js';

function setText(id, text, tone) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `summary-value ${tone || ''}`.trim();
}

export async function refreshSummary() {
  const cards = document.getElementById('summary-cards');
  if (!cards) return;
  try {
    const data = await api.fetchSummary();
    const s = data.summary;
    const rootDomain = s.rootDomain || '(未设置)';
    setText('sum-apps', `${s.apps}`, 'ok');
    setText('sum-lucky-sub', `${s.luckySubRules} (${s.luckyPanelProxies} 面板)`, s.luckySubRules ? '' : 'warn');
    setText('sum-esa-domain', `${s.esaDomains} (${s.esaPanelDomains} cdn 加速)`, s.esaDomains ? '' : 'warn');
    setText('sum-lucky-dns', s.luckyDdnsNasTask ? `*.nas.${rootDomain} ✓` : `缺少 *.nas.${rootDomain}`, s.luckyDdnsNasTask ? 'ok' : 'warn');
    setText('sum-lucky-ssl', s.luckyNasSsl ? `*.nas.${rootDomain} ✓` : `缺少 *.nas.${rootDomain}`, s.luckyNasSsl ? 'ok' : 'warn');
    setText('sum-esa-cert', s.esaNasCertificate ? `*.cdn.${rootDomain} ✓` : `缺少 *.cdn.${rootDomain}（手动申请）`, s.esaNasCertificate ? 'ok' : 'warn');
    setText('sum-root', rootDomain, s.rootDomain ? '' : 'warn');
  } catch (error) {
    cards.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><span>资源摘要加载失败：${escapeHtml(error.message)}</span></div>`;
    window.lucide?.createIcons();
  }
}
