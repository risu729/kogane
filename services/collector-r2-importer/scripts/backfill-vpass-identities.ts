// Default is read-only inventory. --execute explicitly invokes reviewed sidecar writes.
import { getPlatformProxy } from "wrangler";
const execute = process.argv.includes("--execute");
if (process.argv.slice(2).some((v) => v !== "--execute")) throw new Error("unsupported-argument");
const proxy = await getPlatformProxy<{ VPASS_SNAPSHOTS: R2Bucket; IMPORTER: Fetcher }>({
  configPath: new URL("../wrangler.identity-backfill.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
let cursor: string | undefined,
  scanned = 0,
  eligible = 0,
  sealed = 0,
  unavailable = 0;
try {
  do {
    const page = await proxy.env.VPASS_SNAPSHOTS.list({
      prefix: "vpass/",
      limit: 250,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) {
      if (++scanned > 10000) throw new Error("scan-bound-exceeded");
      if (
        !/^vpass\/\d{4}\/\d{2}\/\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\/card-\d{3}\/manifest\.json$/u.test(
          object.key,
        )
      )
        continue;
      eligible++;
      if (!execute) continue;
      const response = await proxy.env.IMPORTER.fetch(
        new Request("https://importer.internal/v1/vpass/import-card-binding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recordKey: object.key }),
        }),
      );
      if (!response.ok) throw new Error("binding-import-failed");
      const body = (await response.json()) as { status?: string; artifactCount?: number };
      if (body.status === "sealed" && body.artifactCount === 1) sealed++;
      else if (body.status === "unavailable") unavailable++;
      else throw new Error("binding-response-invalid");
    }
    const next = page.truncated ? page.cursor : undefined;
    if (page.truncated && (!next || next === cursor)) throw new Error("scan-cursor-invalid");
    cursor = next;
    console.log(
      JSON.stringify({
        mode: execute ? "execute" : "inventory",
        scanned,
        eligible,
        sealed,
        unavailable,
        complete: !cursor,
      }),
    );
  } while (cursor);
} catch {
  console.error("vpass-identity-backfill-failed-safe");
  process.exitCode = 1;
} finally {
  await proxy.dispose();
}
