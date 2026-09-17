# EdgeLink Docker 部署（107）

## 一次性操作（在 192.168.1.107 上）

```bash
# 1. 把 deploy.sh 拷到 107 并执行
curl -fsSL http://192.168.1.x:PORT/deploy.sh -o deploy.sh   # 或 scp / git pull
chmod +x deploy.sh
./deploy.sh
```

容器会：
- 拉 `ghcr.io/cloudcranes/edgelink:latest`
- 启动 `edgelink` 容器，端口 `8787`，重启策略 `unless-stopped`
- 数据卷 `~/edgelink-data` → 容器 `/app/data`
- 健康检查 `/api/health`，30s 内就绪后输出面板地址

## 同步 config.json（本机 → 107）

**方式 A：scp（推荐）**

```powershell
# 在本机 Windows PowerShell（已启用 OpenSSH）
$env:CONFIG = "C:\Users\Master\Documents\code\lucky-esa\config.json"
if (-not (Test-Path $env:CONFIG)) {
  Write-Error "config.json 不存在，先在 8787 面板「设置 → 导出配置」得到一份"
  exit 1
}

# 上传到 107 的 ~/edgelink-data/config.json
scp $env:CONFIG "user@192.168.1.107:~/edgelink-data/config.json"
```

**方式 B：用面板自带导出/导入 API**

```powershell
# 本机导出
curl -s http://127.0.0.1:8787/api/config/export -o config-export.json

# 上传到 107
scp config-export.json user@192.168.1.107:~/edgelink-data/

# 在 107 上通过面板导入（或直接 rename 为 config.json）
ssh user@192.168.1.107 "mv ~/edgelink-data/config-export.json ~/edgelink-data/config.json"
```

## 验证

```bash
# 107 上
curl -fsS http://192.168.1.107:8787/api/summary | head -c 200
echo ""
docker logs --tail 20 edgelink
```

## 重启 / 更新

```bash
# 重启容器（不改镜像）
docker restart edgelink

# 拉新镜像 + 重启（用 deploy.sh 即可）
./deploy.sh
```

## 数据卷内容

```
~/edgelink-data/
├── config.json          # 凭据 + 应用 + 设置
├── snapshots/           # 配置快照
└── health-history.json  # 健康检查历史
```

容器删除后数据保留在卷里；`docker rm -v edgelink` 会**连数据一起删**，慎用。

## 常见问题

- **端口占用**：`sudo lsof -i :8787` 查谁在用，停掉后重试
- **权限问题**：用 sudo docker，或把自己加入 docker 组：`sudo usermod -aG docker $USER && newgrp docker`
- **镜像拉不到**：检查 107 能访问 ghcr.io；如在公司代理后设 `HTTP_PROXY=http://proxy:port`
