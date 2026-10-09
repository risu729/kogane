// The synthetic store behind the cross-identifier instrument resolution tests
// (ADR 0055): CORE migrations 0017+ on the minimal Layer A stub, identifiers
// written by the production identity writer (`identifyParse`) from synthetic
// observations, and decisions through the change lifecycle. Shared by
// instrument-resolution.test.ts and instrument-candidates-review.test.ts.
import type { Database } from "bun:sqlite";
import { resolveIdentity } from "../../identity/src/index.ts";
import { currencyIdentity } from "../../identity/src/instruments.ts";
import type { IdentityInput, IdentityPlan } from "../../identity/src/types.ts";
import { prepareIdentityCommand } from "../../storage-d1/src/core/identity-commands.ts";
import {
  IDENTITY_POLICY_VERSION,
  identifyParse,
} from "../../storage-d1/src/core/identity-store.ts";
import { coreDatabase, sqliteD1 } from "../../storage-d1/test/sqlite.ts";
import { fromTemplate } from "../../read-model/test/schema-template.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import {
  type ChangeKind,
  type ChangePayload,
  type MutationInput,
  type MutationPlanners,
  type MutationWrites,
  type Principal,
} from "../src/command/contract.ts";
import { createPlan } from "../src/command/plan.ts";
import { relationMutation } from "../src/operations/relation-writes.ts";
import { identitySubjectRef } from "../src/operations/sql.ts";
import {
  type InstrumentResolution,
  type ResolutionCandidate,
} from "../src/query/instrument-resolution.ts";
import { sqliteCommandStore } from "./sqlite-store.ts";

