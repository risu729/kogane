import { describe, expect, test } from "bun:test";
import {
  IMPORT_ADAPTERS,
  backfillAdapter,
  checkImportAdapterRegistry,
  executeImport,
  importRunAdapter,
  reconcilerOutcome,
  type ImportAdapter,
  type ImportSource,
} from "../src/adapters";
import { resumeFromWire } from "../src/adapters/contract";
import { ImportError } from "../src/error";
import { RECONCILER_SOURCES, weeklyRepairSeeds } from "../src/reconciler";
import worker from "../src/worker";

/** Frozen public surface: existing collectors call these URLs and must not be redeployed. */
const IMPORT_RUN_ROUTES: Record<ImportSource, string> = {
  "global-pass": "/v1/prestia-globalpass/import-run",
  "mobile-suica": "/v1/mobile-suica/import-run",
  moneyforward: "/v1/moneyforward/import-run",
  myjcb: "/v1/myjcb/import-run",
  "sbi-securities": "/v1/sbi-securities/import-run",
  "sbi-shinsei": "/v1/sbi-shinsei/import-run",
  "sbi-vc-trade": "/v1/sbi-vc-trade/import-run",
  "smbc-direct": "/v1/smbc-direct/import-run",
  "sony-bank": "/v1/sony-bank/import-run",
  vpass: "/v1/vpass/import-run",
  "v-point": "/v1/v-point/import-run",
  "v-point-pay-email": "/v1/v-point-pay-email/import-run",
};
const BACKFILL_ROUTES: Record<ImportSource, string> = Object.fromEntries(
  Object.entries(IMPORT_RUN_ROUTES).map(([source, path]) => [
    source,
    path.replace(/import-run$/u, "backfill-page"),
  ]),
) as Record<ImportSource, string>;
const SIDE_ROUTES = ["/v1/vpass/import-card-binding"];

