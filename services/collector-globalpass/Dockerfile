# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe

WORKDIR /app
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
RUN npx playwright install chrome
COPY container/server.mjs container/collect.mjs container/connect-relay.mjs container/diagnostics.mjs container/failure.mjs container/challenge.mjs container/logout.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
