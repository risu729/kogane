# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.62.1-noble
WORKDIR /app
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
COPY container/connect-relay.mjs container/child-lifecycle.mjs ./
COPY container/browser.mjs container/server.mjs container/extract.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
