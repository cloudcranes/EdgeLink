export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
  // 图标均为装饰性（旁有文字或按钮带 aria-label），从无障碍树隐藏
  document.querySelectorAll('svg[data-lucide]').forEach((svg) => {
    svg.setAttribute('aria-hidden', 'true');
  });
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 降级到 execCommand
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  textarea.remove();
  return ok;
}

export function openDomain(domain, port) {
  if (!domain) {
    return;
  }
  const scheme = /^https?:\/\//i.test(domain) ? '' : 'https://';
  const url = `${scheme}${domain}${port ? `:${port}` : ''}`;
  window.open(url, '_blank', 'noopener');
}

export function setSaveState(text, saved = false) {
  const el = document.getElementById('save-state');
  el.textContent = text;
  el.classList.toggle('saved', saved);
}

let bannerTimer = null;

export function showBanner(message, type = 'ok') {
  const banner = document.getElementById('deploy-result');
  banner.textContent = '';
  banner.className = `result-banner ${type}`;
  banner.hidden = false;
  const span = document.createElement('span');
  span.textContent = message;
  banner.appendChild(span);
  // 错误态不自动消失，提供手动关闭；成功态 6 秒后消失
  if (type === 'err') {
    if (!banner.querySelector('.banner-close')) {
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'banner-close';
      close.setAttribute('aria-label', '关闭');
      close.innerHTML = '<i data-lucide="x"></i>';
      close.addEventListener('click', () => {
        banner.hidden = true;
      });
      banner.appendChild(close);
      window.lucide?.createIcons();
    }
    window.clearTimeout(bannerTimer);
  } else {
    window.clearTimeout(bannerTimer);
    bannerTimer = window.setTimeout(() => {
      banner.hidden = true;
    }, 6000);
  }
}

export function appendLog(step, status, detail, context = null) {
  const logs = document.getElementById('logs');
  const empty = logs.querySelector('.empty');
  if (empty) {
    empty.remove();
  }
  const li = document.createElement('li');
  if (status === 'error') {
    li.className = 'error';
  } else if (status === 'warn') {
    li.className = 'warn';
  }
  const time = document.createElement('span');
  time.className = 'log-time';
  const now = new Date();
  time.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  li.appendChild(time);
  const stepSpan = document.createElement('span');
  stepSpan.className = 'step';
  stepSpan.textContent = `[${step}] `;
  li.appendChild(stepSpan);
  li.appendChild(document.createTextNode(detail));
  if (context && typeof context === 'object') {
    const meta = document.createElement('div');
    meta.className = 'log-meta';
    const parts = [];
    for (const [key, value] of Object.entries(context)) {
      if (value === undefined || value === null || value === '') continue;
      parts.push(`<span>${escapeHtml(key)}=<b>${escapeHtml(String(value))}</b></span>`);
    }
    if (parts.length > 0) {
      meta.innerHTML = parts.join('');
      li.appendChild(meta);
    }
  }
  logs.appendChild(li);
  logs.scrollTop = logs.scrollHeight;
}

export function clearLogs() {
  document.getElementById('logs').innerHTML = '<li class="empty">暂无日志</li>';
}

/* ---------- 全局 Toast 通知 ---------- */

