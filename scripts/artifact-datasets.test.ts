// The registration dataset table (ADR 0022) against both of its sources of
// truth: what each collector writes, and what each registered parser accepts.
//
// `ARTIFACT_DATASETS` in packages/application/src/collection/descriptors.ts
// gives a shared-R2 terminal artifact the parser dataset `terminal-v1` cannot
// carry. This guard fails when
//
//  * a mapped dataset is one no registered parser accepts for that artifact
//    (the mapping would promise a parse that never happens);
//  * a dataset a parser requires from a shared-R2 source is neither mapped,
//    nor withheld (`WITHHELD_ARTIFACT_DATASETS`), nor named below as
//    unreachable with the reason;
//  * a rule is exercised by no artifact a collector writes;
//  * the withheld list changes (Vpass stays unparsed until ADR 0023's
//    binding exists; lifting it is a decision, not an edit);
//  * an artifact a parser reads with a NULL dataset exists outside Mizuho,
//    which would mean a registration before the table was already parsed.
//
// The artifact shapes below are the ones the collectors' persist paths write
// (services/collector-*/src/shared-*.ts, docs/collection.md). Mobile Suica's
// are taken from its real plan builder rather than restated. Every value is
// synthetic.
import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_DATASETS,
  artifactDataset,
  COLLECTOR_SOURCE_IDS,
  coreSourceId,
  datasetByRules,
  REGISTRATION_CONTRACT_VERSION,
  REGISTRATION_CONTRACT_VERSIONS,
  WITHHELD_ARTIFACT_DATASETS,
} from "../packages/application/src/collection/descriptors.ts";
import { PARSERS } from "../packages/parsers/src/parsers/registry.ts";
import type { ArtifactMeta } from "../packages/parsers/src/types.ts";
import { mobileSuicaRunPlan } from "../services/collector-mobile-suica/src/shared-run.ts";

interface Sample {
  /** The terminal `source`. */
  readonly source: string;
  readonly artifactKey: string;
  readonly role: string;
  readonly mediaType: string;
  /** What the table must give this artifact; null means "stays unmapped". */
  readonly dataset: string | null;
  /** What a withheld rule names for it (`WITHHELD_ARTIFACT_DATASETS`). */
  readonly withheld?: string;
  readonly unitKey?: string;
}

const json = "application/json";
const html = "text/html";

