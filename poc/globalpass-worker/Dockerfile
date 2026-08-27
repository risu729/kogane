# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
RUN npx playwright install chrome
COPY container/server.mjs ./server.mjs
EXPOSE 8080
CMD ["node", "server.mjs"]
