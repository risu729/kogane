// `queryLotsOnSelection` (src/query/lots-on-selection.ts) on a synthetic CORE
// store migrated through every migration, with an economic history written
// through CORE 0070's triggers (economic-history-fixture.ts): what it answers
// today (`unsupported`, `security_quantity_writer_missing`, with the manifest
// still produced), why (0070 refuses a security-quantity claim), without CORE
// 0070, an instrument leg no writer claims, B12 (a later commit gives a new
// cut and context; the earlier cut's is unchanged), B13 (equal inputs give
// one manifest), refused queries, and the mapping read's plan without table
// statistics. Every account, instrument, amount and date is invented.
import { describe, expect, test } from "bun:test";
import type { LotPolicy } from "../../domain/src/lots.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture.ts";
import { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import {
  EconomicHistory,
  day,
  storeExecutor,
} from "../../read-model/test/economic-history-fixture.ts";
import { EconomicSelectorError } from "../../read-model/src/economic-selector.ts";
import {
  LOT_INSTRUMENT_MAPPINGS_SQL,
  LotsOnSelectionInputError,
  queryLotsOnSelection,
  type LotsOnSelectionInput,
} from "../src/query/lots-on-selection.ts";

const SEC = "acct-sec";
const BANK = "acct-bank";
const NOW = "2026-04-30T00:00:00.000Z";
const SHARE = "ii-share";
const COIN = "ii-coin";

const POLICY: LotPolicy = {
  policyId: "lot-policy:test",
  version: 1,
  purpose: "investment-analysis",
  method: "fifo",
  scope: "holder-instrument-wrapper",
  timeBasis: "trade-date",
  ordering: "temporal-then-indeterminate",
  acquisitionFee: "capitalize",
  disposalFee: "reduce-proceeds",
  fx: "lot-currency",
  fxPolicyRef: "fx-policy:test@1",
  costUnitRef: null,
  rounding: null,
};

/** A store with a securities account, a bank account and two mapped instrument identifiers. */
function world(): EconomicHistory {
  const h = new EconomicHistory(new DatedStore());
  h.account(SEC);
  h.account(BANK);
  for (const [instrument, identifier, kind] of [
    ["inst-share", SHARE, "security"],
    ["inst-coin", COIN, "crypto"],
  ] as const) {
    h.db.run("INSERT INTO instruments VALUES(?,?,'Synthetic','identified')", [instrument, kind]);
    h.db.run("INSERT INTO instrument_identifiers VALUES(?,'synthetic','test',?,'{}')", [
      identifier,
      identifier,
    ]);
    h.db.run(
      "INSERT INTO instrument_mappings VALUES(?,?,1,?,'manual','synthetic',1,'2026-01-01','Synthetic','identified')",
      [`im-${identifier}`, identifier, instrument],
    );
  }
  return h;
}

const input = (fields: Partial<LotsOnSelectionInput> = {}): LotsOnSelectionInput => ({
  account: SEC,
  wrapperKey: "wrapper:test:general",
  instruments: [SHARE, COIN],
  cut: null,
  policy: POLICY,
  lotSelections: [],
  now: NOW,
  ...fields,
});

/** A logged event moving share units on the securities account; no writer claims a security quantity. */
function moveShares(h: EconomicHistory, eventId: string, knownAt: string) {
  h.adopt({
    eventId,
    revision: 1,
    kind: "fee",
    state: "confirmed",
    legs: [
      {
        subject: `account:${SEC}`,
        unit: SHARE,
        amount: "10",
        role: "increase",
        basis: "trade-date",
        effect: "movement",
      },
      {
        subject: `account:${BANK}`,
        amount: "1000",
        role: "decrease",
        basis: "cash-movement",
        effect: "movement",
      },
    ],
    times: [["trade", day("2026-03-02")]],
    pins: { [`instrument_mapping:${SHARE}`]: 1 },
    knownAt,
  });
}

describe("what it answers today", () => {
  test("without CORE 0070 it is unavailable", async () => {
    const h = world();
    h.db.exec(
      "DROP VIEW unlogged_economic_revisions; DROP VIEW consumption_claim_conflicts; DROP VIEW live_consumption_claims; DROP VIEW economic_revision_claims",
    );
    const result = await queryLotsOnSelection(storeExecutor(h.db), input());
    expect(result).toMatchObject({
      status: "unavailable",
      reasons: ["economic_guard_missing"],
      lots: null,
      manifest: null,
      contextId: null,
    });
  });

  test("an empty log: unsupported, the engine run on no input, the manifest produced", async () => {
    const h = world();
    const result = await queryLotsOnSelection(storeExecutor(h.db), input());
    expect(result.status).toBe("unsupported");
    // An empty log is asked at the caller's instant, which a commit may still reach.
    expect(result.reasons).toEqual([
      "security_quantity_writer_missing",
      "log_empty",
      "cut_provisional",
    ]);
    expect(result.manifest!.lots.cutStanding).toBe("provisional");
    expect(result.cutStanding).toBe("provisional");
    expect(result.lots).toMatchObject({ status: "computed", books: [] });
    expect(result.adaptation).toMatchObject({ securityClaims: 0, inputs: [], entries: [] });
    const manifest = result.manifest!;
    expect(manifest.lots.cut).toEqual({
      requested: { coreEpoch: "core-epoch-1", instant: NOW },
      resolved: { coreEpoch: "core-epoch-1", commitSeq: 0 },
      knownAt: null,
    });
    expect(manifest.lots.lotsManifestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.lots.policyRef).toBe("lot-policy:test@1");
    expect(manifest.lots.holders).toEqual([{ accountId: SEC, wrapperKey: "wrapper:test:general" }]);
    // The mappings read: a crypto identifier states its class, a security does not.
    expect(manifest.lots.instruments).toEqual([
      {
        unitRef: COIN,
        mappingRevision: 1,
        instrumentRef: "instrument:inst-coin",
        status: "identified",
        instrumentClass: "crypto-asset",
      },
      {
        unitRef: SHARE,
        mappingRevision: 1,
        instrumentRef: "instrument:inst-share",
        status: "identified",
        instrumentClass: null,
      },
    ]);
    expect(result.contextId).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("CORE 0070 refuses a security-quantity claim, so no store holds one", () => {
    const h = world();
    const row = h.bankRow("sec-row-1");
    expect(() =>
      h.adopt({
        eventId: "ev-sec",
        revision: 1,
        legs: [
          {
            subject: `account:${SEC}`,
            unit: SHARE,
            amount: "10",
            role: "increase",
            basis: "trade-date",
          },
        ],
        claims: [{ book: "security-quantity", observationId: row }],
      }),
    ).toThrow("economic_claim_book_unsupported");
    expect(h.db.query("SELECT count(*) AS n FROM economic_commit_log").get()).toEqual({ n: 0 });
  });

  test("an instrument leg no writer claims is held, and the answer stays unsupported", async () => {
    const h = world();
    moveShares(h, "ev-move", "2026-04-01T00:00:00.000Z");
    const result = await queryLotsOnSelection(storeExecutor(h.db), input());
    expect(result.status).toBe("unsupported");
    expect(result.reasons).toEqual(["security_quantity_writer_missing", "writer_unsupported"]);
    expect(result.knowledge!.revisions).toBe(1);
    expect(result.adaptation!.entries).toEqual([
      {
        ref: "event:ev-move@1",
        outcome: "held",
        codes: ["writer_unsupported"],
        missingTimeRoles: [],
        books: [
          {
            holderRef: `account:${SEC}`,
            instrumentRef: "instrument:inst-share",
            wrapperKey: "wrapper:test:general",
          },
        ],
      },
    ]);
    expect(result.adaptation!.books[0]!.status).toBe("needs_review");
    expect(result.adaptation!.inputs).toEqual([]);
    expect(result.manifest!.lots.identity.pins).toEqual([
      ["ev-move@1", `instrument_mapping:${SHARE}`, 1],
    ]);
  });

  test("a cash event on the account is outside the instrument scope", async () => {
    const h = world();
    h.adopt({
      eventId: "ev-cash",
      revision: 1,
      legs: [
        { subject: `account:${SEC}`, amount: "500", role: "decrease", basis: "cash-movement" },
      ],
      knownAt: "2026-04-01T00:00:00.000Z",
    });
    const result = await queryLotsOnSelection(storeExecutor(h.db), input());
    expect(result.knowledge!.revisions).toBe(0);
    expect(result.reasons).toEqual(["security_quantity_writer_missing"]);
  });
});

describe("B12 and B13", () => {
  test("B12: a later commit gives a new cut and context; the earlier cut's is unchanged", async () => {
    const h = world();
    moveShares(h, "ev-1", "2026-04-01T00:00:00.000Z");
    const first = await queryLotsOnSelection(storeExecutor(h.db), input());
    expect(first.manifest!.lots.cut.resolved.commitSeq).toBe(1);
    expect(first.cutStanding).toBe("final");
    moveShares(h, "ev-2", "2026-04-02T00:00:00.000Z");
    const later = await queryLotsOnSelection(storeExecutor(h.db), input());
    expect(later.manifest!.lots.cut.resolved.commitSeq).toBe(2);
    expect(later.knowledge!.setVersion).not.toBe(first.knowledge!.setVersion);
    expect(later.contextId).not.toBe(first.contextId);
    const atOne = await queryLotsOnSelection(
      storeExecutor(h.db),
      input({ cut: { coreEpoch: "core-epoch-1", commitSeq: 1 } }),
    );
    expect(atOne.contextId).toBe(first.contextId);
    expect(atOne.adaptation).toEqual(first.adaptation);
  });

  test("B13: the same question twice, instruments in any order, gives one manifest", async () => {
    const h = world();
    moveShares(h, "ev-1", "2026-04-01T00:00:00.000Z");
    const one = await queryLotsOnSelection(storeExecutor(h.db), input());
    const two = await queryLotsOnSelection(
      storeExecutor(h.db),
      input({ instruments: [COIN, SHARE] }),
    );
    expect(two.contextId).toBe(one.contextId);
    expect(two.manifest).toEqual(one.manifest);
    const other = await queryLotsOnSelection(
      storeExecutor(h.db),
      input({ policy: { ...POLICY, method: "moving-average" } }),
    );
    expect(other.contextId).not.toBe(one.contextId);
  });
});

describe("refused queries", () => {
  test("malformed inputs are invalid_query; a future cut is cut_in_future", async () => {
    const h = world();
    const sql = storeExecutor(h.db);
    for (const fields of [
      { account: "" },
      { wrapperKey: "" },
      { instruments: [] },
      { instruments: [SHARE, SHARE] },
      { now: "yesterday" },
      { policy: { ...POLICY, extra: 1 } as unknown as LotPolicy },
      { lotSelections: [{ disposalRef: "event:x@1", selections: [], note: 1 }] as never },
    ] satisfies Partial<LotsOnSelectionInput>[])
      await expect(queryLotsOnSelection(sql, input(fields))).rejects.toBeInstanceOf(
        LotsOnSelectionInputError,
      );
    await expect(
      queryLotsOnSelection(sql, { ...input(), extra: true } as unknown as LotsOnSelectionInput),
    ).rejects.toThrow("invalid_query");
    await expect(
      queryLotsOnSelection(
        sql,
        input({ cut: { coreEpoch: "core-epoch-1", instant: "2026-05-01T00:00:00.000Z" } }),
      ),
    ).rejects.toThrow("cut_in_future");
  });

  test("a cut past the log's end or of another epoch is the selector's refusal", async () => {
    const h = world();
    const sql = storeExecutor(h.db);
    await expect(
      queryLotsOnSelection(sql, input({ cut: { coreEpoch: "core-epoch-1", commitSeq: 3 } })),
    ).rejects.toBeInstanceOf(EconomicSelectorError);
    await expect(
      queryLotsOnSelection(sql, input({ cut: { coreEpoch: "core-epoch-9", commitSeq: 1 } })),
    ).rejects.toThrow("cut_epoch_not_current");
  });

  test("a null policy is the engine's policy_missing, still with a manifest", async () => {
    const h = world();
    const result = await queryLotsOnSelection(storeExecutor(h.db), input({ policy: null }));
    expect(result.reasons).toEqual([
      "security_quantity_writer_missing",
      "policy_missing",
      "log_empty",
      "cut_provisional",
    ]);
    expect(result.manifest!.lots.lotsManifestDigest).toBeNull();
    expect(result.contextId).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("the mapping read", () => {
  test("reads instrument_mappings and instruments by key on the complete CORE schema, without statistics", () => {
    const db = fullCoreSchema();
    expect(
      db.query("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'sqlite_stat%'").get(),
    ).toEqual({ n: 0 });
    const steps = explain(db, LOT_INSTRUMENT_MAPPINGS_SQL, [JSON.stringify([SHARE, COIN])]);
    const scans = steps
      .filter((step) => step.detail.startsWith("SCAN ") && !step.detail.includes("VIRTUAL TABLE"))
      .map((step) => step.detail);
    expect(scans).toEqual([]);
    expect(steps.some((step) => /^SEARCH m USING (COVERING )?INDEX/u.test(step.detail))).toBe(true);
    expect(
      steps.some((step) => /^SEARCH i USING INDEX sqlite_autoindex_instruments/u.test(step.detail)),
    ).toBe(true);
  });
});
