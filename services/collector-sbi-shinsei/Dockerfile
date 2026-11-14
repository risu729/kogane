# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

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
