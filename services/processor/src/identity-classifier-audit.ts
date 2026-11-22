// The classifier audit behind `scripts/audit-identities.ts`: what the identity
// rules plan for every published observation of a sealed, successful financial
// fetch, resolved the way the projection resolves it (`identifyParse`): each
// parse under the policy its module selects for a standard request, the
// trusted Vpass binding when that family was selected, and a still-effective
// manual decision on a run-scoped Vpass reference kept. It reads; it never
// writes. Provider references, tokens and payloads stay in memory; the summary
// holds counts and closed codes only (AGENTS.md).
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import type { D1Like } from "../../../packages/storage-d1/src/d1.ts";
import {
  identityObservationInput,
  type IdentityObservationKind,
  type IdentityObservationRow,
  type IdentityResolver,
  parseIdentityPolicy,
  type ParseIdentityPolicy,
  planObservationIdentity,
} from "../../../packages/storage-d1/src/core/identity-store.ts";
import type { IdentityInput, IdentityPlan } from "../../../packages/identity/src/types.ts";

const kinds: readonly IdentityObservationKind[] = [
  "transaction",
  "balance",
  "position",
  "valuation",
];
const columns: Record<IdentityObservationKind, string> = {
  transaction:
    "o.currency,NULL instrument,NULL security_code,NULL security_name,NULL market,NULL subject",
  balance:
    "NULL currency,o.instrument,NULL security_code,NULL security_name,NULL market,NULL subject",
  position: "o.currency,NULL instrument,o.security_code,o.security_name,o.market,NULL subject",
  valuation:
    "o.currency,NULL instrument,NULL security_code,NULL security_name,NULL market,o.subject",
};
const PAGE = 250;
const PAGE_BOUND = 4000;

type Counts = Record<string, number>;

/** One source's aggregate: counts and closed codes, never a reference or a value. */
interface IdentityClassifierSourceSummary {
  source: string;
  observations: number;
  forms: Counts;
  /**
   * Parses with at least one published observation, by the policy release
   * they were resolved under (`<family>-v<version>`). Empty parses are in
   * `inventory` only.
   */
  policyReleases: Counts;
  /** Parses whose source family did not apply, by `<family>:<reason>`. */
  policyFallbacks: Counts;
  accountStatus: Counts;
  accountRoles: Counts;
  issues: Counts;
  instrumentStatus: Counts;
  instrumentKinds: Counts;
  unknownUnitCodes: Counts;
  noInstrument: number;
  duplicateRoles: number;
  resolverErrors: number;
  sourceAccounts: number;
  canonicalKeys: number;
}

export interface IdentityClassifierAudit {
  scope: "successful-nonsuperseded-parses-of-sealed-successful-financial-fetches";
  policy: "per-parse-required";
  inventory: { source_id: string; successful_parses: number }[];
  sources: IdentityClassifierSourceSummary[];
}

interface Row extends IdentityObservationRow {
  parse_run_id: number;
  artifact_id: number;
  fetch_run_id: number;
  source_id: string;
  producer_id: string;
  dataset: string;
}

interface Working extends Omit<
  IdentityClassifierSourceSummary,
  "sourceAccounts" | "canonicalKeys"
> {
  sourceAccounts: Set<string>;
  canonicalKeys: Set<string>;
}

