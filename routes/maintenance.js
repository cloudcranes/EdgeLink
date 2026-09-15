// 端口冲突预检：列出 Lucky 规则中重复监听端口 + 网关端口占用
const { GATEWAY_RULE_NAME } = require('../lib/constants');
const { readConfig } = require('../lib/config');
const { getLuckyRules } = require('../lib/lucky');
const { asyncHandler } = require('../utils/http');

function register(app) {
  app.get(
    '/api/precheck/ports',
    asyncHandler(async (req, res) => {
      const config = readConfig();
      const { rules } = await getLuckyRules(config);
      const map = new Map();
      for (const rule of rules || []) {
        const key = `${rule.ListenPort || '?'}/${rule.Network || '?'}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(rule.RuleName || '未命名');
      }
      const conflicts = [...map.entries()]
        .filter(([, names]) => names.length > 1)
        .map(([key, names]) => ({ listen: key, rules: [...new Set(names)] }));
      const gatewayPort = Number(config.gateway.listenPort) || 8443;
      const gatewayClash = (rules || [])
        .filter(
          (r) =>
            Number(r.ListenPort) === gatewayPort &&
            r.RuleName !== GATEWAY_RULE_NAME &&
            !(config.gateway.ruleKey && r.RuleKey === config.gateway.ruleKey),
        )
        .map((r) => r.RuleName || '未命名');
      res.json({ ok: true, conflicts, gatewayClash, gatewayPort });
    }),
  );
}

module.exports = { register };
