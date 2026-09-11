import type { D1Like } from "../d1.ts";
import type {
  AccountIdentity,
  IdentityInput,
  IdentityPlan,
  InstrumentIdentity,
} from "../../../identity/src/types.ts";
import { record } from "../../../identity/src/types.ts";
import { executeIdentityCommand, type IdentityCommandError } from "./identity-commands.ts";
import { identityKey } from "./identity-keys.ts";
import {
  BASE_IDENTITY_POLICY_VERSION,
  dependencyDigest,
  IDENTITY_POLICY_VERSION,
  type IdentityParseMeta,
  type IdentityPolicySelection,
  loadIdentityEvidence,
  requiredIdentityPolicySql,
  selectIdentityPolicy,
  trustedVpassBinding,
  VPASS_POLICY_FAMILY,
  type VpassBinding,
} from "./identity-policies/index.ts";

export type IdentityResolver = (input: IdentityInput) => IdentityPlan;
export {
  BASE_IDENTITY_POLICY_VERSION,
  IDENTITY_POLICY_VERSION,
  identityKey,
  requiredIdentityPolicySql,
};
const kinds = ["transaction", "balance", "position", "valuation"] as const;
const EMPTY_PARSE_SQL = kinds
  .map(
    (kind) =>
      `NOT EXISTS(SELECT 1 FROM ${kind}_observations empty_row WHERE empty_row.parse_run_id=p.id)`,
  )
  .join(" AND ");

/** Automatic policy yields to the latest effective decision (migration 0029):
 * an active manual override, or a manual row the log does not describe. */
const PROTECTED_SQL = (subjectKind: "account_mapping" | "instrument_mapping") =>
  `EXISTS(SELECT 1 FROM protected_mapping_subjects protected WHERE protected.subject_kind='${subjectKind}' AND protected.subject_ref=?)`;

/** The first revision keeps the historical id form; later automatic revisions
 * (possible after a release-override) are qualified by their revision. */
const MAPPING_ID_SQL = "CASE WHEN next.revision=1 THEN ? ELSE ?||'-r'||next.revision END";
async function mappingIdBindings(prefix: "am" | "im", ref: string, version: number) {
  const base = await identityKey(prefix, [ref, version]);
  return [base, base] as const;
}

/** Appends an automatic decision only when no effective manual decision
 * protects the subject and no current automatic decision of an equal or newer
 * policy exists. Version comparison is numeric; old workers cannot undo newer rules. */
