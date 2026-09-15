// 运行时状态：Lucky / ESA / 网关端口
const net = require('net');
const { GATEWAY_RULE_NAME, ESA_RULE_PREFIX } = require('../lib/constants');
const { readConfig } = require('../lib/config');
const { getLuckyRules, isManagedProxyKey } = require('../lib/lucky');
const { getEsaClient, esaListOriginRules, esaErrorMessage } = require('../lib/esa');
const { asyncHandler } = require('../utils/http');

function checkGatewayPort(config) {
  const port = Number(config.gateway.listenPort) || 8443;
  const listenIp = config.gateway.listenIp || '::';
  const hosts = listenIp === '::' ? ['::1', '127.0.0.1'] : listenIp === '0.0.0.0' ? ['127.0.0.1'] : [listenIp];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let index = 0;
    const tryNext = () => {
      if (index >= hosts.length) {
        finish({ listening: false, error: '无法连接本地回源端口' });
        return;
      }
      const socket = net.createConnection({ host: hosts[index], port }, () => {
        socket.destroy();
        finish({ listening: true });
      });
      socket.once('error', () => {
        socket.destroy();
        index += 1;
        tryNext();
      });
      socket.setTimeout(1200, () => {
        socket.destroy();
        index += 1;
        tryNext();
      });
    };
    tryNext();
  });
}

async function getRuntimeStatus(config) {
  const result = {
    lucky: { configured: false, ok: false, gatewayRule: false, managedProxies: 0 },
    esa: { configured: false, ok: false, managedRules: 0 },
    gateway: { listening: false, error: '' },
  };

  if (config.lucky.baseUrl && (config.lucky.openToken || (config.lucky.account && config.lucky.password))) {
    result.lucky.configured = true;
    try {
      const { rules } = await getLuckyRules(config);
      result.lucky.ok = true;
      const gateway = rules.find(
        (rule) =>
          rule.RuleName === GATEWAY_RULE_NAME ||
          Number(rule.ListenPort) === (Number(config.gateway.listenPort) || 8443),
      );
      result.lucky.gatewayRule = !!gateway;
      result.lucky.managedProxies = gateway
        ? gateway.ProxyList.filter((proxy) => isManagedProxyKey(proxy.Key)).length
        : 0;
    } catch (error) {
      result.lucky.error = error.message;
    }
  } else {
    result.lucky.error = '未配置';
  }

  if (config.esa.accessKeyId && config.esa.accessKeySecret && config.esa.siteId) {
    result.esa.configured = true;
    try {
      const client = getEsaClient(config.esa);
      const rules = await esaListOriginRules(client, config.esa.siteId);
      result.esa.ok = true;
      result.esa.managedRules = rules.filter((rule) =>
        String(rule.ruleName || '').startsWith(ESA_RULE_PREFIX),
      ).length;
    } catch (error) {
      result.esa.error = esaErrorMessage(error);
    }
  } else {
    result.esa.error = config.esa.siteId ? '未配置' : '未选择站点';
  }

  const portCheck = await checkGatewayPort(config);
  result.gateway = { ...result.gateway, ...portCheck };
  return result;
}

function register(app) {
  app.get(
    '/api/status',
    asyncHandler(async (req, res) => {
      const status = await getRuntimeStatus(readConfig());
      res.json({ ok: true, status });
    }),
  );
}

module.exports = { register };
