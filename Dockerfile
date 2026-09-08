# ---- ビルド ----
FROM node:24-alpine AS builder

WORKDIR /app

# 依存の解決だけを先に行い、ソース変更時のキャッシュを効かせる。
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# 実行に不要な devDependencies を落とす。
RUN pnpm prune --prod

# ---- 実行 ----
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# root で動かさない。node ユーザーはベースイメージに存在する。
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./

USER node

EXPOSE 3000

# 依存を増やさないよう Node の fetch でヘルスチェックする。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# PID 1 として動くため、アプリ側で SIGTERM を処理している (src/index.ts)。
CMD ["node", "dist/index.js"]