/** Artifacts as the collectors write them. */
const SAMPLES: readonly Sample[] = [
  // services/collector-moneyforward/src/shared-collection.ts
  {
    source: "moneyforward-me",
    artifactKey: "accounts.html",
    role: "provider_response",
    mediaType: html,
    dataset: "accounts-index",
  },
  {
    source: "moneyforward-me",
    artifactKey: "account-detail-01.html",
    role: "provider_response",
    mediaType: html,
    dataset: "account-detail",
    unitKey: "account-01",
  },
  {
    source: "moneyforward-me",
    artifactKey: "account-01-month-2026-01.html",
    role: "provider_response",
    mediaType: html,
    dataset: "monthly-transactions",
    unitKey: "account-01",
  },
  {
    source: "moneyforward-me",
    artifactKey: "manifest.json",
    role: "collector_manifest",
    mediaType: json,
    dataset: null,
  },
  // services/collector-myjcb/src/shared-collection.ts (`<connectionId>/<filename>`)
  {
    source: "myjcb",
    artifactKey: "conn-a/discovery.json",
    role: "collector_derived",
    mediaType: json,
    dataset: "discovery",
    unitKey: "conn-a",
  },
  {
    source: "myjcb",
    artifactKey: "conn-a/credit-menu.html",
    role: "sanitized_provider_capture",
    mediaType: html,
    dataset: null,
    unitKey: "conn-a",
  },
  {
    source: "myjcb",
    artifactKey: "conn-a/credit-past-months.json",
    role: "provider_response",
    mediaType: json,
    dataset: "credit-past-months",
    unitKey: "conn-a",
  },
  {
    source: "myjcb",
    artifactKey: "conn-a/credit-detail-01.html",
    role: "sanitized_provider_capture",
    mediaType: html,
    dataset: "credit-detail",
    unitKey: "conn-a",
  },
  {
    source: "myjcb",
    artifactKey: "conn-a/credit-ledger-01.json",
    role: "collector_derived",
    mediaType: json,
    dataset: "credit-ledger",
    unitKey: "conn-a",
  },
  {
    source: "myjcb",
    artifactKey: "manifest.json",
    role: "collector_manifest",
    mediaType: json,
    dataset: null,
  },
  // services/collector-globalpass/src/shared-collection.ts
  {
    source: "prestia-globalpass",
    artifactKey: "activity-2026-01.html",
    role: "sanitized_provider_capture",
    mediaType: html,
    dataset: "globalpass-activity",
    unitKey: "account",
  },
  {
    source: "prestia-globalpass",
    artifactKey: "manifest.json",
    role: "collector_manifest",
    mediaType: json,
    dataset: null,
  },
  // services/collector-sbi-securities/src/shared-run.ts (`<dataset>.json`)
  ...[
    ["domestic-cash-positions", "domestic"],
    ["account-assets-current", "domestic"],
    ["yen-detail-history", "domestic"],
    ["domestic-trade-records", "domestic"],
    ["foreign-cash-positions", "foreign"],
    ["foreign-cash-balances", "foreign"],
    ["foreign-trade-records", "foreign"],
  ].map(([dataset, unitKey]) => ({
    source: "sbi-securities",
    artifactKey: `${dataset!}.json`,
    role: "collector_derived",
    mediaType: json,
    dataset: dataset!,
    unitKey: unitKey!,
  })),
  // services/collector-sbi-shinsei/src/shared-collection.ts (`raw-<dataset>.json`)
  {
    source: "sbi-shinsei",
    artifactKey: "raw-top-accounts-balance-and-activity.json",
    role: "sanitized_provider_capture",
    mediaType: json,
    dataset: "top-accounts-balance-and-activity",
  },
  {
    source: "sbi-shinsei",
    artifactKey: "raw-yen-deposit-account.json",
    role: "sanitized_provider_capture",
    mediaType: json,
    dataset: "yen-deposit-account",
  },
  {
    source: "sbi-shinsei",
    artifactKey: "raw-balance-summary-and-stage.json",
    role: "sanitized_provider_capture",
    mediaType: json,
    dataset: null,
  },
  {
    source: "sbi-shinsei",
    artifactKey: "raw-exchange-rate.json",
    role: "sanitized_provider_capture",
    mediaType: json,
    dataset: null,
  },
  {
    source: "sbi-shinsei",
    artifactKey: "normalized.json",
    role: "collector_derived",
    mediaType: json,
    dataset: null,
  },
  {
    source: "sbi-shinsei",
    artifactKey: "manifest.json",
    role: "collector_derived",
    mediaType: json,
    dataset: null,
  },
  // services/collector-sbi-vc-trade/src/shared-collection.ts (`<dataset>.json`)
  ...[
    "cash-balances",
    "account-margin",
    "position-summary",
    "executions-recent-page-0001",
    "executions-historical-page-0001",
    "cashflows-historical-page-0002",
  ].map((dataset) => ({
    source: "sbi-vc-trade",
    artifactKey: `${dataset}.json`,
    role: "collector_derived",
    mediaType: json,
    dataset,
    unitKey: "account",
  })),
  {
    source: "sbi-vc-trade",
    artifactKey: "manifest.json",
    role: "collector_manifest",
    mediaType: json,
    dataset: null,
  },
  // services/collector-smbc-direct/src/shared-collection.ts
  {
    source: "smbc-direct",
    artifactKey: "balance.normalized.json",
    role: "collector_derived",
    mediaType: json,
    dataset: "balance-normalized",
  },
  {
    source: "smbc-direct",
    artifactKey: "transactions/20260101-20260131.normalized.json",
    role: "collector_derived",
    mediaType: json,
    dataset: "transactions-normalized",
  },
  {
    source: "smbc-direct",
    artifactKey: "balance.raw.json.sjis",
    role: "provider_response",
    mediaType: json,
    dataset: null,
  },
  {
    source: "smbc-direct",
    artifactKey: "manifest.json",
    role: "collector_manifest",
    mediaType: json,
    dataset: null,
  },
  // services/collector-sony-bank/src/shared-collection.ts
  {
    source: "sony-bank",
    artifactKey: "gross-balance.json",
    role: "provider_response",
    mediaType: json,
    dataset: "gross-balance",
    unitKey: "account",
  },
  {
    source: "sony-bank",
    artifactKey: "yen-history-page-0001.json",
    role: "provider_response",
    mediaType: json,
    dataset: "yen-history-page-0001",
    unitKey: "account",
  },
  {
    source: "sony-bank",
    artifactKey: "foreign-history-usd-page-0002.json",
    role: "provider_response",
    mediaType: json,
    dataset: "foreign-history-usd-page-0002",
    unitKey: "account",
  },
  {
    source: "sony-bank",
    artifactKey: "yen-history.csv",
    role: "provider_export",
    mediaType: "text/csv",
    dataset: "yen-history-csv",
    unitKey: "account",
  },
  {
    source: "sony-bank",
    artifactKey: "foreign-history-usd.csv",
    role: "provider_export",
    mediaType: "application/octet-stream",
    dataset: "foreign-history-usd-csv",
    unitKey: "account",
  },
  {
    source: "sony-bank",
    artifactKey: "wallet-history-2026-01.html",
    role: "sanitized_provider_capture",
    mediaType: html,
    dataset: "wallet-history-202601",
    unitKey: "account",
  },
  {
    source: "sony-bank",
    artifactKey: "collection-summary.json",
    role: "collector_summary",
    mediaType: json,
    dataset: null,
    unitKey: "account",
  },
  {
    source: "sony-bank",
    artifactKey: "manifest.json",
    role: "collector_manifest",
    mediaType: json,
    dataset: null,
    unitKey: "account",
  },
  // services/collector-st-george/src/shared-collection.ts
  {
    source: "st-george",
    artifactKey: "account-snapshot.json",
    role: "sanitized_provider_capture",
    mediaType: json,
    dataset: "account-snapshot",
  },
  // services/collector-vpoint/src/shared-run.ts
  {
    source: "v-point",
    artifactKey: "balance-info.json",
    role: "collector_derived",
    mediaType: json,
    dataset: "balance-info",
    unitKey: "account",
  },
  {
    source: "v-point",
    artifactKey: "smfg-point.json",
    role: "collector_derived",
    mediaType: json,
    dataset: "smfg-point",
    unitKey: "account",
  },
  {
    source: "v-point",
    artifactKey: "history-page-0001.json",
    role: "collector_derived",
    mediaType: json,
    dataset: "history-page-0001",
    unitKey: "account",
  },
  {
    source: "v-point",
    artifactKey: "vmoney-history-page-0001.json",
    role: "collector_derived",
    mediaType: json,
    dataset: null,
    unitKey: "account",
  },
  {
    source: "v-point",
    artifactKey: "collection-summary.json",
    role: "collector_summary",
    mediaType: json,
    dataset: null,
    unitKey: "account",
  },
  {
    source: "v-point-pay-email",
    artifactKey: "notification.eml",
    role: "user_capture",
    mediaType: "message/rfc822",
    dataset: null,
    unitKey: "notification",
  },
  {
    source: "v-point-pay-email",
    artifactKey: "normalized-event.json",
    role: "collector_derived",
    mediaType: json,
    dataset: "notification-event",
    unitKey: "notification",
  },
  // services/collector-vpoint-pay/src/shared-run.ts (stopped; nothing it writes has a parser)
  {
    source: "v-point-pay",
    artifactKey: "balance.json",
    role: "collector_derived",
    mediaType: json,
    dataset: null,
  },
  {
    source: "v-point-pay",
    artifactKey: "transactions-202601.json",
    role: "collector_derived",
    mediaType: json,
    dataset: null,
  },
  // services/collector-vpass/src/shared-collection.ts
  {
    source: "vpass",
    artifactKey: "card-list.json",
    role: "sanitized_provider_capture",
    mediaType: json,
    dataset: null,
    unitKey: "card-001",
  },
  {
    source: "vpass",
    artifactKey: "select-card.json",
    role: "sanitized_provider_capture",
    mediaType: json,
    dataset: null,
    unitKey: "card-001",
  },
  {
    source: "vpass",
    artifactKey: "web-meisai-top.json",
    role: "sanitized_provider_capture",
    mediaType: json,
    dataset: null,
    unitKey: "card-001",
  },
  {
    source: "vpass",
    artifactKey: "months/202601/top-001.json",
    role: "provider_response",
    mediaType: json,
    dataset: null,
    withheld: "statement-page",
    unitKey: "card-001",
  },
  {
    source: "vpass",
    artifactKey: "months/202601/answer-002.json",
    role: "provider_response",
    mediaType: json,
    dataset: null,
    withheld: "statement-page",
    unitKey: "card-001",
  },
  {
    source: "vpass",
    artifactKey: "manifest.json",
    role: "collector_manifest",
    mediaType: json,
    dataset: null,
    unitKey: "card-001",
  },
  // docs/collection.md `mizuho-bank`: its parsers read the artifact without a dataset.
  {
    source: "mizuho-bank",
    artifactKey: "account-list.html",
    role: "sanitized_provider_capture",
    mediaType: html,
    dataset: null,
    unitKey: "account-list",
  },
  {
    source: "mizuho-bank",
    artifactKey: "ordinary/001-1234567/history/1-2.html",
    role: "sanitized_provider_capture",
    mediaType: html,
    dataset: null,
    unitKey: "ordinary:001:1234567:page:1:2",
  },
];

