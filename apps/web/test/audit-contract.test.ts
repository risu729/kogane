// The 監査ログ page's wire contract against pages the application's own
// `readAuditPage` produces from the synthetic audit store, the closed lists the
// shared contract restates from the application vocabulary, and the page's URL
// filters. Every value is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import {
  AUDIT_DAILY_CAPS,
  AUDIT_PAGE_SIZE,
  AUDIT_PATHS,
  AUDIT_RESULTS,
  AUTOMATIC_PATHS,
  buildAuditRecord,
  DECISION_COUNTS,
  isAuditRef,
  LANE_PROPOSAL_KINDS,
  REVISION_FIELDS,
  RISK_CLASSES,
  type AuditResult,
} from "../../../packages/application/src/index.ts";
import {
  AUDIT_CONFIRMATION_DIGEST,
  AUDIT_CORRELATION_ID,
  AUDIT_DELEGATION_REF,
  AUDIT_DIGEST,
  AUDIT_ID,
  AUDIT_IDEMPOTENCY_KEY,
  AUDIT_INSTANT,
  AUDIT_OPERATION,
  AUDIT_PRINCIPAL,
  AUDIT_PRINCIPAL_KINDS,
  AUDIT_REASON_CODE,
  AUDIT_REF_PATTERNS,
  AUDIT_RESULT_CODE,
  AUDIT_SCOPE_SOURCE,
  AUDIT_STEPS,
  AUDIT_SUBJECT,
  AUTOMATIC_PRINCIPAL,
  SCOPE_NAMESPACES,
} from "../../../packages/application/src/audit/vocabulary.ts";
import { auditDiffSchema } from "../../../packages/application/src/audit/diff.ts";
import { OPERATION_STATUSES } from "../../../packages/application/src/operations/requests.ts";
import { OPERATION_CATALOGUE } from "../../../packages/application/src/operation-path/catalogue.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import {
  AUDIT_AUTOMATIC_RESULT_VALUES,
  AUDIT_DECISION_COUNT_VALUES,
  AUDIT_LANE_PROPOSAL_KIND_VALUES,
  AUDIT_OVERFLOW_CAPS,
  AUDIT_PAGE_LIMIT,
  AUDIT_PAGE_PATH,
  AUDIT_PATH_VALUES,
  AUDIT_PATTERNS,
  AUDIT_PRINCIPAL_KIND_VALUES,
  AUDIT_REFERENCE_PATTERNS,
  AUDIT_REQUEST_STATUS_VALUES,
  AUDIT_RESULT_VALUES,
  AUDIT_REVISION_FIELD_VALUES,
  AUDIT_RISK_CLASS_VALUES,
  AUDIT_SCOPE_NAMESPACE_VALUES,
  AUDIT_STEP_VALUES,
} from "../../../packages/observation-shared/src/audit-contract.ts";
import {
  AUDIT_DECISION_COUNT_LABELS,
  AUDIT_LANE_PROPOSAL_KIND_LABELS,
  AUDIT_OPERATION_LABELS,
  AUDIT_PATH_LABELS,
  AUDIT_PRINCIPAL_KIND_LABELS,
  AUDIT_REQUEST_STATUS_LABELS,
  AUDIT_RESULT_LABELS,
  AUDIT_REVISION_FIELD_LABELS,
  AUDIT_SCOPE_LABELS,
  AUDIT_STEP_LABELS,
  auditFilterSearch,
  parseAuditFilters,
} from "../src/audit-api.ts";
import { matchRoute } from "../src/router.tsx";
import { auditFixture, FILLER_READS, type AuditFixture } from "./audit-fixture.ts";

let fixture: AuditFixture;
let first: any;
let second: any;

beforeAll(async () => {
  fixture = await auditFixture();
  first = (await fixture.answer(new URLSearchParams())).body;
  second = (await fixture.answer(new URLSearchParams({ cursor: first.cursor }))).body;
}, 60_000);

const copy = (): any => structuredClone(first);
const valid = (value: unknown) => validApiResponse(AUDIT_PAGE_PATH, value);

