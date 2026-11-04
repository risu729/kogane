# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# The build context is the repository root (`image_build_context` in
# wrangler.jsonc). There is one `bun.lock` at the root since the workspace
# migration, so a frozen install needs the root manifests plus this workspace's
# own manifest at the path the lockfile records it under. Bun installs the
# workspaces it can see and says which ones it skipped.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

WORKDIR /app

COPY package.json bunfig.toml bun.lock ./
COPY experiments/cloudflare-runtime-probe/package.json ./experiments/cloudflare-runtime-probe/
# Only this workspace goes into the image, so hoist its dependencies into
# /app/node_modules. The repository's isolated linker would put them under the
# workspace path instead, where the entry point below could not resolve them.
RUN bun install --frozen-lockfile --production --linker hoisted \
  --filter @kogane/cloudflare-runtime-probe

COPY experiments/cloudflare-runtime-probe/container ./container

EXPOSE 8080

CMD ["bun", "run", "container/server.ts"]
