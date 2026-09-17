# EdgeLink

本地面板，把「Lucky 反向代理」和「阿里云 ESA 加速」配好，实现域名免端口访问。

## 它做什么

把内网服务（如 `192.168.1.5:8080`）通过 Lucky 反代，对外暴露成 `https://app.nas.example.top`；再通过阿里云 ESA 给该域名加 CDN 加速，最终用户走 `https://app.cdn.example.top` 访问，无需记忆端口、不暴露内网 IP。

## 数据流

```
浏览器 → https://app.cdn.example.top
        → ESA 边缘节点（CNAME 解析）
        → 回源 follow：https:8443 TLS / http:8000 明文
        → Lucky 网关（按 Host 路由子规则）
        → 192.168.1.5:8080 内网服务
```

- **加速域名**：`*.cdn.example.top` 在阿里云 DNS 配 CNAME → ESA 节点（`*.cdn.example.top.a1.inittt.com`）
- **回源域名**：`*.nas.example.top` 由 Lucky DDNS 自动写 AAAA 到本机公网 IPv6
- **回源**：ESA 规则 `follow`——https 走 Lucky 8443（TLS），http 走 8000（明文）

## 功能

- **概览**：系统健康度（应用就绪率 / Lucky / ESA / 证书 / CDN 可达）+ 性能趋势折线图（1h/24h/7d）+ ESA CNAME 自愈诊断（一键修复）
- **应用管理**：2×4 应用卡 + 侧边抽屉详情；外网域名 ↔ 内网服务映射；单应用重试 / 菜单；连通自检；现存规则面板（手动 Lucky 子规则 + ESA 加速域名）
- **DDNS**：Lucky 任务管理（白名单 ipv6/esa）+ 单条记录删除（dryRun 预览）
- **设置**：Lucky（OpenToken / 账号密码 / 安全入口）、ESA（AccessKey / 站点）、回源网关（监听 / 端口 / 回源协议 / TLS / 超时）、面板访问口令、快照与一致性巡检
- **日志**：服务端 + 客户端执行日志

## 环境要求

- Node.js 18+
- Lucky 后台（v2.27+ 或 v3）
- 阿里云 ESA 站点（已备案域名 + ESA 接入完成）
- 加速域名所在的权威 DNS 在阿里云 DNS（alidns）——「开通 ESA」自动写 CNAME 依赖它

## 启动

```bash
npm install
npm start
```

默认地址：<http://127.0.0.1:8787>，监听 `0.0.0.0`。

⚠️ **面板无登录鉴权**：默认开放，限可信网络使用。建议在「设置 → 面板访问」生成访问口令。凭据存于 `config.json`（已 `.gitignore`），API 返回时密码 / AccessKey / OpenToken 以 `********` 掩码。

## Lucky / ESA 凭据

- **Lucky**：优先 OpenToken（后台「设置 - 安全」生成，请求头 `OpenToken: <token>`），无则账号密码
- **ESA**：AccessKey（建议 `AliyunESAFullAccess`），首次进入面板后选站点
- **alidns**：用于「开通 ESA」自动写 CNAME，优先从 Lucky DDNS 任务（`alidns` provider）取 ID/Secret，回退到 ESA AccessKey

## 测试

```bash
npm test
```

90 个测试覆盖核心业务逻辑（部署配置、证书 SAN 校验、ESA 记录编辑 dryRun、DDNS 记录删除、自愈诊断状态机等）。

## 项目结构

```
server.js                  Express 入口
routes/                    业务路由（apps/lucky/esa/ddns/diagnostics/...）
lib/                       工具层（lucky/esa/alidns/deploy/health/normalize/...）
public/                    静态前端（HTML/CSS/JS ESM）
test/                      node:test 测试
```

## 安全模型

- 不硬编码任何凭据
- 阿里云 SDK 调用走参数化请求，无 SQL / 命令拼接
- 用户输入在 normalize/validate 处边界校验
- 面板访问口令可选开启（浏览器记住一次，刷新后需重新输入）

## 许可证

MIT
