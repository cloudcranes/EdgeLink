// 访问口令（可选）：config.panel.token 非空时，/api/* 除 /api/health 外校验 X-Panel-Token。
// 只接受 X-Panel-Token 请求头，不再接受 query ?token=（避免日志/Referer 泄漏）。
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
  const provided = req.get('X-Panel-Token');
  if (provided === token) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: '访问口令无效或未提供' });
}

module.exports = { apiAuth };
