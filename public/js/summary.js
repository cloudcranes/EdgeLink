import { api } from './api.js';
import { escapeHtml } from './ui.js';

function setText(id, text, tone, title) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `summary-value ${tone || ''}`.trim();
  if (title) el.title = title;
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
    // 长文案（完整子域）放 title 提示，值只显示短状态，避免 6 卡高度参差
    setText('sum-lucky-dns', s.luckyDdnsNasTask ? '✓ 已配置' : '缺少', s.luckyDdnsNasTask ? 'ok' : 'warn', `*.nas.${rootDomain}`);
    setText('sum-lucky-ssl', s.luckyNasSsl ? '✓ 已配置' : '缺少', s.luckyNasSsl ? 'ok' : 'warn', `*.nas.${rootDomain}`);
    setText('sum-esa-cert', s.esaNasCertificate ? '✓ 已配置' : '缺少', s.esaNasCertificate ? 'ok' : 'warn', `*.cdn.${rootDomain}${s.esaNasCertificate ? '' : '（请到 ESA 控制台申请）'}`);
    setText('sum-root', rootDomain, s.rootDomain ? '' : 'warn');
  } catch (error) {
    cards.innerHTML = `<div class="empty-state"><i data-lucide="alert-circle"></i><span>资源摘要加载失败：${escapeHtml(error.message)}</span></div>`;
    window.lucide?.createIcons();
  }
}
