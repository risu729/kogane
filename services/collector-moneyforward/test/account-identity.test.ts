// ADR 0027: the collector derives the account identity the parser requires,
// with the retired importer's tuple, checks and HMAC. Synthetic pages, tuples
// and keys only: no value here is a provider's.
import { describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/index";
import {
  moneyForwardRunPlan,
  persistSharedRun,
  sharedRunDiagnostic,
  type MoneyForwardIdentityState,
  type SharedRunInput,
} from "../src/shared-collection";
import worker from "../src/worker";

const runId = "3f2504e0-4f89-41d3-9a0c-0305e82c3327";
const schemaVersion = "moneyforward-worker-poc-v1";
const KEY = "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0";
const OTHER_KEY = "ab".repeat(32);
/**
 * Known answers computed by the retired importer's own
 * `moneyForwardAccountKeys` (git `49d5d65^:services/collector-r2-importer/src/moneyforward-account-identity.ts`)
 * on the pages `detail(1, "synthetic-account-a", "synthetic-service-1")` and
 * `detail(2, "synthetic-account-b", "synthetic-service-2")` under `KEY`, and
 * the first checked with `openssl dgst -sha256 -mac HMAC`.
 */
const IMPORTER_TOKEN_A =
  "moneyforward-account-v1-205be4208b34c414dba938ec50b50b6caf1117f464b179850c38741fbde9ecb5";
const IMPORTER_TOKEN_B =
  "moneyforward-account-v1-ddaf1a1aa537707640916a1b2fc08fd984c7c76206965e3800256f8b277bf982";
const TOKEN = /^moneyforward-account-v1-[0-9a-f]{64}$/u;

const HTML = "text/html; charset=utf-8";
const pad = (ordinal: number) => String(ordinal).padStart(2, "0");

function index(ids: readonly string[]) {
  return {
    dataset: "accounts-index",
    filename: "accounts.html",
    mediaType: HTML,
    body: `<!doctype html><html><body><table id="account-table">${ids
      .map((id) => `<tr><td><a href="/accounts/show/${id}">synthetic</a></td></tr>`)
      .join("")}</table></body></html>`,
  };
}

function detailBody(inputs: string): string {
  return `<!doctype html><html><head><meta name="csrf-token" content="synthetic-csrf"></head><body>${inputs}</body></html>`;
}

function detail(ordinal: number, account: string, service: string) {
  return {
    dataset: "account-detail",
    filename: `account-detail-${pad(ordinal)}.html`,
    mediaType: HTML,
    body: detailBody(
      `<input name="account[id_hash]" value="${account}"><input name="service[id]" value="${service}">`,
    ),
  };
}

function month(ordinal: number, label: string) {
  return {
    dataset: "monthly-transactions",
    filename: `account-${pad(ordinal)}-month-${label}.html`,
    mediaType: HTML,
    body: `<div id="calendar"></div>`,
  };
}

function input(
  artifacts: SharedRunInput["artifacts"],
  overrides: Partial<SharedRunInput> = {},
): SharedRunInput {
  return {
    schemaVersion,
    runId,
    startedAt: "2026-09-11T21:15:00.000Z",
    completedAt: "2026-09-11T21:17:00.000Z",
    status: "success",
    accountDetailCount: artifacts.filter((artifact) => artifact.dataset === "account-detail")
      .length,
    monthlyFragmentCount: artifacts.filter(
      (artifact) => artifact.dataset === "monthly-transactions",
    ).length,
    artifacts,
    failures: [],
    ...overrides,
  };
}

const twoAccounts = () =>
  input([
    index(["synthetic-account-a", "synthetic-account-b"]),
    detail(1, "synthetic-account-a", "synthetic-service-1"),
    month(1, "2026-08"),
    month(1, "2026-09"),
    detail(2, "synthetic-account-b", "synthetic-service-2"),
    month(2, "2026-09"),
  ]);

/** The importer's construction, written out with a second HMAC implementation. */
function independentToken(key: string, account: string, service: string): string {
  const mac = createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify(["moneyforward-account-v1", account, service]))
    .digest("hex");
  return `moneyforward-account-v1-${mac}`;
}

async function unitOf(run: SharedRunInput, key: string | undefined, filename: string) {
  const plan = await moneyForwardRunPlan(run, key);
  return plan.artifacts.find((artifact) => artifact.artifactKey === filename)?.unitKey;
}

