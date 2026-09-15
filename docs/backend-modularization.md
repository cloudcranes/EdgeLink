# 后端模块化设计文档（激进档）

> **状态**：待用户确认边界后实施
> **目标**：将 `server.js`（3500+ 行单文件）拆为 `lib/` + `routes/` + `middleware/` 三层结构
> **约束**：
> - 现有 85 个测试全部保持通过
> - `module.exports` 向后兼容（`require('../server.js')` 仍能拿到）
> - 85 测试用 `readFileSync('../server.js')` 做静态分析，不能因为重构破坏正则断言

---

## 1. 现状盘点

### 1.1 server.js 体量
- **文件**：`server.js`，3500+ 行（2026-09-15）
- **代码块**：30+ HTTP 路由 + 30+ 辅助函数 + 2 个 SDK 集成

### 1.2 现有职责区（注释已自然划分）
| 区域 | 行号 | 行数 | 职责 |
|---|---|---|---|
| 启动 + 路径常量 | 1-25 | ~25 | env 变量、路径常量 |
| 配置层 | 43-230 | ~200 | defaultConfig / readConfig / writeConfig / mergeConfig / sanitizeConfig |
| 工具层 | 240-380 | ~140 | normalizeApp/Domain/Target、validate*、cert SAN 解析 |
| Lucky 客户端 | 385-680 | ~310 | luckyLogin / luckyRequest / buildLuckyRule / buildLuckyProxy |
| ESA 客户端 | 670-760 | ~90 | getEsaClient / esaListDomains / esaListOriginRules |
| DDNS 客户端 | 760-1060 | ~300 | getLuckyDdnsTasks / alidns SDK / addDdns* / findEsaDdnsTask |
| 快照 + 健康检查 | 1060-1410 | ~340 | readHealthHistory / probeUrl / saveSnapshot / setAppStatus / scheduleLiveCheck / dohLookup |
| HTTP 路由层 | 1420-3450 | ~2000 | 30+ 路由 handler + 中间件 + asyncHandler |
| 导出 | 3456-3535 | ~80 | module.exports |

### 1.3 共享状态（运行时 / 持久化）
| 名称 | 类型 | 行号 | 当前作用域 | 模块归属（设计） |
|---|---|---|---|---|
| `CONFIG_PATH` | 路径常量 | 23 | 全局 | `lib/config.js` |
| `SNAPSHOT_DIR` | 路径常量 | 1070 | 全局 | `lib/snapshots.js` |
| `HEALTH_HISTORY_FILE` | 路径常量 | 1074 | 全局 | `lib/health.js` |
| `HEALTH_H_MAX_POINTS` | 常量 100 | 1075 | 全局 | `lib/constants.js` |
| `GATEWAY_RULE_NAME` | 常量 | 24 | 全局 | `lib/constants.js` |
| `PROXY_KEY_PREFIX` | 常量 | 25 | 全局 | `lib/constants.js` |
| `ESA_RULE_PREFIX` | 常量 | 26 | 全局 | `lib/constants.js` |
| `DOMAIN_RE` | 正则 | 28 | 全局 | `lib/normalize.js` |
| `SNAPSHOT_LIMIT` | 常量 | 1071 | 全局 | `lib/snapshots.js` |
| `MASK` | 常量 | 27 | 全局 | `lib/config.js` |
| `serverLogs[]` | 环形缓冲 | 1436 | 全局 | `lib/logs.js` |
| `logClients Set` | SSE 订阅 | 1437 | 全局 | `lib/logs.js` |
| `liveCheckState Map` | 运行时 | 2951 | 全局 | `lib/health.js` |
| `LIVE_CHECK_INTERVAL_MS` | 常量 | 2843 | 全局 | `lib/constants.js` |
| `LIVE_CHECK_MAX_ATTEMPTS` | 常量 | 2844 | 全局 | `lib/constants.js` |
| `dohCache Map` | 缓存 | 1840 | 全局 | `lib/health.js` |
| `DOH_CACHE_TTL_MS` | 常量 | 1841 | 全局 | `lib/constants.js` |
| `dohInFlight` | Promise | 1842 | 全局 | `lib/health.js` |
| `HEALTH_H_MAX_POINTS` | 常量 | 1075 | 全局 | `lib/constants.js` |