describe("the shared contract restates the application's closed vocabulary", () => {
  test("every closed list and cap is the builder's", () => {
    expect([...AUDIT_PATH_VALUES]).toEqual([...AUDIT_PATHS]);
    expect([...AUDIT_PRINCIPAL_KIND_VALUES]).toEqual([...AUDIT_PRINCIPAL_KINDS]);
    expect([...AUDIT_RESULT_VALUES]).toEqual([...AUDIT_RESULTS]);
    expect([...AUDIT_STEP_VALUES]).toEqual([...AUDIT_STEPS]);
    expect([...AUDIT_RISK_CLASS_VALUES]).toEqual([...RISK_CLASSES]);
    expect([...AUDIT_SCOPE_NAMESPACE_VALUES]).toEqual([...SCOPE_NAMESPACES]);
    expect([...AUDIT_REVISION_FIELD_VALUES]).toEqual([...REVISION_FIELDS]);
    expect([...AUDIT_DECISION_COUNT_VALUES]).toEqual([...DECISION_COUNTS]);
    expect([...AUDIT_REQUEST_STATUS_VALUES]).toEqual([...OPERATION_STATUSES]);
    expect([...AUDIT_LANE_PROPOSAL_KIND_VALUES]).toEqual([...LANE_PROPOSAL_KINDS]);
    // The contract names the automatic paths by value, as the builder does.
    expect([...AUTOMATIC_PATHS]).toEqual(["alarm", "lane"]);
    expect(AUDIT_OVERFLOW_CAPS).toEqual({
      read: AUDIT_DAILY_CAPS.read,
      refused: AUDIT_DAILY_CAPS.refused,
    });
    expect(AUDIT_PAGE_LIMIT).toBe(AUDIT_PAGE_SIZE);
  });

  test("the strict diff shapes are the builder's kinds and keys", () => {
    // The contract checks each kind's exact keys; a kind or key the builder
    // gains must reach the contract before a page carrying it can render.
    const builder = (
      auditDiffSchema as unknown as {
        _zod: { def: { options: { _zod: { def: { shape: Record<string, unknown> } } }[] } };
      }
    )._zod.def.options.map((option) => Object.keys(option._zod.def.shape).sort());
    expect(builder).toEqual(
      [
        ["kind", "from", "to", "fields"],
        ["kind", "decisionRevisions", "commitSeq", "counts"],
        ["kind", "status"],
        ["kind", "rows", "truncated"],
        ["kind", "released"],
        ["kind", "of", "count", "cap"],
        ["kind", "decisionRevisions", "commits", "proposals"],
        ["kind"],
      ].map((keys) => keys.sort()),
    );
    const examples = new Map(first.records.map((record: any) => [record.diff.kind, record.diff]));
    for (const keys of builder)
      expect(
        [...examples.values()].some((diff: any) => Object.keys(diff).sort().join() === keys.join()),
      ).toBe(true);
  });

  test("every pattern is the builder's, and every stored reference passes both", () => {
    const pairs: [RegExp, RegExp][] = [
      [AUDIT_PATTERNS.auditId, AUDIT_ID],
      [AUDIT_PATTERNS.correlationId, AUDIT_CORRELATION_ID],
      [AUDIT_PATTERNS.instant, AUDIT_INSTANT],
      [AUDIT_PATTERNS.subject, AUDIT_SUBJECT],
      [AUDIT_PATTERNS.principal, AUDIT_PRINCIPAL],
      [AUDIT_PATTERNS.operation, AUDIT_OPERATION],
      [AUDIT_PATTERNS.resultCode, AUDIT_RESULT_CODE],
      [AUDIT_PATTERNS.reasonCode, AUDIT_REASON_CODE],
      [AUDIT_PATTERNS.idempotencyKey, AUDIT_IDEMPOTENCY_KEY],
      [AUDIT_PATTERNS.digest, AUDIT_DIGEST],
      [AUDIT_PATTERNS.delegationRef, AUDIT_DELEGATION_REF],
      [AUDIT_PATTERNS.confirmationDigest, AUDIT_CONFIRMATION_DIGEST],
      [AUDIT_PATTERNS.scopeSource, AUDIT_SCOPE_SOURCE],
      [AUDIT_PATTERNS.alarmPrincipal, AUTOMATIC_PRINCIPAL.alarm],
      [AUDIT_PATTERNS.lanePrincipal, AUTOMATIC_PRINCIPAL.lane],
    ];
    for (const [shared, builder] of pairs) expect(shared.source).toBe(builder.source);
    expect(AUDIT_REFERENCE_PATTERNS.map((pattern) => pattern.source)).toEqual(
      AUDIT_REF_PATTERNS.map((pattern) => pattern.source),
    );
    const refs = fixture.rows.flatMap((row) => [
      ...(JSON.parse(row.refs_json) as string[]),
      ...(row.target_ref === null ? [] : [row.target_ref]),
    ]);
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs) {
      expect(isAuditRef(ref)).toBe(true);
    }
    expect(valid(first)).toBe(true);
  });

  test("the results and steps the automatic paths admit are the builder's", () => {
    // `record.ts` keeps this pairing inline; probe it on each automatic path.
    for (const path of AUTOMATIC_PATHS) {
      const admitted = (AUDIT_RESULTS as readonly AuditResult[]).filter((result) => {
        try {
          buildAuditRecord(
            {
              path,
              subject: null,
              principal: `${path}:synthetic`,
              principalKind: "automatic",
              correlationId: "00000000-0000-4000-8000-000000000001",
            },
            {
              operation: path === "alarm" ? "alarm.occurrence.claim" : "lane.tick",
              riskClass: "R2",
              result,
              resultCode: result === "refused" || result === "failed" ? "lane_failed" : null,
              diff:
                result === "overflow"
                  ? { kind: "overflow", of: "read", count: 1, cap: 2000 }
                  : { kind: "none" },
            },
            "2026-10-09T09:00:00.000Z",
          );
          return true;
        } catch {
          return false;
        }
      });
      expect(admitted).toEqual([...AUDIT_AUTOMATIC_RESULT_VALUES]);
    }
    const page = copy();
    const lane = page.records.find((record: any) => record.path === "lane");
    lane.step = "confirm";
    expect(valid(page)).toBe(false);
  });

  test("every catalogued operation and closed code has a Japanese label", () => {
    expect(Object.keys(AUDIT_OPERATION_LABELS).sort()).toEqual(
      Object.keys(OPERATION_CATALOGUE).sort(),
    );
    const named: [readonly string[], Readonly<Record<string, string>>][] = [
      [AUDIT_PATH_VALUES, AUDIT_PATH_LABELS],
      [AUDIT_PRINCIPAL_KIND_VALUES, AUDIT_PRINCIPAL_KIND_LABELS],
      [AUDIT_RESULT_VALUES, AUDIT_RESULT_LABELS],
      [AUDIT_STEP_VALUES, AUDIT_STEP_LABELS],
      [AUDIT_SCOPE_NAMESPACE_VALUES, AUDIT_SCOPE_LABELS],
      [AUDIT_REVISION_FIELD_VALUES, AUDIT_REVISION_FIELD_LABELS],
      [AUDIT_DECISION_COUNT_VALUES, AUDIT_DECISION_COUNT_LABELS],
      [AUDIT_REQUEST_STATUS_VALUES, AUDIT_REQUEST_STATUS_LABELS],
      [AUDIT_LANE_PROPOSAL_KIND_VALUES, AUDIT_LANE_PROPOSAL_KIND_LABELS],
    ];
    for (const [values, labels] of named)
      expect(Object.keys(labels).sort()).toEqual([...values].sort());
  });
});