function increment(counts: Counts, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function working(source: string): Working {
  return {
    source,
    observations: 0,
    forms: {},
    policyReleases: {},
    policyFallbacks: {},
    accountStatus: {},
    accountRoles: {},
    issues: {},
    instrumentStatus: {},
    instrumentKinds: {},
    unknownUnitCodes: {},
    noInstrument: 0,
    duplicateRoles: 0,
    resolverErrors: 0,
    sourceAccounts: new Set(),
    canonicalKeys: new Set(),
  };
}

/**
 * Classifies every published observation and returns per-source aggregates.
 * `onProgress` is called after each form with the running observation count.
 * `resolver` is the projection's (`resolveIdentity`); tests pass a recording
 * wrapper to see the input each row was resolved with.
 */
export async function auditIdentityClassification(
  db: D1Like,
  onProgress: (kind: IdentityObservationKind, observations: number) => void = () => {},
  resolver: IdentityResolver = resolveIdentity,
): Promise<IdentityClassifierAudit> {
  const maxParse =
    (await db.prepare("SELECT coalesce(max(id),0) n FROM parse_runs").first<{ n: number }>())?.n ??
    0;
  const inventory = await db
    .prepare(`SELECT a.source_id,count(*) successful_parses
    FROM published_parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
    WHERE f.status='success' AND f.failure_count=0 AND p.parse_run_id<=?
    GROUP BY a.source_id ORDER BY a.source_id`)
    .bind(maxParse)
    .all<{ source_id: string; successful_parses: number }>();
  const summaries = new Map<string, Working>();
  for (const { source_id } of inventory.results) summaries.set(source_id, working(source_id));
  const policies = new Map<number, ParseIdentityPolicy>();
  let observations = 0;
  for (const kind of kinds) {
    let after = 0;
    for (let page = 0; ; page++) {
      if (page === PAGE_BOUND) throw new Error("audit-page-bound-exceeded");
      const rows = await db
        .prepare(`SELECT o.id,o.parse_run_id,a.id artifact_id,a.fetch_run_id,a.source_id,r.producer_id,a.dataset,o.source_account,${columns[kind]},o.extra_json
        FROM ${kind}_observations o JOIN published_parse_runs p ON p.parse_run_id=o.parse_run_id
        JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
        JOIN observation_fetch_runs f ON f.id=a.fetch_run_id JOIN financial_fetch_runs r ON r.id=a.fetch_run_id
        WHERE f.status='success' AND f.failure_count=0 AND p.parse_run_id<=? AND o.id>?
        ORDER BY o.id LIMIT ${PAGE}`)
        .bind(maxParse, after)
        .all<Row>();
      if (!rows.results.length) break;
      for (const row of rows.results) {
        after = row.id;
        observations++;
        const summary = summaries.get(row.source_id);
        if (!summary) throw new Error("audit-inventory-mismatch");
        summary.observations++;
        increment(summary.forms, `${kind}:${row.dataset}`);
        summary.sourceAccounts.add(JSON.stringify([row.producer_id, row.source_account]));
        const parse = {
          id: row.parse_run_id,
          artifact_id: row.artifact_id,
          source_id: row.source_id,
          producer_id: row.producer_id,
          fetch_run_id: row.fetch_run_id,
        };
        let policy = policies.get(parse.id);
        if (!policy) {
          // The standard request, as the sweep makes it: each parse gets its
          // own required version, and the Vpass binding only when trusted.
          policy = await parseIdentityPolicy(db, parse);
          policies.set(parse.id, policy);
          increment(summary.policyReleases, policy.selection.release);
          const eligibility = policy.selection.eligibility;
          if (eligibility.status === "fallback")
            increment(summary.policyFallbacks, `${eligibility.family}:${eligibility.reason}`);
        }
        let input: IdentityInput;
        let resolved: IdentityPlan;
        try {
          input = identityObservationInput(parse, policy, kind, row);
          resolved = resolver(input);
        } catch {
          summary.resolverErrors++;
          continue;
        }
        const plan = await planObservationIdentity(db, input, () => resolved);
        summary.canonicalKeys.add(JSON.stringify([row.producer_id, plan.account.key]));
        increment(summary.accountStatus, plan.account.status);
        increment(summary.accountRoles, plan.account.role);
        for (const issue of plan.issues) increment(summary.issues, issue);
        if (!plan.instruments.length) summary.noInstrument++;
        if (new Set(plan.instruments.map((i) => i.role)).size !== plan.instruments.length)
          summary.duplicateRoles++;
        for (const instrument of plan.instruments) {
          increment(summary.instrumentStatus, instrument.status);
          increment(summary.instrumentKinds, instrument.kind);
          if (instrument.status === "unresolved" && instrument.role !== "security")
            increment(
              summary.unknownUnitCodes,
              /^[A-Z_]{2,12}$/u.test(instrument.value) ? instrument.value : "unprintable-unit-code",
            );
        }
      }
    }
    onProgress(kind, observations);
  }
  return {
    scope: "successful-nonsuperseded-parses-of-sealed-successful-financial-fetches",
    policy: "per-parse-required",
    inventory: inventory.results,
    sources: Array.from(summaries.values(), (summary) => ({
      ...summary,
      sourceAccounts: summary.sourceAccounts.size,
      canonicalKeys: summary.canonicalKeys.size,
    })),
  };
}