async function accountMapping(
  db: D1Like,
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
    // The id carries the revision: after a release-override the same policy
    // version may append again, and an id derived from the version alone
    // would collide with the earlier rule revision.
    db
      .prepare(`INSERT INTO account_mappings SELECT ${MAPPING_ID_SQL},?,next.revision,?,'rule',?,?,?,?,?
      FROM (SELECT coalesce((SELECT max(revision) FROM account_mappings WHERE source_account_id=?),0)+1 AS revision) next
      WHERE NOT ${PROTECTED_SQL("account_mapping")}
      AND NOT EXISTS(SELECT 1 FROM current_account_mappings current WHERE current.source_account_id=? AND current.method='rule' AND current.policy_version>=?)`)
      .bind(
        ...(await mappingIdBindings("am", ref, version)),
        ref,
        entity,
        account.reason,
        version,
        new Date().toISOString(),
        account.label,
        account.status,
        ref,
        ref,
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

async function instrumentMapping(db: D1Like, instrument: InstrumentIdentity, version: number) {
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
      .prepare(`INSERT INTO instrument_mappings SELECT ${MAPPING_ID_SQL},?,next.revision,?,'rule',?,?,?,?,?
      FROM (SELECT coalesce((SELECT max(revision) FROM instrument_mappings WHERE identifier_id=?),0)+1 AS revision) next
      WHERE NOT ${PROTECTED_SQL("instrument_mapping")}
      AND NOT EXISTS(SELECT 1 FROM current_instrument_mappings current WHERE current.identifier_id=? AND current.method='rule' AND current.policy_version>=?)`)
      .bind(
        ...(await mappingIdBindings("im", ref, version)),
        ref,
        entity,
        instrument.reason,
        version,
        new Date().toISOString(),
        instrument.label,
        instrument.status,
        ref,
        ref,
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

type ParseIdentity = IdentityParseMeta;
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

/** The run's policy record: family, release and the digest of its evidence set. */
async function policyRecord(runId: string, parseId: number, selection: IdentityPolicySelection) {
  return [
    runId,
    parseId,
    selection.policyFamily,
    selection.release,
    await dependencyDigest(selection.dependencySet),
    JSON.stringify(selection.dependencySet),
  ] as const;
}

export async function identifyParse(
  db: D1Like,
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
  // The source's policy module decides the release and its evidence; the
  // store only persists the selected plan.
  const evidence = await loadIdentityEvidence(db, parse, version);
  const selection = selectIdentityPolicy(parse, evidence, version);
  version = selection.policyVersion;
  const binding: VpassBinding | undefined =
    selection.policyFamily === VPASS_POLICY_FAMILY ? trustedVpassBinding(evidence) : undefined;
  const runId = await identityKey("ir", [parse.id, version]);
  if (
    await db.prepare("SELECT 1 FROM identity_run_seals WHERE identity_run_id=?").bind(runId).first()
  )
    return 0;
  await db.batch([
    db
      .prepare(
        "INSERT INTO identity_runs SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM identity_runs WHERE id=?)",
      )
      .bind(runId, parse.id, version, new Date().toISOString(), runId),
    db
      .prepare(`INSERT INTO identity_run_policies SELECT ?,?,?,?,?,?
      WHERE NOT EXISTS(SELECT 1 FROM identity_run_policies WHERE identity_run_id=?)`)
      .bind(...(await policyRecord(runId, parse.id, selection)), runId),
  ]);
  if (binding)
    await db
      .prepare(`INSERT INTO identity_vpass_bindings
    SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM identity_vpass_bindings WHERE identity_run_id=?)`)
      .bind(
        runId,
        binding.financial_unit_id,
        binding.binding_artifact_id,
        binding.card_token,
        runId,
      )
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
          ...(binding && row.source_account === `vpass:${binding.financial_unit_key}`
            ? {
                trustedVpassBinding: {
                  cardToken: binding.card_token,
                  bindingArtifactId: binding.binding_artifact_id,
                  financialUnitId: binding.financial_unit_id,
                },
              }
            : {}),
        };
        const plan = resolver(input);
        if (input.trustedVpassBinding) {
          // A still-effective manual decision on the run-scoped reference is
          // retained instead of being replaced by the automatic token mapping.
          const fallbackKey = [input.sourceAccount, "fetch-run", String(input.fetchRunId)];
          const fallbackRef = await identityKey("sa", [
            input.sourceId,
            input.producerId,
            fallbackKey,
          ]);
          if (
            await db
              .prepare(
                `SELECT 1 FROM protected_mapping_subjects WHERE subject_kind='account_mapping' AND subject_ref=?`,
              )
              .bind(fallbackRef)
              .first()
          ) {
            plan.account.key = fallbackKey;
            plan.issues.push("manual-run-scoped-account-mapping-preserved");
          }
        }
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
  db: D1Like,
  resolver: IdentityResolver,
  maxRuns = 8,
  source?: string,
) {
  if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 40)
    throw new Error("identity_batch_invalid");
  const candidates = await db
    .prepare(`SELECT p.id,a.id AS artifact_id,a.source_id,r.producer_id,a.fetch_run_id,
      ${requiredIdentityPolicySql("a")} AS required_policy,
      (${EMPTY_PARSE_SQL}) AS is_empty
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN financial_fetch_runs r ON r.id=a.fetch_run_id
    JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
    WHERE p.status='ok' AND f.status='success' AND f.failure_count=0 AND (?1 IS NULL OR a.source_id=?1) AND NOT EXISTS(
      SELECT 1 FROM identity_runs i JOIN identity_run_seals s ON s.identity_run_id=i.id
      WHERE i.parse_run_id=p.id AND i.policy_version>=${requiredIdentityPolicySql("a")})
    ORDER BY NOT EXISTS(SELECT 1 FROM published_parse_runs pub WHERE pub.parse_run_id=p.id),p.id LIMIT ?2`)
    .bind(source ?? null, maxRuns)
    .all<ParseIdentity & { required_policy: number; is_empty: number }>();
  let observations = 0;
  let processedRuns = 0,
    identifiedRuns = 0;
  const empty = candidates.results.filter((parse) => parse.is_empty === 1);
  if (empty.length) {
    const createdAt = new Date().toISOString();
    const values = JSON.stringify(
      await Promise.all(
        empty.map(async (parse) => {
          // The same selector as the row path decides the release and evidence
          // digest; the SQL below still rechecks the required version itself.
          const selection = selectIdentityPolicy(
            parse,
            await loadIdentityEvidence(db, parse, parse.required_policy),
            parse.required_policy,
          );
          const [runId, , family, release, digest, dependencies] = await policyRecord(
            await identityKey("ir", [parse.id, selection.policyVersion]),
            parse.id,
            selection,
          );
          return [runId, parse.id, selection.policyVersion, family, release, digest, dependencies];
        }),
      ),
    );
    // At most maxRuns (40) entries and four SQL statements. Recheck all four
    // B tables and live eligibility inside the atomic write, not only in the
    // candidate read. Trusted Vpass policy-2 runs get the same guarded pins.
    const result = await db.batch([
      db
        .prepare(`INSERT INTO identity_runs
        SELECT json_extract(candidate.value,'$[0]'),p.id,json_extract(candidate.value,'$[2]'),? FROM json_each(?) candidate
        JOIN parse_runs p ON p.id=json_extract(candidate.value,'$[1]')
        JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
        JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
        WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
          AND ${requiredIdentityPolicySql("a")}=json_extract(candidate.value,'$[2]') AND ${EMPTY_PARSE_SQL}
          AND NOT EXISTS(SELECT 1 FROM identity_runs existing WHERE existing.id=json_extract(candidate.value,'$[0]'))`)
        .bind(createdAt, values),
      db
        .prepare(`INSERT INTO identity_run_policies
        SELECT r.id,r.parse_run_id,json_extract(candidate.value,'$[3]'),json_extract(candidate.value,'$[4]'),json_extract(candidate.value,'$[5]'),json_extract(candidate.value,'$[6]')
        FROM json_each(?) candidate
        JOIN identity_runs r ON r.id=json_extract(candidate.value,'$[0]')
          AND r.parse_run_id=json_extract(candidate.value,'$[1]') AND r.policy_version=json_extract(candidate.value,'$[2]')
        WHERE NOT EXISTS(SELECT 1 FROM identity_run_policies existing WHERE existing.identity_run_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM identity_run_seals sealed WHERE sealed.identity_run_id=r.id)`)
        .bind(values),
      db
        .prepare(`INSERT INTO identity_vpass_bindings
        SELECT r.id,b.financial_unit_id,b.binding_artifact_id,b.card_token FROM json_each(?) candidate
        JOIN identity_runs r ON r.id=json_extract(candidate.value,'$[0]')
          AND r.policy_version=json_extract(candidate.value,'$[2]') AND r.policy_version=2
        JOIN parse_runs p ON p.id=r.parse_run_id AND p.id=json_extract(candidate.value,'$[1]')
        JOIN trusted_vpass_card_bindings b ON b.financial_artifact_id=p.fetch_artifact_id
        WHERE p.status='ok' AND ${EMPTY_PARSE_SQL}
          AND NOT EXISTS(SELECT 1 FROM identity_vpass_bindings pin WHERE pin.identity_run_id=r.id)`)
        .bind(values),
      db
        .prepare(`INSERT INTO identity_run_seals
        SELECT r.id,0,? FROM json_each(?) candidate
        JOIN identity_runs r ON r.id=json_extract(candidate.value,'$[0]') AND r.policy_version=json_extract(candidate.value,'$[2]')
        JOIN parse_runs p ON p.id=r.parse_run_id AND p.id=json_extract(candidate.value,'$[1]')
        JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
        JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
        WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
          AND ${requiredIdentityPolicySql("a")}=json_extract(candidate.value,'$[2]') AND ${EMPTY_PARSE_SQL}
          AND NOT EXISTS(SELECT 1 FROM identity_run_seals existing WHERE existing.identity_run_id=r.id)
        RETURNING identity_run_id`)
        .bind(createdAt, values),
    ]);
    processedRuns += empty.length;
    // Sealed runs are counted from the rows the seal statement returned: D1
    // counts rows written by triggers too, and since migration 0038 sealing an
    // identity run also bumps the CORE revision (docs/projection-input.md).
    identifiedRuns += result[3]!.results?.length ?? 0;
  }
  const fastIds = new Set(empty.map((parse) => parse.id));
  for (const parse of candidates.results) {
    if (fastIds.has(parse.id)) continue;
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
        `SELECT 1 FROM identity_runs r JOIN identity_run_seals s ON s.identity_run_id=r.id
         JOIN parse_runs p ON p.id=r.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
         WHERE r.parse_run_id=? AND r.policy_version>=${requiredIdentityPolicySql("a")}`,
      )
      .bind(parse.id)
      .first();
    if (sealed) identifiedRuns++;
  }
  return { processedRuns, identifiedRuns, identifiedObservations: observations };
}

const LEGACY_ERRORS: Record<IdentityCommandError, string> = {
  invalid_command: "identity_revision_invalid",
  idempotency_conflict: "identity_operation_conflict",
  revision_conflict: "identity_revision_conflict",
  target_missing: "identity_target_missing",
  target_metadata_ambiguous: "identity_target_metadata_ambiguous",
  no_active_override: "identity_no_active_override",
};

/** Compatibility adapter for the pre-command callers: an `assign` from an
 * unverified local operator, recorded as the `legacy-cli` actor with a fresh
 * operation id. Expected-revision protection is unchanged. Never accepts
 * amounts or edits B. */
export async function reviseIdentity(
  db: D1Like,
  change: {
    kind: "account" | "instrument";
    referenceId: string;
    targetId: string;
    expectedRevision: number;
    reason: string;
  },
) {
  const result = await executeIdentityCommand(
    db,
    {
      operationId: crypto.randomUUID(),
      actorId: "legacy-cli",
      actorVerification: "legacy-unknown",
      action: "assign",
      kind: change.kind,
      referenceId: change.referenceId,
      expectedRevision: change.expectedRevision,
      targetId: change.targetId,
      reason: change.reason,
    },
    IDENTITY_POLICY_VERSION,
  );
  if (!result.ok) throw new Error(LEGACY_ERRORS[result.error]);
}
