# ---- build stage ----
FROM node:20-alpine AS builder
WORKDIR /app
# better-sqlite3 是原生模块,Alpine 默认无 python/g++,要自己装
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- deps stage: 单独编译 prod deps,把 native 二进制带到 runtime ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM node:20-alpine
WORKDIR /app

# Runtime 只要 sqlite-libs(运行期共享库),编译工具留在 deps stage
RUN apk add --no-cache sqlite-libs

COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY seed ./seed
COPY plugins ./plugins
COPY .env.example .env.example

# Data volume mount point
RUN mkdir -p /app/server-data
VOLUME /app/server-data

ENV NODE_ENV=production
ENV SERVER_HOST=0.0.0.0
ENV SERVER_PORT=5173

EXPOSE 5173

COPY scripts/healthcheck.js ./scripts/healthcheck.js
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node scripts/healthcheck.js

CMD ["node", "server/start.js"]
