FROM node:20-alpine

LABEL org.opencontainers.image.title="NAI to IDLECLOUD Proxy" \
      org.opencontainers.image.description="把 NovelAI 官方 API 请求转换为 IDLECLOUD 通用生成端点(/api/generate_image)" \
      org.opencontainers.image.source="https://github.com/WLGH01/nai-idlecloud-proxy" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 零运行时依赖：仅 Node 标准库，无需 npm install
COPY package.json server.js convert.js quota.js icon.svg icon.png ./

# 额度状态默认写 /data/quota.json；预先建目录并交给 node 用户，避免非 root 运行时写不进去
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=8788 \
    QUOTA_FILE=/data/quota.json

EXPOSE 8788

VOLUME ["/data"]

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
