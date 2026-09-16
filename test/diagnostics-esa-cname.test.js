// 锁定 diagnostics 路由的状态判定逻辑（与 routes/diagnostics.js 同步演进）
const test = require('node:test');
const assert = require('node:assert');

// 复刻 routes/diagnostics.js 的状态判定（保持一致；如路由逻辑变则同步更新本测试）
function classify({ esaRec, cnameTarget, dnsRec, dnsValue }) {
  if (!esaRec) return { status: 'esa-missing', fixable: true, message: 'ESA 加速域名未创建' };
  if (!cnameTarget) return { status: 'esa-no-cname', fixable: false, message: 'ESA 记录缺少接入 CNAME' };
  if (!dnsRec) return { status: 'cname-missing', fixable: true, message: `alidns 无 CNAME 解析（应指向 ${cnameTarget}）` };
  if (dnsValue && dnsValue !== cnameTarget.toLowerCase()) {
    return { status: 'cname-mismatch', fixable: true, message: `alidns CNAME 指向错误：${dnsValue}` };
  }
  return { status: 'ok', fixable: false, message: 'ESA 加速域名 + alidns CNAME 一致' };
}

test('ESA 记录不存在 → esa-missing + fixable', () => {
  const r = classify({ esaRec: null, cnameTarget: '', dnsRec: null, dnsValue: '' });
  assert.equal(r.status, 'esa-missing');
  assert.equal(r.fixable, true);
});

test('ESA 存在但无 recordCname → esa-no-cname + 不可自愈', () => {
  const r = classify({ esaRec: { name: 'mp.cdn.alanmaster.top' }, cnameTarget: '', dnsRec: null, dnsValue: '' });
  assert.equal(r.status, 'esa-no-cname');
  assert.equal(r.fixable, false);
});

test('ESA 存在 + alidns 无 CNAME → cname-missing + fixable', () => {
  const r = classify({
    esaRec: { name: 'mp.cdn.alanmaster.top', recordCname: 'mp.cdn.alanmaster.top.a1.inittt.com' },
    cnameTarget: 'mp.cdn.alanmaster.top.a1.inittt.com',
    dnsRec: null,
    dnsValue: '',
  });
  assert.equal(r.status, 'cname-missing');
  assert.equal(r.fixable, true);
});

test('alidns CNAME 指向错误目标 → cname-mismatch + fixable', () => {
  const r = classify({
    esaRec: { name: 'mp.cdn.alanmaster.top', recordCname: 'mp.cdn.alanmaster.top.a1.inittt.com' },
    cnameTarget: 'mp.cdn.alanmaster.top.a1.inittt.com',
    dnsRec: { type: 'CNAME', value: 'wrong.example.com' },
    dnsValue: 'wrong.example.com',
  });
  assert.equal(r.status, 'cname-mismatch');
  assert.equal(r.fixable, true);
});

test('ESA + alidns CNAME 一致 → ok', () => {
  const r = classify({
    esaRec: { name: 'mp.cdn.alanmaster.top', recordCname: 'mp.cdn.alanmaster.top.a1.inittt.com' },
    cnameTarget: 'mp.cdn.alanmaster.top.a1.inittt.com',
    dnsRec: { type: 'CNAME', value: 'mp.cdn.alanmaster.top.a1.inittt.com' },
    dnsValue: 'mp.cdn.alanmaster.top.a1.inittt.com',
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.fixable, false);
});
