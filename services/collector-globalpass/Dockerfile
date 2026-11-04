# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f

WORKDIR /app
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
RUN npx playwright install chrome
COPY container/server.mjs container/connect-relay.mjs container/diagnostics.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
