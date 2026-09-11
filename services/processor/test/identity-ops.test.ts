// Exercise the actual bundled private Worker locally; no live service binding.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf: Miniflare;
beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
  });
  if (!bundle.success) throw new Error("Private identity Worker test bundle failed");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: await bundle.outputs[0]!.text(),
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
}, 30_000);
afterAll(async () => {
  await mf?.dispose();
});

test("private identity sweep rejects invalid source and batch bounds before querying storage", async () => {
  for (const query of [
    "maxRuns=0",
    "maxRuns=-1",
    "maxRuns=41",
    "maxRuns=1.5",
    "maxRuns=NaN",
    "maxRuns=Infinity",
    "maxRuns=9007199254740992",
    "source=UPPERCASE",
    "source=x%2Fy",
    "source=x%00y",
    `source=${"x".repeat(101)}`,
  ]) {
    const response = await mf.dispatchFetch(`https://private.test/identity-sweep?${query}`, {
      method: "POST",
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(/^Invalid (source|batch)$/);
  }
});

test("private revision rejects absent, invalid JSON, schema mismatch and malformed UTF-8", async () => {
  const invalid = [
    "",
    "{",
    "null",
    "[]",
    "true",
    "123",
    JSON.stringify({ kind: "account" }),
    JSON.stringify({
      kind: "unexpected",
      referenceId: "ref",
      targetId: "target",
      expectedRevision: 1,
      reason: "synthetic",
    }),
    JSON.stringify({
      kind: "account",
      referenceId: 1,
      targetId: "target",
      expectedRevision: 1,
      reason: "synthetic",
    }),
    JSON.stringify({
      kind: "instrument",
      referenceId: "ref",
      targetId: "target",
      expectedRevision: "1",
      reason: "synthetic",
    }),
  ];
  for (const body of invalid) {
    const response = await mf.dispatchFetch("https://private.test/identity-revise", {
      method: "POST",
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid request");
  }
  const malformed = await mf.dispatchFetch("https://private.test/identity-revise", {
    method: "POST",
    body: new Uint8Array([0xc3, 0x28]),
  });
  expect(malformed.status).toBe(400);
});

test("private revision bounds bytes including multibyte input and does not echo submitted data", async () => {
  for (const body of ["x".repeat(4097), "合".repeat(1400)]) {
    const response = await mf.dispatchFetch("https://private.test/identity-revise", {
      method: "POST",
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid request");
  }
  for (const patch of [
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { reason: " " },
    { reason: "x".repeat(1001) },
  ]) {
    const response = await mf.dispatchFetch("https://private.test/identity-revise", {
      method: "POST",
      body: JSON.stringify({
        kind: "account",
        referenceId: "SYNTHETIC_PRIVATE_REFERENCE",
        targetId: "SYNTHETIC_PRIVATE_TARGET",
        expectedRevision: 1,
        reason: "SYNTHETIC_PRIVATE_REASON",
        ...patch,
      }),
    });
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toBe("Revision conflict or invalid identity");
    expect(text).not.toContain("SYNTHETIC_PRIVATE");
  }
});

test("identity mutation routes accept neither GET nor unrelated methods or suffix paths", async () => {
  for (const path of ["/identity-sweep", "/identity-revise"]) {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const response = await mf.dispatchFetch(`https://private.test${path}`, { method });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
    const response = await mf.dispatchFetch(`https://private.test${path}/unexpected`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
  }
});
