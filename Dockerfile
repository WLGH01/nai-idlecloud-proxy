FROM node:20-alpine

LABEL org.opencontainers.image.title="NAI to IDLECLOUD Proxy" \
      org.opencontainers.image.description="把 NovelAI 官方 API 请求转换为 IDLECLOUD 通用生成端点(/api/generate_image)" \
      org.opencontainers.image.source="https://github.com/WLGH01/nai-idlecloud-proxy" \
      org.opencontainers.image.licenses="MIT"

# su-exec：入口脚本降权用；tini 作为 init，正确处理信号与僵尸进程
RUN apk add --no-cache su-exec tini

WORKDIR /app

# 零运行时依赖：仅 Node 标准库，无需 npm install
COPY package.json server.js convert.js quota.js icon.svg icon.png entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh

# 额度状态默认写 /data/quota.json
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=8788 \
    QUOTA_FILE=/data/quota.json \
    PUID=1000 \
    PGID=1000

EXPOSE 8788

VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口脚本需要 root 来 chown 数据目录，随后自行降权到 PUID:PGID
ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
CMD ["node", "server.js"]
