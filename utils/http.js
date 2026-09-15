// asyncHandler 包装：把 async 路由的异常统一转 JSON 500 + 服务端日志（独立于 express）
const { pushServerLog } = require('../lib/logs');

function asyncHandler(handler) {
  return (req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      console.error(error);
      pushServerLog('服务端', 'error', error.message || String(error));
      res.status(500).json({ ok: false, error: error.message || String(error) });
    });
  };
}

module.exports = { asyncHandler };
