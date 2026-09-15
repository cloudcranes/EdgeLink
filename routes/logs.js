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
    req.on('close', () => {
      unsubscribeLogClient(res);
    });
  });
}

module.exports = { register };