describe("the audit page contract", () => {
  test("every page the reader produces is accepted, and the second page ends the store", () => {
    expect(valid(first)).toBe(true);
    expect(valid(second)).toBe(true);
    expect(first.records).toHaveLength(50);
    expect(first.cursor).not.toBeNull();
    expect(second.cursor).toBeNull();
    expect(first.records.length + second.records.length).toBe(fixture.rows.length);
    expect(fixture.rows.length).toBe(FILLER_READS + 13);
    // Each diff kind, a delegated preparation and its confirmation, and the
    // Processor's alarm and lane records are on the first page.
    const kinds = new Set(first.records.map((record: any) => record.diff.kind));
    for (const kind of [
      "read",
      "revision",
      "decision",
      "request",
      "release",
      "overflow",
      "lane",
      "none",
    ])
      expect(kinds.has(kind)).toBe(true);
    expect(first.records.some((record: any) => record.result === "prepared")).toBe(true);
    const paths = new Set(first.records.map((record: any) => record.path));
    for (const path of AUDIT_PATH_VALUES) expect(paths.has(path)).toBe(true);
    expect(
      first.records.some((record: any) => record.path === "lane" && record.result === "failed"),
    ).toBe(true);
    // The builder's schema admits proposals in any order; it stores them sorted.
    const page = copy();
    const lane = page.records.find((record: any) => record.diff.proposals?.length > 1);
    lane.diff.proposals.reverse();
    expect(valid(page)).toBe(true);
  });

  test("a value outside the closed vocabulary or a pairing the table refuses fails the page", () => {
    const at = (result: string) =>
      first.records.findIndex((record: any) => record.result === result);
    const onPath = (path: string) =>
      first.records.findIndex((record: any) => record.path === path && record.result !== "failed");
    const onKind = (kind: string) =>
      first.records.findIndex((record: any) => record.diff.kind === kind);
    const laneDiff = (page: any) => page.records[onPath("lane")].diff;
    const mutations: [string, (page: any) => void][] = [
      ["unknown result", (page) => (page.records[0].result = "approved")],
      ["unknown path", (page) => (page.records[0].path = "cron")],
      ["unknown kind", (page) => (page.records[0].principalKind = "robot")],
      ["unknown step", (page) => (page.records[0].step = "retry")],
      ["unknown risk", (page) => (page.records[0].riskClass = "R5")],
      ["malformed lane diff", (page) => (page.records[0].diff = { kind: "lane", from: 1, to: 2 })],
      ["lane diff with an extra key", (page) => (laneDiff(page).ticks = 3)],
      ["lane diff without commits", (page) => delete laneDiff(page).commits],
      ["negative lane count", (page) => (laneDiff(page).decisionRevisions = -1)],
      ["fractional lane count", (page) => (laneDiff(page).commits = 1.5)],
      ["proposals not a list", (page) => (laneDiff(page).proposals = {})],
      ["zero proposals of a kind", (page) => (laneDiff(page).proposals[0].count = 0)],
      [
        "unknown proposal kind",
        (page) => (laneDiff(page).proposals[0].kind = "reconciliation_supports"),
      ],
      ["proposal with an extra key", (page) => (laneDiff(page).proposals[0].from = 1)],
      [
        "repeated proposal kind",
        (page) => laneDiff(page).proposals.push({ ...laneDiff(page).proposals[0] }),
      ],
      [
        "too many proposal kinds",
        (page) =>
          (laneDiff(page).proposals = Array.from({ length: 12 }, (_, i) => ({
            kind: AUDIT_LANE_PROPOSAL_KIND_VALUES[i % 11],
            count: 1,
          }))),
      ],
      [
        "lane principal on alarm",
        (page) => (page.records[onPath("alarm")].principal = "lane:synthetic"),
      ],
      [
        "alarm principal on lane",
        (page) => (page.records[onPath("lane")].principal = "alarm:synthetic"),
      ],
      [
        "lane principal outside its pattern",
        (page) => (page.records[onPath("lane")].principal = "lane:Synthetic"),
      ],
      ["read on lane", (page) => (page.records[onPath("lane")].result = "read")],
      [
        "refusal on alarm",
        (page) => {
          const record = page.records[onPath("alarm")];
          record.result = "refused";
          record.resultCode = "lane_failed";
        },
      ],
      ["replay on alarm", (page) => (page.records[onPath("alarm")].result = "replayed")],
      [
        "lane range out of shape",
        (page) => (page.records[onPath("lane")].refs[0] = "decision-revisions:0-4"),
      ],
      [
        "unknown proposal kind in a reference",
        (page) => page.records[onPath("lane")].refs.push("proposals:other:1-2"),
      ],
      [
        "occurrence of another shape",
        (page) => (page.records[onPath("alarm")].refs[0] = "occurrence:manual:synthetic:1"),
      ],
      ["automatic kind on ui", (page) => (page.records[onPath("ui")].principalKind = "automatic")],
      ["extra diff key", (page) => (page.records[at("read")].diff.amount = "1000")],
      ["unknown field", (page) => page.records[onKind("revision")].diff.fields.push("amount")],
      ["text in operation", (page) => (page.records[0].operation = "Free Text")],
      ["text in result code", (page) => (page.records[at("refused")].resultCode = "Not allowed.")],
      ["refusal without code", (page) => (page.records[at("refused")].resultCode = null)],
      ["read with code", (page) => (page.records[at("read")].resultCode = "invalid_query")],
      [
        "prepare without digest",
        (page) => (page.records[at("prepared")].confirmationDigest = null),
      ],
      [
        "digest off a prepare",
        (page) => (page.records[at("read")].confirmationDigest = `cfm_${"0".repeat(64)}`),
      ],
      ["delegated without ref", (page) => (page.records[at("prepared")].delegationRef = null)],
      [
        "ref without delegation",
        (page) => (page.records[at("read")].delegationRef = `dlg_${"0".repeat(64)}`),
      ],
      ["subject on alarm", (page) => (page.records[at("read")].path = "alarm")],
      ["missing subject on ui", (page) => (page.records[onPath("ui")].subject = null)],
      [
        "overflow without its diff",
        (page) => (page.records[at("overflow")].diff = { kind: "none" }),
      ],
      ["unknown cap", (page) => (page.records[at("overflow")].diff.cap = 100)],
      [
        "reference outside the shape",
        (page) => (page.records[0].refs = ["https://example.test/x"]),
      ],
      [
        "too many refs",
        (page) =>
          (page.records[0].refs = Array.from({ length: 17 }, (_, i) => `field:a${"b".repeat(i)}`)),
      ],
      ["noncanonical time", (page) => (page.records[0].recordedAt = "2026-10-09T09:00:00Z")],
      ["missing field", (page) => delete page.records[0].correlationId],
      [
        "scope with an extra key",
        (page) => (page.records.find((r: any) => r.scope).scope.label = "x"),
      ],
      ["out of order", (page) => page.records.reverse()],
      ["repeated record", (page) => (page.records[1] = page.records[0])],
      ["too many records", (page) => page.records.push(second.records[0])],
      ["other schema", (page) => (page.schemaVersion = "kogane-audit-page-v2")],
      ["cursor shape", (page) => (page.cursor = "not a cursor")],
      ["missing cursor", (page) => delete page.cursor],
      ["a total", (page) => (page.records = "50")],
    ];
    for (const [name, mutate] of mutations) {
      const page = copy();
      mutate(page);
      // Each mutation changes the page; one that found nothing to change proves nothing.
      expect(JSON.stringify(page), name).not.toBe(JSON.stringify(first));
      expect(valid(page), name).toBe(false);
    }
    // An additive top-level field is tolerated and never read, as elsewhere in the contract.
    expect(valid({ ...copy(), servedBy: "synthetic" })).toBe(true);
  });
});

