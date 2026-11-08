import { beforeAll, expect, test } from "bun:test";
import { QualityStore } from "./collection-quality-fixture.ts";
import { fullCoreSchema } from "./card-usage-scale-fixture.ts";
import {
  TERMINAL_QUALITY_SQL,
  UNREGISTERED_QUALITY_SQL,
  type TerminalQualityRow,
  type UnregisteredQualityRow,
} from "../src/collection-quality.ts";
import {
  LEGACY_TERMINAL_QUALITY_SQL,
  LEGACY_UNREGISTERED_QUALITY_SQL,
} from "./collection-quality-terminals-legacy-sql.ts";
import { explain } from "./card-usage-plan.ts";

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

test("failure buckets preserve shipped counts, newest-row selection and terminal projections on seeded stores", () => {
  const store = new QualityStore();
  try {
    let seed = 1143;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const pairs: string[][] = [];
    for (let index = 0; index < 180; index++) {
      const source = next() % 3 === 0 ? "myjcb" : "vpass";
      const runId = `synthetic-${index}`;
      pairs.push([source, runId]);
      const codes = [undefined, "login-unrecognized-page", "authentication-required"];
      const code = codes[next() % codes.length];
      const spec = {
        source,
        runId,
        outcome: "failed" as const,
        seenAt: `2099-01-${String(1 + (next() % 28)).padStart(2, "0")}T00:00:00.000Z`,
        ...(code === undefined ? {} : { providerFailureCode: code }),
        ...(next() % 3 === 0 ? {} : { blockedCode: "provider_run_failed" }),
      };
      store.terminal({ ...spec, contract: "terminal-registration-v1" });
      if (index % 4 === 0)
        store.terminal({
          ...spec,
          contract: "terminal-registration-v2",
          providerFailureCode: "timeout",
        });
      if (index % 11 === 0) {
        const registered = store.run({ source, at: "2099-01-01T00:00:00Z", artifacts: [] });
        store.terminal({
          source,
          runId,
          outcome: "failed",
          fetchRun: registered.run,
          contract: "terminal-registration-v3",
          providerFailureCode: "timeout",
        });
      }
    }
    for (const sources of [["vpass"], ["myjcb"], ["vpass", "myjcb"], []]) {
      const args = [JSON.stringify(sources)];
      const legacy = store.all(LEGACY_UNREGISTERED_QUALITY_SQL, args);
      const rolledUp = store.all(
        `SELECT source, blocked_code, SUM(runs) AS runs, MAX(newest_seen_at) AS newest_seen_at
        FROM (${UNREGISTERED_QUALITY_SQL}) GROUP BY source, blocked_code ORDER BY source, blocked_code`,
        args,
      );
      expect(rolledUp).toEqual(legacy);
      const buckets = store.all<UnregisteredQualityRow>(UNREGISTERED_QUALITY_SQL, args);
      if (sources.length > 0)
        expect(buckets.some((row) => row.provider_failure_code === "login-unrecognized-page")).toBe(
          true,
        );
      const scans = explain(store.db, UNREGISTERED_QUALITY_SQL, args).filter(
        (row) => row.detail.startsWith("SCAN ") && !row.detail.includes("wanted VIRTUAL TABLE"),
      );
      expect(scans).toEqual([]);
    }
    const args = [JSON.stringify(pairs)];
    const oldTerminals = store.all(LEGACY_TERMINAL_QUALITY_SQL, args);
    const newTerminals = store.all<TerminalQualityRow>(TERMINAL_QUALITY_SQL, args);
    expect(newTerminals.map(({ provider_failure_code: _code, ...row }) => row)).toEqual(
      oldTerminals,
    );
    expect(newTerminals.some((row) => row.provider_failure_code === "timeout")).toBe(true);
  } finally {
    store.db.close();
  }
});
