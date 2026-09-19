// asyncHandler 包装：把 async 路由的异常 throw 交给统一的 error middleware（next(error)）。
// 同步 throw 也走 next(error)，由 server.js 注册的 errorMiddleware 统一格式化。
function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// error middleware：把 error 翻译成 { ok:false, error } + 合法 HTTP status。
// 优先用 error.status（必须是合法 4xx/5xx）；ETIMEDOUT -> 504；其它 -> 500。日志只记一次。
function errorMiddleware(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  const { pushServerLog } = require('../lib/logs');
  const message = (err && err.message) || String(err) || '服务端错误';
  let status;
  if (err && err.code === 'ETIMEDOUT') {
    status = 504;
  } else if (
    err &&
    Number.isInteger(err.status) &&
    err.status >= 400 &&
    err.status < 600
  ) {
    status = err.status;
  } else {
    status = 500;
  }
  console.error(err);
  pushServerLog('服务端', 'error', `${req.method} ${req.originalUrl || req.url || ''} -> ${status} ${message}`);
  res.status(status).json({ ok: false, error: message });
}

module.exports = { asyncHandler, errorMiddleware };
