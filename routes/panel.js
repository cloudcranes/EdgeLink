// 面板：访问口令 + 主题切换
const crypto = require('crypto');
const { PANEL_THEMES } = require('../lib/constants');
const { readConfig, writeConfig } = require('../lib/config');
const { asyncHandler } = require('../utils/http');

function register(app) {
  app.post('/api/panel/token', (req, res) => {
    const config = readConfig();
    if (req.body?.clear) {
      config.panel = { ...config.panel, token: '' };
      writeConfig(config);
      res.json({ ok: true, token: '', message: '已关闭访问口令' });
      return;
    }
    const token = crypto.randomBytes(16).toString('base64url');
    config.panel = { ...config.panel, token };
    writeConfig(config);
    res.json({ ok: true, token, message: '已生成新口令，请用新口令重新访问' });
  });

  // 主题切换：6 套主题持久化到 config.panel.theme（白名单见 lib/constants.js）
  app.patch(
    '/api/panel/theme',
    asyncHandler(async (req, res) => {
      const theme = String(req.body?.theme || '').trim();
      if (!PANEL_THEMES.has(theme)) {
        throw new Error(`未知主题: ${theme}（允许：${[...PANEL_THEMES].join('、')}）`);
      }
      const config = readConfig();
      config.panel = { ...config.panel, theme };
      writeConfig(config);
      res.json({ ok: true, theme, message: `已切换到 ${theme}` });
    }),
  );
}

module.exports = { register };
