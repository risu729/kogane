// ADR 0027 and ADR 0029: the collector derives the account identity the
// parser requires, with the retired importer's tuple and checks, as an
// unkeyed, domain-separated SHA-256 (`moneyforward-account-v2-`). Synthetic
// pages and tuples only: no value here is a provider's.
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
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
/**
 * Known answers for the pages `detail(1, "synthetic-account-a",
 * "synthetic-service-1")` and `detail(2, "synthetic-account-b",
 * "synthetic-service-2")`, computed outside this code with
 * `printf '%s' '["moneyforward-account-v2","synthetic-account-a","synthetic-service-1"]' | sha256sum`
 * (and likewise for B). Pinned as literals so a silent change of the domain
 * string, the tuple order or the encoding fails here.
 */
const TOKEN_A =
  "moneyforward-account-v2-2dc934287d14c0bcfbf95309174a182fdf4eb7d1d674b601c079390fea687aae";
const TOKEN_B =
  "moneyforward-account-v2-8b1264e5db14410381e1d9d571928ee58827f48773254d1e335a8c49febd10d8";
const TOKEN = /^moneyforward-account-v2-[0-9a-f]{64}$/u;

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

/** The construction, written out with a second SHA-256 implementation. */
function independentToken(domain: string, account: string, service: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([domain, account, service]))
    .digest("hex");
  return `${domain}-${digest}`;
}

async function unitOf(run: SharedRunInput, filename: string) {
  const plan = await moneyForwardRunPlan(run);
  return plan.artifacts.find((artifact) => artifact.artifactKey === filename)?.unitKey;
}

