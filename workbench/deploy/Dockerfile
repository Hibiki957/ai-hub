FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./web
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund
RUN node --input-type=module -e "import {SqliteSaver} from '@langchain/langgraph-checkpoint-sqlite'; const s=SqliteSaver.fromConnString(':memory:'); await s.getTuple({configurable:{thread_id:'build-check'}}); s.db.close();"

FROM node:22.23.1-bookworm-slim AS service
ENV NODE_ENV=production HUB_HOST=0.0.0.0 HUB_PORT=8787 HUB_DATA_DIR=/data HOME=/data
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* && mkdir /data && chown node:node /data
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY server ./server
COPY deploy ./deploy
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
