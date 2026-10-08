// Cross-identifier instrument resolution (src/query/instrument-resolution.ts,
// ADR 0048) over CORE migrations 0017+ on the minimal Layer A stub. The
// identifiers are written by the production identity writer (`identifyParse`)
// from synthetic observations: SBI Securities rows go through the deployed SBI
// rules, and a second broker, `synthetic-broker-b`, through a test policy
// that states a code and a country the way a provider rule would. Decisions
// go through the change lifecycle (plan, approve, commit) with the same
// identity writer the Processor commits with. Every code, name and account
// here is invented.
import { beforeAll, describe, expect, test } from "bun:test";
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
import {
  INSTRUMENT_FACTS_SQL,
  INSTRUMENT_HISTORY_SQL,
  LISTED_AS_SQL,
} from "../../read-model/src/instrument-resolution.ts";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import {
  validPayload,
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
  InstrumentResolutionLimitError,
  queryInstrumentHistory,
  queryInstrumentResolution,
  type InstrumentResolution,
  type ResolutionCandidate,
} from "../src/query/instrument-resolution.ts";
import { sqliteCommandStore } from "./sqlite-store.ts";

const PRODUCER = "synthetic-producer";
const BROKER_B = "synthetic-broker-b";
const OPERATOR: Principal = {
  id: "operator",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const AGENT: Principal = {
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

function planners(db: Database): MutationPlanners {
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

const resolver = (input: IdentityInput): IdentityPlan =>
  input.sourceId === BROKER_B ? brokerBPolicy(input) : resolveIdentity(input);

interface Position {
  account: string;
  code: string;
  name: string;
  market?: string | null;
  currency: string;
  extra?: Record<string, unknown>;
}
interface Trade {
  account: string;
  currency: string;
  extra: Record<string, unknown>;
}

// CORE 0017+ over the Layer A stub, migrated once per process; every world
// gets its own copy of the image (packages/read-model/test/schema-template.ts).
function stubDatabase(): Database {
  return fromTemplate("instrument-resolution-core-stub", () => coreDatabase());
}

class World {
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

  /** One sealed, published capture of `source`, identified by the production writer. */
  async capture(source: string, positions: Position[], trades: Trade[] = []): Promise<void> {
    const run = this.id();
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
    const artifact = this.id();
    this.db.run(
      `INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetched_at_ms,recorded_at_ms,sha256,artifact_role)
       VALUES(?,?,?,'synthetic','synthetic.json',0,0,?,'provider_response')`,
      [artifact, run, source, artifact.toString(16).padStart(64, "0")],
    );
    const parse = this.id();
    this.db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic','1.0.0',?,'ok','[]')",
      [parse, artifact, T0],
    );
    this.db.run(
      "INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind) VALUES(?,'synthetic',?,'1.0.0',?,'normal')",
      [artifact, parse, T0],
    );
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
 * - SBI domestic `9001` held on XTKS, and traded on a venue the SBI rule does
 *   not map (a provider-code identifier), and held at broker B in JPY;
 * - SBI domestic `9002` held on XTKS and on XNGO (two listings);
 * - SBI domestic `9003` held in JPY and broker B's `9003` stated in USD;
 * - SBI foreign `SYN` with a provider RIC, and traded without one;
 * - SBI `9004` and broker B `9005` under one display name.
 */
async function world(): Promise<World> {
  const w = new World();
  const domestic = "sbi-securities:domestic";
  await w.capture(
    "sbi-securities",
    [
      {
        account: domestic,
        code: "9001",
        name: "Synthetic Holdings",
        market: "TKY",
        currency: "JPY",
      },
      { account: domestic, code: "9002", name: "Synthetic Two", market: "TKY", currency: "JPY" },
      { account: domestic, code: "9002", name: "Synthetic Two", market: "NGY", currency: "JPY" },
      { account: domestic, code: "9003", name: "Synthetic Three", market: "TKY", currency: "JPY" },
      {
        account: domestic,
        code: "9004",
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
          issueCode: "9001",
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
      code: "9001",
      name: "SYNTHETIC HOLDINGS",
      currency: "JPY",
      extra: { country: "JP" },
    },
    {
      account: "synthetic-broker-b:custody",
      code: "9003",
      name: "Synthetic Three",
      currency: "USD",
      extra: { country: "JP" },
    },
    {
      account: "synthetic-broker-b:custody",
      code: "9005",
      name: "Synthetic Shared Name",
      currency: "JPY",
      extra: { country: "JP" },
    },
  ]);
  return w;
}

function ids(w: World) {
  return {
    listing9001: w.identifier("mic-symbol", "XTKS", "9001"),
    venue9001: w.identifier("sbi-security-code", "JP", "9001"),
    broker9001: w.identifier("synthetic-broker-b-code", "JP", "9001"),
    tokyo9002: w.identifier("mic-symbol", "XTKS", "9002"),
    nagoya9002: w.identifier("mic-symbol", "XNGO", "9002"),
    listing9003: w.identifier("mic-symbol", "XTKS", "9003"),
    broker9003: w.identifier("synthetic-broker-b-code", "JP", "9003"),
    shared9004: w.identifier("mic-symbol", "XTKS", "9004"),
    broker9005: w.identifier("synthetic-broker-b-code", "JP", "9005"),
    ric: w.identifier("ric", "", "SYN.X"),
    foreignCode: w.identifier("sbi-security-code", "US", "SYN"),
  };
}

function candidateOf(result: InstrumentResolution, a: string, b: string): ResolutionCandidate {
  const found = result.candidates.find(
    (candidate) =>
      (candidate.anchorIdentifierId === a && candidate.subjectIdentifierId === b) ||
      (candidate.anchorIdentifierId === b && candidate.subjectIdentifierId === a),
  );
  if (!found) throw new Error(`no candidate ${a} ${b}`);
  return found;
}

function stateOf(result: InstrumentResolution, id: string) {
  return result.identifiers.find((row) => row.identifierId === id)?.state;
}

async function decide(
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
    { actor: principal, baseContextId: "instrument-resolution:test", now: T0, ttlSeconds: 3600 },
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

beforeAll(() => {
  stubDatabase().close();
}, 60_000);

describe("candidates from the identifiers the identity rules stored", () => {
  test("evidence-backed pairs are proposed, conflicting ones separated, equal names only hinted", async () => {
    const w = await world();
    const id = ids(w);
    const before = w.snapshot();
    const result = await queryInstrumentResolution(w.sql);
    expect(w.snapshot()).toBe(before);
    expect(result.policy).toBe("instrument-candidates-v1");

    // The same JP code on XTKS and on a venue the rule does not map: one
    // source, a proposal with the market unconfirmed.
    expect(candidateOf(result, id.listing9001, id.venue9001)).toMatchObject({
      anchorIdentifierId: id.listing9001,
      subjectIdentifierId: id.venue9001,
      evidence: ["security-code-equal"],
      gaps: ["market-unconfirmed"],
      crossSource: false,
      status: "proposed",
    });
    // Across brokers: the listing anchors broker B's code.
    const cross = candidateOf(result, id.listing9001, id.broker9001);
    expect(cross).toMatchObject({
      anchorIdentifierId: id.listing9001,
      subjectIdentifierId: id.broker9001,
      agreements: ["kind-agrees", "country-agrees", "currency-agrees"],
      crossSource: true,
      status: "proposed",
    });
    // The foreign RIC and the RIC-less trade code: USD on both (the trade's
    // trade unit, not its JPY settlement unit).
    expect(candidateOf(result, id.ric, id.foreignCode)).toMatchObject({
      anchorIdentifierId: id.ric,
      evidence: ["security-code-equal"],
      agreements: ["kind-agrees", "country-agrees", "currency-agrees"],
      status: "proposed",
    });

    // Two listings, and two currencies, are kept apart.
    const separated = new Map(
      result.separated.map((pair) => [pair.identifierIds.join("|"), pair.conflicts]),
    );
    expect(separated.get([id.tokyo9002, id.nagoya9002].sort().join("|"))).toEqual([
      "market-differs",
    ]);
    expect(separated.get([id.listing9003, id.broker9003].sort().join("|"))).toEqual([
      "currency-differs",
    ]);
    for (const candidate of result.candidates) {
      const pair = [candidate.anchorIdentifierId, candidate.subjectIdentifierId];
      expect(pair.includes(id.nagoya9002) && pair.includes(id.tokyo9002)).toBe(false);
      expect(pair.includes(id.broker9003)).toBe(false);
    }

    // One display name, two codes: a hint, never a candidate.
    expect(result.hints).toEqual([
      {
        pairId: `instrument-pair:${[id.shared9004, id.broker9005].sort().join("|")}`,
        identifierIds: [id.shared9004, id.broker9005].sort() as [string, string],
        reason: "same-display-name",
        conflicts: [],
      },
    ]);
    expect(stateOf(result, id.broker9005)).toBe("no-candidate");
    expect(stateOf(result, id.shared9004)).toBe("no-candidate");

    // Nothing is adopted: every identifier still maps to its own instrument.
    expect(result.candidates.every((candidate) => candidate.status === "proposed")).toBe(true);
    expect(result.identifiers.every((row) => row.sharedWith.length === 0)).toBe(true);
    expect(stateOf(result, id.listing9001)).toBe("unresolved-candidates");
    expect(stateOf(result, id.nagoya9002)).toBe("no-candidate");
    expect(result.summary).toMatchObject({
      proposed: result.candidates.length,
      adopted: 0,
      rejected: 0,
    });

    // The provider's market wording is shown, never compared.
    expect(result.identifiers.find((row) => row.identifierId === id.venue9001)).toMatchObject({
      providerMarket: "SYNTHETIC-VENUE",
      mappingMethod: "rule",
      mappingRevision: 1,
      sources: ["sbi-securities"],
      currencies: ["JPY"],
    });
  });

  test("the commands a candidate names are valid change payloads once a person writes a reason", async () => {
    const w = await world();
    const result = await queryInstrumentResolution(w.sql);
    for (const candidate of result.candidates) {
      const commands = candidate.commands!;
      expect(
        validPayload(commands.adopt.kind, { ...commands.adopt.payload, reason: "same security" }),
      ).toBe(true);
      expect(
        validPayload(commands.keepApart.kind, {
          ...commands.keepApart.payload,
          reason: "different security",
        }),
      ).toBe(true);
      // The adopted target is the anchor's instrument; the subject is re-mapped.
      expect(commands.adopt.payload.referenceId).toBe(candidate.subjectIdentifierId);
    }
  });
});

describe("only a person's decision adopts or rejects, and the history keeps every revision", () => {
  test("an agent can plan an adoption but never approve or commit it", async () => {
    const w = await world();
    const id = ids(w);
    const candidate = candidateOf(
      await queryInstrumentResolution(w.sql),
      id.listing9001,
      id.broker9001,
    );
    const before = w.db.query("SELECT * FROM instrument_mappings ORDER BY id").all();
    const outcome = await decide(
      w,
      AGENT,
      "identity.assign",
      { ...candidate.commands!.adopt.payload, reason: "agent proposal" },
      "op-agent-adopt",
    );
    expect(outcome.stage).toBe("approve");
    expect(outcome.result).toMatchObject({ ok: false, error: "approval_required" });
    expect(w.db.query("SELECT * FROM instrument_mappings ORDER BY id").all()).toEqual(before);
    expect(
      candidateOf(await queryInstrumentResolution(w.sql), id.listing9001, id.broker9001).status,
    ).toBe("proposed");
  });

  test("a person's identity.assign adopts the candidate as a new manual revision", async () => {
    const w = await world();
    const id = ids(w);
    const candidate = candidateOf(
      await queryInstrumentResolution(w.sql),
      id.listing9001,
      id.broker9001,
    );
    const outcome = await decide(
      w,
      OPERATOR,
      "identity.assign",
      { ...candidate.commands!.adopt.payload, reason: "same security, checked" },
      "op-adopt",
    );
    expect(outcome.result.ok).toBe(true);

    const after = await queryInstrumentResolution(w.sql);
    const adopted = candidateOf(after, id.listing9001, id.broker9001);
    expect(adopted.status).toBe("adopted");
    expect(adopted.commands).toBeNull();
    expect(after.identifiers.find((row) => row.identifierId === id.broker9001)).toMatchObject({
      mappingMethod: "manual",
      mappingRevision: 2,
      sharedWith: [id.listing9001],
    });
    // The listing still has an open candidate with the venue code, so it is
    // unresolved; broker B's code is resolved.
    expect(stateOf(after, id.broker9001)).toBe("unresolved-candidates");
    // The venue code's candidates are still open: one decision does not
    // resolve a third identifier transitively.
    expect(candidateOf(after, id.listing9001, id.venue9001).status).toBe("proposed");

    const [history] = await queryInstrumentHistory(w.sql, [id.broker9001]);
    expect(
      history!.entries.map((entry) => [
        entry.entry,
        entry.revision,
        entry.method,
        entry.decisionKind,
      ]),
    ).toEqual([
      ["mapping", 1, "rule", null],
      ["decision", 2, "manual", "assign"],
      ["mapping", 2, "manual", null],
    ]);
    // The rule revision is still there, pointing where it pointed.
    expect(history!.entries[0]!.instrumentId).not.toBe(history!.entries[2]!.instrumentId);
  });

  test("a person's listed_as rejection keeps the pair apart and is in the history", async () => {
    const w = await world();
    const id = ids(w);
    const candidate = candidateOf(await queryInstrumentResolution(w.sql), id.ric, id.foreignCode);
    const outcome = await decide(
      w,
      OPERATOR,
      "relation.reject",
      { ...candidate.commands!.keepApart.payload, reason: "different listing, checked" },
      "op-keep-apart",
    );
    expect(outcome.result.ok).toBe(true);
    const after = await queryInstrumentResolution(w.sql);
    expect(candidateOf(after, id.ric, id.foreignCode).status).toBe("rejected");
    expect(stateOf(after, id.ric)).toBe("kept-separate");
    expect(stateOf(after, id.foreignCode)).toBe("kept-separate");
    // No mapping moved.
    expect(after.identifiers.find((row) => row.identifierId === id.foreignCode)).toMatchObject({
      mappingMethod: "rule",
      mappingRevision: 1,
      sharedWith: [],
    });
    const [history] = await queryInstrumentHistory(w.sql, [id.foreignCode]);
    expect(
      history!.entries.map((entry) => [entry.entry, entry.relationStatus, entry.decisionKind]),
    ).toEqual([
      ["mapping", null, null],
      ["relation", "rejected", "reject"],
    ]);
  });

  test("the history read is bounded", async () => {
    const w = await world();
    await expect(
      queryInstrumentHistory(
        w.sql,
        Array.from({ length: 101 }, (_, index) => `ii_${index}`),
      ),
    ).rejects.toBeInstanceOf(InstrumentResolutionLimitError);
    expect(await queryInstrumentHistory(w.sql, [])).toEqual([]);
  });
});

describe("a decision binds every identifier on the decided instrument", () => {
  const domestic = "sbi-securities:domestic";
  /** A domestic trade on a venue the SBI rule does not map: `sbi-security-code/JP/<code>`. */
  const venueTrade = (code: string, name: string): Trade => ({
    account: domestic,
    currency: "JPY",
    extra: {
      issueCode: code,
      issueName: name,
      marketLabel: "SYNTHETIC-VENUE",
      accountLabel: "synthetic",
    },
  });

  test("S1: a code a person mapped onto one listing is separated from the other listing", async () => {
    const w = new World();
    await w.capture(
      "sbi-securities",
      [
        {
          account: domestic,
          code: "SYN9102",
          name: "Synthetic Dual",
          market: "TKY",
          currency: "JPY",
        },
        {
          account: domestic,
          code: "SYN9102",
          name: "Synthetic Dual",
          market: "NGY",
          currency: "JPY",
        },
      ],
      [venueTrade("SYN9102", "Synthetic Dual")],
    );
    const tokyo = w.identifier("mic-symbol", "XTKS", "SYN9102");
    const nagoya = w.identifier("mic-symbol", "XNGO", "SYN9102");
    const venue = w.identifier("sbi-security-code", "JP", "SYN9102");

    const open = await queryInstrumentResolution(w.sql);
    const toTokyo = candidateOf(open, tokyo, venue);
    expect(toTokyo).toMatchObject({ anchorIdentifierId: tokyo, subjectIdentifierId: venue });
    expect(candidateOf(open, nagoya, venue)).toMatchObject({
      anchorIdentifierId: nagoya,
      subjectIdentifierId: venue,
    });
    const outcome = await decide(
      w,
      OPERATOR,
      "identity.assign",
      { ...toTokyo.commands!.adopt.payload, reason: "the venue trade is the Tokyo listing" },
      "op-s1-adopt",
    );
    expect(outcome.result.ok).toBe(true);

    const after = await queryInstrumentResolution(w.sql);
    expect(candidateOf(after, tokyo, venue)).toMatchObject({ status: "adopted", commands: null });
    // No command now offers to move the decided code onto the Nagoya listing.
    expect(
      after.candidates.some(
        (row) =>
          [row.anchorIdentifierId, row.subjectIdentifierId].includes(nagoya) &&
          [row.anchorIdentifierId, row.subjectIdentifierId].includes(venue),
      ),
    ).toBe(false);
    expect(after.separated).toContainEqual({
      pairId: `instrument-pair:${[nagoya, venue].sort().join("|")}`,
      identifierIds: [nagoya, venue].sort() as [string, string],
      evidence: ["security-code-equal"],
      conflicts: ["market-differs"],
      via: [tokyo],
      sharedInstrument: false,
    });
    expect(stateOf(after, venue)).toBe("resolved-by-decision");
    expect(stateOf(after, nagoya)).toBe("no-candidate");
  });

  test("S2: the identifier a person mapped is the anchor even when a new code has a lower id", async () => {
    const w = new World();
    await w.capture("sbi-securities", [
      { account: domestic, code: "SYN9101", name: "Synthetic Tie", market: "TKY", currency: "JPY" },
    ]);
    await w.capture(BROKER_B, [
      {
        account: "synthetic-broker-b:custody",
        code: "SYN9101",
        name: "Synthetic Tie",
        currency: "JPY",
        extra: { country: "JP" },
      },
    ]);
    const listing = w.identifier("mic-symbol", "XTKS", "SYN9101");
    const broker = w.identifier("synthetic-broker-b-code", "JP", "SYN9101");
    const adopt = candidateOf(await queryInstrumentResolution(w.sql), listing, broker);
    expect(adopt).toMatchObject({ anchorIdentifierId: listing, subjectIdentifierId: broker });
    expect(
      (
        await decide(
          w,
          OPERATOR,
          "identity.assign",
          { ...adopt.commands!.adopt.payload, reason: "same security, checked" },
          "op-s2-adopt",
        )
      ).result.ok,
    ).toBe(true);

    // A later trade on an unmapped venue adds a bare code whose hashed id
    // sorts before the decided broker code: the tie the anchor rule once broke by id.
    await w.capture("sbi-securities", [], [venueTrade("SYN9101", "Synthetic Tie")]);
    const venue = w.identifier("sbi-security-code", "JP", "SYN9101");
    expect(venue < broker).toBe(true);

    const after = await queryInstrumentResolution(w.sql);
    const listingInstrument = after.identifiers.find(
      (row) => row.identifierId === listing,
    )!.instrumentId;
    const tie = candidateOf(after, broker, venue);
    expect(tie).toMatchObject({
      anchorIdentifierId: broker,
      subjectIdentifierId: venue,
      status: "proposed",
      hold: null,
    });
    expect(tie.commands!.adopt.payload).toEqual({
      subject: "instrument",
      referenceId: venue,
      targetId: listingInstrument,
    });
    expect(tie.commands!.keepApart.payload).toMatchObject({
      fromRef: `instrument:${listingInstrument}`,
      toRef: `identifier:${venue}`,
    });
    expect(candidateOf(after, listing, venue)).toMatchObject({
      anchorIdentifierId: listing,
      subjectIdentifierId: venue,
    });

    // Once a person maps the bare code somewhere else (here: onto its own
    // instrument), no candidate offers to move it again.
    const ownInstrument = after.identifiers.find((row) => row.identifierId === venue)!.instrumentId;
    expect(
      (
        await decide(
          w,
          OPERATOR,
          "identity.assign",
          {
            subject: "instrument",
            referenceId: venue,
            targetId: ownInstrument,
            reason: "kept on its own instrument, checked",
          },
          "op-s2-own",
        )
      ).result.ok,
    ).toBe(true);
    const held = await queryInstrumentResolution(w.sql);
    for (const other of [listing, broker])
      expect(candidateOf(held, other, venue)).toMatchObject({
        status: "proposed",
        hold: "subject-decided-elsewhere",
        commands: null,
      });
  });
});

describe("currencies the observations state", () => {
  test("an unresolved trade currency is unconfirmed, never replaced by the settlement unit", async () => {
    const w = new World();
    await w.capture(
      "sbi-securities",
      [
        {
          account: "sbi-securities:foreign",
          code: "SYNVN01",
          name: "Synthetic Overseas",
          currency: "JPY",
          extra: {
            specificAccountCode: "SYNTHETIC",
            securities: { securitiesCode: "SYNVN01", ric: "SYNVN01.X", countryCode: "VN" },
          },
        },
      ],
      [
        {
          account: "sbi-securities:foreign",
          currency: "JPY",
          extra: {
            specificAccountCode: "SYNTHETIC",
            // Not in the explicit currency catalogue: the rule stores it unresolved.
            tradeCurrencyCode: "VND",
            settlementCurrencyCode: "JPY",
            securities: { securitiesCode: "SYNVN01", countryCode: "VN" },
          },
        },
      ],
    );
    const ric = w.identifier("ric", "", "SYNVN01.X");
    const code = w.identifier("sbi-security-code", "VN", "SYNVN01");
    const result = await queryInstrumentResolution(w.sql);
    expect(result.identifiers.find((row) => row.identifierId === code)).toMatchObject({
      currencies: [],
      currencyUnconfirmed: true,
    });
    expect(result.identifiers.find((row) => row.identifierId === ric)).toMatchObject({
      currencies: ["JPY"],
      currencyUnconfirmed: false,
    });
    const candidate = candidateOf(result, ric, code);
    expect(candidate.agreements).not.toContain("currency-agrees");
    expect(candidate.gaps).toContain("currency-unconfirmed");
  });

  test("an exchange product states its quote unit, not the coin it trades", async () => {
    const w = new World();
    await w.capture(
      "sbi-vc-trade",
      [],
      [
        {
          account: "sbi-vc-trade:main",
          currency: "JPY",
          extra: {
            productId: "SYNCOINJPY",
            _kogane: { currencyPair: { base: "SYNCOIN", quote: "JPY" } },
          },
        },
      ],
    );
    const product = w.identifier("provider-product", "sbi-vc-trade", "SYNCOINJPY");
    expect(
      (await queryInstrumentResolution(w.sql)).identifiers.find(
        (row) => row.identifierId === product,
      ),
    ).toMatchObject({ kind: "product", currencies: ["JPY"], currencyUnconfirmed: false });
  });
});

describe("cost", () => {
  test("the reads scan no observation table, and reach mappings, decisions and relations by index", () => {
    const w = new World();
    const plan = (text: string, args: unknown[] = []) =>
      (w.db.query(`EXPLAIN QUERY PLAN ${text}`).all(...(args as never[])) as { detail: string }[])
        .map((row) => row.detail)
        .join("\n");
    const facts = plan(INSTRUMENT_FACTS_SQL);
    for (const table of [
      "transaction_observations",
      "balance_observations",
      "position_observations",
      "valuation_observations",
    ])
      expect(facts).not.toContain(table);
    // Identifier uses are reached from each current identity observation by
    // its primary key, never by scanning the use table.
    expect(facts).not.toMatch(/SCAN u\b/u);
    expect(facts).toContain("SEARCH u USING INDEX sqlite_autoindex_identity_instrument_uses_1");
    // A use's trade unit and unit are reached by the same primary key.
    for (const alias of ["t", "n"])
      expect(facts).toContain(
        `SEARCH ${alias} USING INDEX sqlite_autoindex_identity_instrument_uses_1 (identity_observation_id=? AND role=?) LEFT-JOIN`,
      );
    const listed = plan(LISTED_AS_SQL);
    expect(listed).toMatch(/SEARCH r USING INDEX entity_relations_(from|to)\b/u);
    expect(listed).not.toMatch(/SCAN r\b/u);
    const history = plan(INSTRUMENT_HISTORY_SQL, ["[]"]);
    expect(history).not.toMatch(/SCAN (m|d|r)\b/u);
    expect(history).toContain(
      "SEARCH m USING INDEX sqlite_autoindex_instrument_mappings_2 (identifier_id=?)",
    );
    expect(history).toContain(
      "SEARCH d USING INDEX decision_revisions_subject (subject_kind=? AND subject_ref=?)",
    );
    expect(history).toContain("SEARCH r USING INDEX entity_relations_to (kind=? AND to_ref=?)");
  });
});