describe("import adapter registry", () => {
  test("every reconciler source has a consistent adapter and the check passes", () => {
    expect(checkImportAdapterRegistry()).toEqual([]);
    expect(Object.keys(IMPORT_ADAPTERS).sort()).toEqual(Object.keys(RECONCILER_SOURCES).sort());
    for (const source of Object.keys(RECONCILER_SOURCES) as ImportSource[]) {
      const adapter: ImportAdapter = IMPORT_ADAPTERS[source];
      expect(adapter.id).toBe(source);
      expect(adapter.resumeKind).toBe(RECONCILER_SOURCES[source].resume);
      expect(adapter.contractVersion).toMatch(/^[a-z0-9-]+-v\d+$/u);
    }
    expect(Object.keys(IMPORT_ADAPTERS).sort()).toEqual(
      weeklyRepairSeeds()
        .map((seed) => seed.source)
        .sort(),
    );
  });

  test("the check reports missing adapters, resume drift, unrouted paths, and orphan adapters", () => {
    const { myjcb, ...withoutMyJcb } = IMPORT_ADAPTERS;
    expect(checkImportAdapterRegistry(withoutMyJcb)).toEqual([
      "myjcb: reconciler source has no import adapter",
    ]);
    expect(
      checkImportAdapterRegistry({ ...IMPORT_ADAPTERS, myjcb: { ...myjcb, resumeKind: "offset" } }),
    ).toEqual(["myjcb: adapter resume kind offset != reconciler token"]);
    expect(
      checkImportAdapterRegistry({
        ...IMPORT_ADAPTERS,
        myjcb: {
          ...myjcb,
          http: { ...myjcb.http, importRun: IMPORT_ADAPTERS.vpass.http.importRun },
        },
      }),
    ).toEqual(["myjcb: import-run route is not routed to this adapter"]);
    expect(
      checkImportAdapterRegistry({
        ...IMPORT_ADAPTERS,
        myjcb: { ...myjcb, http: { ...myjcb.http, importRun: "/v2/myjcb/import" } },
      }),
    ).toEqual(["myjcb: import-run path is not a versioned import-run route"]);
    expect(
      checkImportAdapterRegistry({
        ...IMPORT_ADAPTERS,
        extra: { ...myjcb, id: "extra" as never, http: null },
      }),
    ).toEqual(["extra: adapter has no reconciler source"]);
    expect(
      checkImportAdapterRegistry(IMPORT_ADAPTERS, {
        ...RECONCILER_SOURCES,
        later: { resume: "none" },
      }),
    ).toEqual(["later: reconciler source has no import adapter"]);
  });

  test("declared HTTP routes are exactly the frozen public URLs", () => {
    for (const source of Object.keys(IMPORT_RUN_ROUTES) as ImportSource[]) {
      const adapter: ImportAdapter = IMPORT_ADAPTERS[source];
      expect(adapter.http?.importRun).toBe(IMPORT_RUN_ROUTES[source]);
      expect(adapter.http?.backfillPage.path).toBe(BACKFILL_ROUTES[source]);
      expect(importRunAdapter(IMPORT_RUN_ROUTES[source])).toBe(adapter);
      expect(backfillAdapter(BACKFILL_ROUTES[source])).toBe(adapter);
    }
    expect(importRunAdapter("/v1/unknown/import-run")).toBeUndefined();
    expect(backfillAdapter("/v1/myjcb/import-run")).toBeUndefined();
  });

  test("every declared route is served and no other POST route exists", async () => {
    const env = {} as Env;
    for (const path of [
      ...Object.values(IMPORT_RUN_ROUTES),
      ...Object.values(BACKFILL_ROUTES),
      ...SIDE_ROUTES,
    ]) {
      const malformed = await worker.fetch(
        new Request(`https://importer.internal${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        }) as Parameters<typeof worker.fetch>[0],
        env,
      );
      expect([path, malformed.status, await malformed.json()]).toEqual([
        path,
        400,
        { error: "json_invalid" },
      ]);
      const wrongMethod = await worker.fetch(
        new Request(`https://importer.internal${path}`) as Parameters<typeof worker.fetch>[0],
        env,
      );
      expect(wrongMethod.status).toBe(404);
      const withQuery = await worker.fetch(
        new Request(`https://importer.internal${path}?x=1`, {
          method: "POST",
          body: "{}",
        }) as Parameters<typeof worker.fetch>[0],
        env,
      );
      expect(withQuery.status).toBe(404);
    }
    for (const path of ["/v1/unknown/import-run", "/v1/myjcb/import", "/v2/myjcb/import-run"]) {
      const response = await worker.fetch(
        new Request(`https://importer.internal${path}`, {
          method: "POST",
          body: "{}",
        }) as Parameters<typeof worker.fetch>[0],
        env,
      );
      expect(response.status).toBe(404);
    }
  });

  test("each repair outbox binding resolves to the reconciler's bucket in wrangler.jsonc", async () => {
    const config = JSON.parse(
      await Bun.file(new URL("../wrangler.jsonc", import.meta.url)).text(),
    ) as { r2_buckets: Array<{ binding: string; bucket_name: string }> };
    const env = Object.fromEntries(
      config.r2_buckets.map((bucket) => [bucket.binding, { bucketName: bucket.bucket_name }]),
    ) as unknown as Env;
    for (const source of Object.keys(IMPORT_ADAPTERS) as ImportSource[]) {
      const adapter: ImportAdapter = IMPORT_ADAPTERS[source];
      const outbox = adapter.repairPolicy.outbox(env) as unknown as { bucketName: string };
      expect([source, outbox.bucketName]).toEqual([source, RECONCILER_SOURCES[source].bucket]);
    }
  });

  test("the executor rejects a command or resume that contradicts the adapter", async () => {
    const env = {} as Env;
    await expect(
      executeImport(
        env,
        "myjcb",
        { source: "vpass", terminalKey: "k", mode: "staged" },
        {
          kind: "none",
        },
      ),
    ).rejects.toThrow("import_command_source_mismatch");
    await expect(
      executeImport(
        env,
        "myjcb",
        { source: "myjcb", terminalKey: "k", mode: "staged" },
        {
          kind: "offset",
          offset: 5,
        },
      ),
    ).rejects.toThrow("import_resume_kind_mismatch");
    await expect(
      executeImport(
        env,
        "sony-bank",
        { source: "sony-bank", terminalKey: "k", mode: "staged" },
        {
          kind: "token",
          token: "t",
        },
      ),
    ).rejects.toThrow("import_resume_kind_mismatch");
  });

  test("queue wire resume values map to the internal union by declared kind", () => {
    expect(resumeFromWire("none", null)).toEqual({ kind: "none" });
    expect(resumeFromWire("token", null)).toEqual({ kind: "none" });
    expect(resumeFromWire("offset", null)).toEqual({ kind: "none" });
    expect(resumeFromWire("token", "opaque")).toEqual({ kind: "token", token: "opaque" });
    expect(resumeFromWire("offset", 12)).toEqual({ kind: "offset", offset: 12 });
    for (const [kind, value] of [
      ["none", "x"],
      ["none", 1],
      ["token", 1],
      ["offset", "1"],
      ["offset", 0],
      ["offset", -1],
      ["offset", 1.5],
    ] as const) {
      expect(() => resumeFromWire(kind, value)).toThrow("reconciler_message_invalid");
    }
  });

  test("the queue outcome mapping keeps the previous fail-closed rules", () => {
    expect(reconcilerOutcome({ sealed: true })).toEqual({ status: "sealed" });
    expect(reconcilerOutcome({ status: "sealed" })).toEqual({ status: "sealed" });
    expect(reconcilerOutcome({ status: "deferred", nextOffset: 5, continuation: "t" })).toEqual({
      status: "deferred",
      resume: "t",
      progress: 5,
    });
    expect(reconcilerOutcome({ status: "deferred", nextOffset: 10 })).toEqual({
      status: "deferred",
      resume: 10,
      progress: 10,
    });
    for (const result of [
      { status: "deferred" as const },
      { status: "deferred" as const, nextOffset: 0 },
      { status: "deferred" as const, nextOffset: -1 },
      { status: "deferred" as const, nextOffset: 1.5 },
    ]) {
      let caught: unknown;
      try {
        reconcilerOutcome(result);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ImportError);
      expect((caught as ImportError).code).toBe("reconciler_import_stalled");
      expect((caught as ImportError).status).toBe(409);
    }
  });
});