const PRODUCER = "synthetic-producer";
export const BROKER_B = "synthetic-broker-b";
export const OPERATOR: Principal = {
  id: "operator",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
export const AGENT: Principal = {
  id: "agent",
  kind: "agent",
  verification: "server",
  capabilities: ["interpretation.propose"],
};
// After the identity writer's own clock, so a decision is later than the rule revision it corrects.
const T0 = "2099-01-01T00:00:00.000Z";

/** The Processor's identity planner (services/processor/src/change-commands.ts), over bun:sqlite. */
function identityMutation(db: Database) {
  return async (input: MutationInput): Promise<MutationWrites | null> => {
    const { plan, principal, operationId, now, guard } = input;
    if (plan.kind !== "identity.assign" && plan.kind !== "identity.release-override") return null;
    const payload = plan.payload as {
      subject: "account" | "instrument";
      referenceId: string;
      targetId?: string;
      reason: string;
    };
    const expectedRevision =
      plan.expectedRevisions[identitySubjectRef(payload.subject, payload.referenceId)];
    if (expectedRevision === undefined) return null;
    const assign = plan.kind === "identity.assign";
    const prepared = await prepareIdentityCommand(
      sqliteD1(db),
      {
        operationId,
        actorId: principal.id,
        actorVerification: "server",
        action: assign ? "assign" : "release-override",
        kind: payload.subject,
        referenceId: payload.referenceId,
        expectedRevision,
        targetId: assign ? (payload.targetId ?? null) : null,
        reason: payload.reason,
      },
      IDENTITY_POLICY_VERSION,
      { guard, now },
    );
    if ("error" in prepared) return null;
    return {
      writes: prepared.writes.map((write) => ({ sql: write.sql, binds: write.binds })),
      decisionRevisionId: prepared.receipt.decisionRevisionId,
      result: { referenceId: prepared.receipt.referenceId, revision: prepared.receipt.revision },
    };
  };
}

export function planners(db: Database): MutationPlanners {
  const identity = identityMutation(db);
  return {
    "identity.assign": identity,
    "identity.release-override": identity,
    "relation.accept": relationMutation,
    "relation.reject": relationMutation,
  };
}

/** A synthetic second broker: one provider code, the country it is scoped to, one currency. */
function brokerBPolicy(input: IdentityInput): IdentityPlan {
  const extra = input.extra as { country?: string };
  return {
    account: {
      key: [input.sourceAccount],
      label: "Synthetic broker B",
      role: "brokerage",
      status: "provider-local",
      reason: "synthetic-test-policy",
    },
    instruments: [
      currencyIdentity(input.currency ?? "JPY", "unit"),
      {
        role: "security",
        kind: "security",
        namespace: "synthetic-broker-b-code",
        scope: extra.country ?? "unknown-country",
        value: input.securityCode ?? "unknown",
        label: input.securityName ?? input.securityCode ?? "unknown",
        status: "provider-local",
        reason: "synthetic-test-policy",
        details: {
          securityCode: input.securityCode ?? "unknown",
          ...(extra.country ? { countryCode: extra.country } : {}),
        },
      },
    ],
    issues: [],
  };
}

export const resolver = (input: IdentityInput): IdentityPlan =>
  input.sourceId === BROKER_B ? brokerBPolicy(input) : resolveIdentity(input);

export interface Position {
  account: string;
  code: string;
  name: string;
  market?: string | null;
  /** Nullable as in position_observations: a provider row may name no currency. */
  currency: string | null;
  extra?: Record<string, unknown>;
}
export interface Trade {
  account: string;
  currency: string;
  extra: Record<string, unknown>;
}
interface Capture {
  run: number;
  artifact: number;
}

// CORE 0017+ over the Layer A stub, migrated once per process; every world
// gets its own copy of the image (packages/read-model/test/schema-template.ts).
export function stubDatabase(): Database {
  return fromTemplate("instrument-resolution-core-stub", () => coreDatabase());
}

export class World {
  readonly db: Database = stubDatabase();
  readonly sql: SqlExecutor;
  private sequence = 0;

  constructor() {
    this.db
      .exec(`INSERT INTO sources VALUES('sbi-securities','synthetic'),('sbi-vc-trade','synthetic'),('${BROKER_B}','synthetic');
      INSERT INTO producers VALUES('${PRODUCER}');`);
    const db = this.db;
    this.sql = {
      all: async <T>(text: string, args: readonly unknown[]) =>
        db.query(text).all(...(args as never[])) as T[],
      first: async <T>(text: string, args: readonly unknown[]) =>
        (db.query(text).get(...(args as never[])) as T | null) ?? null,
    };
  }

  private id(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * One sealed capture of `source`, identified by the production writer and
   * published unless `publish` is false. `reparseOf` parses an earlier
   * capture's artifact again; publishing it moves that artifact's
   * publication pointer, so the earlier parse is superseded.
   */
  async capture(
    source: string,
    positions: Position[],
    trades: Trade[] = [],
    options: { publish?: boolean; reparseOf?: Capture } = {},
  ): Promise<Capture> {
    let run: number;
    let artifact: number;
    if (options.reparseOf) ({ run, artifact } = options.reparseOf);
    else {
      run = this.id();
      this.db.run(
        "INSERT INTO acquisition_sessions(id,external_session_id,producer_id,external_id_namespace) VALUES(?,?,?,'synthetic')",
        [run, `synthetic-session-${run}`, PRODUCER],
      );
      this.db.run(
        "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,?,?,?,0)",
        [run, source, run, PRODUCER],
      );
      this.db.run("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)", [run]);
      this.db.run("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)", [run]);
      artifact = this.id();
      this.db.run(
        `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetched_at_ms,recorded_at_ms,sha256,artifact_role)
         VALUES(?,?,?,'synthetic','synthetic.json',0,0,?,'provider_response')`,
        [artifact, run, source, artifact.toString(16).padStart(64, "0")],
      );
    }
    const parse = this.id();
    // A parser runs once per artifact and version, so a re-parse is a new version.
    const version = options.reparseOf ? `1.1.${parse}` : "1.0.0";
    this.db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic',?,?,'ok','[]')",
      [parse, artifact, version, T0],
    );
    if (options.publish !== false) {
      if (options.reparseOf)
        this.db.run(
          "UPDATE published_parse_runs SET parse_run_id=?,parser_version=? WHERE fetch_artifact_id=?",
          [parse, version, artifact],
        );
      else
        this.db.run(
          "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,'synthetic',?,?,?,'normal')",
          [artifact, parse, version, T0],
        );
    }
    for (const [index, position] of positions.entries())
      this.db.run(
        `INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,raw_locator,extra_json)
         VALUES(?,?,?,?,?,'1',0,?,?,?)`,
        [
          parse,
          position.account,
          position.code,
          position.name,
          position.market ?? null,
          position.currency,
          `$.positions[${index}]`,
          JSON.stringify(position.extra ?? {}),
        ],
      );
    for (const [index, trade] of trades.entries())
      this.db.run(
        `INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json)
         VALUES(?,?,?,?,?)`,
        [parse, trade.account, trade.currency, `$.trades[${index}]`, JSON.stringify(trade.extra)],
      );
    const meta = {
      id: parse,
      artifact_id: artifact,
      source_id: source,
      producer_id: PRODUCER,
      fetch_run_id: run,
    };
    while (await identifyParse(sqliteD1(this.db), meta, resolver)) {
      // Resume the writer's bounded pages until the run is sealed.
    }
    if (
      !this.db
        .query(
          "SELECT 1 FROM identity_runs r JOIN identity_run_seals s ON s.identity_run_id=r.id WHERE r.parse_run_id=?",
        )
        .get(parse)
    )
      throw new Error("identity run not sealed");
    return { run, artifact };
  }

  /**
   * Identify a capture's published parse again under a later identity policy
   * version, as a re-identification sweep does: a second sealed identity run
   * for the same parse, which the current view then reads instead of the first.
   */
  async reidentify(capture: Capture, version: number): Promise<void> {
    const row = this.db
      .query(
        "SELECT p.parse_run_id AS id,a.source_id FROM published_parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id WHERE p.fetch_artifact_id=?",
      )
      .get(capture.artifact) as { id: number; source_id: string };
    const meta = {
      id: row.id,
      artifact_id: capture.artifact,
      source_id: row.source_id,
      producer_id: PRODUCER,
      fetch_run_id: capture.run,
    };
    while (await identifyParse(sqliteD1(this.db), meta, resolver, version)) {
      // Resume the writer's bounded pages until the run is sealed.
    }
  }

  /** Every row of the tables a read must never write. */
  snapshot(): string {
    return JSON.stringify(
      [
        "instrument_identifiers",
        "instruments",
        "instrument_mappings",
        "decision_revisions",
        "decision_operations",
        "entity_relations",
        "change_plans",
      ].map((table) => this.db.query(`SELECT * FROM ${table} ORDER BY 1`).all()),
    );
  }

  identifier(namespace: string, scope: string, value: string): string {
    const row = this.db
      .query("SELECT id FROM instrument_identifiers WHERE namespace=? AND scope=? AND value=?")
      .get(namespace, scope, value) as { id: string } | null;
    if (!row) throw new Error(`no identifier ${namespace}/${scope}/${value}`);
    return row.id;
  }
}

/**
 * A store with:
 * - SBI domestic `SYN9001` held on XTKS, and traded on a venue the SBI rule does
 *   not map (a provider-code identifier), and held at broker B in JPY;
 * - SBI domestic `SYN9002` held on XTKS and on XNGO (two listings);
 * - SBI domestic `SYN9003` held in JPY and broker B's `SYN9003` stated in USD;
 * - SBI foreign `SYN` with a provider RIC, and traded without one;
 * - SBI `SYN9004` and broker B `SYN9005` under one display name.
 */
export async function world(): Promise<World> {
  const w = new World();
  const domestic = "sbi-securities:domestic";
  await w.capture(
    "sbi-securities",
    [
      {
        account: domestic,
        code: "SYN9001",
        name: "Synthetic Holdings",
        market: "TKY",
        currency: "JPY",
      },
      { account: domestic, code: "SYN9002", name: "Synthetic Two", market: "TKY", currency: "JPY" },
      { account: domestic, code: "SYN9002", name: "Synthetic Two", market: "NGY", currency: "JPY" },
      {
        account: domestic,
        code: "SYN9003",
        name: "Synthetic Three",
        market: "TKY",
        currency: "JPY",
      },
      {
        account: domestic,
        code: "SYN9004",
        name: "Synthetic Shared Name",
        market: "TKY",
        currency: "JPY",
      },
      {
        account: "sbi-securities:foreign",
        code: "SYN",
        name: "Synthetic Foreign",
        currency: "USD",
        extra: {
          specificAccountCode: "SYNTHETIC",
          securities: { securitiesCode: "SYN", ric: "SYN.X", countryCode: "US" },
        },
      },
    ],
    [
      {
        account: domestic,
        currency: "JPY",
        extra: {
          issueCode: "SYN9001",
          issueName: "Synthetic Holdings",
          marketLabel: "SYNTHETIC-VENUE",
          accountLabel: "synthetic",
        },
      },
      {
        account: "sbi-securities:foreign",
        currency: "JPY",
        extra: {
          specificAccountCode: "SYNTHETIC",
          tradeCurrencyCode: "USD",
          settlementCurrencyCode: "JPY",
          securities: { securitiesCode: "SYN", countryCode: "US" },
        },
      },
    ],
  );
  await w.capture(BROKER_B, [
    {
      account: "synthetic-broker-b:custody",
      code: "SYN9001",
      name: "SYNTHETIC HOLDINGS",
      currency: "JPY",
      extra: { country: "JP" },
    },
    {
      account: "synthetic-broker-b:custody",
      code: "SYN9003",
      name: "Synthetic Three",
      currency: "USD",
      extra: { country: "JP" },
    },
    {
      account: "synthetic-broker-b:custody",
      code: "SYN9005",
      name: "Synthetic Shared Name",
      currency: "JPY",
      extra: { country: "JP" },
    },
  ]);
  return w;
}

export function ids(w: World) {
  return {
    listing9001: w.identifier("mic-symbol", "XTKS", "SYN9001"),
    venue9001: w.identifier("sbi-security-code", "JP", "SYN9001"),
    broker9001: w.identifier("synthetic-broker-b-code", "JP", "SYN9001"),
    tokyo9002: w.identifier("mic-symbol", "XTKS", "SYN9002"),
    nagoya9002: w.identifier("mic-symbol", "XNGO", "SYN9002"),
    listing9003: w.identifier("mic-symbol", "XTKS", "SYN9003"),
    broker9003: w.identifier("synthetic-broker-b-code", "JP", "SYN9003"),
    shared9004: w.identifier("mic-symbol", "XTKS", "SYN9004"),
    broker9005: w.identifier("synthetic-broker-b-code", "JP", "SYN9005"),
    ric: w.identifier("ric", "", "SYN.X"),
    foreignCode: w.identifier("sbi-security-code", "US", "SYN"),
  };
}

export function candidateOf(
  result: InstrumentResolution,
  a: string,
  b: string,
): ResolutionCandidate {
  const found = result.candidates.find(
    (candidate) =>
      (candidate.anchorIdentifierId === a && candidate.subjectIdentifierId === b) ||
      (candidate.anchorIdentifierId === b && candidate.subjectIdentifierId === a),
  );
  if (!found) throw new Error(`no candidate ${a} ${b}`);
  return found;
}

export function stateOf(result: InstrumentResolution, id: string) {
  return result.identifiers.find((row) => row.identifierId === id)?.state;
}

export async function decide(
  w: World,
  principal: Principal,
  kind: ChangeKind,
  payload: ChangePayload,
  operationId: string,
) {
  const store = sqliteCommandStore(w.db);
  const plan = await createPlan(
    kind,
    payload,
    {
      actor: principal,
      baseContextId:
        kind === "identity.assign" && "candidate" in payload && payload.candidate
          ? payload.candidate.candidateId
          : "instrument-resolution:test",
      now: T0,
      ttlSeconds: 3600,
    },
    store,
  );
  if (!plan.ok) return { stage: "plan", result: plan } as const;
  const approval = await approve(store, {
    planId: plan.plan.planId,
    planDigest: plan.plan.planDigest,
    actor: principal,
    scope: [],
    ttlSeconds: 3600,
    now: T0,
  });
  if (!approval.ok) return { stage: "approve", result: approval } as const;
  const committed = await commit(store, {
    operationId,
    principal,
    planId: plan.plan.planId,
    approvalId: approval.approval.approvalId,
    planners: planners(w.db),
    now: T0,
  });
  return { stage: "commit", result: committed } as const;
}

/**
 * A held candidate: broker B's `SYN9101` is mapped by a person onto another
 * listing's instrument (`SYN9102` on XTKS), and the `SYN9101` listing's own
 * mapping is confirmed by a person, so both sides are settled and the pair is
 * `subject-decided-elsewhere`: it names keeping apart only.
 */
export async function heldWorld(): Promise<{ w: World; listing: string; broker: string }> {
  const w = new World();
  const domestic = "sbi-securities:domestic";
  await w.capture("sbi-securities", [
    { account: domestic, code: "SYN9101", name: "Synthetic A", market: "TKY", currency: "JPY" },
    { account: domestic, code: "SYN9102", name: "Synthetic B", market: "TKY", currency: "JPY" },
  ]);
  await w.capture(BROKER_B, [
    {
      account: "synthetic-broker-b:custody",
      code: "SYN9101",
      name: "Synthetic A",
      currency: "JPY",
      extra: { country: "JP" },
    },
  ]);
  const listing = w.identifier("mic-symbol", "XTKS", "SYN9101");
  const other = w.identifier("mic-symbol", "XTKS", "SYN9102");
  const broker = w.identifier("synthetic-broker-b-code", "JP", "SYN9101");
  const instrumentOf = (identifier: string) =>
    (
      w.db
        .query("SELECT instrument_id AS id FROM current_instrument_mappings WHERE identifier_id=?")
        .get(identifier) as { id: string }
    ).id;
  for (const [referenceId, targetId, operationId] of [
    [broker, instrumentOf(other), "op-held-first"],
    [listing, instrumentOf(listing), "op-held-second"],
  ] as const) {
    const outcome = await decide(
      w,
      OPERATOR,
      "identity.assign",
      { subject: "instrument", referenceId, targetId, reason: "synthetic earlier decision" },
      operationId,
    );
    if (outcome.stage !== "commit" || !outcome.result.ok) throw new Error("held world not built");
  }
  return { w, listing, broker };
}