/** Mobile Suica's artifacts from its own plan builder, with the datasets they must get. */
async function mobileSuicaSamples(): Promise<Sample[]> {
  const plan = await mobileSuicaRunPlan({
    runId: "synthetic-run",
    producerVersion: "synthetic-v1",
    attemptId: "attempt-synthetic-run",
    startedAt: "2026-01-02T00:00:00.000Z",
    completedAt: "2026-01-02T00:01:00.000Z",
    status: "success",
    asOfDateJst: "2026-01-02",
    complete: true,
    artifacts: [
      {
        dataset: "sf-history-html",
        filename: "sf-history-page-0001.html",
        mediaType: "text/html; charset=shift_jis",
        body: "<html></html>",
      },
      {
        dataset: "sf-history",
        filename: "sf-history.json",
        mediaType: "application/json",
        body: "{}",
      },
      {
        dataset: "collection-summary",
        filename: "collection-summary.json",
        mediaType: "application/json",
        body: "{}",
      },
    ],
    failureCodes: [],
  });
  const expected: Record<string, string | null> = {
    "sf-history-page-0001.html": null,
    "sf-history.json": "sf-history",
    "collection-summary.json": null,
  };
  return plan.artifacts.map((artifact) => ({
    source: "mobile-suica",
    artifactKey: artifact.artifactKey,
    role: artifact.role,
    mediaType: artifact.mediaType,
    dataset: expected[artifact.artifactKey] ?? null,
    ...(artifact.unitKey === undefined ? {} : { unitKey: artifact.unitKey }),
  }));
}

