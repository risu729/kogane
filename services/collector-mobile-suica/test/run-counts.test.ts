// INV05: a run whose history walk did not finish never learned its page or
// transaction count, so the `mobile-suica-collection-persisted` line leaves
// both out instead of reporting 0. A finished walk reports what it read,
// including a known 0 for an empty history. The browser bootstrap is a stub
// and the provider is a mocked `fetch`; nothing leaves the test.
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { emptyPage, historyResponse, syntheticSession, walkPages } from "./history-fixture";

mock.module("../src/browser-bootstrap", () => ({
  bootstrapMobileSuicaSessionWithBrowser: async () => syntheticSession,
}));
const { alarmCollection } = await import("../src/worker");

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  setSystemTime();
});

const COUNT_FIELDS = ["transactionCount", "pageCount"] as const;

function credentialJson(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return JSON.stringify({
    schemaVersion: "jre-id-bitwarden-passkey-v1",
    syncedAt: "2026-08-31T00:00:00.000Z",
    username: "fixture-user",
    rpId: "id.jreast.co.jp",
    credentialId: "00000000-0000-4000-8000-000000000000",
    userHandle: Buffer.from("fixture-handle").toString("base64url"),
    counter: 0,
    privateKeyPkcs8Base64Url: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
  });
}

/** Run one alarm collection against these history responses and return its persisted line. */
async function run(
  responses: readonly Response[] | null,
): Promise<{ line: Record<string, unknown>; fetches: number }> {
  // The fixtures' rows are dated relative to 2026-08-30 JST.
  setSystemTime(new Date("2026-08-30T03:00:00Z"));
  const records: Array<Record<string, unknown>> = [];
  for (const method of ["log", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation((value) =>
      records.push(JSON.parse(String(value)) as Record<string, unknown>),
    );
    restores.push(() => spy.mockRestore());
  }
  let fetches = 0;
  const pending = [...(responses ?? [])];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
    fetches += 1;
    const next = pending.shift();
    if (next === undefined) throw new Error("unexpected_request");
    return next;
  }) as unknown as typeof globalThis.fetch);
  restores.push(() => fetchSpy.mockRestore());
  const env = {
    COLLECTOR_SCHEMA_VERSION: "mobile-suica-worker-poc-v2",
    DATA: new FakeR2Bucket(),
    ...(responses === null ? {} : { JRE_ID_CREDENTIAL_JSON: credentialJson() }),
  } as unknown as Env;
  await alarmCollection(env, "", 0);
  const persisted = records.filter(
    (record) => record.event === "mobile-suica-collection-persisted",
  );
  expect(persisted).toHaveLength(1);
  return { line: persisted[0]!, fetches };
}

describe("Mobile Suica run counts are reported only when the history walk finished", () => {
  test("a finished walk reports its counts", async () => {
    const { line } = await run(walkPages.map(historyResponse));
    expect(line).toMatchObject({ status: "success", transactionCount: 101, pageCount: 2 });
  });

  test("a finished walk over an empty history reports a known zero", async () => {
    const { line } = await run([historyResponse(emptyPage)]);
    expect(line).toMatchObject({ status: "success", transactionCount: 0, pageCount: 1 });
  });

  test("a walk stopped after its first page leaves both counts out", async () => {
    const { line } = await run([
      historyResponse(walkPages[0]!),
      new Response("private-account-body", { status: 503 }),
    ]);
    // The kept page is stored and counted as an artifact, not as the walk's page count.
    expect(line).toMatchObject({ status: "partial", artifactCount: 1, failureCount: 1 });
    for (const field of COUNT_FIELDS) expect(Object.hasOwn(line, field)).toBe(false);
    expect(JSON.stringify(line)).not.toContain("private-account-body");
  });

  test("a walk refused on its first page leaves both counts out", async () => {
    const { line } = await run([new Response("private-account-body", { status: 503 })]);
    expect(line).toMatchObject({ status: "failed", artifactCount: 0, failureCount: 1 });
    for (const field of COUNT_FIELDS) expect(Object.hasOwn(line, field)).toBe(false);
  });

  test("a run with no credential leaves both counts out and asks nothing", async () => {
    const { line, fetches } = await run(null);
    expect(fetches).toBe(0);
    expect(line).toMatchObject({ status: "failed", artifactCount: 0, failureCount: 1 });
    for (const field of COUNT_FIELDS) expect(Object.hasOwn(line, field)).toBe(false);
  });
});
