// 服务端日志：历史 + SSE 实时流（前端用 fetch 流式读取以携带口令头）
const { getServerLogs, subscribeLogClient, unsubscribeLogClient } = require('../lib/logs');

function register(app) {
  app.get('/api/logs', (req, res) => {
    res.json({ ok: true, logs: getServerLogs() });
  });

  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    subscribeLogClient(res);
    // 幂等清理：close 与 error 都触发同一函数；EventEmitter.removeListener 对未注册函数是 no-op。
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      res.removeListener('close', cleanup);
      res.removeListener('error', cleanup);
      req.removeListener('close', cleanup);
      req.removeListener('error', cleanup);
      unsubscribeLogClient(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('close', cleanup);
    req.on('error', cleanup);
  });
}

module.exports = { register };
