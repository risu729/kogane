// Pure contract tests: what a payload may contain, what a digest depends on,
// what a grant allows, and how an error maps to a status. Everything that
// needs the schema is tested against real migrations in
// `services/processor/test/change-lifecycle.test.ts`.
import { describe, expect, test } from "bun:test";
import {
  ACTOR_PATTERN,
  CARD_REVIEW_KINDS,
  CHANGE_KINDS,
  COMMAND_ERROR_CODES,
  configuredGrantLoader,
  type GrantConfigProblem,
  isCardReviewKind,
  isChangeKind,
  MAX_SUBJECTS_PER_LIST,
  parseSubjectList,
  planDigestOf,
  principalCan,
  resolvePrincipal,
  statusForCommandError,
  subjectGrantTable,
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
      "card-settlement.accept",
      "card-settlement.reject",
      "card-settlement.withdraw",
      "card-purchase.exclude",
      "card-purchase.restore",
      "card-refund.allocate",
      "card-refund.withdraw",
      "card-installment.link",
      "card-installment.unlink",
    ]);
    // The review kinds are exactly the tail the 0051 CHECK added (ADR 0017).
    expect<readonly string[]>([...CARD_REVIEW_KINDS]).toEqual(CHANGE_KINDS.slice(7));
    expect(CHANGE_KINDS.filter(isCardReviewKind)).toEqual([...CARD_REVIEW_KINDS]);
    for (const kind of ["card-purchase.delete", "card-refund", "card-installment.relink"])
      expect(isChangeKind(kind)).toBe(false);
    expect(
      CHANGE_KINDS.some((kind) => /^(?:payment|transfer|order|withdrawal|send)\./u.test(kind)),
    ).toBe(false);
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

  test("settlement decisions pin a server revision and cannot carry caller financial effects", () => {
    for (const kind of [
      "card-settlement.accept",
      "card-settlement.reject",
      "card-settlement.withdraw",
    ] as const) {
      const payload = { proposalId: "cs_synthetic", reason: "Reviewed the evidence" };
      expect(validPayload(kind, payload)).toBe(true);
      for (const extra of [
        { expectedRevision: 1 },
        { ownerId: "owner" },
        { amount: "1000" },
        { approved: true },
      ])
        expect(validPayload(kind, { ...payload, ...extra })).toBe(false);
      expect(validPayload(kind, { ...payload, proposalId: "" })).toBe(false);
      expect(validPayload(kind, { ...payload, reason: " " })).toBe(false);
    }
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

describe("card purchase review payloads (ADR 0017)", () => {
  const hex = (digit: string) => digit.repeat(64);
  const purchase = `purchase_${hex("a")}`;
  const refund = `refund_${hex("b")}`;
  const obligation = `obl_cp_${hex("c")}`;
  const allocation = `ra_${hex("d")}`;
  const reason = "Reviewed the statement row";
  const valid = {
    "card-purchase.exclude": { eventId: purchase, reasonCode: "card_fee", reason },
    "card-purchase.restore": { eventId: refund, reason },
    "card-refund.allocate": { refundEventId: refund, purchaseEventId: purchase, reason },
    "card-refund.withdraw": { allocationId: allocation, reason },
    "card-installment.link": {
      obligationId: obligation,
      portionRefs: ["transaction:12@parse_run:3", "transaction:13@parse_run:3"],
      reason,
    },
    "card-installment.unlink": {
      obligationId: obligation,
      portionKeys: [JSON.stringify(["myjcb", "producer", null, "card", "row-2"])],
      reason,
    },
  } as const;

  test("each kind accepts exactly its documented keys", () => {
    for (const kind of CARD_REVIEW_KINDS) {
      const payload = valid[kind];
      expect(validPayload(kind, payload)).toBe(true);
      for (const extra of [
        { amount: "1000" },
        { expectedRevisions: {} },
        { approved: true },
        { decisionRevisionId: "dr_1" },
      ])
        expect(validPayload(kind, { ...payload, ...extra })).toBe(false);
      for (const key of Object.keys(payload)) {
        const { [key]: _dropped, ...missing } = payload as Record<string, unknown>;
        expect(validPayload(kind, missing)).toBe(false);
      }
      expect(validPayload(kind, { ...payload, reason: " " })).toBe(false);
      expect(validPayload(kind, { ...payload, reason: "x".repeat(1001) })).toBe(false);
      // A review payload is never read as another kind's.
      for (const other of CARD_REVIEW_KINDS)
        if (other !== kind) expect(validPayload(other, payload)).toBe(false);
      expect(validPayload("relation.accept", payload)).toBe(false);
    }
  });

  test("every exclusion reason code is closed", () => {
    for (const reasonCode of [
      "card_fee",
      "cash_advance",
      "own_account_transfer",
      "provider_adjustment",
      "other",
    ])
      expect(
        validPayload("card-purchase.exclude", { ...valid["card-purchase.exclude"], reasonCode }),
      ).toBe(true);
    for (const reasonCode of ["fee", "CARD_FEE", "", null, 1, "installment_portion"])
      expect(
        validPayload("card-purchase.exclude", { ...valid["card-purchase.exclude"], reasonCode }),
      ).toBe(false);
  });

  test("ids are the shapes the lanes and later writers name, and nothing else", () => {
    for (const eventId of [
      "purchase_1",
      `purchase_${hex("A")}`,
      `fee_${hex("a")}`,
      `event:${purchase}`,
      `${purchase} `,
      42,
    ]) {
      expect(
        validPayload("card-purchase.exclude", { ...valid["card-purchase.exclude"], eventId }),
      ).toBe(false);
      expect(validPayload("card-purchase.restore", { eventId, reason })).toBe(false);
    }
    // A refund is allocated from a refund to a purchase, never the other way round.
    const allocate = valid["card-refund.allocate"];
    expect(validPayload("card-refund.allocate", { ...allocate, refundEventId: purchase })).toBe(
      false,
    );
    expect(validPayload("card-refund.allocate", { ...allocate, purchaseEventId: refund })).toBe(
      false,
    );
    for (const allocationId of [
      `allocation:${allocation}`,
      `ra_${hex("d").slice(1)}`,
      `cs_${hex("d")}`,
    ])
      expect(validPayload("card-refund.withdraw", { allocationId, reason })).toBe(false);
    for (const obligationId of [`obl_${hex("c")}`, `obligation:${obligation}`, ""])
      expect(
        validPayload("card-installment.link", { ...valid["card-installment.link"], obligationId }),
      ).toBe(false);
  });

  test("portion lists hold one to 36 distinct, well-formed entries", () => {
    const link = valid["card-installment.link"];
    const refs = (count: number) =>
      Array.from({ length: count }, (_, index) => `transaction:${index + 1}@parse_run:1`);
    expect(validPayload("card-installment.link", { ...link, portionRefs: refs(36) })).toBe(true);
    for (const portionRefs of [
      [],
      refs(37),
      ["transaction:1@parse_run:1", "transaction:1@parse_run:1"],
      ["transaction:1"],
      ["transaction:0@parse_run:1"],
      ["balance:1@parse_run:1"],
      "transaction:1@parse_run:1",
    ])
      expect(validPayload("card-installment.link", { ...link, portionRefs })).toBe(false);
    const unlink = valid["card-installment.unlink"];
    const key = (row: string) => JSON.stringify(["myjcb", "producer", "ns", "card", row]);
    expect(
      validPayload("card-installment.unlink", {
        ...unlink,
        portionKeys: Array.from({ length: 36 }, (_, index) => key(`row-${index}`)),
      }),
    ).toBe(true);
    for (const portionKeys of [
      [],
      Array.from({ length: 37 }, (_, index) => key(`row-${index}`)),
      [key("a"), key("a")],
      ['["myjcb","producer",null,"card"]'],
      ['["myjcb", "producer", null, "card", "row"]'],
      ['["myjcb","producer",null,"card",""]'],
      ['[null,"producer",null,"card","row"]'],
      ["not json"],
      [key("r".repeat(2049 - key("").length))],
    ])
      expect(validPayload("card-installment.unlink", { ...unlink, portionKeys })).toBe(false);
    // Any key the 0047 CHECK admits (at most 2048 characters) can be named.
    const longest = key("r".repeat(2048 - key("").length));
    expect(longest).toHaveLength(2048);
    expect(validPayload("card-installment.unlink", { ...unlink, portionKeys: [longest] })).toBe(
      true,
    );
    // Link names rows, unlink names held keys; the two lists are not interchangeable.
    expect(
      validPayload("card-installment.link", {
        obligationId: obligation,
        portionKeys: unlink.portionKeys,
        reason,
      }),
    ).toBe(false);
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

describe("grants: two allow-lists, and a refusal for everything else", () => {
  const configured = {
    OPERATOR_SUBJECTS: '["operator@example.test"]',
    AGENT_GRANTS: '["agent-1"]',
  };

  test("the operator may accept; an agent may propose, never accept", () => {
    const agent = resolvePrincipal(configured, "agent-1");
    expect(agent.ok).toBe(true);
    if (!agent.ok) throw new Error("unreachable");
    expect(agent.principal.kind).toBe("agent");
    expect(principalCan(agent.principal, "interpretation.propose")).toBe(true);
    expect(principalCan(agent.principal, "interpretation.accept")).toBe(false);
    const human = resolvePrincipal(configured, "operator@example.test");
    expect(human.ok).toBe(true);
    if (!human.ok) throw new Error("unreachable");
    expect(human.principal.kind).toBe("human");
    expect(principalCan(human.principal, "interpretation.accept")).toBe(true);
    // The verification is always the server's; nothing sets it from a body.
    expect([agent.principal.verification, human.principal.verification]).toEqual([
      "server",
      "server",
    ]);
  });

  // The finding this replaces: an unlisted subject used to be graded the human
  // operator, so it held `interpretation.accept` by default. It now holds
  // nothing and never becomes a principal at all.
  test("a subject neither list names is refused, not graded a human", () => {
    expect(resolvePrincipal(configured, "somebody-else")).toEqual({
      ok: false,
      code: "subject_not_granted",
    });
    // Including with nothing configured at all, which is the shipped default.
    expect(resolvePrincipal({}, "somebody-else")).toEqual({
      ok: false,
      code: "subject_not_granted",
    });
    expect(resolvePrincipal({ OPERATOR_SUBJECTS: "", AGENT_GRANTS: "" }, "agent-1")).toEqual({
      ok: false,
      code: "subject_not_granted",
    });
  });

  test("an absent or empty list is the empty list: readable, and it grants nobody", () => {
    expect(parseSubjectList(undefined)).toEqual([]);
    expect(parseSubjectList(null)).toEqual([]);
    expect(parseSubjectList("")).toEqual([]);
    expect(parseSubjectList("   ")).toEqual([]);
    expect(parseSubjectList("[]")).toEqual([]);
    expect(parseSubjectList('["a","a","b"]')).toEqual(["a", "b"]);
    expect(subjectGrantTable({})).toMatchObject({ ok: true });
  });

  test("a list that is present but unreadable is refused, never silently shortened", () => {
    // Each of these used to yield `[]`, which *promoted* every listed agent.
    expect(parseSubjectList("not json")).toBeNull();
    expect(parseSubjectList('{"agent":true}')).toBeNull();
    expect(parseSubjectList('"agent-1"')).toBeNull();
    expect(parseSubjectList("[1,2]")).toBeNull();
    expect(parseSubjectList('["a",1]')).toBeNull();
    expect(parseSubjectList('["a",null]')).toBeNull();
    expect(parseSubjectList('["a",""]')).toBeNull();
    expect(parseSubjectList(JSON.stringify(["x".repeat(257)]))).toBeNull();
    const tooMany = Array.from({ length: MAX_SUBJECTS_PER_LIST + 1 }, (_, i) => `a${String(i)}`);
    expect(parseSubjectList(JSON.stringify(tooMany))).toBeNull();
    // A var declared as a JSON array or object arrives at runtime as that
    // value, not as a string. It is unreadable, not empty: reading it as empty
    // would deny everyone — including the operator it tried to name — with
    // `subject_not_granted` and no misconfiguration line to explain why.
    for (const notAString of [["op"], { op: true }, 7, true])
      expect(parseSubjectList(notAString as unknown as string), typeof notAString).toBeNull();
  });

  test("every misconfiguration denies everyone, with a code and no value", () => {
    const table = JSON.stringify({ bot: { capabilities: [] } });
    const cases: [string, Record<string, string>, GrantConfigProblem][] = [
      [
        "operator list is a JSON var, not a string",
        { OPERATOR_SUBJECTS: ["op"] as unknown as string, AGENT_GRANTS: '["agent-1"]' },
        "operator_subjects_invalid",
      ],
      [
        "operator list is not JSON",
        { OPERATOR_SUBJECTS: "{", AGENT_GRANTS: '["agent-1"]' },
        "operator_subjects_invalid",
      ],
      [
        "operator list is an object",
        { OPERATOR_SUBJECTS: table, AGENT_GRANTS: '["agent-1"]' },
        "operator_subjects_invalid",
      ],
      [
        "operator list holds a non-string",
        { OPERATOR_SUBJECTS: '["op",7]', AGENT_GRANTS: "" },
        "operator_subjects_invalid",
      ],
      [
        "agent list is not JSON",
        { OPERATOR_SUBJECTS: '["op"]', AGENT_GRANTS: "not json" },
        "agent_grants_invalid",
      ],
      [
        "agent list is an object",
        { OPERATOR_SUBJECTS: '["op"]', AGENT_GRANTS: table },
        "agent_grants_invalid",
      ],
      [
        "agent list holds a non-string",
        { OPERATOR_SUBJECTS: '["op"]', AGENT_GRANTS: '["agent-1",null]' },
        "agent_grants_invalid",
      ],
      [
        "a subject is in both lists",
        { OPERATOR_SUBJECTS: '["both"]', AGENT_GRANTS: '["both"]' },
        "subject_in_both_lists",
      ],
    ];
    for (const [label, vars, problem] of cases) {
      expect(subjectGrantTable(vars), label).toEqual({
        ok: false,
        code: "grants_misconfigured",
        problem,
      });
      // Nobody is graded: not the named operator, not the named agent, not a
      // stranger. `grants_misconfigured` is 503, never a capability.
      for (const subject of ["op", "operator@example.test", "agent-1", "both", "stranger"]) {
        const resolved = resolvePrincipal(vars, subject);
        expect(resolved.ok, `${label} / ${subject}`).toBe(false);
        if (resolved.ok) throw new Error("unreachable");
        expect(resolved.code).toBe("grants_misconfigured");
        expect(resolved.problem).toBe(problem);
        expect(statusForCommandError(resolved.code)).toBe(503);
      }
      // The problem code carries no configured value.
      expect(problem).toMatch(/^[a-z_]{1,40}$/u);
    }
  });

  test("the loader parses the configuration once and answers the same way", () => {
    const loader = configuredGrantLoader(configured);
    expect(loader.principalFor("agent-1")).toEqual(resolvePrincipal(configured, "agent-1"));
    expect(loader.principalFor("nobody")).toEqual({ ok: false, code: "subject_not_granted" });
    const broken = configuredGrantLoader({ OPERATOR_SUBJECTS: "[" });
    expect(broken.principalFor("op")).toEqual({
      ok: false,
      code: "grants_misconfigured",
      problem: "operator_subjects_invalid",
    });
  });

  test("the actor shape is one pattern, shared with the decision log", () => {
    for (const subject of ["operator@example.test", "agent-1", "ops:alice", "a"])
      expect(ACTOR_PATTERN.test(subject)).toBe(true);
    for (const subject of ["", "Bad Actor", "-leading", `a${"b".repeat(128)}`])
      expect(ACTOR_PATTERN.test(subject)).toBe(false);
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

  test("the authorization refusals are codes of the same table", () => {
    for (const code of ["subject_not_granted", "grants_misconfigured"] as const)
      expect(COMMAND_ERROR_CODES).toContain(code);
  });

  test("statuses separate refusal, conflict and failure", () => {
    expect(statusForCommandError("approval_required")).toBe(403);
    expect(statusForCommandError("commands_disabled")).toBe(403);
    expect(statusForCommandError("stale_context")).toBe(409);
    expect(statusForCommandError("idempotency_conflict")).toBe(409);
    expect(statusForCommandError("plan_not_found")).toBe(404);
    expect(statusForCommandError("invalid_command")).toBe(400);
    // A subject this deployment does not grant is the caller's 403; a
    // deployment that grades nobody is its own 503 (docs/change-lifecycle.md).
    expect(statusForCommandError("subject_not_granted")).toBe(403);
    expect(statusForCommandError("grants_misconfigured")).toBe(503);
  });

  test("no error code leaks a value, a token or provider text", () => {
    for (const code of COMMAND_ERROR_CODES) expect(code).toMatch(/^[a-z_]{1,40}$/u);
  });
});
