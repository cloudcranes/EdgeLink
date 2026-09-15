// 面板配置：读 / 存 / 导出 / 导入
const { readConfig, writeConfig, mergeConfig, sanitizeConfig, defaultConfig } = require('../lib/config');
const { pushServerLog } = require('../lib/logs');

function register(app) {
  app.get('/api/config', (req, res) => {
    res.json({ ok: true, config: sanitizeConfig(readConfig()) });
  });

  app.post('/api/config', (req, res) => {
    const config = mergeConfig(readConfig(), req.body.config || req.body);
    writeConfig(config);
    pushServerLog('保存配置', 'ok', '配置已保存');
    res.json({ ok: true, config: sanitizeConfig(config) });
  });

  // 配置导出：完整配置（含凭据，便于换机/备份迁移）
  app.get('/api/config/export', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="edgelink-config.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(readConfig(), null, 2));
  });

  // 配置导入：整体覆盖保存
  app.post('/api/config/import', (req, res) => {
    const incoming = req.body?.config || req.body;
    if (!incoming || typeof incoming !== 'object') {
      throw new Error('导入内容无效');
    }
    const config = mergeConfig(defaultConfig(), incoming);
    writeConfig(config);
    res.json({ ok: true, config: sanitizeConfig(config), message: '配置已导入' });
  });
}

module.exports = { register };
