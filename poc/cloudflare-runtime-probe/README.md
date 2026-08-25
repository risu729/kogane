# Cloudflare runtime probe

This temporary, deliberately retained deployment compares the network identity
seen through five paths:

1. normal Worker `fetch`,
2. Container native `fetch`,
3. Container `impit` with the Chrome 142 profile,
4. VPC Tunnel binding `fetch` through `tamia`, and
5. VPC Tunnel binding raw TCP `connect` through `tamia`.

The public endpoints return a SHA-256 of the observed IP, never the address
itself. They contain no Vpass credential, cookie, card identifier, or financial
response. The third-party TLS diagnostic receives only a fixed test User-Agent.

The live account is currently on the Workers Free plan. The Worker and VPC
paths are deployed, but Cloudflare rejected creation of the remote Container
application because Containers require Workers Paid. Local Docker still runs
the exact image built by Wrangler. See `RESULTS.md` for the observed behavior.

Use the exact locked dependencies:

```bash
bun install --frozen-lockfile
bun run typegen
bun run typecheck
bun run typecheck:container
bun run deploy:dry
bun run deploy
```

`bun run deploy` uploads the Worker version before Cloudflare attempts the
Container image. On the current Free plan the command therefore ends with an
expected `Unauthorized` error after leaving the Worker/VPC probe deployed.

See `RESOURCE_INVENTORY.md` before changing or deleting any deployed resource.