describe("ADR 0027 the unit key is the importer's account identity", () => {
  test("the identity equals the importer's known answer and an independent HMAC", async () => {
    const plan = await moneyForwardRunPlan(twoAccounts(), KEY);
    expect(IMPORTER_TOKEN_A).toBe(
      independentToken(KEY, "synthetic-account-a", "synthetic-service-1"),
    );
    expect(IMPORTER_TOKEN_B).toBe(
      independentToken(KEY, "synthetic-account-b", "synthetic-service-2"),
    );
    // Filenames stay positional; only the unit is the identity.
    expect(
      plan.artifacts.map((artifact) => [artifact.artifactKey, artifact.unitKey] as const),
    ).toEqual([
      ["accounts.html", undefined],
      ["account-detail-01.html", IMPORTER_TOKEN_A],
      ["account-01-month-2026-08.html", IMPORTER_TOKEN_A],
      ["account-01-month-2026-09.html", IMPORTER_TOKEN_A],
      ["account-detail-02.html", IMPORTER_TOKEN_B],
      ["account-02-month-2026-09.html", IMPORTER_TOKEN_B],
      ["manifest.json", undefined],
    ]);
    const sorted = [IMPORTER_TOKEN_A, IMPORTER_TOKEN_B].sort();
    expect(plan.run.requestedScope.unitKeys).toEqual(sorted);
    expect(plan.run.units).toEqual(
      sorted.map((unitKey) => ({
        unitKey,
        unitKind: "account",
        artifactCount: unitKey === IMPORTER_TOKEN_A ? 3 : 2,
        coverageStatus: "complete",
      })),
    );
    expect(plan.run.ranges.map((range) => [range.rangeKey, range.unitKey])).toEqual(
      sorted.map((unitKey) => [`months-${unitKey}`, unitKey]),
    );
  });

  test("the terminal and the log carry the identity, never the identifiers or the key", async () => {
    const bucket = new FakeR2Bucket();
    const run = twoAccounts();
    const outcome = await persistSharedRun(bucket, run, KEY);
    expect(outcome.result.outcome).toBe("persisted");
    expect(outcome.identity).toBe("derived");
    const read = await readTerminal(bucket, "moneyforward-me", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    const terminal = JSON.stringify(read.manifest);
    const diagnostic = JSON.stringify(sharedRunDiagnostic(run, outcome));
    expect(diagnostic).toContain('"identity":"derived"');
    for (const text of [terminal, diagnostic]) {
      for (const secret of ["synthetic-account", "synthetic-service", KEY]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(terminal).toContain(IMPORTER_TOKEN_A);
    expect(diagnostic).not.toContain("moneyforward-account-v1-");
    // The stored manifest artifact is unchanged by the identity: it names
    // objects, not units.
    const manifestEntry = read.manifest.artifacts.find(
      (artifact) => artifact.artifactKey === "manifest.json",
    )!;
    const body = await bucket.get(manifestEntry.storageRef.key);
    const stored = new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer()));
    expect(stored).not.toContain("moneyforward-account-v1-");
    expect(stored).not.toContain(KEY);
  });

  test("the identity survives ordinal movement and separates exact tuples and keys", async () => {
    const before = input([
      index(["synthetic-beta"]),
      detail(1, "synthetic-beta", "service"),
      month(1, "2026-09"),
    ]);
    const after = input([
      index(["synthetic-alpha", "synthetic-beta"]),
      detail(1, "synthetic-alpha", "service"),
      month(1, "2026-09"),
      detail(2, "synthetic-beta", "service"),
      month(2, "2026-09"),
    ]);
    const beta = await unitOf(before, KEY, "account-01-month-2026-09.html");
    expect(beta).toMatch(TOKEN);
    expect(await unitOf(after, KEY, "account-02-month-2026-09.html")).toBe(beta);
    expect(await unitOf(after, KEY, "account-01-month-2026-09.html")).not.toBe(beta);
    const service = input([detail(1, "synthetic-beta", "other"), month(1, "2026-09")]);
    expect(await unitOf(service, KEY, "account-01-month-2026-09.html")).not.toBe(beta);
    const tupleA = input([detail(1, "ab", "c")]);
    const tupleB = input([detail(1, "a", "bc")]);
    expect(await unitOf(tupleA, KEY, "account-detail-01.html")).not.toBe(
      await unitOf(tupleB, KEY, "account-detail-01.html"),
    );
    expect(await unitOf(before, OTHER_KEY, "account-01-month-2026-09.html")).not.toBe(beta);
    expect(await unitOf(before, OTHER_KEY, "account-01-month-2026-09.html")).toMatch(TOKEN);
  });

  test("the tuple is read as parse5 reads it, template content included", async () => {
    const templated = input([
      {
        ...detail(1, "x", "y"),
        body: detailBody(
          `<template><input name="account[id_hash]" value="synthetic-account-a"></template><input name='service[id]' value=synthetic-service-1>`,
        ),
      },
    ]);
    expect(await unitOf(templated, KEY, "account-detail-01.html")).toBe(IMPORTER_TOKEN_A);
  });
});

describe("ADR 0027 no identity: the run keeps positional units and logs one code", () => {
  const cases: [string, SharedRunInput, string | undefined, MoneyForwardIdentityState][] = [
    ["no key", twoAccounts(), undefined, "identity_key_absent"],
    ["an empty key", twoAccounts(), "", "identity_key_absent"],
    ["an uppercase key", twoAccounts(), KEY.toUpperCase(), "identity_key_invalid"],
    ["a short key", twoAccounts(), KEY.slice(2), "identity_key_invalid"],
    [
      "a detail without the service id",
      input([
        {
          ...detail(1, "x", "y"),
          body: detailBody(`<input name="account[id_hash]" value="synthetic-account-a">`),
        },
      ]),
      KEY,
      "identity_tuple_absent",
    ],
    [
      "a repeated input",
      input([
        {
          ...detail(1, "x", "y"),
          body: detailBody(
            `<input name="account[id_hash]" value="a"><input name="account[id_hash]" value="a"><input name="service[id]" value="s">`,
          ),
        },
      ]),
      KEY,
      "identity_tuple_invalid",
    ],
    ["an empty value", input([detail(1, "", "s")]), KEY, "identity_tuple_invalid"],
    ["a value with a space", input([detail(1, "has space", "s")]), KEY, "identity_tuple_invalid"],
    ["a value with a slash", input([detail(1, "a/b", "s")]), KEY, "identity_tuple_invalid"],
    ["an overlong value", input([detail(1, "x".repeat(4097), "s")]), KEY, "identity_tuple_invalid"],
    [
      "two details with one tuple",
      input([detail(1, "same", "s"), detail(2, "same", "s")]),
      KEY,
      "identity_duplicate",
    ],
    [
      "a detail that is not the index's account at its ordinal",
      input([index(["synthetic-alpha", "synthetic-beta"]), detail(1, "synthetic-beta", "s")]),
      KEY,
      "identity_index_mismatch",
    ],
    [
      "a month of an account without a detail",
      input([detail(1, "a", "s"), month(1, "2026-09"), month(2, "2026-09")]),
      KEY,
      "identity_incomplete",
    ],
    [
      "a successful run with fewer details than it counted",
      input([detail(1, "a", "s")], { accountDetailCount: 2 }),
      KEY,
      "identity_incomplete",
    ],
  ];
  for (const [name, run, key, code] of cases) {
    test(name, async () => {
      const bucket = new FakeR2Bucket();
      const outcome = await persistSharedRun(bucket, run, key);
      expect(outcome.result.outcome).toBe("persisted");
      expect(outcome.identity).toBe(code);
      const read = await readTerminal(bucket, "moneyforward-me", runId);
      if (read.outcome !== "found") throw new Error("unreachable");
      expect(read.manifest.units.length).toBeGreaterThan(0);
      expect(read.manifest.units.every((unit) => /^account-\d{2}$/u.test(unit.unitKey))).toBe(true);
      const diagnostic = sharedRunDiagnostic(run, outcome);
      expect(diagnostic["identity"]).toBe(code);
      const text = JSON.stringify(diagnostic);
      expect(text).not.toContain("synthetic-account");
      if (key) expect(text).not.toContain(key);
    });
  }
});

describe("ADR 0027 the Worker reads the optional secret", () => {
  async function trigger(extra: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const records: Record<string, unknown>[] = [];
    const spies = [
      spyOn(console, "log").mockImplementation((value) =>
        records.push(JSON.parse(String(value)) as Record<string, unknown>),
      ),
      spyOn(console, "error").mockImplementation((value) =>
        records.push(JSON.parse(String(value)) as Record<string, unknown>),
      ),
    ];
    try {
      // Missing credential deliberately fails before any provider request.
      await worker.fetch(
        new Request("https://worker.invalid/trigger", {
          method: "POST",
          headers: { authorization: "Bearer synthetic-admin" },
        }) as Request<unknown, IncomingRequestCfProperties>,
        {
          ADMIN_TRIGGER_TOKEN: "synthetic-admin",
          COLLECTOR_SCHEMA_VERSION: schemaVersion,
          DATA: new FakeR2Bucket(),
          ...extra,
        } as unknown as Env,
      );
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    return records;
  }

  test("the persist diagnostic states the identity code and never the key", async () => {
    const without = await trigger({});
    expect(
      without.find((record) => record.event === "moneyforward-shared-collection")?.["identity"],
    ).toBe("identity_key_absent");
    const invalid = await trigger({ MONEYFORWARD_ACCOUNT_IDENTITY_KEY: "not-hex" });
    expect(
      invalid.find((record) => record.event === "moneyforward-shared-collection")?.["identity"],
    ).toBe("identity_key_invalid");
    const withKey = await trigger({ MONEYFORWARD_ACCOUNT_IDENTITY_KEY: KEY });
    expect(
      withKey.find((record) => record.event === "moneyforward-shared-collection")?.["identity"],
    ).toBe("derived");
    expect(JSON.stringify([without, invalid, withKey])).not.toContain(KEY);
  });
});
