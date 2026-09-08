import type {
  AccountIdentity,
  IdentityInput,
  IdentityPlan,
  InstrumentIdentity,
} from "../../../poc/observation-pipeline/src/identity/types.ts";
import { record } from "../../../poc/observation-pipeline/src/identity/types.ts";

export type IdentityResolver = (input: IdentityInput) => IdentityPlan;
export const IDENTITY_POLICY_VERSION = 1;
const kinds = ["transaction", "balance", "position", "valuation"] as const;

export async function identityKey(prefix: string, parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return `${prefix}_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Appends an automatic decision only when no manual decision protects it.
 * Version comparison is numeric; old workers cannot undo newer rules. */
async function accountMapping(
  db: D1Database,
  input: IdentityInput,
  account: AccountIdentity,
  version: number,
) {
  const ref = await identityKey("sa", [input.sourceId, input.producerId, account.key]);
  const entity = await identityKey("account", [ref]);
  await db.batch([
    db
      .prepare(
        "INSERT INTO source_accounts SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM source_accounts WHERE id=?)",
      )
      .bind(ref, input.sourceId, input.producerId, JSON.stringify(account.key), ref),
    db
      .prepare(
        "INSERT INTO accounts SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM accounts WHERE id=?)",
      )
      .bind(entity, account.label, account.role, account.status, entity),
    db
      .prepare(`INSERT INTO account_mappings SELECT ?,?,coalesce((SELECT max(revision) FROM account_mappings WHERE source_account_id=?),0)+1,?,'rule',?,?,?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM account_mappings WHERE source_account_id=? AND (method='manual' OR policy_version>=?))`)
      .bind(
        await identityKey("am", [ref, version]),
        ref,
        ref,
        entity,
        account.reason,
        version,
        new Date().toISOString(),
        account.label,
        account.status,
        ref,
        version,
      ),
  ]);
  const mapping = await db
    .prepare("SELECT id FROM current_account_mappings WHERE source_account_id=?")
    .bind(ref)
    .first<{ id: string }>();
  if (!mapping) throw new Error("identity_account_mapping_missing");
  return { ref, mapping: mapping.id };
}

async function instrumentMapping(db: D1Database, instrument: InstrumentIdentity, version: number) {
  const ref = await identityKey("ii", [instrument.namespace, instrument.scope, instrument.value]);
  const entity = await identityKey("instrument", [ref]);
  await db.batch([
    db
      .prepare(
        "INSERT INTO instrument_identifiers SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM instrument_identifiers WHERE id=?)",
      )
      .bind(
        ref,
        instrument.namespace,
        instrument.scope,
        instrument.value,
        JSON.stringify(instrument.details),
        ref,
      ),
    db
      .prepare(
        "INSERT INTO instruments SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM instruments WHERE id=?)",
      )
      .bind(entity, instrument.kind, instrument.label, instrument.status, entity),
    db
      .prepare(`INSERT INTO instrument_mappings SELECT ?,?,coalesce((SELECT max(revision) FROM instrument_mappings WHERE identifier_id=?),0)+1,?,'rule',?,?,?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM instrument_mappings WHERE identifier_id=? AND (method='manual' OR policy_version>=?))`)
      .bind(
        await identityKey("im", [ref, version]),
        ref,
        ref,
        entity,
        instrument.reason,
        version,
        new Date().toISOString(),
        instrument.label,
        instrument.status,
        ref,
        version,
      ),
  ]);
  const mapping = await db
    .prepare("SELECT id FROM current_instrument_mappings WHERE identifier_id=?")
    .bind(ref)
    .first<{ id: string }>();
  if (!mapping) throw new Error("identity_instrument_mapping_missing");
  return { ref, mapping: mapping.id };
}

interface ParseIdentity {
  id: number;
  artifact_id: number;
  source_id: string;
  producer_id: string;
  fetch_run_id: number;
}
interface ObservationRow {
  id: number;
  source_account: string;
  currency: string | null;
  instrument: string | null;
  security_code: string | null;
  security_name: string | null;
  market: string | null;
  subject: string | null;
  extra_json: string;
}
const columns = {
  transaction:
    "currency,NULL AS instrument,NULL AS security_code,NULL AS security_name,NULL AS market,NULL AS subject",
  balance:
    "NULL AS currency,instrument,NULL AS security_code,NULL AS security_name,NULL AS market,NULL AS subject",
  position: "currency,NULL AS instrument,security_code,security_name,market,NULL AS subject",
  valuation:
    "currency,NULL AS instrument,NULL AS security_code,NULL AS security_name,NULL AS market,subject",
};

export async function identifyParse(
  db: D1Database,
  parse: ParseIdentity,
  resolver: IdentityResolver,
  version = IDENTITY_POLICY_VERSION,
  maxRows = 200,
) {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("identity_version_invalid");
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 200)
    throw new Error("identity_row_budget_invalid");
  const verified = await db
    .prepare(`SELECT p.id,a.id AS artifact_id,a.source_id,r.producer_id,a.fetch_run_id FROM parse_runs p
    JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN financial_fetch_runs r ON r.id=a.fetch_run_id
    WHERE p.id=? AND p.status='ok'`)
    .bind(parse.id)
    .first<ParseIdentity>();
  if (
    !verified ||
    verified.artifact_id !== parse.artifact_id ||
    verified.source_id !== parse.source_id ||
    verified.producer_id !== parse.producer_id ||
    verified.fetch_run_id !== parse.fetch_run_id
  )
    throw new Error("identity_parse_provenance_invalid");
  const runId = await identityKey("ir", [parse.id, version]);
  if (
    await db.prepare("SELECT 1 FROM identity_run_seals WHERE identity_run_id=?").bind(runId).first()
  )
    return 0;
  await db
    .prepare(
      "INSERT INTO identity_runs SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM identity_runs WHERE id=?)",
    )
    .bind(runId, parse.id, version, new Date().toISOString(), runId)
    .run();
  const accounts = new Map<string, Awaited<ReturnType<typeof accountMapping>>>();
  const instruments = new Map<string, Awaited<ReturnType<typeof instrumentMapping>>>();
  let total = 0;
  for (const kind of kinds) {
    let after = 0;
    for (;;) {
      const rows = await db
        .prepare(
          `SELECT id,source_account,${columns[kind]},extra_json FROM ${kind}_observations b WHERE parse_run_id=? AND id>?
            AND NOT EXISTS(SELECT 1 FROM identity_observations c WHERE c.identity_run_id=? AND c.kind=? AND c.observation_id=b.id)
            ORDER BY id LIMIT ?`,
        )
        .bind(parse.id, after, runId, kind, Math.min(50, maxRows - total))
        .all<ObservationRow>();
      if (!rows.results.length) break;
      const observations: unknown[][] = [];
      const uses: unknown[][] = [];
      for (const row of rows.results) {
        const extra: unknown = JSON.parse(row.extra_json);
        if (extra === null || typeof extra !== "object" || Array.isArray(extra))
          throw new Error("identity_extra_invalid");
        const input: IdentityInput = {
          kind,
          observationId: row.id,
          parseRunId: parse.id,
          artifactId: parse.artifact_id,
          fetchRunId: parse.fetch_run_id,
          sourceId: parse.source_id,
          producerId: parse.producer_id,
          sourceAccount: row.source_account,
          currency: row.currency,
          instrument: row.instrument,
          securityCode: row.security_code,
          securityName: row.security_name,
          market: row.market,
          subject: row.subject,
          extra: record(extra),
        };
        const plan = resolver(input);
        const accountKey = JSON.stringify(plan.account.key);
        let account = accounts.get(accountKey);
        if (!account) {
          account = await accountMapping(db, input, plan.account, version);
          accounts.set(accountKey, account);
        }
        const id = await identityKey("io", [runId, kind, row.id]);
        observations.push([
          id,
          runId,
          kind,
          row.id,
          account.ref,
          account.mapping,
          JSON.stringify(plan.issues),
        ]);
        const roles = new Set<string>();
        for (const value of plan.instruments) {
          if (roles.has(value.role)) throw new Error("identity_duplicate_instrument_role");
          roles.add(value.role);
          const key = JSON.stringify([value.namespace, value.scope, value.value]);
          let mapped = instruments.get(key);
          if (!mapped) {
            mapped = await instrumentMapping(db, value, version);
            instruments.set(key, mapped);
          }
          uses.push([id, value.role, mapped.ref, mapped.mapping]);
        }
        total++;
        after = row.id;
      }
      // JSON batches bound the parameter count; all row writes are atomic.
      await db.batch([
        db
          .prepare(`INSERT INTO identity_observations SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),json_extract(value,'$[6]') FROM json_each(?) x
          WHERE NOT EXISTS(SELECT 1 FROM identity_observations o WHERE o.id=json_extract(x.value,'$[0]'))`)
          .bind(JSON.stringify(observations)),
        db
          .prepare(`INSERT INTO identity_instrument_uses SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]') FROM json_each(?) x
          WHERE NOT EXISTS(SELECT 1 FROM identity_instrument_uses u WHERE u.identity_observation_id=json_extract(x.value,'$[0]') AND u.role=json_extract(x.value,'$[1]'))`)
          .bind(JSON.stringify(uses)),
      ]);
      // Persisted pages are the checkpoint. A later invocation skips them
      // rather than starting a large parse from the beginning indefinitely.
      if (total >= maxRows) return total;
    }
  }
  await db
    .prepare(
      "INSERT INTO identity_run_seals SELECT ?,(SELECT count(*) FROM identity_observations WHERE identity_run_id=?),? WHERE NOT EXISTS(SELECT 1 FROM identity_run_seals WHERE identity_run_id=?)",
    )
    .bind(runId, runId, new Date().toISOString(), runId)
    .run();
  return total;
}

/** Runs on the existing private pipeline. No new public service or credentials. */
export async function identitySweep(
  db: D1Database,
  resolver: IdentityResolver,
  maxRuns = 8,
  source?: string,
) {
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 40)
    throw new Error("identity_batch_invalid");
  const candidates = await db
    .prepare(`SELECT p.id,a.id AS artifact_id,a.source_id,r.producer_id,a.fetch_run_id
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN financial_fetch_runs r ON r.id=a.fetch_run_id
    JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
    WHERE p.status='ok' AND f.status='success' AND f.failure_count=0 AND (?1 IS NULL OR a.source_id=?1) AND NOT EXISTS(
      SELECT 1 FROM identity_runs i JOIN identity_run_seals s ON s.identity_run_id=i.id
      WHERE i.parse_run_id=p.id AND i.policy_version>=?2)
    ORDER BY (p.superseded_by_parse_run_id IS NOT NULL),p.id LIMIT ?3`)
    .bind(source ?? null, IDENTITY_POLICY_VERSION, maxRuns)
    .all<ParseIdentity>();
  let observations = 0;
  let processedRuns = 0,
    identifiedRuns = 0;
  for (const parse of candidates.results) {
    if (observations >= 200) break;
    observations += await identifyParse(
      db,
      parse,
      resolver,
      IDENTITY_POLICY_VERSION,
      200 - observations,
    );
    processedRuns++;
    const sealed = await db
      .prepare(
        "SELECT 1 FROM identity_runs r JOIN identity_run_seals s ON s.identity_run_id=r.id WHERE r.parse_run_id=? AND r.policy_version=?",
      )
      .bind(parse.id, IDENTITY_POLICY_VERSION)
      .first();
    if (sealed) identifiedRuns++;
  }
  return { processedRuns, identifiedRuns, identifiedObservations: observations };
}

/** Local operator corrections use expected revision to reject stale edits.
 * Entity creation and decisions are atomic. Never accepts amounts or edits B. */
export async function reviseIdentity(
  db: D1Database,
  change: {
    kind: "account" | "instrument";
    referenceId: string;
    targetId: string;
    expectedRevision: number;
    reason: string;
  },
) {
  if (
    !change.reason.trim() ||
    change.reason.length > 1000 ||
    !Number.isSafeInteger(change.expectedRevision) ||
    change.expectedRevision < 1
  )
    throw new Error("identity_revision_invalid");
  const account = change.kind === "account";
  const table = account ? "account_mappings" : "instrument_mappings";
  const reference = account ? "source_account_id" : "identifier_id";
  const target = account ? "account_id" : "instrument_id";
  const entities = account ? "accounts" : "instruments";
  const currentView = account ? "current_account_mappings" : "current_instrument_mappings";
  const same = await db
    .prepare(`SELECT label,status FROM ${currentView} WHERE ${reference}=? AND ${target}=?`)
    .bind(change.referenceId, change.targetId)
    .first<{ label: string; status: string }>();
  const claims = same
    ? [same]
    : (
        await db
          .prepare(`SELECT DISTINCT label,status FROM ${currentView} WHERE ${target}=? LIMIT 2`)
          .bind(change.targetId)
          .all<{ label: string; status: string }>()
      ).results;
  if (claims.length > 1) throw new Error("identity_target_metadata_ambiguous");
  const metadata =
    claims[0] ??
    (await db
      .prepare(`SELECT label,status FROM ${entities} WHERE id=?`)
      .bind(change.targetId)
      .first<{ label: string; status: string }>());
  if (!metadata) throw new Error("identity_target_missing");
  const result = await db
    .prepare(`INSERT INTO ${table}(id,${reference},revision,${target},method,reason,policy_version,created_at,label,status)
    SELECT ?,?,?,?,'manual',?,?,?,?,? FROM ${entities} e WHERE e.id=? AND (SELECT max(revision) FROM ${table} WHERE ${reference}=?)=?`)
    .bind(
      crypto.randomUUID(),
      change.referenceId,
      change.expectedRevision + 1,
      change.targetId,
      change.reason,
      IDENTITY_POLICY_VERSION,
      new Date().toISOString(),
      metadata.label,
      metadata.status,
      change.targetId,
      change.referenceId,
      change.expectedRevision,
    )
    .run();
  if (result.meta.changes !== 1) throw new Error("identity_revision_conflict");
}