/**
 * Datasets a parser requires that no terminal can reach, and why. A terminal
 * media type carries no parameters (`terminal-v1`, and CORE's own media-type
 * validation), so a parser that insists on one cannot be fed from a terminal.
 */
const UNREACHABLE: Readonly<Record<string, string>> = {
  "myjcb/credit-menu": "myjcb-canonical-evidence-boundary accepts only text/html; charset=utf-8",
};

/**
 * Every dataset a registered parser requires from a source a shared-R2
 * collector writes, as a concrete example of its shape (read from
 * packages/parsers/src/parsers/*.ts). Mizuho requires none.
 */
const REQUIRED_DATASETS: Readonly<Record<string, readonly string[]>> = {
  "global-pass": ["globalpass-activity"],
  "mobile-suica": ["sf-history"],
  "moneyforward-me": ["accounts-index", "account-detail", "monthly-transactions"],
  myjcb: ["credit-ledger", "credit-past-months", "credit-detail", "credit-menu", "discovery"],
  "sbi-securities": [
    "domestic-cash-positions",
    "account-assets-current",
    "yen-detail-history",
    "domestic-trade-records",
    "foreign-cash-positions",
    "foreign-cash-balances",
    "foreign-trade-records",
  ],
  "sbi-shinsei-bank": ["top-accounts-balance-and-activity", "yen-deposit-account"],
  "sbi-vc-trade": [
    "cash-balances",
    "account-margin",
    "position-summary",
    "executions-recent-page-0001",
    "executions-historical-page-0001",
    "cashflows-historical-page-0002",
  ],
  "smbc-bank": ["balance-normalized", "transactions-normalized"],
  "sony-bank": [
    "gross-balance",
    "yen-history-page-0001",
    "foreign-history-usd-page-0002",
    "yen-history-csv",
    "foreign-history-usd-csv",
    "wallet-history-202601",
  ],
  "st-george": ["account-snapshot"],
  "v-point": ["balance-info", "smfg-point", "history-page-0001"],
  "v-point-pay": ["notification-event"],
  vpass: ["statement-page"],
};

