import { describe, expect, test } from "bun:test";
import worker, {
  classifySbiVcBackfillError,
  parseGlobalPassLegacyEmptyAllowlist,
} from "../src/worker";
import { ImportError } from "../src/error";
import { backfillStoredRuns } from "../../../poc/mobile-suica-worker/src/raw-evidence";

describe("collector R2 importer routes", () => {
  test("the GLOBAL PASS legacy empty allowlist is exact and bounded", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    expect([...parseGlobalPassLegacyEmptyAllowlist(`${first},${second}`)])
      .toEqual([first, second]);
    for (const value of ["", "A".repeat(64), `${first},${first}`, `${first}, ${second}`]) {
      expect(() => parseGlobalPassLegacyEmptyAllowlist(value))
        .toThrow("global_pass_legacy_empty_allowlist_invalid");
    }
  });

  test("the V Point backfill page scans exactly one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return options.cursor === "next"
          ? { objects: [], truncated: false } as unknown as R2Objects
          : {
              objects: [{ key: "raw/v-point/2026/09/05/run/balance-info.json" }],
              truncated: true,
              cursor: "next",
            } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/v-point/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, bucket,
      ),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ prefix: "raw/v-point/", limit: 1 }]);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "v-point",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      truncated: true,
    });
    expect(body.nextCursor).toBeString();
    expect(body.nextCursor as string).toStartWith("vpoint-v3.");

    const final = await worker.fetch(
      new Request("https://importer.internal/v1/v-point/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: body.nextCursor, limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, bucket,
      ),
    );
    expect(final.status).toBe(200);
    expect(calls[1]).toEqual({ prefix: "raw/v-point/", limit: 1, cursor: "next" });
  });

  test("the V Point backfill route rejects invalid limits and tampered or stalled cursors", async () => {
    const never = { list: async () => { throw new Error("must_not_list"); } } as unknown as R2Bucket;
    const invalidLimit = await worker.fetch(
      new Request("https://importer.internal/v1/v-point/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, never,
      ),
    );
    expect(invalidLimit.status).toBe(400);
    expect(await invalidLimit.json() as unknown).toEqual({ error: "backfill_limit_must_be_one" });

    const invalidCursor = await worker.fetch(
      new Request("https://importer.internal/v1/v-point/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "not opaque", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, never,
      ),
    );
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json() as unknown).toEqual({ error: "cursor_invalid" });

    const legacyCursor = await worker.fetch(
      new Request("https://importer.internal/v1/v-point/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: `vpoint-v2.e30.${"A".repeat(43)}`, limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, never,
      ),
    );
    expect(legacyCursor.status).toBe(400);
    expect(await legacyCursor.json() as unknown).toEqual({ error: "cursor_invalid" });

    const seed = {
      list: async () => ({
        objects: [{ key: "raw/v-point/ignored.json" }],
        truncated: true,
        cursor: "same",
      } as unknown as R2Objects),
    } as unknown as R2Bucket;
    const seeded = await worker.fetch(
      new Request("https://importer.internal/v1/v-point/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, seed,
      ),
    );
    const signed = (await seeded.json() as { nextCursor: string }).nextCursor;
    const tampered = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`;
    const tamperedResponse = await worker.fetch(
      new Request("https://importer.internal/v1/v-point/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: tampered, limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, never,
      ),
    );
    expect(tamperedResponse.status).toBe(400);

    const stalled = {
      list: async () => ({ objects: [], truncated: true, cursor: "same" } as unknown as R2Objects),
    } as unknown as R2Bucket;
    const stalledResponse = await worker.fetch(
      new Request("https://importer.internal/v1/v-point/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: signed, limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, stalled,
      ),
    );
    expect(stalledResponse.status).toBe(409);
  });

  test("the SMBC Direct backfill page scans exactly one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        if (options.cursor === "next") {
          return { objects: [], truncated: false } as unknown as R2Objects;
        }
        return {
          objects: [{
            key: "raw/smbc-direct/2026/09/05/123e4567-e89b-42d3-a456-426614174000/balance.raw.json.sjis",
          }],
          truncated: true,
          cursor: "next",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/smbc-direct/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket,
      ),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ prefix: "raw/smbc-direct/", limit: 1 }]);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "smbc-direct",
      scannedObjectCount: 1,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      truncated: true,
    });
    expect(body.nextCursor).toBeString();
    expect(body.nextCursor).toStartWith("smbc-direct-v2.");

    const resumed = await worker.fetch(
      new Request("https://importer.internal/v1/smbc-direct/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: body.nextCursor, limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
        {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket,
      ),
    );
    expect(resumed.status).toBe(200);
    expect(calls[1]).toEqual({ prefix: "raw/smbc-direct/", limit: 1, cursor: "next" });
  });

  test("the SMBC Direct route rejects invalid limits and cursor states before listing", async () => {
    const bucket = {
      list: async () => {
        throw new Error("list_must_not_be_called");
      },
    } as unknown as R2Bucket;
    const validTransfer = await smbcDirectCursor({
      v: 2,
      scanCursor: null,
      scanDone: true,
      manifestKey:
        "raw/smbc-direct/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json",
      offset: 10,
    });
    const invalidBodies = [
      { limit: 2 },
      { cursor: "not-an-smbc-cursor", limit: 1 },
      { cursor: "smbc-direct-v1.e30", limit: 1 },
      {
        cursor: await smbcDirectCursor({
          v: 2,
          scanCursor: null,
          scanDone: false,
        }),
        limit: 1,
      },
      {
        cursor: await smbcDirectCursor({
          v: 2,
          scanCursor: null,
          scanDone: true,
          manifestKey:
            "raw/smbc-direct/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json",
          offset: 0,
        }),
        limit: 1,
      },
      {
        cursor: await smbcDirectCursor({
          v: 2,
          scanCursor: null,
          scanDone: true,
          manifestKey:
            "raw/smbc-direct/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json",
          offset: 11,
        }),
        limit: 1,
      },
      { cursor: tamperSmbcDirectCursor(validTransfer, { scanDone: false }), limit: 1 },
      {
        cursor: tamperSmbcDirectCursor(validTransfer, {
          manifestKey:
            "raw/smbc-direct/2026/09/05/223e4567-e89b-42d3-a456-426614174000/manifest.json",
        }),
        limit: 1,
      },
      { cursor: tamperSmbcDirectCursor(validTransfer, { offset: 20 }), limit: 1 },
    ];
    for (const body of invalidBodies) {
      const response = await worker.fetch(
        new Request("https://importer.internal/v1/smbc-direct/backfill-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }) as Parameters<typeof worker.fetch>[0],
        environment(
          {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket,
          {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket,
        ),
      );
      expect(response.status).toBe(400);
      expect(await response.json() as unknown).toEqual({
        error: body.limit === 2 ? "backfill_limit_must_be_one" : "cursor_invalid",
      });
    }
  });

  test("the GLOBAL PASS backfill page scans exactly one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/prestia-globalpass/2026/09/05/run/activity-2026-09.html" }],
          truncated: true,
          cursor: "next",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/prestia-globalpass/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      prefix: "raw/prestia-globalpass/",
      limit: 1,
    }]);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      source: "prestia-globalpass",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      truncated: true,
    });
    expect(body.nextCursor).toBeString();
    expect(body.nextCursor as string).toStartWith("global-pass-v2.");
  });

  test("the GLOBAL PASS backfill route rejects limits above one", async () => {
    const bucket = {
      list: async () => { throw new Error("must_not_list"); },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/prestia-globalpass/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(400);
    expect(await response.json() as unknown).toEqual({ error: "backfill_limit_must_be_one" });
  });

  test("the GLOBAL PASS backfill route rejects an untrusted cursor before listing", async () => {
    const bucket = {
      list: async () => { throw new Error("must_not_list"); },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/prestia-globalpass/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "not-a-global-pass-cursor", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(400);
    expect(await response.json() as unknown).toEqual({ error: "cursor_invalid" });
  });

  test("the GLOBAL PASS backfill route rejects a v1 continuation before listing", async () => {
    const bucket = {
      list: async () => { throw new Error("must_not_list"); },
    } as unknown as R2Bucket;
    const legacy = `global-pass-v1.${btoa(JSON.stringify({
      v: 1,
      scanCursor: null,
      scanDone: true,
      manifestKey:
        "raw/prestia-globalpass/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json",
      offset: 10,
    })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/prestia-globalpass/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: legacy, limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(400);
    expect(await response.json() as unknown).toEqual({ error: "cursor_invalid" });
  });

  test("the GLOBAL PASS cursor enforces scan and manifest-offset state invariants", async () => {
    const bucket = {
      list: async () => { throw new Error("must_not_list"); },
    } as unknown as R2Bucket;
    const manifestKey =
      "raw/prestia-globalpass/2026/09/05/123e4567-e89b-42d3-a456-426614174000/manifest.json";
    for (const state of [
      { v: 2, scanCursor: null, scanDone: false },
      { v: 2, scanCursor: "", scanDone: false },
      { v: 2, scanCursor: "next", scanDone: true },
      { v: 2, scanCursor: null, scanDone: true, manifestKey },
      { v: 2, scanCursor: null, scanDone: true, offset: 10 },
      { v: 2, scanCursor: null, scanDone: true, manifestKey, offset: 0 },
      { v: 2, scanCursor: null, scanDone: true, manifestKey, offset: 16 },
    ]) {
      const response = await worker.fetch(
        new Request("https://importer.internal/v1/prestia-globalpass/backfill-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cursor: globalPassCursor(state), limit: 1 }),
        }) as Parameters<typeof worker.fetch>[0],
        environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
      );
      expect(response.status).toBe(400);
      expect(await response.json() as unknown).toEqual({ error: "cursor_invalid" });
    }
  });

  test("the GLOBAL PASS route rejects an unchanged R2 scan cursor", async () => {
    const bucket = {
      list: async () => ({
        objects: [{ key: "raw/prestia-globalpass/2026/09/05/run/activity-2026-09.html" }],
        truncated: true,
        cursor: "same-r2-cursor",
      } as unknown as R2Objects),
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/prestia-globalpass/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cursor: globalPassCursor({ v: 2, scanCursor: "same-r2-cursor", scanDone: false }),
          limit: 1,
        }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(409);
    expect(await response.json() as unknown).toEqual({ error: "prefix_cursor_did_not_advance" });
  });

  test("the MyJCB backfill page scans exactly one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/myjcb/2026/09/05/run/primary/credit-menu.html" }],
          truncated: true,
          cursor: "next",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/myjcb/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket,
        {} as R2Bucket,
        {} as R2Bucket,
        {} as R2Bucket,
        {} as R2Bucket,
        bucket,
      ),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ prefix: "raw/myjcb/", limit: 1 }]);
    expect(await response.json()).toMatchObject({
      source: "myjcb",
      scannedObjectCount: 1,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      truncated: true,
    });
  });

  test("the MyJCB backfill route rejects malformed cursors before listing", async () => {
    const bucket = {
      list: async () => { throw new Error("must_not_list"); },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/myjcb/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "not-a-myjcb-cursor", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(
        {} as R2Bucket,
        {} as R2Bucket,
        {} as R2Bucket,
        {} as R2Bucket,
        {} as R2Bucket,
        bucket,
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json() as unknown).toEqual({ error: "cursor_invalid" });
  });

  test("the Mobile Suica backfill page scans exactly one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/mobile-suica/2026/09/05/run/sf-history.json" }],
          truncated: true,
          cursor: "next",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/mobile-suica/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "prior", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ prefix: "raw/mobile-suica/", limit: 1, cursor: "prior" }]);
    expect(await response.json()).toMatchObject({
      source: "mobile-suica",
      scannedObjectCount: 1,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      nextCursor: "next",
      truncated: true,
    });
  });

  test("the Mobile Suica backfill route rejects limits above one", async () => {
    const bucket = { list: async () => { throw new Error("must_not_list"); } } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/mobile-suica/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(400);
    expect(await response.json() as unknown).toEqual({ error: "backfill_limit_must_be_one" });
  });
  test("the Sony backfill page scans one non-manifest object without central writes", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/sony-bank/2026/09/03/run/gross-balance.json" }],
          truncated: false,
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/sony-bank/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ prefix: "raw/sony-bank/", limit: 1 }]);
    const responseBody: unknown = await response.json();
    expect(responseBody).toEqual({
      source: "sony-bank",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
    });
  });

  test("the Sony backfill route rejects invalid limits and cursors before listing R2", async () => {
    const bucket = {
      list: async () => {
        throw new Error("list_must_not_be_called");
      },
    } as unknown as R2Bucket;
    for (const body of [{ limit: 2 }, { cursor: "not-a-sony-cursor", limit: 1 }]) {
      const response = await worker.fetch(
        new Request("https://importer.internal/v1/sony-bank/backfill-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }) as Parameters<typeof worker.fetch>[0],
        environment({} as R2Bucket, bucket),
      );
      expect(response.status).toBe(400);
    }
  });

  test("the SBI VC backfill page lists at most one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/sbi-vc-trade/2026/09/03/run/cash-balances.json" }],
          truncated: true,
          cursor: "next-cursor",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/sbi-vc-trade/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "prior", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      prefix: "raw/sbi-vc-trade/",
      limit: 1,
      cursor: "prior",
    }]);
    expect(await response.json()).toMatchObject({
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      nextCursor: "next-cursor",
      truncated: true,
    });
  });

  test("the SBI VC backfill route rejects any requested limit above one", async () => {
    const bucket = {
      list: async () => {
        throw new Error("list_must_not_be_called");
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/sbi-vc-trade/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 2 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment(bucket),
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body).toEqual({ error: "backfill_limit_must_be_one" });
  });

  test("the SBI Shinsei backfill page lists exactly one source object", async () => {
    const calls: R2ListOptions[] = [];
    const bucket = {
      list: async (options: R2ListOptions) => {
        calls.push(options);
        return {
          objects: [{ key: "raw/sbi-shinsei/2026/09/03/run/raw-exchange-rate.json" }],
          truncated: true,
          cursor: "next-cursor",
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;
    const response = await worker.fetch(
      new Request("https://importer.internal/v1/sbi-shinsei/backfill-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: "prior", limit: 1 }),
      }) as Parameters<typeof worker.fetch>[0],
      environment({} as R2Bucket, {} as R2Bucket, bucket),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      prefix: "raw/sbi-shinsei/",
      limit: 1,
      cursor: "prior",
    }]);
    expect(await response.json()).toMatchObject({
      source: "sbi-shinsei",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      failedManifestCount: 0,
      nextCursor: "next-cursor",
      truncated: true,
    });
  });

  test("the Mobile Suica backfill response passes the collector contract validator", async () => {
    const bucket = {
      list: async () => ({
        objects: [{ key: "raw/mobile-suica/2026/09/05/run/sf-history.json" }],
        truncated: false,
      }) as unknown as R2Objects,
    } as unknown as R2Bucket;
    const env = environment({} as R2Bucket, {} as R2Bucket, {} as R2Bucket, bucket);
    const importer = {
      fetch: (request: Request) => worker.fetch(
        request as Parameters<typeof worker.fetch>[0],
        env,
      ),
    } as Fetcher;
    await expect(backfillStoredRuns(importer)).resolves.toEqual({
      source: "mobile-suica",
      scannedObjectCount: 1,
      importedManifestCount: 0,
      skippedManifestCount: 1,
      deferredManifestCount: 0,
      failedManifestCount: 0,
      nextCursor: null,
      truncated: false,
    });
  });

  test("classifies the synchronous chain limit as deferred, not failed", () => {
    expect(classifySbiVcBackfillError(
      new ImportError(409, "sync_import_worker_chain_limit"),
    )).toEqual({
      deferred: true,
      code: "sync_import_worker_chain_limit",
    });
    expect(classifySbiVcBackfillError(
      new ImportError(409, "artifact_checksum_mismatch"),
    )).toEqual({
      deferred: false,
      code: "artifact_checksum_mismatch",
    });
  });
});