describe("the page's URL filters", () => {
  test("only the server's closed values are sent, in one fixed order", () => {
    expect(parseAuditFilters("")).toEqual({});
    expect(
      parseAuditFilters("to=2026-10-09&result=refused&from=2026-10-08&operation=command.plan"),
    ).toEqual({
      result: "refused",
      from: "2026-10-08",
      to: "2026-10-09",
      operation: "command.plan",
    });
    expect(
      auditFilterSearch({
        to: "2026-10-09",
        result: "refused",
        path: "mcp",
        principalKind: "agent",
      }),
    ).toBe("path=mcp&principalKind=agent&result=refused&to=2026-10-09");
    for (const search of [
      "result=approved",
      "path=cron",
      "principalKind=robot",
      // A name the server's pattern admits but the catalogue does not hold.
      "operation=command.delete",
      "from=2026-02-30",
      "from=2026-10-10&to=2026-10-09",
      "result=read&result=refused",
      "cursor=abc",
      "offset=50",
    ])
      expect(parseAuditFilters(search), search).toBeNull();
  });

  test("the page has its own route", () => {
    expect(matchRoute("/audit")).toEqual({ name: "audit" });
    expect(matchRoute("/audit/records")).toEqual({ name: "notFound", path: "/audit/records" });
  });
});
