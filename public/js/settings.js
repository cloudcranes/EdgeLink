import { state } from './state.js';
import { escapeHtml } from './ui.js';

let nextUserIndex = 0;

function makeUserRow(initial = {}) {
  const idx = nextUserIndex++;
  const wrap = document.createElement('div');
  wrap.className = 'basic-auth-user';
  wrap.innerHTML =
    `<input class="basic-auth-user-name" type="text" placeholder="用户名" value="${escapeHtml(initial.username || '')}" />` +
    `<input class="basic-auth-user-pass" type="password" placeholder="密码" value="${escapeHtml(initial.password || '')}" />` +
    `<button class="btn btn-ghost icon-only" type="button" data-remove-user="${idx}" title="删除"><i data-lucide="trash-2"></i></button>`;
  wrap.dataset.userIndex = String(idx);
  return wrap;
}

export function initBasicAuth() {
  const enabled = document.getElementById('basic-auth-enabled');
  const list = document.getElementById('basic-auth-users');
  const addBtn = document.getElementById('basic-auth-add');
  if (!enabled || !list || !addBtn) return;

  addBtn.addEventListener('click', () => {
    list.appendChild(makeUserRow({}));
    if (window.lucide) window.lucide.createIcons();
  });

  list.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-remove-user]');
    if (btn && btn.closest('.basic-auth-user')) {
      btn.closest('.basic-auth-user').remove();
    }
  });
}

export function renderBasicAuth(config) {
  const enabled = document.getElementById('basic-auth-enabled');
  const list = document.getElementById('basic-auth-users');
  if (!enabled || !list) return;
  const ba = config.lucky?.basicAuth || { enabled: false, users: [] };
  enabled.checked = !!ba.enabled;
  list.innerHTML = '';
  nextUserIndex = 0;
  for (const u of ba.users || []) {
    list.appendChild(makeUserRow(u));
  }
  if (window.lucide) window.lucide.createIcons();
}
