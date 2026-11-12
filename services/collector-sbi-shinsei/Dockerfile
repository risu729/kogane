# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

FROM mcr.microsoft.com/playwright:v1.65.0-noble@sha256:6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d

WORKDIR /app
COPY container/chrome-install.mjs container/chrome-manifest.json ./
RUN node chrome-install.mjs install && rm chrome-install.mjs chrome-manifest.json
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
COPY container/connect-relay.mjs ./
COPY container/stage-diagnostics.mjs ./
COPY container/child-lifecycle.mjs ./
COPY container/browser-launch.mjs ./
COPY container/server.mjs ./
EXPOSE 8080
CMD ["node", "server.mjs"]
