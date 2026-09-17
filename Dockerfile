# 多阶段构建：deps → runtime
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

# 仅复制运行时所需文件
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY utils ./utils
COPY public ./public
COPY middleware ./middleware

# 前端硬依赖 vendor/lucide.min.js：从 jsDelivr CDN 拉取保持镜像自包含
# 失败也不阻断构建（icons 是渐进增强，缺了功能仍可用）
RUN mkdir -p public/vendor && \
    curl -fsSL -o public/vendor/lucide.min.js \
      https://cdn.jsdelivr.net/npm/lucide@latest/dist/umd/lucide.min.js || \
    echo '// lucide fetch failed at build time' > public/vendor/lucide.min.js

# 数据卷：存放 config.json（凭据）+ 快照/历史（运行时生成）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787

# wget 用于 healthcheck（alpine 自带 busybox 提供 wget）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server.js"]