describe("ADR 0029 the unit key is the unkeyed v2 account identity", () => {
  test("the identity equals the pinned known answer and an independent SHA-256", async () => {
    const plan = await moneyForwardRunPlan(twoAccounts());
    expect(TOKEN_A).toBe(
      independentToken("moneyforward-account-v2", "synthetic-account-a", "synthetic-service-1"),
    );
    expect(TOKEN_B).toBe(
      independentToken("moneyforward-account-v2", "synthetic-account-b", "synthetic-service-2"),
    );
    // The domain string separates the derivation: the same tuple under the
    // v1 domain, or with its fields swapped, is another value.
    expect(
      independentToken(
        "moneyforward-account-v1",
        "synthetic-account-a",
        "synthetic-service-1",
      ).slice(-64),
    ).not.toBe(TOKEN_A.slice(-64));
    expect(
      independentToken("moneyforward-account-v2", "synthetic-service-1", "synthetic-account-a"),
    ).not.toBe(TOKEN_A);
    // No key parameter exists any more.
    expect(moneyForwardRunPlan.length).toBe(1);
    // Filenames stay positional; only the unit is the identity.
    expect(
      plan.artifacts.map((artifact) => [artifact.artifactKey, artifact.unitKey] as const),
    ).toEqual([
      ["accounts.html", undefined],
      ["account-detail-01.html", TOKEN_A],
      ["account-01-month-2026-08.html", TOKEN_A],
      ["account-01-month-2026-09.html", TOKEN_A],
      ["account-detail-02.html", TOKEN_B],
      ["account-02-month-2026-09.html", TOKEN_B],
      ["manifest.json", undefined],
    ]);
    const sorted = [TOKEN_A, TOKEN_B].sort();
    expect(plan.run.requestedScope.unitKeys).toEqual(sorted);
    expect(plan.run.units).toEqual(
      sorted.map((unitKey) => ({
        unitKey,
        unitKind: "account",
        artifactCount: unitKey === TOKEN_A ? 3 : 2,
        coverageStatus: "complete",
      })),
    );
    expect(plan.run.ranges.map((range) => [range.rangeKey, range.unitKey])).toEqual(
      sorted.map((unitKey) => [`months-${unitKey}`, unitKey]),
    );
  });

  test("the terminal and the log carry the identity, never the identifiers", async () => {
    const bucket = new FakeR2Bucket();
    const run = twoAccounts();
    const outcome = await persistSharedRun(bucket, run);
    expect(outcome.result.outcome).toBe("persisted");
    expect(outcome.identity).toBe("derived");
    const read = await readTerminal(bucket, "moneyforward-me", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    const terminal = JSON.stringify(read.manifest);
    const diagnostic = JSON.stringify(sharedRunDiagnostic(run, outcome));
    expect(diagnostic).toContain('"identity":"derived"');
    for (const text of [terminal, diagnostic]) {
      for (const secret of ["synthetic-account", "synthetic-service"]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(terminal).toContain(TOKEN_A);
    expect(diagnostic).not.toContain("moneyforward-account-v");
    // The stored manifest artifact is unchanged by the identity: it names
    // objects, not units.
    const manifestEntry = read.manifest.artifacts.find(
      (artifact) => artifact.artifactKey === "manifest.json",
    )!;
    const body = await bucket.get(manifestEntry.storageRef.key);
    const stored = new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer()));
    expect(stored).not.toContain("moneyforward-account-v");
  });

  test("the identity survives ordinal movement and separates exact tuples", async () => {
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
    const beta = await unitOf(before, "account-01-month-2026-09.html");
    expect(beta).toMatch(TOKEN);
    expect(await unitOf(after, "account-02-month-2026-09.html")).toBe(beta);
    expect(await unitOf(after, "account-01-month-2026-09.html")).not.toBe(beta);
    const service = input([detail(1, "synthetic-beta", "other"), month(1, "2026-09")]);
    expect(await unitOf(service, "account-01-month-2026-09.html")).not.toBe(beta);
    const tupleA = input([detail(1, "ab", "c")]);
    const tupleB = input([detail(1, "a", "bc")]);
    expect(await unitOf(tupleA, "account-detail-01.html")).not.toBe(
      await unitOf(tupleB, "account-detail-01.html"),
    );
    expect(beta).toBe(independentToken("moneyforward-account-v2", "synthetic-beta", "service"));
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
    expect(await unitOf(templated, "account-detail-01.html")).toBe(TOKEN_A);
  });
});

describe("ADR 0027 no identity: the run keeps positional units and logs one code", () => {
  const cases: [string, SharedRunInput, MoneyForwardIdentityState][] = [
    [
      "a detail without the service id",
      input([
        {
          ...detail(1, "x", "y"),
          body: detailBody(`<input name="account[id_hash]" value="synthetic-account-a">`),
        },
      ]),
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
      "identity_tuple_invalid",
    ],
    ["an empty value", input([detail(1, "", "s")]), "identity_tuple_invalid"],
    ["a value with a space", input([detail(1, "has space", "s")]), "identity_tuple_invalid"],
    ["a value with a slash", input([detail(1, "a/b", "s")]), "identity_tuple_invalid"],
    ["an overlong value", input([detail(1, "x".repeat(4097), "s")]), "identity_tuple_invalid"],
    [
      "two details with one tuple",
      input([detail(1, "same", "s"), detail(2, "same", "s")]),
      "identity_duplicate",
    ],
    [
      "a detail that is not the index's account at its ordinal",
      input([index(["synthetic-alpha", "synthetic-beta"]), detail(1, "synthetic-beta", "s")]),
      "identity_index_mismatch",
    ],
    [
      "a month of an account without a detail",
      input([detail(1, "a", "s"), month(1, "2026-09"), month(2, "2026-09")]),
      "identity_incomplete",
    ],
    [
      "a successful run with fewer details than it counted",
      input([detail(1, "a", "s")], { accountDetailCount: 2 }),
      "identity_incomplete",
    ],
  ];
  for (const [name, run, code] of cases) {
    test(name, async () => {
      const bucket = new FakeR2Bucket();
      const outcome = await persistSharedRun(bucket, run);
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
    });
  }
});

describe("ADR 0029 the Worker needs no identity secret", () => {
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

  test("no secret is read: a run derives with none set, and a retired secret changes nothing", async () => {
    const identity = (records: Record<string, unknown>[]) =>
      records.find((record) => record.event === "moneyforward-shared-collection")?.["identity"];
    const without = await trigger({});
    expect(identity(without)).toBe("derived");
    const retired = "0f".repeat(32);
    const withRetired = await trigger({ MONEYFORWARD_ACCOUNT_IDENTITY_KEY: retired });
    expect(identity(withRetired)).toBe("derived");
    expect(JSON.stringify(withRetired)).not.toContain(retired);
  });
});
