// 部署快照：列表 + 恢复
const { listSnapshots, loadSnapshot } = require('../lib/snapshots');
const { defaultConfig, mergeConfig, writeConfig, sanitizeConfig } = require('../lib/config');

function register(app) {
  // 部署快照：列表
  app.get('/api/snapshots', (req, res) => {
    res.json({ ok: true, snapshots: listSnapshots() });
  });

  // 部署快照：恢复
  app.post('/api/snapshots/restore', (req, res) => {
    const file = String(req.body?.file || '');
    if (!file || !file.startsWith('snapshot-') || !file.endsWith('.json') || file.includes('..')) {
      throw new Error('无效的快照文件');
    }
    const data = loadSnapshot(file);
    const restoredConfig = mergeConfig(defaultConfig(), data.config || {});
    writeConfig(restoredConfig);
    res.json({ ok: true, config: sanitizeConfig(restoredConfig), message: `已恢复快照 ${file}` });
  });
}

module.exports = { register };
