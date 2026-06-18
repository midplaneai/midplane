FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production

FROM oven/bun:1.3-alpine
WORKDIR /app
RUN apk add --no-cache sqlite
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.ts client.ts ./
RUN mkdir -p /data
EXPOSE 8080
CMD ["bun", "run", "server.ts"]
