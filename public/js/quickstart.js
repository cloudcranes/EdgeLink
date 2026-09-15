import { state } from './state.js';
import { escapeHtml } from './ui.js';

const $ = (id) => document.getElementById(id);

function renderSteps() {
  const config = state.config;
  const steps = [];
  let done = 0;

  // 1. 域名（应用）——规则的源头，Lucky/ESA 都围绕域名服务
  const apps = config?.apps || [];
  steps.push({
    label: '确定域名规则',
    detail: apps.length ? `已有 ${apps.length} 个应用` : '先定域名映射：在「应用管理」添加，或从现存 Lucky 规则导入/开通 ESA',
    done: apps.length > 0,
    route: 'apps',
  });
  if (apps.length > 0) done += 1;

  // 2. Lucky 连接
  const luckyOk = !!config?.lucky?.baseUrl && (!!config?.lucky?.openToken || (!!config?.lucky?.account && !!config?.lucky?.password));
  steps.push({
    label: '配置 Lucky 连接',
    detail: luckyOk ? '已配置（地址 + OpenToken/账号）' : '填后台地址，用 OpenToken 或账号密码',
    done: luckyOk,
    route: 'settings',
  });
  if (luckyOk) done += 1;

  // 3. ESA
  const esaOk = !!config?.esa?.accessKeyId && !!config?.esa?.accessKeySecret && !!config?.esa?.siteId;
  steps.push({
    label: '配置阿里云 ESA',
    detail: esaOk ? '已配置（AccessKey + 站点）' : '填 AccessKey 并选择站点',
    done: esaOk,
    route: 'settings',
  });
  if (esaOk) done += 1;

  // 4. 网关参数
  const gatewayOk = !!config?.gateway?.listenPort;
  steps.push({
    label: '确认回源网关参数',
    detail: gatewayOk ? `监听 :${config.gateway.listenPort}，回源 ${config.gateway.originScheme || 'http'}${config.gateway.originScheme === 'follow' ? `（http ${config.gateway.originHttpPort || 8000}）` : ''}` : '填监听端口与回源协议',
    done: gatewayOk,
    route: 'settings',
  });
  if (gatewayOk) done += 1;

  const total = steps.length;
  $('quick-start-progress').textContent = `${done}/${total} 完成`;
  $('quick-start-steps').innerHTML = steps
    .map(
      (step, index) => `
    <li class="${step.done ? 'done' : ''}">
      <span class="qs-index">${step.done ? '<i data-lucide="check"></i>' : index + 1}</span>
      <div class="qs-body">
        <div class="qs-label">${escapeHtml(step.label)}</div>
        <div class="qs-detail">${escapeHtml(step.detail)}</div>
      </div>
    </li>`,
    )
    .join('');
  window.lucide?.createIcons();

  // 全部完成则隐藏引导，否则显示
  $('quick-start').hidden = done === total;
}

export function refreshQuickStart() {
  renderSteps();
}
