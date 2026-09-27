// ADR 0030: the pure half of the identity crosswalk. The SQL is exercised on
// real migrations in services/processor/test/identity-crosswalk.test.ts; this
// file pins the value shapes and the verdict rule. Synthetic values only.
import { describe, expect, test } from "bun:test";
import {
  crosswalkAccountKey,
  crosswalkKeyValue,
  type CrosswalkProposalRow,
  crosswalkProposals,
  importerEntityId,
  isCrosswalkValue,
} from "../src/core/identity-crosswalk.ts";
import { identityKey } from "../src/core/identity-keys.ts";

const vpass = (version: number, fill: string) => `vpass-card-v${version}-${fill.repeat(64)}`;
const mf = (version: number, fill: string) => `moneyforward-account-v${version}-${fill.repeat(64)}`;

describe("identity values", () => {
  test("both derivations of both sources are values; nothing else is", () => {
    for (const version of [1, 2]) {
      expect(isCrosswalkValue("vpass", vpass(version, "a"))).toBe(true);
      expect(isCrosswalkValue("moneyforward-me", mf(version, "a"))).toBe(true);
      expect(crosswalkKeyValue("vpass", ["vpass:card", vpass(version, "a")])).toBe(
        vpass(version, "a"),
      );
      expect(crosswalkKeyValue("moneyforward-me", [`moneyforward-me:${mf(version, "a")}`])).toBe(
        mf(version, "a"),
      );
    }
    for (const [source, key] of [
      ["vpass", ["vpass:card", vpass(3, "a")]],
      ["vpass", ["vpass:card", vpass(2, "A")]],
      ["vpass", ["vpass:card-001", "fetch-run", "7"]],
      ["vpass", ["vpass:card", mf(2, "a")]],
      ["moneyforward-me", [`moneyforward-me:${vpass(2, "a")}`]],
      ["moneyforward-me", ["moneyforward-me:account-01"]],
      ["moneyforward-me", [mf(2, "a")]],
      ["mizuho-bank", [`moneyforward-me:${mf(2, "a")}`]],
    ] as const)
      expect(crosswalkKeyValue(source, key)).toBeNull();
  });

  test("the importer-era entity is the one the importer's own reference derives", async () => {
    for (const [source, value] of [
      ["vpass", vpass(1, "b")],
      ["moneyforward-me", mf(1, "b")],
    ] as const) {
      const reference = await identityKey("sa", [
        source,
        "collector-r2-importer",
        crosswalkAccountKey(source, value),
      ]);
      expect(await importerEntityId(source, value)).toBe(await identityKey("account", [reference]));
      expect(crosswalkKeyValue(source, crosswalkAccountKey(source, value))).toBe(value);
    }
  });
});

describe("proposals", () => {
  const row = (
    newRef: string,
    oldRef: string | null,
    shared: number,
    totals: { new: number; old?: number; months?: number },
  ): CrosswalkProposalRow => ({
    source_id: "vpass",
    new_ref: newRef,
    new_total: totals.new,
    old_ref: oldRef,
    shared,
    months: totals.months ?? (shared > 0 ? 1 : 0),
    old_total: totals.old ?? null,
  });

  test("one-to-one is unique, anything shared otherwise is ambiguous, nothing shared is none", () => {
    const out = crosswalkProposals([
      row(vpass(2, "1"), vpass(1, "1"), 5, { new: 6, old: 9, months: 2 }),
      // New 2 shares with two old values.
      row(vpass(2, "2"), vpass(1, "2"), 3, { new: 4, old: 3 }),
      row(vpass(2, "2"), vpass(1, "3"), 1, { new: 4, old: 1 }),
      // Old 4 is shared by two new values.
      row(vpass(2, "3"), vpass(1, "4"), 2, { new: 2, old: 5 }),
      row(vpass(2, "4"), vpass(1, "4"), 1, { new: 1, old: 5 }),
      row(vpass(2, "5"), null, 0, { new: 7 }),
    ]);
    expect(out.map((line) => line.verdict)).toEqual([
      "unique",
      "ambiguous",
      "ambiguous",
      "ambiguous",
      "ambiguous",
      "none",
    ]);
    expect(out[0]).toEqual({
      source: "vpass",
      newKeyRef: vpass(2, "1"),
      oldKeyRef: vpass(1, "1"),
      sharedRows: 5,
      newOnlyRows: 1,
      oldOnlyRows: 4,
      months: 2,
      verdict: "unique",
    });
    // No candidate: the old side is a missing value, not zero rows.
    expect(out[5]).toEqual({
      source: "vpass",
      newKeyRef: vpass(2, "5"),
      oldKeyRef: null,
      sharedRows: 0,
      newOnlyRows: 7,
      oldOnlyRows: null,
      months: 0,
      verdict: "none",
    });
  });

  test("a line carries the eight named fields: identity values, counts and a verdict", () => {
    const out = crosswalkProposals([
      row(vpass(2, "1"), vpass(1, "1"), 1, { new: 1, old: 1 }),
      row(vpass(2, "2"), null, 0, { new: 1 }),
    ]);
    for (const line of out) {
      expect(Object.keys(line).sort()).toEqual(
        [
          "months",
          "newKeyRef",
          "newOnlyRows",
          "oldKeyRef",
          "oldOnlyRows",
          "sharedRows",
          "source",
          "verdict",
        ].sort(),
      );
      for (const [key, value] of Object.entries(line)) {
        if (key === "source" || key === "verdict") continue;
        if (key === "newKeyRef" || key === "oldKeyRef") {
          if (value !== null) expect(isCrosswalkValue("vpass", value)).toBe(true);
        } else if (value !== null) expect(Number.isSafeInteger(value)).toBe(true);
      }
    }
  });
});
