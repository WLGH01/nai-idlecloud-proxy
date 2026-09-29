FROM node:20-alpine

LABEL org.opencontainers.image.title="NAI to IDLECLOUD Proxy" \
      org.opencontainers.image.description="把 NovelAI 官方 API 请求转换为 IDLECLOUD 通用生成端点(/api/generate_image)" \
      org.opencontainers.image.source="local"

WORKDIR /app

# 零运行时依赖：仅标准库，无需 npm install
COPY package.json server.js convert.js icon.svg icon.png ./

ENV NODE_ENV=production \
    PORT=8788

EXPOSE 8788

# 以非 root 运行；本镜像不需要写任何文件
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
