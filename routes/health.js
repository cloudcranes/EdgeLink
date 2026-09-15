// 应用连通性自检 + 历史健康度
// 说明：nas.* 子域是局域网域名（指向 Lucky 反代），从面板所在环境探测无意义（外网不通/内网恒通），
// 故仅探测 cdn 公网加速域名的可达性。
const { HEALTH_H_MAX_POINTS } = require('../lib/constants');
const { readConfig } = require('../lib/config');
const { probeUrl, cdnProbeUrl, appendHealthHistory, readHealthHistory } = require('../lib/health');
const { asyncHandler } = require('../utils/http');

function register(app) {
  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.get(
    '/api/apps/health',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const apps = (config.apps || []).filter((a) => a.prefix);
      const results = await Promise.all(
        apps.map(async (app) => {
          const url = cdnProbeUrl(app, config);
          const checks = [];
          if (url && app.esaEnabled !== false) {
            checks.push({ label: 'cdn', url, ...(await probeUrl(url)) });
          }
          return { id: app.id, name: app.name || app.prefix, prefix: app.prefix, group: app.group || '', checks };
        }),
      );

      appendHealthHistory(results, new Date().toISOString());
      res.json({ ok: true, results, checkedAt: new Date().toISOString() });
    }),
  );

  app.get(
    '/api/health/history',
    asyncHandler(async (req, res) => {
      const data = readHealthHistory();
      res.json({ ok: true, series: data.series || {}, maxPoints: HEALTH_H_MAX_POINTS });
    }),
  );
}

module.exports = { register };
