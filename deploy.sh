#!/bin/bash
# EdgeLink Docker 部署脚本（Ubuntu/Debian 适用）
# 在 192.168.1.107 上以普通用户执行，需要 sudo 权限

set -e

IMAGE="ghcr.io/cloudcranes/edgelink:latest"
CONTAINER="edgelink"
PORT=8787
DATA_DIR="$HOME/edgelink-data"

echo "=== EdgeLink Docker 部署 ==="

# 1. 准备数据目录
mkdir -p "$DATA_DIR"

# 2. 拉取最新镜像
echo "[1/4] 拉取镜像 $IMAGE..."
sudo docker pull "$IMAGE"

# 3. 停止并删除旧容器（如果存在）
if sudo docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[2/4] 停止并删除旧容器 $CONTAINER..."
  sudo docker stop "$CONTAINER" 2>/dev/null || true
  sudo docker rm "$CONTAINER" 2>/dev/null || true
else
  echo "[2/4] 跳过（无旧容器）"
fi

# 4. 启动新容器
echo "[3/4] 启动容器 $CONTAINER..."
sudo docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "${PORT}:8787" \
  -v "${DATA_DIR}:/app/data" \
  "$IMAGE"

# 5. 健康检查
echo "[4/4] 等待容器就绪..."
for i in {1..15}; do
  sleep 2
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "✓ 容器健康"
    sudo docker ps --filter "name=$CONTAINER" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    echo "面板地址: http://192.168.1.107:${PORT}"
    echo "数据卷:   $DATA_DIR"
    echo ""
    echo "下一步：在本地 8787 面板导出 config.json，scp 到 107 的 $DATA_DIR/config.json"
    exit 0
  fi
done

echo "⚠ 容器未在 30s 内就绪，请检查日志："
sudo docker logs --tail 50 "$CONTAINER"
exit 1
