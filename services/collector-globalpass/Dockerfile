# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

WORKDIR /app
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
RUN npx playwright install chrome
COPY container/server.mjs container/connect-relay.mjs container/diagnostics.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
