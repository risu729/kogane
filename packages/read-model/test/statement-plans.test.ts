// Plans of the evidence reader's keyed reads and of the economic events
// reader, on the complete CORE schema with no table statistics (D1 never runs
// `ANALYZE`). Each statement reaches its rows from the key it is given — an
// artifact, a parse run, an observation, a hash, a list of event ids or
// account refs — and walks no growing table from end to end. The whole-set
// reads of the same reader (overview counts, filter options, the grouped
// lists) are documented as such in docs/read-model.md and are not here.
import { beforeAll, describe, expect, test } from "bun:test";
import { fullCoreDatabase } from "../../storage-d1/test/sqlite.ts";
import { planOf, unboundedScans } from "../../storage-d1/test/plan-check.ts";
import {
  ARTIFACT_DETAIL_SQL,
  ARTIFACT_PARSE_RUNS_SQL,
  ARTIFACTS_SQL,
  observationDetailSql,
  parseRunObservationsSql,
  PARSING_HEALTH_SQL,
  PROVENANCE_SQL,
  RAW_DOWNLOAD_SQL,
} from "../src/sql";
import {
  activityEventsSql,
  eventAllocationsSql,
  eventLegsSql,
  evidenceLocatorsSql,
  obligationSettlementsSql,
  obligationsSql,
  reportedBalancesSql,
} from "../src/events";
import type { ObservationKind } from "../src/index";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const KINDS: readonly ObservationKind[] = ["transaction", "balance", "position", "valuation"];
const OBSERVATION_INDEX = {
  transaction: "idx_txn_obs_parse_run",
  balance: "idx_bal_obs_parse_run",
  position: "idx_pos_obs_parse_run",
  valuation: "idx_val_obs_parse_run",
} as const;

/** The reader's list wrapper (`createObservationReader`), applied to every list read. */
const listed = (sql: string) => `SELECT * FROM (${sql}) LIMIT 5001`;

interface Case {
  name: string;
  sql: string;
  /** Steps the plan must contain: the keyed access each read is for. */
  keyed: readonly string[];
  /** Relations the plan may read whole, each bounded by construction. */
  bounded?: readonly string[];
  /** An ordered walk that a LIMIT stops: no sort of the whole relation first. */
  noSort?: boolean;
}

const cases: Case[] = [
  {
    name: "listArtifacts walks artifact ids down from the cursor",
    sql: listed(ARTIFACTS_SQL),
    keyed: ["SEARCH a USING INTEGER PRIMARY KEY (rowid<?)"],
    noSort: true,
  },
  {
    name: "getArtifact reads the artifact by id",
    sql: ARTIFACT_DETAIL_SQL,
    keyed: ["SEARCH a USING INTEGER PRIMARY KEY (rowid=?)"],
  },
  {
    name: "getArtifact reads the artifact's parse runs by artifact",
    sql: listed(ARTIFACT_PARSE_RUNS_SQL),
    keyed: ["SEARCH p USING INDEX idx_parse_runs_artifact (fetch_artifact_id=?)"],
  },
  ...KINDS.map((kind) => ({
    name: `getArtifact reads a parse run's ${kind} observations by parse run`,
    sql: listed(parseRunObservationsSql(kind)),
    keyed: [
      "SEARCH p USING INTEGER PRIMARY KEY (rowid=?)",
      `SEARCH o USING INDEX ${OBSERVATION_INDEX[kind]} (parse_run_id=?)`,
    ],
  })),
  ...KINDS.map((kind) => ({
    name: `getObservation reads one ${kind} observation by id`,
    sql: observationDetailSql(kind),
    keyed: ["SEARCH o USING INTEGER PRIMARY KEY (rowid=?)"],
  })),
  {
    name: "getObservation reads the provenance of one parse run",
    sql: PROVENANCE_SQL,
    keyed: ["SEARCH p USING INTEGER PRIMARY KEY (rowid=?)"],
  },
  {
    name: "getRawDownload reads one raw object by hash",
    sql: RAW_DOWNLOAD_SQL,
    keyed: ["SEARCH o USING INDEX sqlite_autoindex_raw_objects_1 (sha256=?)"],
  },
  {
    name: "parsingHealth reads unfinished jobs by status",
    sql: PARSING_HEALTH_SQL,
    keyed: ["SEARCH j USING INDEX observation_jobs_ready (status=?)"],
  },
  {
    name: "activity walks live event revisions in key order",
    sql: activityEventsSql,
    keyed: [
      "SCAN e USING INDEX economic_event_revisions_current",
      "SEARCH l USING INDEX sqlite_autoindex_economic_legs_1 (event_id=? AND revision=?)",
    ],
    // The partial index holds live revisions only, in the page's order; the
    // LIMIT stops the walk, so a page never reads the whole history.
    bounded: ["e"],
    noSort: true,
  },
  {
    name: "activity reads the legs of the page's events",
    sql: eventLegsSql,
    keyed: ["SEARCH l USING INDEX sqlite_autoindex_economic_legs_1 (event_id=?)"],
  },
  {
    name: "activity reads the allocations of the page's legs",
    sql: eventAllocationsSql,
    keyed: ["SEARCH a USING INDEX allocations_target (target_effect_ref=?)"],
  },
  {
    name: "activity reads the raw locators of the page's transactions",
    sql: evidenceLocatorsSql,
    keyed: ["SEARCH t USING INTEGER PRIMARY KEY (rowid=?)"],
  },
  {
    name: "obligations walks live obligation revisions in key order",
    sql: obligationsSql,
    keyed: ["SCAN o USING INDEX obligation_revisions_current"],
    bounded: ["o"],
    noSort: true,
  },
  {
    name: "obligations reads the settlements of the page's obligations",
    sql: obligationSettlementsSql,
    keyed: ["SEARCH s USING INDEX settlement_relations_obligation (obligation_id=?)"],
  },
  {
    name: "reconciliationSignals reads reported balances by account",
    sql: reportedBalancesSql,
    keyed: [
      "SEARCH b USING INDEX idx_bal_obs_account (source_account=?)",
      "SEARCH b2 USING INDEX idx_bal_obs_account (source_account=?)",
    ],
  },
];

describe("keyed reads of the evidence and events readers, without table statistics", () => {
  for (const entry of cases)
    test(entry.name, () => {
      const db = fullCoreDatabase();
      const plan = planOf(db, entry.sql);
      db.close();
      for (const step of entry.keyed) expect(plan).toContain(step);
      expect(unboundedScans(plan, entry.bounded)).toEqual([]);
      if (entry.noSort) expect(plan.filter((step) => step.includes("TEMP B-TREE"))).toEqual([]);
    });
});
