import { api } from './api.js';
import { fillFormFromConfig, getRootDomain, nasDomainFor, saveConfig, setConfig, state } from './state.js';
import { appendLog, confirmDialog, escapeHtml, refreshIcons, showToast } from './ui.js';

let luckyRules = [];
let esaRules = [];
let esaDomains = [];

function el(id) {
  return document.getElementById(id);
}

function renderEmpty(container, text) {
  container.innerHTML = `<div class="empty-state"><i data-lucide="inbox"></i><span>${escapeHtml(text)}</span></div>`;
  refreshIcons();
}

export function renderExistingRules() {
  const source = document.querySelector('input[name="existing-source"]:checked')?.value || 'lucky';
  const container = el('existing-rules-body');
  if (source === 'lucky') {
    renderLuckyRules(container);
  } else {
    renderEsaRules(container);
  }
}

// 站点根域：优先从已存在的 ESA 加速域名（X.cdn.{root}）反推，不依赖 config.esa.siteName（可能有脏值/占位符）
function deriveSiteRoot() {
  const fromDomains = esaDomains.find((d) => d.name && d.name.includes('.cdn.'));
  if (fromDomains) {
    const match = fromDomains.name.match(/\.cdn\.(.+)$/);
    if (match) {
      return match[1];
    }
  }
  return state.config?.esa.siteName || '';
}