### 1.4 关键测试断言（不能破坏）
85 测试中，下述断言锁定了 server.js 的内联结构，拆分后必须保证这些字符串仍在 server.js 中（或者把函数保留为 re-export）：
- `destructive-safety.test.js`：
  - `/cleanup-residue/`、`/alidnsListRecords/`、`/alidnsDeleteRecord/`、`/cleanup-residue[\s\S]{0,2500}dryRun/`（锁后端端点 + dryRun）
  - `ddns.js`、`main.js` 中 `cleanupResidue` / `recordDeleteDdns` 的引用
- `backend-offline.test.js`：mock 整个 SDK + 调用 30+ 路由，**这是最重的依赖**
- `app-status.test.js`：`require('../server.js')` 拿到 `normalizeApp` 等导出
- `esa-list-domains-id.test.js`：直接读源码断言

**应对**：所有这些断言锁的函数都需要从 `server.js` 导出（用 `module.exports`），或者在 server.js 中保留一行 `const X = require('./lib/x'); module.exports.X = X` 的 re-export。

---

## 2. 设计目标与原则

### 2.1 目标
- **server.js 缩到 < 250 行**：仅启动 + 中间件 + 路由注册 + listen
- **每个 lib/*.js ≤ 500 行**：单一职责，可独立读懂
- **每个 routes/*.js ≤ 150 行**：一个业务域一个文件
- **测试 100% 通过**：85 测试 + 重启服务验证

### 2.2 原则
1. **依赖单向**：高层依赖低层，不允许反向
2. **共享状态集中**：跨模块的运行时状态必须挂在归属模块，不在 server.js
3. **业务函数签名接 config 参数**：避免全局 config 引用（已经是这个风格，保留）
4. **路由只做 HTTP 胶水**：业务调用下沉到 lib/，routes/*.js 只做 `req.body → 校验 → 调 lib → res.json`
5. **错误处理统一**：保留 `asyncHandler` 包装，handler 抛错即 500 + JSON

---

## 3. 目录结构

```
server.js                       < 250 行：env + lib 初始化 + 路由注册 + listen
lib/
  constants.js                  跨模块常量（GATEWAY_RULE_NAME / DOH_CACHE_TTL_MS / LIVE_CHECK_* 等）
  normalize.js                  normalizeApp / normalizeDomain / normalizeTarget / DOMAIN_RE / validate*
  config.js                     defaultConfig / readConfig / writeConfig / mergeConfig / sanitizeConfig + MASK + CONFIG_PATH
  logs.js                       serverLogs + logClients + pushServerLog / pushLogToClients / getServerLogs
  snapshots.js                  SNAPSHOT_DIR / SNAPSHOT_LIMIT / saveSnapshot / listSnapshots / loadSnapshot
  lucky.js                      LUCKY_* + luckyLogin / luckyRequest / getLuckyRules / buildLuckyRule / buildLuckyProxy
  esa.js                        getEsaClient / esaListDomains / esaListOriginRules + ESA SDK 封装
  ddns.js                       LUCKY DDNS: getLuckyDdnsTasks / findEsaDdnsTask / findDdnsTaskByType / addDdnsCnameRecord / addDdnsAaaaRecord / addDdnsRecord / deleteDdnsRecords / recordMatches / readRecordDetail / recordMatchesCname / hasNasDdnsRecords / generateRecordKey
  alidns.js                     直连 alidns（旁路）：getAlidnsClient / alidnsListRecords / alidnsDeleteRecord
  health.js                     readHealthHistory / writeHealthHistory / appendHealthHistory / HEALTH_H_MAX_POINTS + setAppStatus / scheduleLiveCheck / probeUrl + dohLookup / dohCache / dohInFlight + LIVE_CHECK_*（来自 constants.js）
  deploy.js                     applyLucky / enableEsaDomain / disableEsaDomain / createNasDdnsTask / validateDeployConfig / validateLuckySelfReference / runAppHealth（聚合 health 路由）
routes/
  config.js                     /api/config GET/POST/export/import
  panel.js                      /api/panel/token POST + /api/panel/theme PATCH
  snapshots.js                  /api/snapshots GET + restore POST
  lucky.js                      /api/lucky/{test,test-via-config,sl-test,ssl,nas-check,ports,nets}
  esa.js                        /api/esa/{sites,rules,certificates,enable-domain,record,rule}
  ddns.js                       /api/lucky/ddns/{tasks,nas-task,txt,pending,record-delete,cleanup-residue}
  apps.js                       /api/apps (POST + GET by id) + PATCH + DELETE
  health.js                     /api/apps/health GET + /api/health/history GET
  summary.js                    /api/summary GET
  status.js                     /api/status GET
  audit.js                      /api/audit GET + /api/audit/fix POST
  maintenance.js                /api/precheck/ports + /api/precheck/audit
  logs.js                       /api/logs GET + /api/logs/stream SSE
middleware/
  auth.js                       /api/* 访问口令校验
  errors.js                     全局错误兜底（暂留空，asyncHandler 已够用）
utils/
  http.js                       asyncHandler 包装（独立于 express）
```

### 3.1 路由文件实际清单（来自 server.js 当前路由）
| 文件 | 路由 | 大致行数 |
|---|---|---|
| `routes/config.js` | `GET/POST /api/config` + `GET /api/config/export` + `POST /api/config/import` | ~50 |
| `routes/panel.js` | `POST /api/panel/token` + `PATCH /api/panel/theme` + `GET /api/panel/token/status`（待发现） | ~40 |
| `routes/snapshots.js` | `GET /api/snapshots` + `POST /api/snapshots/restore` | ~30 |
| `routes/lucky.js` | `POST /api/lucky/test` + `GET /api/lucky/rules` + `POST /api/lucky/ssl` + `POST /api/lucky/nas-check` + `GET /api/precheck/ports` + `POST /api/lucky/ddns/nas-task` | ~120 |
| `routes/esa.js` | `GET /api/esa/sites` + `GET /api/esa/rules` + `GET /api/esa/certificates` + `POST /api/esa/enable-domain` + `PATCH/DELETE /api/esa/record/:recordId` + `PATCH /api/esa/rule` | ~150 |
| `routes/ddns.js` | `GET /api/lucky/ddns/tasks` + `POST /api/lucky/ddns/txt` + `POST /api/lucky/ddns/nas-task` + `GET /api/lucky/ddns/pending` + `POST /api/lucky/ddns/record-delete` + `POST /api/lucky/ddns/cleanup-residue` | ~150 |
| `routes/apps.js` | `POST /api/apps` + `GET /api/apps/:id` + `PATCH /api/apps/:id` + `DELETE /api/apps/:id` + `POST /api/deploy` + `POST /api/apps/replace` | ~250 |
| `routes/health.js` | `GET /api/apps/health` + `GET /api/health/history` | ~40 |
| `routes/summary.js` | `GET /api/summary` | ~30 |
| `routes/status.js` | `GET /api/status` | ~30 |
| `routes/audit.js` | `GET /api/audit` + `POST /api/audit/fix` | ~120 |
| `routes/maintenance.js` | `GET /api/precheck/ports`（迁移自 lucky.js）+ 巡检相关 | 视具体合并情况 |
| `routes/logs.js` | `GET /api/logs` + `GET /api/logs/stream` | ~30 |

---

## 4. 依赖图

```
┌─────────────────────────────────────────────────────────────┐
│                       server.js (启动)                       │
│                  register routes/* (顺序)                     │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│                        routes/* (HTTP 胶水)                   │
│   apps / lucky / esa / ddns / panel / config / summary ...   │
└─────────────────────────────────────────────────────────────┘
            ↓                  ↓                  ↓
┌────────────────────┐ ┌────────────────────┐ ┌────────────────┐
│   lib/lucky.js      │ │   lib/esa.js       │ │  lib/ddns.js   │
│   (Lucky 客户端)    │ │   (ESA 客户端)     │ │  (DDNS 逻辑)   │
└────────────────────┘ └────────────────────┘ └────────────────┘
                          ↓                     ↓
                  ┌─────────────────────────────────┐
                  │      lib/deploy.js              │ ← 聚合多模块
                  │  applyLucky / enableEsaDomain   │
                  └─────────────────────────────────┘
                          ↓
                  ┌─────────────────────────────────┐
                  │  lib/{config, normalize,        │
                  │    health, snapshots, logs,     │
                  │    constants, alidns}.js       │ ← 基础层
                  └─────────────────────────────────┘
                          ↓
                  ┌─────────────────────────────────┐
                  │   middleware/auth.js            │
                  │   utils/http.js (asyncHandler) │
                  └─────────────────────────────────┘
                          ↓
                  ┌─────────────────────────────────┐
                  │  express + fs + SDK             │
                  └─────────────────────────────────┘
```

**关键：不允许反向依赖**
- `lib/constants.js`、`lib/normalize.js`、`lib/config.js` 是叶子节点，不依赖任何其他 lib/
- `lib/lucky.js` 只依赖 `lib/config.js`（+ fs + fetch + crypto）
- `lib/esa.js` 只依赖 `lib/config.js`（+ SDK + fs）
- `lib/ddns.js` 依赖 `lib/lucky.js` + `lib/config.js` + `lib/normalize.js`
- `lib/alidns.js` 依赖 `lib/config.js`
- `lib/health.js` 依赖 `lib/lucky.js` + `lib/esa.js` + `lib/config.js` + `lib/logs.js` + `lib/snapshots.js`
- `lib/deploy.js` 依赖 `lib/lucky.js` + `lib/esa.js` + `lib/ddns.js` + `lib/config.js` + `lib/logs.js` + `lib/snapshots.js`
- `lib/snapshots.js` 依赖 `lib/config.js`
- `lib/logs.js` 无依赖（仅 fs + 全局 serverLogs）

**无循环**：`deploy → ddns → lucky`、`health → lucky/esa`，没有反向。

---

## 5. 关键设计决策

### 5.1 共享状态归属
所有运行时状态在 lib 内部 `const X = ...` 模块级单例，跨进程自动隔离。

### 5.2 业务函数签名（保持现有风格）
- 接 config 参数：`enableEsaDomain(config, domain, target, remark)`
- 业务异常用 `throw new Error(msg)`，asyncHandler 自动包 500
- 不引入 class，保持 plain function

### 5.3 路由注册机制
```js
// lib/route-helpers.js（新增工具）
function register(app, method, path, ...handlers) {
  app[method](path, asyncHandler(handlers[handlers.length - 1]));
}

// routes/lucky.js  示例
const { getLuckyRules } = require('../lib/lucky');
const { readConfig } = require('../lib/config');

function register(app) {
  app.get('/api/lucky/rules', asyncHandler(async (req, res) => {
    const config = readConfig();
    const { rules } = await getLuckyRules(config);
    res.json({ ok: true, rules });
  }));

  app.post('/api/lucky/test', asyncHandler(async (req, res) => {
    const config = mergeConfig(readConfig(), req.body || {});
    await luckyLogin(config);
    res.json({ ok: true });
  }));
}

module.exports = { register };
```

```js
// server.js
function registerRoutes(app) {
  for (const mod of [
    './routes/config', './routes/panel', './routes/snapshots',
    './routes/lucky',  './routes/esa',    './routes/ddns',
    './routes/apps',   './routes/health', './routes/summary',
    './routes/status', './routes/audit',  './routes/maintenance',
    './routes/logs',
  ]) {
    require(mod).register(app);
  }
}
```

### 5.4 中间件
- `middleware/auth.js`：当前 `/api/*` 的访问口令校验。导出 `attachTo(app)` 或 `apiAuth(req, res, next)`
- `utils/http.js`：`asyncHandler(fn)`（现状保留，从 express 独立出来便于测试）

### 5.5 持久化边界
| 资源 | 路径 | 持久化函数 | 模块 |
|---|---|---|---|
| 主配置 | `config.json` | read/write/merge | `lib/config.js` |
| 配置备份 | `config.json.corrupt-*.bak`、`config.json.backup-*.json` | write | `lib/config.js` |
| 配置快照 | `snapshots/snapshot-*.json` | save/list/load | `lib/snapshots.js` |
| 健康历史 | `data/health-history.json` | read/write/append | `lib/health.js` |
| 临时 tmp | `config.json.tmp-*` | write（原子写） | `lib/config.js` |

---

## 6. 测试兼容策略

### 6.1 关键问题
85 个测试中有：
1. **4 个测试 `require('../server.js')`**：`app-status.test.js` 等 — 需要 server.js 仍导出 `normalizeApp` 等
2. **多个测试 `readFileSync('../server.js')` 静态分析**：`destructive-safety.test.js`、`esa-list-domains-id.test.js`、`esa-patch-record.test.js`、`backend-offline.test.js` 等
3. **`backend-offline.test.js` 是最重的**：mock SDK + 调用 30+ 路由端到端，HTTP 级别

### 6.2 应对：保留 server.js 的 re-export 桩

```js
// server.js（简化版示意）
const config = require('./lib/config');
const lucky = require('./lib/lucky');
// ... 所有 lib

const express = require('express');
const path = require('path');
const app = express();

// 中间件
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/lucide/dist/umd')));
app.use('/api', require('./middleware/auth').apiAuth);  // 访问口令

// 注册路由
require('./routes/config').register(app);
require('./routes/lucky').register(app);
// ...

// 启动
if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  app.listen(port, '0.0.0.0', () => console.log(`EdgeLink panel listening on http://0.0.0.0:${port}`));
}

// 向后兼容：原 server.js 的 module.exports 全部保留
module.exports = {
  defaultConfig: config.defaultConfig,
  mergeConfig: config.mergeConfig,
  sanitizeConfig: config.sanitizeConfig,
  normalizeApp: config.normalizeApp,
  normalizeDomain: config.normalizeDomain,
  // ... 等所有原导出
};
```

这样：
- `require('../server.js')` 仍能拿到原导出 ✅
- `readFileSync('../server.js')` 看到的源码大幅缩水，但关键字符串（`/api/lucky/ddns/record-delete`、`dryRun`、`alidnsListRecords` 等）仍存在（因为路由文件用了相同字符串，server.js 可能不直接有这些字符串 → **风险点**）

### 6.3 风险点：测试正则断言可能失效
`backend-offline.test.js` 用 `readFileSync('../server.js')` 断言某些函数名存在于 server.js。拆分后这些函数在 `lib/*.js`，不在 server.js。

**应对**：
- **方案 A（推荐）**：修改测试用 `readFileSync('../lib/X.js')` 替代。1-2 处测试改动，工作量小
- **方案 B**：server.js 保留一行 `// @deprecated: see lib/lucky` 之类的注释 + 实际函数定义。但这违背拆分目的

**实施时确认**：实际读 4 个 server-requires 测试 + 检查 readFileSync 断言，决定方案 A/B

### 6.4 兼容性测试步骤
1. 每步重构后跑 `node --test test/*.test.js`，必须全绿
2. 重启服务（pwsh job）后 `curl /api/health` 200
3. 实际功能抽测：`/api/config`、`/api/lucky/rules`、`/api/esa/rules` 等 5 个核心路由

---

## 7. 实施步骤（10 步）

每步完成后跑 85 测试确认绿，否则回滚该步。

### Step 1: 创建 `lib/constants.js` + `lib/normalize.js`（叶子节点）
- 提取 `DOMAIN_RE`、`MASK`、所有常量
- 提取 `normalizeApp`、`normalizeDomain`、`normalizeTarget`、`normalizeBaseUrl`、`normalizeApiPrefix`
- 提取 `validateLuckySelfReference`、`assertDomain`、`certificateCoversDomain`
- **不导出现在 server.js 的任何函数**，避免重复。改为 server.js 删原定义，从 lib require
- 测试：85 全绿

### Step 2: 创建 `lib/config.js`
- 提取 `defaultConfig`、`readConfig`、`writeConfig`、`mergeConfig`、`sanitizeConfig`
- `CONFIG_PATH` 在此模块内（env override）
- server.js 改为 `const { readConfig } = require('./lib/config');`
- 测试：85 全绿

### Step 3: 创建 `lib/logs.js` + `lib/snapshots.js`
- `logs.js`：导出 `pushServerLog`、`pushLogToClients`、`getServerLogs`、`subscribeLogClient`（订阅 SSE）
- `snapshots.js`：导出 `saveSnapshot`、`listSnapshots`、`loadSnapshot`
- server.js 删原 `serverLogs[]` 等，改为 require
- 测试：85 全绿

### Step 4: 创建 `lib/lucky.js` + `lib/esa.js` + `lib/alidns.js`
- 三个独立 SDK 封装模块，互相不依赖
- 每个导出对应的 client 函数
- 测试：85 全绿

### Step 5: 创建 `lib/ddns.js`
- 提取 `getLuckyDdnsTasks` + `findEsaDdnsTask` + `findDdnsTaskByType` + `addDdns*` + `deleteDdnsRecords` + `recordMatches` + `readRecordDetail` + `hasNasDdnsRecords`
- 依赖 `lib/lucky.js`、`lib/esa.js`（间接）
- 测试：85 全绿

### Step 6: 创建 `lib/health.js`
- 提取 health history 持久化 + DoH 缓存 + setAppStatus + scheduleLiveCheck + probeUrl
- 依赖 `lib/lucky.js`、`lib/esa.js`、`lib/logs.js`、`lib/snapshots.js`、`lib/config.js`
- 测试：85 全绿

### Step 7: 创建 `lib/deploy.js`
- 提取 `applyLucky`、`enableEsaDomain`、`disableEsaDomain`、`validateDeployConfig`、`createNasDdnsTask`、`runAppHealth`
- 依赖 `lib/lucky.js`、`lib/esa.js`、`lib/ddns.js`、`lib/health.js`、`lib/config.js`、`lib/logs.js`、`lib/snapshots.js`、`lib/normalize.js`
- 测试：85 全绿

### Step 8: 创建 `middleware/auth.js`
- 提取当前 `/api/*` 访问口令校验中间件
- server.js 改为 `app.use('/api', require('./middleware/auth').apiAuth)`
- 测试：85 全绿

### Step 9: 创建 12 个 `routes/*.js`
- 拆分所有 30+ 路由到对应文件
- 每个 `register(app)` 函数
- server.js `require('./routes/X').register(app)`
- 测试：85 全绿

### Step 10: 精简 `server.js` + 重导出
- 收缩到 < 250 行
- 加 `module.exports` 重导出所有原函数（向后兼容）
- 测试：85 全绿

### 实施总时长
- 每步 ~15-25 分钟
- 10 步共 ~3-4 小时
- 测试 + 调试 ~30 分钟
- **总计 4-5 小时**

---

## 8. 验收清单

### 8.1 文件级
- [ ] `lib/constants.js`、`lib/normalize.js`、`lib/config.js`、`lib/logs.js`、`lib/snapshots.js`、`lib/lucky.js`、`lib/esa.js`、`lib/alidns.js`、`lib/ddns.js`、`lib/health.js`、`lib/deploy.js` 共 11 个文件存在
- [ ] `middleware/auth.js` 存在
- [ ] `routes/*.js` 12 个文件存在
- [ ] `server.js` ≤ 250 行（实际目标 < 200）
- [ ] 无循环依赖（通过 `node --check` 加载验证）

### 8.2 测试
- [ ] `node --test test/*.test.js` 全部通过（85/85）
- [ ] `node --check server.js`、`node --check lib/*.js`、`node --check routes/*.js` 无语法错
- [ ] 重启服务后 `/api/health` 200

### 8.3 运行时
- [ ] 启动服务后能加载真实配置
- [ ] 5 个核心路由（config / lucky/rules / esa/rules / apps / summary）抽测通过
- [ ] 主题切换、日志 SSE、健康检查、审计功能正常

### 8.4 Git
- [ ] 一次提交（或多次小提交，每步一提交便于回滚）
- [ ] 提交信息："refactor: split server.js into lib/ + routes/ + middleware/ modules"

---

## 9. 风险登记表

| # | 风险 | 影响 | 概率 | 缓解 |
|---|---|---|---|---|
| 1 | 循环依赖 | 启动失败 | 低（已设计单向） | node --check + 启动验证 |
| 2 | server.js 静态断言失效 | 测试失败 | **高** | 实施前先 grep 所有 readFileSync 断言，必要时改测试路径（方案 A） |
| 3 | 共享状态丢失 | 运行时行为变 | 低 | 模块级 const 单例 + 每步功能验证 |
| 4 | deploy/health 互调复杂度 | 代码混乱 | 中 | 显式参数传递，不通过模块顶层 require |
| 5 | alidns 是否独立 | 设计不清晰 | 低 | 直连 alidns 与 Lucky DDNS 语义不同，独立 |
| 6 | 长路由文件（apps 250 行）| 可读性 | 中 | 接受（路由胶水不算复杂） |
| 7 | 移动端/前端无影响 | 0 | 0 | server.js 是纯 API，前端无关 |
| 8 | 现有测试要求修改 | 工作量 +1h | 中 | 1-2 个 readFileSync 断言调整 |

---

## 10. 后续可选优化（不在本次范围）

- 加 `middleware/errors.js` 统一错误日志（暂留空）
- 加 `lib/cache.js` 抽象 ddoCache 模式（避免 health.js 与未来模块各自实现缓存）
- 加 `lib/auth.js` 集中所有凭证校验
- 加 `scripts/check-circular-deps.js`（CI 防回归）
- 加 `lib/route-helpers.js` 抽取 register 路由模板

---

## 附录 A：常量清单（从 server.js 提取）

```js
// lib/constants.js
const CONFIG_PATH_DEFAULT = path.join(__dirname, '..', 'config.json');

const GATEWAY_RULE_NAME = 'lucky-esa-gateway';
const PROXY_KEY_PREFIX = 'lucky-esa-';
const ESA_RULE_PREFIX = 'lucky-esa-';
const MASK = '********';
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

const SNAPSHOT_LIMIT = 10;
const HEALTH_H_MAX_POINTS = 100;
const DOH_CACHE_TTL_MS = 60_000;
const LIVE_CHECK_INTERVAL_MS = 10_000;
const LIVE_CHECK_MAX_ATTEMPTS = 30;

const PANEL_THEMES = new Set([
  'neon', 'aurora', 'brutal-sun', 'brutal-ocean', 'brutal-berry', 'terminal'
]);

module.exports = {
  CONFIG_PATH_DEFAULT, GATEWAY_RULE_NAME, PROXY_KEY_PREFIX, ESA_RULE_PREFIX,
  MASK, DOMAIN_RE, SNAPSHOT_LIMIT, HEALTH_H_MAX_POINTS, DOH_CACHE_TTL_MS,
  LIVE_CHECK_INTERVAL_MS, LIVE_CHECK_MAX_ATTEMPTS, PANEL_THEMES,
};
```

## 附录 B：lib/config.js 公开 API

```js
// 公开 API
function defaultConfig()           // → object
function readConfig()              // → object (throws on corrupt)
function writeConfig(config)       // → void (atomic write)
function mergeConfig(existing, incoming)  // → object
function sanitizeConfig(config)   // → object (mask secrets)

// 内部
const CONFIG_PATH = process.env.LUCKY_ESA_CONFIG_PATH
  ? path.resolve(process.env.LUCKY_ESA_CONFIG_PATH)
  : path.join(__dirname, '..', 'config.json');
```

## 附录 C：server.js 终态（目标）

```js
// 约 200 行
const path = require('path');
const express = require('express');

const config = require('./lib/config');
const logs = require('./lib/logs');
const auth = require('./middleware/auth');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules/lucide/dist/umd')));
app.use('/api', auth.apiAuth);

// 注册路由
const routes = [
  'config', 'panel', 'snapshots', 'lucky', 'esa', 'ddns',
  'apps', 'health', 'summary', 'status', 'audit', 'maintenance', 'logs',
];
for (const name of routes) {
  require(`./routes/${name}`).register(app);
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`EdgeLink panel listening on http://${host}:${port}`);
  });
}

// 向后兼容：原 server.js 的 module.exports 全部保留
module.exports = {
  defaultConfig: config.defaultConfig,
  mergeConfig: config.mergeConfig,
  sanitizeConfig: config.sanitizeConfig,
  normalizeApp: require('./lib/normalize').normalizeApp,
  normalizeDomain: require('./lib/normalize').normalizeDomain,
  // ... 等
};
```

---

## 附录 D：待用户确认的边界问题

下面这些问题需要在动手前明确答案，避免来回返工：

1. **`docs/` 目录**：设计文档放 `docs/` 还是 `docs-ref/`（后者已被 .gitignore 排除）？
   - 建议 `docs/`（被 Git 追踪）

2. **`utils/` 目录**：放 `utils/http.js`（asyncHandler）还是直接放 `lib/http.js`？
   - 建议 `utils/`（明显是工具层）

3. **路由文件命名**：按"业务域"（apps/lucky/esa/ddns）还是按"HTTP 路径前缀"（api-apps.js、api-lucky.js）？
   - 建议"业务域"——读 routes/ 目录名就知道有哪些业务

4. **测试兼容性**：发现测试 `readFileSync('../server.js')` 断言失效时，改测试 vs 改 server.js？
   - 建议改测试（保持 server.js 干净）。预计 1-3 处测试调整

5. **`module.exports` 重导出范围**：保留所有原导出函数，还是只保留测试实际使用的？
   - 建议"测试实际使用的 + 外部脚本可能用的"（保守）。可在实施时扫一遍 `grep -r 'require.*server\.js'`

6. **ddns.js 的 `Lucky DDNS 任务` UI 路由归属**：`/api/lucky/ddns/*` 路径前缀 `lucky`，但语义是"DDNS 管理"。放 `routes/lucky.js` 还是 `routes/ddns.js`？
   - 建议按 URL 前缀 `lucky` 放（路径是 `/api/lucky/ddns/*`）
   - 但业务分组可以放 `routes/ddns.js` 内部按子段
   - 最终建议：放 `routes/ddns.js`（业务 DDNS 全在这里），URL 路径 `/api/lucky/ddns/*` 保留（Gitea 兼容性 + Lucky 命名习惯）

---

确认这些边界后，我就开始按 10 步实施。