export function showToast(message, type = 'ok', opts = {}) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const iconName = type === 'err' ? 'circle-alert' : type === 'warn' ? 'triangle-alert' : 'circle-check';
  toast.innerHTML = `<i data-lucide="${iconName}"></i><span>${escapeHtml(message)}</span>`;
  stack.appendChild(toast);
  window.lucide?.createIcons();
  const duration = opts.duration ?? (type === 'err' ? 6000 : 3000);
  const dismiss = () => {
    if (toast.classList.contains('leaving')) return;
    toast.classList.add('leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };
  const timer = window.setTimeout(dismiss, duration);
  toast.addEventListener('click', () => {
    window.clearTimeout(timer);
    dismiss();
  });
  // 上限 5 条，超出挤掉最早的
  while (stack.children.length > 5) {
    stack.firstElementChild?.remove();
  }
  return dismiss;
}

/* ---------- 自定义确认弹窗（替换 window.confirm） ---------- */

let confirmState = null; // { resolve, ok, cancel }

function getConfirmModal() {
  return document.getElementById('confirm-modal');
}

export function confirmDialog({ title = '确认操作', message = '', okLabel = '确定', cancelLabel = '取消', danger = false } = {}) {
  const modal = getConfirmModal();
  if (!modal) {
    // 容器缺失（异常场景）：降级到原生 confirm，保证功能不中断
    return Promise.resolve(window.confirm(message || title));
  }
  // 关闭上一个未决弹窗
  if (confirmState) {
    confirmState.resolve(false);
    confirmState = null;
  }
  document.getElementById('confirm-title').innerHTML = `<i data-lucide="${danger ? 'triangle-alert' : 'help-circle'}"></i>${escapeHtml(title)}`;
  document.getElementById('confirm-body').textContent = message;
  const okBtn = modal.querySelector('[data-confirm-ok]');
  const cancelBtn = modal.querySelector('[data-confirm-cancel]');
  okBtn.innerHTML = `<i data-lucide="${danger ? 'trash-2' : 'check'}"></i><span>${escapeHtml(okLabel)}</span>`;
  cancelBtn.textContent = cancelLabel;
  okBtn.classList.toggle('btn-danger', danger);
  okBtn.classList.toggle('btn-primary', !danger);
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const cleanup = () => {
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.querySelector('[data-confirm-close]').onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      confirmState = null;
    };
    const finish = (value) => {
      modal.classList.add('hidden');
      cleanup();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') finish(false);
      if (event.key === 'Enter') finish(true);
    };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    modal.querySelector('[data-confirm-close]').onclick = () => finish(false);
    modal.onclick = (event) => {
      if (event.target === modal) finish(false);
    };
    document.addEventListener('keydown', onKey);
    confirmState = { resolve };
    okBtn.focus();
    window.lucide?.createIcons();
  });
}

/* ---------- 自定义输入弹窗（替换 window.prompt，用于面板访问口令） ---------- */

export function promptDialog({ title = '输入', message = '', placeholder = '', initial = '', okLabel = '确定', cancelLabel = '取消', inputType = 'text' } = {}) {
  const modal = getConfirmModal();
  if (!modal) {
    return Promise.resolve(window.prompt(message || title, initial));
  }
  if (confirmState) {
    confirmState.resolve(null);
    confirmState = null;
  }
  document.getElementById('confirm-title').innerHTML = `<i data-lucide="key-round"></i>${escapeHtml(title)}`;
  const body = document.getElementById('confirm-body');
  body.textContent = message;
  const input = document.createElement('input');
  input.type = inputType;
  input.placeholder = placeholder;
  input.value = initial;
  input.autocomplete = 'off';
  input.spellcheck = false;
  body.appendChild(input);
  const okBtn = modal.querySelector('[data-confirm-ok]');
  const cancelBtn = modal.querySelector('[data-confirm-cancel]');
  okBtn.innerHTML = `<i data-lucide="check"></i><span>${escapeHtml(okLabel)}</span>`;
  cancelBtn.textContent = cancelLabel;
  okBtn.classList.remove('btn-danger');
  okBtn.classList.add('btn-primary');
  modal.classList.remove('hidden');

  return new Promise((resolve) => {
    const cleanup = () => {
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.querySelector('[data-confirm-close]').onclick = null;
      modal.onclick = null;
      document.removeEventListener('keydown', onKey);
      confirmState = null;
      input.remove();
    };
    const finish = (value) => {
      modal.classList.add('hidden');
      cleanup();
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') finish(null);
      if (event.key === 'Enter') finish(input.value.trim());
    };
    okBtn.onclick = () => finish(input.value.trim());
    cancelBtn.onclick = () => finish(null);
    modal.querySelector('[data-confirm-close]').onclick = () => finish(null);
    modal.onclick = (event) => {
      if (event.target === modal) finish(null);
    };
    document.addEventListener('keydown', onKey);
    confirmState = { resolve };
    input.focus();
    input.select();
    window.lucide?.createIcons();
  });
}
