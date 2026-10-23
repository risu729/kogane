# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
WORKDIR /app
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
COPY container/connect-relay.mjs container/child-lifecycle.mjs ./
COPY container/browser.mjs container/server.mjs container/extract.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
