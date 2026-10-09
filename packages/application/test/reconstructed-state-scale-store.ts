// The store of the reconstructed state's cost measurements: the scaled
// statement store of packages/read-model/test/card-usage-scale-fixture.ts
// (the complete CORE schema, no table statistics) with settlements on its
// SMBC account written through CORE 0070's triggers, spread over the year
// before the store's last day and each revised under the log. Built once on
// `bun:sqlite`; reconstructed-state-scale.test.ts reads it there, and
// services/app/scripts/reconstructed-state-workerd.ts copies it into a
// Miniflare D1 to read it on workerd. Synthetic values only.
import type { Database } from "bun:sqlite";
import { KNOWN_WRITER_RELEASES } from "../../domain/src/reconstruction-adapter.ts";
import {
  STATEMENT_CI_SCALE,
  STATEMENT_SCALE,
  scaledStore,
} from "../../read-model/test/card-usage-scale-fixture.ts";
import type { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import { EconomicHistory, day } from "../../read-model/test/economic-history-fixture.ts";

export interface ReconstructedScaleStore {
  db: Database;
  scale: "ci" | "full";
  account: string;
  events: number;
  revisions: number;
  /** Commits the scaled store's own lanes logged before these settlements. */
  existingCommits: number;
  /** The range one answer asks: the year before the store's last day. */
  from: string;
  to: string;
  /** The caller's clock: the day after the store's last day. */
  now: string;
}

/** CI: `STATEMENT_CI_SCALE`, 150 settlements of two revisions; full: `STATEMENT_SCALE`, 1,500 of three. */
export async function reconstructedScaleStore(full: boolean): Promise<ReconstructedScaleStore> {
  const options = full ? STATEMENT_SCALE : STATEMENT_CI_SCALE;
  const events = full ? 1_500 : 150;
  const revisions = full ? 3 : 2;
  const account = "acct-bank";
  const to = options.today;
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 365 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const built = await scaledStore(options);
  const db = built.store.db;
  // `adopt` writes through the store's database only.
  const h = new EconomicHistory({ db } as unknown as DatedStore);
  const existingCommits = (
    db.query("SELECT count(*) AS n FROM economic_commit_log").get() as { n: number }
  ).n;
  const release = KNOWN_WRITER_RELEASES["card-settlement-review"][0]!;
  let clock = Date.parse(`${from}T00:00:00Z`);
  for (let event = 0; event < events; event += 1) {
    const posting = new Date(Date.parse(`${from}T00:00:00Z`) + (event % 360) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (let revision = 1; revision <= revisions; revision += 1) {
      clock += 60_000;
      h.adopt({
        eventId: `ev-scale-${event}`,
        revision,
        legs: [
          {
            subject: account,
            amount: String(100 + revision),
            role: "decrease",
            basis: "cash-movement",
          },
          { subject: "acct-card-0", amount: null, role: "unresolved", basis: "obligation-change" },
        ],
        times: [["posting", day(posting)]],
        knownAt: new Date(clock).toISOString(),
        writerRelease: release,
      });
    }
  }
  return {
    db,
    scale: full ? "full" : "ci",
    account,
    events,
    revisions,
    existingCommits,
    from,
    to,
    now: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString(),
  };
}
