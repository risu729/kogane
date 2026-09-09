// Pure contract tests: what a payload may contain, what a digest depends on,
// what a grant allows, and how an error maps to a status. Everything that
// needs the schema is tested against real migrations in
// `services/observation-pipeline/test/change-lifecycle.test.ts`.
import { describe, expect, test } from "bun:test";
import {
  agentSubjects,
  CHANGE_KINDS,
  COMMAND_ERROR_CODES,
  isChangeKind,
  planDigestOf,
  principalCan,
  staticGrantLoader,
  statusForCommandError,
  validPayload,
} from "../src/index.ts";
import { expectedRevisionsJson, identitySubjectRef, relationSubjectRef } from "../src/index.ts";

const assign = {
  subject: "account" as const,
  referenceId: "sa_1",
  targetId: "acct_1",
  reason: "same account, evidenced by the connection detail",
};

describe("payloads", () => {
  test("the change kinds are a closed list with no external money action", () => {
    expect([...CHANGE_KINDS]).toEqual([
      "identity.assign",
      "identity.release-override",
      "relation.accept",
      "relation.reject",
    ]);
    expect(CHANGE_KINDS.some((kind) => /pay|transfer|order|withdraw|send/u.test(kind))).toBe(false);
    expect(isChangeKind("payment.send")).toBe(false);
  });

  test("a caller cannot smuggle its own impact, approval or revisions", () => {
    expect(validPayload("identity.assign", assign)).toBe(true);
    for (const extra of [
      { noImpact: true },
      { approved: true },
      { expectedRevisions: { "account_mapping:sa_1": 99 } },
      { actorId: "someone-else" },
    ])
      expect(validPayload("identity.assign", { ...assign, ...extra })).toBe(false);
  });

  test("payload shape is checked per kind", () => {
    expect(validPayload("identity.release-override", assign)).toBe(false);
    expect(
      validPayload("identity.release-override", {
        subject: "instrument",
        referenceId: "id_1",
        reason: "back to policy",
      }),
    ).toBe(true);
    expect(validPayload("identity.assign", { ...assign, reason: "  " })).toBe(false);
    expect(validPayload("identity.assign", { ...assign, subject: "wallet" })).toBe(false);
    const relation = {
      relationKind: "same_account",
      fromRef: "source_account:sa_1",
      toRef: "source_account:sa_2",
      validFrom: null,
      validTo: null,
      evidenceRefs: ["fetch_artifact:1"],
      reason: "same institution reference",
    };
    expect(validPayload("relation.accept", relation)).toBe(true);
    expect(validPayload("relation.accept", { ...relation, toRef: relation.fromRef })).toBe(false);
    expect(validPayload("relation.accept", { ...relation, relationKind: "same_as" })).toBe(false);
    expect(validPayload("relation.accept", { ...relation, evidenceRefs: ["a", "a"] })).toBe(false);
  });
});

describe("plan digest", () => {
  test("every input of the plan changes its identity (SC17, INV09)", async () => {
    const base = {
      kind: "identity.assign" as const,
      payload: assign,
      expectedRevisions: { "account_mapping:sa_1": 7 },
      baseContextId: "identity-current-v1",
    };
    const digest = await planDigestOf(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await planDigestOf(base)).toBe(digest);
    for (const changed of [
      { ...base, expectedRevisions: { "account_mapping:sa_1": 8 } },
      { ...base, baseContextId: "identity-current-v2" },
      { ...base, payload: { ...assign, targetId: "acct_2" } },
      { ...base, kind: "identity.release-override" as const },
    ])
      expect(await planDigestOf(changed)).not.toBe(digest);
  });

  test("expected revisions serialise with sorted keys, so the digest is stable", () => {
    expect(expectedRevisionsJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test("subject references name their table, not a free string", () => {
    expect(identitySubjectRef("account", "sa_1")).toBe("account_mapping:sa_1");
    expect(identitySubjectRef("instrument", "id_1")).toBe("instrument_mapping:id_1");
    expect(
      relationSubjectRef({
        relationKind: "same_account",
        fromRef: "a",
        toRef: "b",
        validFrom: null,
        validTo: null,
        evidenceRefs: [],
        reason: "r",
      }),
    ).toBe("relation:same_account|a|b");
  });
});

describe("grants", () => {
  test("an agent may propose, never accept", () => {
    const loader = staticGrantLoader(["agent-1"]);
    const agent = loader.principalFor("agent-1");
    expect(agent.kind).toBe("agent");
    expect(principalCan(agent, "interpretation.propose")).toBe(true);
    expect(principalCan(agent, "interpretation.accept")).toBe(false);
    const human = loader.principalFor("operator@example.test");
    expect(human.kind).toBe("human");
    expect(principalCan(human, "interpretation.accept")).toBe(true);
    // The verification is always the server's; nothing sets it from a body.
    expect([agent.verification, human.verification]).toEqual(["server", "server"]);
  });

  test("a malformed agent list grants nothing extra", () => {
    expect(agentSubjects(undefined)).toEqual([]);
    expect(agentSubjects("")).toEqual([]);
    expect(agentSubjects("not json")).toEqual([]);
    expect(agentSubjects('{"agent":true}')).toEqual([]);
    expect(agentSubjects('["a",1,""]')).toEqual(["a"]);
  });
});

describe("errors", () => {
  test("the nine agent-facing codes of addendum 10 section 9 are present", () => {
    for (const code of [
      "needs_scope_resolution",
      "incomplete_evidence",
      "unsupported_semantics",
      "needs_rule_verification",
      "stale_context",
      "approval_required",
      "idempotency_conflict",
      "budget_exceeded",
      "evidence_restricted",
    ] as const)
      expect(COMMAND_ERROR_CODES).toContain(code);
  });

  test("statuses separate refusal, conflict and failure", () => {
    expect(statusForCommandError("approval_required")).toBe(403);
    expect(statusForCommandError("commands_disabled")).toBe(403);
    expect(statusForCommandError("stale_context")).toBe(409);
    expect(statusForCommandError("idempotency_conflict")).toBe(409);
    expect(statusForCommandError("plan_not_found")).toBe(404);
    expect(statusForCommandError("invalid_command")).toBe(400);
  });

  test("no error code leaks a value, a token or provider text", () => {
    for (const code of COMMAND_ERROR_CODES) expect(code).toMatch(/^[a-z_]{1,40}$/u);
  });
});
