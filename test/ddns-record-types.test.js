const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  recordMatches,
  readRecordDetail,
  readRecordContent,
} = require('../server.js');

test('recordMatches 匹配 CNAME', () => {
  const r = {
    SyncRecordData: {
      type: 'CNAME',
      DomainName: 'alanmaster.top',
      SubDomainName: 'agent.cdn',
      CNAMEContent: 'target.esa.com',
      remark: '',
    },
  };
  assert.equal(recordMatches(r, 'agent.cdn', 'alanmaster.top', 'CNAME', 'CNAMEContent', 'target.esa.com'), true);
  assert.equal(recordMatches(r, 'agent.cdn', 'alanmaster.top', 'CNAME', 'CNAMEContent', 'wrong'), false);
});

test('recordMatches 匹配 TXT', () => {
  const r = {
    SyncRecordData: {
      type: 'TXT',
      DomainName: 'alanmaster.top',
      SubDomainName: '_acme-challenge.agent',
      TXTContent: 'token-abc',
      remark: 'ACME',
    },
  };
  assert.equal(recordMatches(r, '_acme-challenge.agent', 'alanmaster.top', 'TXT', 'TXTContent', 'token-abc'), true);
  assert.equal(recordMatches(r, '_acme-challenge.agent', 'alanmaster.top', 'TXT', 'TXTContent', 'wrong'), false);
});

test('recordMatches 类型不同不匹配', () => {
  const r = { SyncRecordData: { type: 'CNAME', DomainName: 'a.com', SubDomainName: 'x', CNAMEContent: 'v' } };
  assert.equal(recordMatches(r, 'x', 'a.com', 'TXT', 'TXTContent', 'v'), false);
});

test('readRecordContent 读 TXT', () => {
  const r = { SyncRecordData: { TXTContent: 'tok' } };
  assert.equal(readRecordContent(r, 'TXTContent'), 'tok');
});

test('readRecordContent 缺 TXTContent 返回空', () => {
  const r = { SyncRecordData: {} };
  assert.equal(readRecordContent(r, 'TXTContent'), '');
});

test('readRecordDetail 识别 TXT', () => {
  const r = { SyncRecordData: { type: 'TXT', DomainName: 'a.com', SubDomainName: '_acme', TXTContent: 'v' } };
  const d = readRecordDetail(r);
  assert.equal(d.type, 'TXT');
  assert.equal(d.domainName, 'a.com');
  assert.equal(d.subDomainName, '_acme');
});