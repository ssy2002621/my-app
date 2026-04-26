FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG VITE_CONVEX_URL
ENV VITE_CONVEX_URL=$VITE_CONVEX_URL
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends pandoc \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# 复制构建输出（从 dist 而不是 .output）
COPY --from=build /app/dist ./dist

# 复制模板文件（运行时 pandoc 需要用到）
COPY --from=build /app/src/lib/templates ./src/lib/templates

EXPOSE 3000
CMD ["node", "dist/server/server.js"]