// Build-time only: this module must never be bundled into a deployed Worker.
// There is deliberately no input-store or fixture-directory option.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ArtifactDetail, ArtifactRow } from "../shared/api-contract.ts";
import { validApiResponse } from "../shared/api-validation.ts";
import { createApi } from "./api.ts";
import { ingestFixtures } from "./ingest.ts";
import { runParsers } from "./parse.ts";
import { openStore, type Store } from "./store.ts";

export interface DemoResponse {
  status: number;
  contentType: string;
  bodyBase64: string;
}

export interface DemoSnapshot {
  schemaVersion: 1;
  classification: "synthetic";
  responses: Record<string, DemoResponse>;
}

/** Export only committed synthetic fixtures, with an isolated disposable store. */
export async function exportDemo(output: string): Promise<DemoSnapshot> {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, "kogane-demo-export-"));
  let store: Store | undefined;
  try {
    store = openStore(directory);
    ingestFixtures(store, join(import.meta.dir, "..", "fixtures"));
    const parsed = runParsers(store, undefined, () => "2026-09-08T00:00:00.000Z");
    if (parsed.errors !== 0) throw new Error("Synthetic fixture parsing failed");
    store.db.exec("PRAGMA query_only = ON");
    const api = createApi(store, { dataClassification: "synthetic" });
    const responses: Record<string, DemoResponse> = {};
    async function capture(path: string): Promise<unknown> {
      const response = await api.fetch(new Request(`http://demo.invalid${path}`));
      if (response.status !== 200) throw new Error(`Synthetic export failed: ${path}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      responses[path] = {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        bodyBase64: bytes.toString("base64"),
      };
      if (path.startsWith("/api/raw/")) return undefined;
      const body: unknown = JSON.parse(bytes.toString("utf8"));
      if (!validApiResponse(path, body)) throw new Error(`Invalid synthetic response: ${path}`);
      return body;
    }
    for (const path of ["meta", "overview", "transactions", "balances", "positions"]) {
      await capture(`/api/${path}`);
    }
    const listing = (await capture("/api/artifacts")) as { artifacts: ArtifactRow[] };
    for (const artifact of listing.artifacts) {
      const detail = (await capture(`/api/artifacts/${artifact.id}`)) as ArtifactDetail;
      await capture(`/api/raw/${artifact.sha256}`);
      // Walk every parse run, including superseded runs, not only current rows.
      for (const parseRun of detail.parseRuns) {
        for (const observation of parseRun.observations) {
          await capture(`/api/observations/${observation.kind}/${observation.id}`);
        }
      }
    }
    const snapshot: DemoSnapshot = {
      schemaVersion: 1,
      classification: "synthetic",
      responses: Object.fromEntries(
        Object.entries(responses).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
    mkdirSync(dirname(resolve(output)), { recursive: true });
    writeFileSync(output, `${JSON.stringify(snapshot)}\n`);
    return snapshot;
  } finally {
    store?.db.close();
    const target = resolve(directory);
    if (dirname(target) === temporaryRoot && basename(target).startsWith("kogane-demo-export-")) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const output = process.argv[2];
  if (output === undefined || process.argv.length !== 3) {
    throw new Error("Usage: bun run src/export-demo.ts <output.json>");
  }
  const snapshot = await exportDemo(output);
  console.log(`Exported ${Object.keys(snapshot.responses).length} synthetic demo responses`);
}
