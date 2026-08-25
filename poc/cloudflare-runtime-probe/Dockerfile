# syntax=docker/dockerfile:1

FROM oven/bun:1.4.0-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY container ./container

EXPOSE 8080

CMD ["bun", "run", "container/server.ts"]
