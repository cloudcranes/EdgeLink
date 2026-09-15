// 访问口令（可选）：config.panel.token 非空时，/api/* 除 /api/health 外校验 X-Panel-Token
const { readConfig } = require('../lib/config');

function apiAuth(req, res, next) {
  if (req.path === '/health') {
    next();
    return;
  }
  let config;
  try {
    config = readConfig();
  } catch (error) {
    // 配置损坏时给出 JSON 错误（而非 Express 默认 HTML 500），避免泄露堆栈且前端可读
    res.status(500).json({ ok: false, error: error.message || String(error) });
    return;
  }
  const token = config.panel?.token || '';
  if (!token) {
    next();
    return;
  }
  const provided = req.get('X-Panel-Token') || req.query.token;
  if (provided === token) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: '访问口令无效或未提供' });
}

module.exports = { apiAuth };