/** Parsers of sources no shared-R2 collector writes. */
const NOT_SHARED_R2 = new Set(["paypay-csv"]);

function meta(sample: Sample, dataset: string | null, mime = sample.mediaType): ArtifactMeta {
  return {
    id: 1,
    sourceId: coreSourceId(sample.source)!,
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    artifactKey: sample.artifactKey,
    fetchUnitKey: sample.unitKey ?? null,
    statementState: null,
    period: null,
    url: null,
    mime,
    fetchedAt: "2026-01-02T00:01:00.000Z",
    sha256: "0".repeat(64),
  };
}

const accepting = (candidate: ArtifactMeta) =>
  PARSERS.filter((parser) => parser.accepts(candidate)).map((parser) => parser.name);

async function allSamples(): Promise<Sample[]> {
  return [...SAMPLES, ...(await mobileSuicaSamples())];
}

describe("the registration dataset table (ADR 0022)", () => {
  test("gives each collector artifact the dataset its parser reads, and nothing else one", async () => {
    for (const sample of await allSamples()) {
      expect({
        key: `${sample.source}/${sample.artifactKey}`,
        dataset: artifactDataset(sample.source, sample),
      }).toEqual({
        key: `${sample.source}/${sample.artifactKey}`,
        dataset: sample.dataset,
      });
    }
  });

  test("names only sources the Processor maps to CORE", () => {
    for (const source of Object.keys(ARTIFACT_DATASETS)) {
      expect(Object.hasOwn(COLLECTOR_SOURCE_IDS, source)).toBe(true);
    }
  });

  test("every mapped or withheld dataset is one a registered parser accepts for that artifact", async () => {
    for (const sample of await allSamples()) {
      const dataset = sample.dataset ?? sample.withheld ?? null;
      if (dataset === null) continue;
      expect({
        artifact: `${sample.source}/${sample.artifactKey}`,
        parsers: accepting(meta(sample, dataset)).length > 0,
      }).toEqual({ artifact: `${sample.source}/${sample.artifactKey}`, parsers: true });
    }
  });

  test("Vpass is withheld: every artifact a collector-vpass run writes stays without a dataset", async () => {
    // Lifting this is a decision (ADR 0022, ADR 0023): change the pin below
    // together with an ADR that says the collector now derives the binding.
    expect(Object.keys(WITHHELD_ARTIFACT_DATASETS)).toEqual(["vpass"]);
    expect(Object.hasOwn(ARTIFACT_DATASETS, "vpass")).toBe(false);
    const vpass = (await allSamples()).filter((sample) => sample.source === "vpass");
    expect(vpass.length).toBeGreaterThan(0);
    for (const sample of vpass) {
      expect(artifactDataset("vpass", sample)).toBeNull();
      expect(accepting(meta(sample, null))).toEqual([]);
      // What the withheld rule would give, so lifting it is a move, not a new mapping.
      expect(datasetByRules(WITHHELD_ARTIFACT_DATASETS.vpass!.rules, sample)).toBe(
        sample.withheld ?? null,
      );
    }
  });

  test("without the table only Mizuho's artifacts are parsed, so no earlier registration was", async () => {
    for (const sample of await allSamples()) {
      const parsers = accepting(meta(sample, null));
      if (sample.source === "mizuho-bank") expect(parsers.length).toBe(1);
      else
        expect({ artifact: `${sample.source}/${sample.artifactKey}`, parsers }).toEqual({
          artifact: `${sample.source}/${sample.artifactKey}`,
          parsers: [],
        });
    }
  });

  test("v2 changes a descriptor only where v1 left an artifact no parser read", async () => {
    // The INV06 half of the version bump: a terminal v2 registers again is
    // one whose v1 artifacts were never parsed, so its capture is parsed
    // once; every other terminal is carried over, not registered again.
    const v1 = REGISTRATION_CONTRACT_VERSIONS[0];
    expect(REGISTRATION_CONTRACT_VERSION).not.toBe(v1);
    let changed = 0;
    for (const sample of await allSamples()) {
      const before = artifactDataset(sample.source, sample, v1);
      const after = artifactDataset(sample.source, sample);
      if (before === after) continue;
      changed += 1;
      expect({ artifact: `${sample.source}/${sample.artifactKey}`, before }).toEqual({
        artifact: `${sample.source}/${sample.artifactKey}`,
        before: null,
      });
      expect(accepting(meta(sample, before))).toEqual([]);
    }
    expect(changed).toBeGreaterThan(0);
    // St George's snapshot is the one dataset v1 already named.
    const snapshot = SAMPLES.find((sample) => sample.source === "st-george")!;
    expect(artifactDataset("st-george", snapshot, v1)).toBe("account-snapshot");
    expect(() => artifactDataset("st-george", snapshot, "terminal-registration-v0")).toThrow(
      "registration_contract_unknown",
    );
  });

  test("an unmapped artifact of a mapped source is read by no parser", async () => {
    for (const sample of await allSamples()) {
      if (sample.dataset !== null || sample.source === "mizuho-bank") continue;
      expect(accepting(meta(sample, null))).toEqual([]);
    }
  });

  test("a wrong role or media type is never mapped", async () => {
    for (const sample of await allSamples()) {
      if (sample.dataset === null) continue;
      expect(artifactDataset(sample.source, { ...sample, role: "collector_error" })).toBeNull();
      expect(
        artifactDataset(sample.source, { ...sample, mediaType: "application/pdf" }),
      ).toBeNull();
      expect(artifactDataset("kogane-synthetic", sample)).toBeNull();
    }
  });

  test("every rule, applied or withheld, is exercised by an artifact a collector writes", async () => {
    const samples = await allSamples();
    const tables = [
      ...Object.entries(ARTIFACT_DATASETS),
      ...Object.entries(WITHHELD_ARTIFACT_DATASETS).map(
        ([source, withheld]) => [source, withheld.rules] as const,
      ),
    ];
    for (const [source, rules] of tables) {
      for (const rule of rules) {
        const hit = samples.some(
          (sample) =>
            sample.source === source &&
            sample.role === rule.role &&
            rule.mediaTypes.includes(sample.mediaType) &&
            (typeof rule.key === "string"
              ? rule.key === sample.artifactKey
              : rule.key.test(sample.artifactKey)),
        );
        expect({ source, key: String(rule.key), hit }).toEqual({
          source,
          key: String(rule.key),
          hit: true,
        });
      }
    }
  });

  test("every dataset a parser requires from a shared-R2 source is mapped, withheld or named unreachable", async () => {
    const samples = await allSamples();
    const covered = (pick: (sample: Sample) => string | null | undefined) =>
      new Set(
        samples
          .filter((sample) => pick(sample) != null)
          .map((sample) => `${coreSourceId(sample.source)!}/${pick(sample)!}`),
      );
    const mapped = covered((sample) => sample.dataset);
    const withheld = covered((sample) => sample.withheld);
    const sharedSources = new Set(Object.values(COLLECTOR_SOURCE_IDS));
    for (const [sourceId, datasets] of Object.entries(REQUIRED_DATASETS)) {
      expect(sharedSources.has(sourceId)).toBe(true);
      for (const dataset of datasets) {
        const key = `${sourceId}/${dataset}`;
        const how = mapped.has(key)
          ? "mapped"
          : withheld.has(key)
            ? "withheld"
            : Object.hasOwn(UNREACHABLE, key)
              ? "unreachable"
              : "missing";
        expect({ key, missing: how === "missing" }).toEqual({ key, missing: false });
      }
    }
  });

  test("every registered parser of a shared-R2 source is reached by some collector artifact", async () => {
    const samples = await allSamples();
    for (const parser of PARSERS) {
      if (NOT_SHARED_R2.has(parser.name)) continue;
      const reached = samples.some((sample) =>
        parser.accepts(meta(sample, sample.dataset ?? sample.withheld ?? null)),
      );
      expect({ parser: parser.name, reached }).toEqual({ parser: parser.name, reached: true });
    }
  });

  test("the unreachable dataset is unreachable only because of the media type parameter", () => {
    const menu = SAMPLES.find((sample) => sample.artifactKey.endsWith("/credit-menu.html"))!;
    expect(accepting(meta(menu, "credit-menu"))).toEqual([]);
    expect(accepting(meta(menu, "credit-menu", "text/html; charset=utf-8"))).toEqual([
      "myjcb-canonical-evidence-boundary",
    ]);
  });
});
