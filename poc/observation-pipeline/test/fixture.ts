import { expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseRun,
  openStore,
  putRawObject,
  supersedeOlderParseRuns,
  upsertSource,
  type Store,
} from "../src/store.ts";

// A two-parse-version dataset shared by the API and client tests. It is built
// through the store helpers rather than from the fixtures directory, so the
// tests depend on the schema and the store API rather than on sample files.

// Provider text is untrusted: a description shaped like markup must survive
// into the page as text and never as an element.
export const HOSTILE_DESCRIPTION = 'Coffee & <script>alert("xss")</script>';
// Produced only by the retired parser version, so it must not appear in any
// current view, and must stay reachable through the artifact.
export const RETIRED_DESCRIPTION = "row-from-the-retired-parser-version";

const RAW_BYTES = new TextEncoder().encode(
  JSON.stringify({
    account: "demo-bank:main",
    rows: [
      { id: "T-1", date: "2026-08-19", amount: "-1,180", label: HOSTILE_DESCRIPTION },
      { id: "T-2", date: "2026-08-20", amount: "1,024.53", label: "Inbound transfer" },
    ],
  }),
);

export interface Fixture {
  store: Store;
  artifactId: number;
  sha256: string;
  retiredObservationId: number;
}

/**
 * A two-parse-version dataset built through the store helpers, so the test
 * depends on the schema and the store API rather than on the fixtures.
 */
export function buildFixture(): Fixture {
  const store = openStore(mkdtempSync(join(tmpdir(), "kogane-ui-")));
  upsertSource(store, {
    id: "demo-bank",
    provider: "Demo Bank",
    ingestion: "collector-r2",
  });
  const fetchRunId = insertFetchRun(store, {
    sourceId: "demo-bank",
    externalRunId: "run-20260820-210000-ui01",
    tool: "import-run",
    startedAt: "2026-08-20T21:00:00Z",
    completedAt: "2026-08-20T21:01:42Z",
    status: "success",
  });
  const stored = putRawObject(store, RAW_BYTES, "application/json");
  const artifactId = insertFetchArtifact(store, {
    fetchRunId,
    sourceId: "demo-bank",
    dataset: "statement",
    mime: "application/json",
    fetchedAt: "2026-08-20T21:01:42Z",
    sha256: stored.sha256,
  });

  const retiredRunId = insertParseRun(store, {
    artifactId,
    parserName: "demo-statement",
    parserVersion: "0.1.0",
    parsedAt: "2026-08-20T22:00:00Z",
    status: "ok",
    warnings: [],
  });
  insertObservation(store, retiredRunId, {
    kind: "transaction",
    sourceAccount: "demo-bank:main",
    description: RETIRED_DESCRIPTION,
    amountMinor: -1180,
    currency: "JPY",
    asOf: "2026-08-19",
    rawLocator: "json:$.rows[0]",
    extra: {},
  });

  const currentRunId = insertParseRun(store, {
    artifactId,
    parserName: "demo-statement",
    parserVersion: "0.2.0",
    parsedAt: "2026-08-21T09:00:00Z",
    status: "ok",
    warnings: ["json:$.rows[1]: currency inferred from the account, not stated"],
  });
  insertObservation(store, currentRunId, {
    kind: "transaction",
    sourceAccount: "demo-bank:main",
    externalId: "T-1",
    description: HOSTILE_DESCRIPTION,
    counterparty: "Kissaten <b>",
    amountMinor: -1180,
    currency: "JPY",
    asOf: "2026-08-19",
    rawLocator: "json:$.rows[0]",
    extra: { label: HOSTILE_DESCRIPTION },
  });
  insertObservation(store, currentRunId, {
    kind: "transaction",
    sourceAccount: "demo-bank:main",
    externalId: "T-2",
    description: "Inbound transfer",
    amountMinor: 102453,
    currency: "USD",
    asOf: "2026-08-20",
    rawLocator: "json:$.rows[1]",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "balance",
    sourceAccount: "demo-bank:main",
    metric: "ledger",
    amountMinor: 250000,
    instrument: "JPY",
    asOf: "2026-08-19",
    rawLocator: "json:$.balance",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "balance",
    sourceAccount: "demo-bank:main",
    metric: "ledger",
    amountMinor: 248820,
    instrument: "JPY",
    asOf: "2026-08-20",
    rawLocator: "json:$.balance",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "position",
    sourceAccount: "demo-bank:securities",
    securityCode: "1234",
    securityName: "Example <Fund>",
    market: "TSE",
    quantityText: "10.5",
    quantityScale: 1,
    currency: "JPY",
    asOf: "2026-08-20",
    rawLocator: "json:$.positions[0]",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "valuation",
    sourceAccount: "demo-bank:securities",
    subject: "1234",
    metric: "evaluation_amount",
    amountMinor: 123456,
    currency: "JPY",
    asOf: "2026-08-20",
    rawLocator: "json:$.positions[0]",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "valuation",
    sourceAccount: "demo-bank:securities",
    subject: "1234",
    metric: "frn_evaluation_amount",
    amountMinor: 82000,
    currency: "USD",
    asOf: "2026-08-20",
    rawLocator: "json:$.positions[0]",
    extra: {},
  });

  const superseded = supersedeOlderParseRuns(store, artifactId, "demo-statement", currentRunId);
  expect(superseded).toBe(1);

  const retiredObservation = store.db
    .query("SELECT id FROM transaction_observations WHERE description = ?1")
    .get(RETIRED_DESCRIPTION) as { id: number };

  return {
    store,
    artifactId,
    sha256: stored.sha256,
    retiredObservationId: retiredObservation.id,
  };
}
