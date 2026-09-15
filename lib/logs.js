// 服务端日志环形缓冲 + SSE 实时广播。
// 依赖：无（仅全局单例状态）
// 模块级单例：serverLogs[] 环形缓冲、logClients Set SSE 订阅集合。

const { SERVER_LOG_LIMIT } = require('./constants');

const serverLogs = [];
const logClients = new Set();

function pushServerLog(step, status = 'ok', detail = '') {
  const entry = { step, status, detail, time: new Date().toISOString() };
  serverLogs.push(entry);
  if (serverLogs.length > SERVER_LOG_LIMIT) {
    serverLogs.splice(0, serverLogs.length - SERVER_LOG_LIMIT);
  }
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of logClients) {
    try {
      client.write(payload);
    } catch {
      logClients.delete(client);
    }
  }
  return entry;
}

function getServerLogs() {
  return serverLogs;
}

function subscribeLogClient(res) {
  logClients.add(res);
}

function unsubscribeLogClient(res) {
  logClients.delete(res);
}

module.exports = {
  pushServerLog,
  getServerLogs,
  subscribeLogClient,
  unsubscribeLogClient,
};