function renderLuckyRules(container) {
  if (luckyRules.length === 0) {
    renderEmpty(container, '未读取到 Lucky 子规则，或未配置 Lucky');
    return;
  }
  const siteRoot = deriveSiteRoot();
  // 双向核对：加速域名名匹配 或 CNAME 目标（value）就是该 Lucky 域名
  const domainSet = new Set(esaDomains.map((d) => d.name));
  const targetSet = new Set(esaDomains.map((d) => d.value));
  container.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>状态</th>
          <th>域名</th>
          <th>回源目标</th>
          <th>备注</th>
          <th>端口</th>
          <th>开关</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${luckyRules
          .map((rule) => {
            const domain = rule.domains[0] || '';
            const accelDomain = siteRoot ? `${domain.split('.')[0]}.cdn.${siteRoot}` : '';
            const enabled =
              !!accelDomain && (domainSet.has(accelDomain) || (domain && targetSet.has(domain)));
            const importDisabled = rule.managed ? '' : 'disabled';
            const esaDisabled = enabled || !accelDomain;
            return `
          <tr>
            <td data-label="状态"><span class="pill ${rule.enabled ? 'on' : 'off'}">${rule.enabled ? '启用' : '停用'}</span></td>
            <td class="mono" data-label="域名">${escapeHtml(domain || '-')}</td>
            <td class="mono" data-label="回源目标">${escapeHtml((rule.locations[0] || '-').replace(/^https?:\/\//, ''))}</td>
            <td data-label="备注">${escapeHtml(rule.name || '-')}</td>
            <td class="mono" data-label="端口">${escapeHtml(rule.listenPort || '-')}</td>
            <td data-label="开关">
              <div class="app-switches">
                <label class="mini-toggle" title="是否反代（Lucky 子规则启停）">
                  <input type="checkbox" data-ex-switch="luckyEnabled" data-key="${escapeHtml(rule.key)}" ${rule.enabled ? 'checked' : ''} />
                  <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
                  <span class="mini-toggle-label">反代</span>
                </label>
                <label class="mini-toggle" title="是否网页认证">
                  <input type="checkbox" data-ex-switch="webAuth" data-key="${escapeHtml(rule.key)}" ${rule.webAuth || rule.enableBasicAuth ? 'checked' : ''} />
                  <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
                  <span class="mini-toggle-label">认证</span>
                </label>
              </div>
            </td>
            <td data-label="操作">
              <div class="row-actions">
                <button class="btn" type="button" data-existing-action="copy" data-domain="${escapeHtml(enabled ? accelDomain : domain)}" title="复制域名（${escapeHtml(enabled ? accelDomain : domain)}${enabled ? '' : ':' + escapeHtml(rule.listenPort || '')}）">
                  <i data-lucide="copy"></i>
                </button>
                <button class="btn" type="button" data-existing-action="open" data-domain="${escapeHtml(enabled ? accelDomain : domain)}" data-port="${enabled ? '' : escapeHtml(rule.listenPort || '')}" title="访问${enabled ? ` ${escapeHtml(accelDomain)}` : ` ${escapeHtml(domain)}:${escapeHtml(rule.listenPort || '')}`}">
                  <i data-lucide="external-link"></i>
                </button>
                <button class="btn" type="button" data-existing-action="import" data-key="${escapeHtml(rule.key)}" ${importDisabled} title="${rule.managed ? '导入为面板应用' : '手动规则不支持导入（避免重复）'}">
                  <i data-lucide="download"></i>
                  <span>${rule.managed ? '导入' : '手动'}</span>
                </button>
                <button class="btn ${enabled ? 'btn-done' : 'btn-secondary'}" type="button" data-existing-action="enable-esa" data-domain="${escapeHtml(domain)}" data-target="${escapeHtml(domain)}" data-accel="${escapeHtml(accelDomain)}" ${esaDisabled ? 'disabled' : ''} title="${enabled ? `已开通 ${escapeHtml(accelDomain)}` : accelDomain ? `开通 ESA：${escapeHtml(accelDomain)} -> ${escapeHtml(domain)}` : '未配置 ESA 站点'}">
                  <i data-lucide="${enabled ? 'check-circle' : 'globe'}"></i>
                  <span>${enabled ? '已开通' : '开通 ESA'}</span>
                </button>
              </div>
            </td>
          </tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
  refreshIcons();
}

function renderEsaRules(container) {
  const domainHtml = esaDomains.length
    ? `
    <div class="sub-section">
      <div class="sub-title"><i data-lucide="globe"></i>加速域名</div>
      <table>
        <thead>
          <tr>
            <th>域名</th>
            <th>类型</th>
            <th>记录值</th>
            <th>加速</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${esaDomains
            .map(
              (domain) => `
            <tr>
              <td class="mono" data-label="域名">${escapeHtml(domain.name || '-')}</td>
              <td class="mono" data-label="类型">${escapeHtml(domain.type || '-')}</td>
              <td class="mono" data-label="记录值">${escapeHtml(domain.value || domain.recordCname || '-')}</td>
              <td data-label="加速">
                <label class="mini-toggle" title="ESA 加速已启用（CNAME 接入不允许关闭 proxied；如需彻底关闭请删除应用或调用 disableEsaDomain）">
                  <input type="checkbox" checked disabled />
                  <span class="mini-toggle-track"><span class="mini-toggle-knob"></span></span>
                  <span class="mini-toggle-label">已启用</span>
                </label>
              </td>
              <td data-label="操作">
                <div class="row-actions">
                  <button class="btn" type="button" data-existing-action="edit-esa" data-record-id="${escapeHtml(String(domain.id || ''))}" data-domain="${escapeHtml(domain.name)}" title="编辑 ESA 记录（回源/hostPolicy/proxied/ttl）">
                    <i data-lucide="edit-3"></i>
                    <span>编辑</span>
                  </button>
                  <button class="btn" type="button" data-existing-action="del-esa" data-record-id="${escapeHtml(String(domain.id || ''))}" data-domain="${escapeHtml(domain.name)}" title="删除 ESA 记录（可连带删 DDNS CNAME）">
                    <i data-lucide="trash-2"></i>
                    <span>删除</span>
                  </button>
                  <button class="btn" type="button" data-existing-action="copy" data-domain="${escapeHtml(domain.name)}" title="复制域名">
                    <i data-lucide="copy"></i>
                  </button>
                  <button class="btn" type="button" data-existing-action="open" data-domain="${escapeHtml(domain.name)}" title="访问域名">
                    <i data-lucide="external-link"></i>
                  </button>
                </div>
              </td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`
    : '';
  const rulesHtml = esaRules.length
    ? `
    <div class="sub-section">
      <div class="sub-title"><i data-lucide="git-branch"></i>回源规则</div>
      <table>
        <thead>
          <tr>
            <th>状态</th>
            <th>域名</th>
            <th>回源地址</th>
            <th>回源 Host</th>
            <th>端口</th>
            <th>规则名</th>
          </tr>
        </thead>
        <tbody>
          ${esaRules
            .map(
              (rule) => `
            <tr>
              <td data-label="状态"><span class="pill ${rule.enabled ? 'on' : 'off'}">${rule.enabled ? '启用' : '停用'}</span></td>
              <td class="mono" data-label="域名">${escapeHtml(rule.domain || '全部流量')}</td>
              <td class="mono" data-label="回源地址">${escapeHtml(rule.dnsRecord || '-')}</td>
              <td class="mono" data-label="回源 Host">${escapeHtml(rule.originHost || '-')}</td>
              <td class="mono" data-label="端口">${escapeHtml(rule.originHttpPort || rule.originHttpsPort || '-')}</td>
              <td class="mono" data-label="规则名">${escapeHtml(rule.ruleName || '-')}${rule.managed ? '' : ' <span class="manual-tag">手动</span>'}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`
    : '';
  if (!domainHtml && !rulesHtml) {
    renderEmpty(container, '未读取到 ESA 数据，或未配置 ESA');
    return;
  }
  container.innerHTML = domainHtml + rulesHtml;
  refreshIcons();
}

export async function loadExistingRules() {
  const container = el('existing-rules-body');
  container.innerHTML = '<div class="empty-state"><i data-lucide="loader-circle"></i><span>正在读取…</span></div>';
  refreshIcons();
  // 各自独立取数：Lucky 未配置时 ESA 视图不受影响
  const [luckyRes, esaRes] = await Promise.allSettled([api.fetchLuckyRules(), api.fetchEsaRules()]);
  let luckyErr = null;
  let esaErr = null;
  if (luckyRes.status === 'rejected') {
    luckyErr = luckyRes.reason?.message || String(luckyRes.reason);
    luckyRules = [];
    appendLog('现存规则', 'error', `Lucky 读取失败：${luckyErr}`);
  } else {
    luckyRules = luckyRes.value.rules || [];
  }
  if (esaRes.status === 'rejected') {
    esaErr = esaRes.reason?.message || String(esaRes.reason);
    esaRules = [];
    esaDomains = [];
    appendLog('现存规则', 'error', `ESA 读取失败：${esaErr}`);
  } else {
    esaRules = esaRes.value.rules || [];
    esaDomains = esaRes.value.domains || [];
  }
  if (luckyErr && esaErr) {
    renderEmpty(container, `读取失败：Lucky ${luckyErr}；ESA ${esaErr}`);
    return;
  }
  renderExistingRules();
  appendLog(
    '现存规则',
    'ok',
    `Lucky ${luckyRules.length} 条子规则，ESA 加速域名 ${esaDomains.length} 个，回源规则 ${esaRules.length} 条`,
  );
}

export async function importLuckyRule(key, { autoDeploy = true } = {}) {
  const rule = luckyRules.find((item) => item.key === key);
  if (!rule) {
    return;
  }
  const domain = rule.domains[0];
  const target = rule.locations[0];
  if (!domain || !target) {
    appendLog('导入规则', 'error', '该规则缺少域名或回源目标，无法导入');
    return;
  }
  const apps = state.config?.apps || [];
  const root = getRootDomain(state.config);
  // 与表单同一套去重：比较派生 nas 域名（无根域时退回 prefix/externalDomain）
  if (apps.some((app) => (nasDomainFor(app, root) || app.prefix || app.externalDomain) === domain)) {
    appendLog('导入规则', 'error', `域名 ${domain} 已存在于面板，跳过`);
    return;
  }
  const newApp = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: rule.name || domain,
    externalDomain: domain,
    originDomain: domain,
    originHostHeader: domain,
    target,
    enabled: rule.enabled,
    // 注意：保留 externalDomain 模式以便 Lucky 子规则 Domains 数组保持原样
    luckyEnabled: rule.enabled,
    esaEnabled: false, // externalDomain 模式不走 ESA 加速域名（prefix 未知）
    webAuth: rule.webAuth === true || rule.enableBasicAuth === true,
  };
  apps.push(newApp);
  try {
    await saveConfig(false);
    appendLog('导入规则', 'ok', `已导入 ${domain} -> ${target}（仅 Lucky 子规则，ESA 加速域名需另开通）`);
  } catch (error) {
    appendLog('导入规则', 'error', error.message);
    return;
  }
  // 自动同步 Lucky 子规则（让面板接管这条记录的后续更新/认证切换）
  if (autoDeploy) {
    try {
      const deployData = await api.deploy(state.config, newApp.id, ['lucky']);
      setConfig(deployData.config);
      fillFormFromConfig(deployData.config);
      appendLog('导入规则', 'ok', `已接管 Lucky 子规则（${deployData.logs?.length || 0} 步）`);
    } catch (error) {
      appendLog('导入规则', 'warn', `接管 Lucky 子规则失败：${error.message}（可手动点同步）`);
    }
  }
}

export async function enableEsaForRule(accelDomain, target) {
  appendLog('开通 ESA', 'ok', `正在创建 ${accelDomain} -> ${target}`);
  try {
    const data = await api.enableDomain(accelDomain, target);
    appendLog('开通 ESA', 'ok', data.message);
    if (data.ddns?.error) {
      appendLog('开通 ESA', 'error', `DNS CNAME 未生效：${data.ddns.error}`);
    }
    if (data.created) {
      esaDomains.push({ name: accelDomain, type: 'CNAME', value: target, proxied: true });
      renderExistingRules();
    }
  } catch (error) {
    appendLog('开通 ESA', 'error', error.message);
  }
}

// 编辑单条 ESA 记录：弹窗编辑（用 index.html 已有 modal 容器，避免 dialog/prompt 兼容性）
// 可编辑字段：value（回源值）、hostPolicy、proxied、ttl、sourceType、bizName
// 删除单条 ESA 加速域名记录（保留面板应用）
// 流程：dryRun 预览 → 询问是否连带删 DDNS CNAME → confirm → 执行
export async function deleteEsaRecord(recordId, domain) {
  if (!recordId) {
    appendLog('删除 ESA', 'error', '缺少 recordId');
    return;
  }
  try {
    // 1) 先看只删 ESA 的计划
    const dry = await api.deleteEsaRecord(recordId, { dryRun: true });
    if (!dry.ok) {
      appendLog('删除 ESA', 'error', dry.error || '预览失败');
      return;
    }
    const plan = dry.willRemove || {};
    // 2) 询问是否连带删除 DDNS CNAME
    let purgeDdns = false;
    if (plan.ddnsSub) {
      purgeDdns = await confirmDialog({
        title: '删除 ESA 加速域名',
        message: `将删除 ESA 加速域名：${plan.name}\n\n是否连带删除 Lucky DDNS 中的 CNAME 记录「${plan.ddnsSub}」？\n\n确定 = 一并删除（域名将完全不可访问）\n取消 = 只删 ESA 加速域名（DNS CNAME 保留，解析仍在但不走 ESA）`,
        okLabel: '连带删除',
        cancelLabel: '只删 ESA',
        danger: true,
      });
    } else {
      const ok = await confirmDialog({
        title: '删除 ESA 加速域名',
        message: `确认删除 ESA 加速域名 ${plan.name}？`,
        okLabel: '删除',
        danger: true,
      });
      if (!ok) {
        appendLog('删除 ESA', 'warn', `用户取消：${domain}`);
        return;
      }
    }
    // 3) 执行
    const real = await api.deleteEsaRecord(recordId, { purgeDdns, confirm: true });
    (real.logs || []).forEach((l) => {
      appendLog('删除 ESA', l.status === 'error' ? 'error' : 'ok', `${l.step}: ${l.detail}`);
    });
    if (real.deleted) {
      const idx = esaDomains.findIndex((d) => String(d.id) === String(recordId));
      if (idx >= 0) {
        esaDomains.splice(idx, 1);
        renderExistingRules();
      }
      appendLog('删除 ESA', 'ok', `${domain} 已删除${purgeDdns ? '（含 DDNS CNAME）' : ''}`);
    } else {
      appendLog('删除 ESA', 'error', real.message || '删除失败');
    }
  } catch (error) {
    appendLog('删除 ESA', 'error', error.message, { 域名: domain, recordId });
  }
}

export async function editEsaRecord(recordId, domain) {
  if (!recordId) {
    appendLog('编辑 ESA', 'error', '缺少 recordId');
    return;
  }
  const cur = esaDomains.find((d) => String(d.id) === String(recordId)) || {};
  const defValue = cur.value || cur.recordCname || '';
  const defPolicy = cur.hostPolicy || 'follow_origin_domain';
  const defTtl = cur.ttl || 1;
  const defProxied = !!cur.proxied;
  const defSource = cur.sourceType || 'Domain';
  const defBiz = cur.bizName || 'web';

  const modal = document.getElementById('esa-modal');
  const title = document.getElementById('esa-modal-title');
  const body = document.getElementById('esa-modal-body');
  if (!modal || !body) {
    appendLog('编辑 ESA', 'error', '找不到 esa-modal 容器（index.html 缺失）');
    return;
  }
  if (title) title.textContent = `编辑 ESA 记录 — ${domain || ''}`;

  body.innerHTML = `
    <form id="esa-edit-form" class="form">
      <label>回源值 (value)
        <input name="value" value="${escapeHtml(defValue)}" />
      </label>
      <label>hostPolicy
        <select name="hostPolicy">
          <option value="follow_origin_domain"${defPolicy === 'follow_origin_domain' ? ' selected' : ''}>follow_origin_domain（回源到回源域名）</option>
          <option value="follow_hostname"${defPolicy === 'follow_hostname' ? ' selected' : ''}>follow_hostname（回源到 Host 头）</option>
          <option value="none"${defPolicy === 'none' ? ' selected' : ''}>none（不回源到回源域名，按原值转发）</option>
        </select>
        <small>仅对 CNAME 记录生效</small>
      </label>
      <label>TTL (秒，1=自动)
        <input name="ttl" type="number" min="1" max="86400" value="${escapeHtml(String(defTtl))}" />
      </label>
      <label>proxied
        ${cur.type === 'CNAME'
          ? `<input type="hidden" name="proxied" value="true" />
             <div class="form-readonly">true（CNAME 接入类型 ESA 强制开启加速）</div>`
          : `<select name="proxied">
              <option value="true"${defProxied ? ' selected' : ''}>true（启用加速）</option>
              <option value="false"${!defProxied ? ' selected' : ''}>false（关闭加速）</option>
            </select>`}
        ${cur.type === 'CNAME' ? '<small>CNAME 记录必须启用加速（ESA 服务端限制）</small>' : ''}
      </label>
      <details>
        <summary>高级字段（一般无需修改）</summary>
        <label>sourceType
          <select name="sourceType">
            ${['Domain','OSS','S3','LB','OP'].map(v => `<option value="${v}"${defSource === v ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
          <small>回源类型（一般保持 Domain）</small>
        </label>
        <label>bizName
          <select name="bizName">
            ${['web','video_image','api'].map(v => `<option value="${v}"${defBiz === v ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
      </details>
      <pre id="esa-preview" class="esa-preview" style="display:none"></pre>
      <div class="form-actions">
        <button type="button" class="btn btn-secondary" data-esa-act="cancel">取消</button>
        <button type="button" class="btn" data-esa-act="dry">dryRun 预览</button>
        <button type="submit" class="btn btn-primary" data-esa-act="save">保存</button>
      </div>
    </form>`;
  modal.classList.remove('hidden');

  // 关闭函数
  const close = () => {
    modal.classList.add('hidden');
    body.innerHTML = '';
  };

  // 关闭按钮
  modal.querySelector('[data-close-esa]').onclick = close;
  body.querySelector('[data-esa-act="cancel"]').onclick = close;

  // dryRun 预览
  body.querySelector('[data-esa-act="dry"]').onclick = async () => {
    const body2 = readEsaForm(body);
    const prev = body.querySelector('#esa-preview');
    prev.style.display = 'block';
    prev.textContent = '请求中…';
    try {
      const r = await api.patchEsaRecord(recordId, body2, { dryRun: true });
      prev.textContent = JSON.stringify({ before: r.before, after: r.after, message: r.message }, null, 2);
    } catch (error) {
      prev.textContent = '错误：' + error.message;
    }
  };

  // 表单提交
  body.querySelector('#esa-edit-form').onsubmit = async (event) => {
    event.preventDefault();
    const body2 = readEsaForm(body);
    const prev = body.querySelector('#esa-preview');
    prev.style.display = 'block';
    prev.textContent = '保存中…';
    try {
      const real = await api.patchEsaRecord(recordId, body2);
      if (real.after) {
        const idx = esaDomains.findIndex((d) => String(d.id) === String(recordId));
        if (idx >= 0) {
          esaDomains[idx] = {
            ...esaDomains[idx],
            value: real.after.value,
            recordCname: real.after.recordCname,
            proxied: real.after.proxied,
            hostPolicy: real.after.hostPolicy,
            ttl: real.after.ttl,
            sourceType: real.after.sourceType,
            bizName: real.after.bizName,
          };
          renderExistingRules();
        }
      }
      appendLog('编辑 ESA', 'ok', `${domain} 已更新：${real.message || ''}`);
      close();
    } catch (error) {
      prev.textContent = '保存失败：' + error.message;
      appendLog('编辑 ESA', 'error', error.message, { 域名: domain, recordId });
    }
  };
}

function readEsaForm(body) {
  const f = (name) => body.querySelector(`[name="${name}"]`).value;
  return {
    value: f('value'),
    hostPolicy: f('hostPolicy'),
    ttl: Number(f('ttl')) || 1,
    proxied: String(f('proxied')).toLowerCase() === 'true',
    sourceType: f('sourceType') || 'Domain',
    bizName: f('bizName') || 'web',
  };
}

export async function enableAllEsa() {
  const siteRoot = deriveSiteRoot();
  if (!siteRoot) {
    appendLog('开通 ESA', 'error', '未配置 ESA 站点');
    return;
  }
  const domainSet = new Set(esaDomains.map((d) => d.name));
  const targetSet = new Set(esaDomains.map((d) => d.value));
  // 仅匹配"符合面板域名模型"的 Lucky 子规则：{prefix}.nas.{siteRoot}
  // 其它手写域名（如 *.nas 泛解析、pass.xxx 等）批量开通风险高，按行单独开通
  const pending = luckyRules.filter((rule) => {
    const domain = rule.domains[0] || '';
    if (!domain || !domain.endsWith('.nas.' + siteRoot)) return false;
    const prefix = domain.slice(0, -(('.nas.' + siteRoot).length));
    if (!prefix || prefix.includes('.')) return false;
    const accelDomain = `${prefix}.cdn.${siteRoot}`;
    return !domainSet.has(accelDomain) && !targetSet.has(domain);
  });
  if (pending.length === 0) {
    appendLog('开通 ESA', 'ok', '没有待开通的规则');
    return;
  }
  const button = el('existing-enable-all');
  if (button) {
    button.disabled = true;
  }
  appendLog('开通 ESA', 'ok', `批量开通 ${pending.length} 条规则…`);
  let okCount = 0;
  for (const rule of pending) {
    const domain = rule.domains[0];
    const accelDomain = `${domain.split('.')[0]}.cdn.${siteRoot}`;
    try {
      const data = await api.enableDomain(accelDomain, domain);
      appendLog('开通 ESA', 'ok', data.message);
      if (data.created) {
        esaDomains.push({ name: accelDomain, type: 'CNAME', value: domain, proxied: true });
        okCount += 1;
      }
    } catch (error) {
      appendLog('开通 ESA', 'error', `${accelDomain}: ${error.message}`);
    }
  }
  if (button) {
    button.disabled = false;
  }
  renderExistingRules();
  appendLog('开通 ESA', 'ok', `批量完成：新开通 ${okCount} 条`);
}