function globalPassCursor(value: unknown): string {
  return `global-pass-v2.${btoa(JSON.stringify(value)).replaceAll("+", "-")
    .replaceAll("/", "_").replace(/=+$/u, "")}`;
}

async function smbcDirectCursor(value: unknown): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(value)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("collector-r2-smbc-direct." + "d".repeat(32)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`smbc-direct-v2.${payload}`),
  ));
  return `smbc-direct-v2.${payload}.${base64Url(signature)}`;
}

function tamperSmbcDirectCursor(
  cursor: string,
  changes: Record<string, unknown>,
): string {
  const [prefix, payload, signature] = cursor.split(".");
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(payload!))) as Record<string, unknown>;
  return `${prefix}.${base64Url(new TextEncoder().encode(JSON.stringify({
    ...parsed,
    ...changes,
  })))}.${signature}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function environment(
  bucket: R2Bucket,
  sonyBucket: R2Bucket = {} as R2Bucket,
  sbiShinseiBucket: R2Bucket = {} as R2Bucket,
  mobileSuicaBucket: R2Bucket = {} as R2Bucket,
  globalPassBucket: R2Bucket = {} as R2Bucket,
  myJcbBucket: R2Bucket = {} as R2Bucket,
  vPointBucket: R2Bucket = {} as R2Bucket,
  vPointPayBucket: R2Bucket = {} as R2Bucket,
  smbcDirectBucket: R2Bucket = {} as R2Bucket,
): Env {
  return {
    SBI_SNAPSHOTS: {} as R2Bucket,
    SBI_VC_SNAPSHOTS: bucket,
    SONY_SNAPSHOTS: sonyBucket,
    SBI_SHINSEI_SNAPSHOTS: sbiShinseiBucket,
    MOBILE_SUICA_SNAPSHOTS: mobileSuicaBucket,
    GLOBAL_PASS_SNAPSHOTS: globalPassBucket,
    MYJCB_SNAPSHOTS: myJcbBucket,
    VPOINT_SNAPSHOTS: vPointBucket,
    VPOINT_PAY_SNAPSHOTS: vPointPayBucket,
    SMBC_DIRECT_SNAPSHOTS: smbcDirectBucket,
    RAW_EVIDENCE: {} as Fetcher,
    IMPORTER_VERSION: "collector-r2-importer-v14",
    RAW_EVIDENCE_TOKEN: `collector-r2-sbi.${"s".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SBI_VC: `collector-r2-sbi-vc.${"v".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SONY: `collector-r2-sony-bank.${"o".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SBI_SHINSEI: `collector-r2-sbi-shinsei.${"n".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_MOBILE_SUICA: `collector-r2-mobile-suica.${"m".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_GLOBAL_PASS: `collector-r2-global-pass.${"g".repeat(32)}`,
    GLOBAL_PASS_LEGACY_EMPTY_SHA256_ALLOWLIST: "a".repeat(64),
    RAW_EVIDENCE_TOKEN_MYJCB: `collector-r2-myjcb.${"j".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_VPOINT: `collector-r2-v-point.${"p".repeat(32)}`,
    RAW_EVIDENCE_TOKEN_SMBC_DIRECT: "collector-r2-smbc-direct." + "d".repeat(32),
    ORIGIN_FINGERPRINT_KEY: "ab".repeat(32),
  };
}
