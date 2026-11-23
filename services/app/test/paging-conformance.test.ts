// The paging conformance walk (ADR 0128) over the converted reads: each is
// called the way an agent that knows nothing of its cursor kind calls it —
// over `/mcp` — continuing by
// merging `next.arguments` into its last call until `next` is null. Every walk
// must end, list every seeded item once (no duplicate, no gap), and carry
// `next` and `paging` that agree with the read's deprecated fields on every
// page. The card settlement reads are walked in
// `paging-conformance-cards.test.ts`; `paging-registry.ts` names every walk.
// Every row is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { walkPages } from "../../../packages/observation-shared/test-support/paging-walk";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { validEvidenceResponse } from "../../../packages/observation-shared/src/evidence-validation";
import { validAuditPage } from "../../../packages/observation-shared/src/audit-contract";
import { validOperationListPage } from "../../../packages/observation-shared/src/operation-contract";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness } from "./page-read-harness";

const page = pageReadHarness("paging-conformance");
// The operations list is served while the operations API is on (ADR 0086);
// its walk runs over `/mcp` and on its route, as the 依頼の一覧 page reads it.
const operator = pageReadHarness("paging-conformance-ops", {
  OPS_API_ENABLED: "true",
  OPERATOR_SUBJECTS: '["synthetic-agent","synthetic-reader"]',
});

const DATE = '{"kind":"local-date","value":"2026-03-01","zone":null,"basis":"provider"}';
const EVENTS = 201;
const REPORTS = 51;
const RUNS = 51;
const ARTIFACTS = 51;
const ACCOUNTS = 101;
const AUDITED = 120;
const OPERATIONS = 45;

const eventIds: string[] = [];
const reportIds: string[] = [];
const runIds: string[] = [];
const artifactIds: string[] = [];
const accountRefs: string[] = [];
const auditIds: string[] = [];
const operationIds: string[] = [];
let artifactRun = "";

/** The tool's `data` over `/mcp`, failing the walk on any refusal. */
async function overMcp(tool: string, args: Record<string, unknown>) {
  const answer = await page.mcp(tool, args);
  expect({ tool, args, isError: answer.isError }).toEqual({ tool, args, isError: false });
  return answer.body as Record<string, any>;
}

beforeAll(async () => {
  await seedRegistry();

  // Economic events: one more than a page of 200.
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < EVENTS; index++) {
    const id = `ev-walk-${String(index).padStart(3, "0")}`;
    eventIds.push(id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
         VALUES(?,'relation',?,1,'accept','rule','rule:test',NULL,'synthetic','[]',NULL,NULL,'2026-03-01T00:00:00Z')`,
      ).bind(`dr_${id}`, `event:${id}`),
      env.DB.prepare(
        `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
         VALUES(?,1,'card_settlement','debited',NULL,?,'cash-movement','[{"kind":"transaction","id":"transaction:1","revision":"parse_run:1"}]',?,NULL,'2026-03-01T00:00:00Z')`,
      ).bind(id, DATE, `dr_${id}`),
      env.DB.prepare(
        "INSERT INTO economic_legs VALUES(?,1,0,'account:bank','JPY','exact','100',0,NULL,'decrease','cash-movement')",
      ).bind(id),
    );
  }
  await env.DB.batch(statements);

  // Stored reports: one more than a page of 50.
  await env.DB.batch(
    Array.from({ length: REPORTS }, (_, index) => {
      const id = `report-walk-${String(index).padStart(3, "0")}`;
      reportIds.push(id);
      const digest = index.toString(16).padStart(64, "0");
      return env.DB.prepare(
        `INSERT INTO report_artifacts(report_id,context_id,purpose,schema_version,content_digest,storage_ref,created_by,created_at)
         VALUES (?,?,'holdings-view','report-holdings-v1',?,?,'report-job',?)`,
      ).bind(
        id,
        `ctx-walk-${String(index)}`,
        digest,
        `reports/${digest}`,
        new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 60_000).toISOString(),
      );
    }),
  );

  // Sealed runs of the evidence source, and one run with more artifacts than a page.
  for (let index = 0; index < RUNS - 1; index++) runIds.push(`r_${(await seedRun()).id}`);
  const run = await seedRun({ count: ARTIFACTS });
  runIds.push(`r_${run.id}`);
  artifactRun = `r_${run.id}`;
  for (const artifact of run.artifacts) artifactIds.push(`a_${artifact.id}`);

  // Source references of one source: one more than a page of 100.
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'walk-identity','1','2099','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO transaction_observations (parse_run_id,source_account,currency,raw_locator,extra_json)
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${ACCOUNTS})
      SELECT ?,printf('walk-%03d',x),'JPY','synthetic','{}' FROM n`).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO source_accounts SELECT source_account,'sony-bank','evidence-test',json_array(source_account) FROM transaction_observations WHERE parse_run_id=?`,
    ).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO accounts SELECT source_account,source_account,'cash','provider-local' FROM transaction_observations WHERE parse_run_id=?`,
    ).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO account_mappings SELECT source_account,source_account,1,source_account,'rule','synthetic',1,'2099',source_account,'provider-local' FROM transaction_observations WHERE parse_run_id=?`,
    ).bind(parse!.id),
    env.DB.prepare(`INSERT INTO identity_runs VALUES ('walk-run',?,1,'2099')`).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO identity_observations SELECT source_account,'walk-run','transaction',id,source_account,source_account,'[]' FROM transaction_observations WHERE parse_run_id=?`,
    ).bind(parse!.id),
    env.DB.prepare(`INSERT INTO identity_run_seals VALUES ('walk-run',${ACCOUNTS},'2099')`),
  ]);
  for (let index = 1; index <= ACCOUNTS; index++)
    accountRefs.push(`walk-${String(index).padStart(3, "0")}`);

  // Audit records of one operation, more than two pages of 50.
  const recorded = Date.parse("2026-10-01T00:00:00.000Z");
  await env.DB.batch(
    Array.from({ length: AUDITED }, (_, index) => {
      const id = `aud_${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`;
      auditIds.push(id);
      return env.DB.prepare(
        `INSERT INTO audit_records(audit_id,recorded_at,path,subject,principal,principal_kind,operation,risk_class,step,result,result_code,correlation_id,refs_json,diff_json)
         VALUES(?,?,'agent-http','walk-agent','walk-agent','agent','capabilities','R0','call','read',NULL,'00000000-0000-4000-8000-000000000000','[]','{"kind":"read","rows":1,"truncated":false}')`,
      ).bind(id, new Date(recorded + Math.floor(index / 3) * 1000).toISOString());
    }),
  );

  // Accepted operations, several sharing an instant, so the keyset breaks ties by id.
  await env.DB.batch(
    Array.from({ length: OPERATIONS }, (_, index) => {
      const id = `op_${(index + 1).toString(16).padStart(64, "0")}`;
      operationIds.push(id);
      const at = new Date(Date.parse("2026-09-11T00:00:00Z") + Math.floor(index / 4) * 1000)
        .toISOString()
        .replace(/\.000Z$/u, "Z");
      return env.DB.prepare(
        `INSERT INTO ops_requests(operation_id,kind,principal,idempotency_key,payload_digest,
          source_id,request_json,status,dispatch_state,created_at,updated_at)
         VALUES(?1,'projection','synthetic-reader',?1,?2,NULL,'{}','accepted','dispatch_pending',?3,?3)`,
      ).bind(id, "0".repeat(64), at);
    }),
  );
}, 120_000);

describe("each converted read, walked by next.arguments alone", () => {
  it("kogane.events.read: activity across the 200-row page", async () => {
    const walk = await walkPages({
      first: { collection: "activity" },
      call: async (args) => (await overMcp("kogane.events.read", args)).data,
      items: (answer) => answer.items as { eventId: string }[],
      id: (item) => item.eventId,
    });
    expect(walk.calls).toEqual([
      { collection: "activity" },
      { collection: "activity", offset: 200 },
    ]);
    expect(walk.items.map((item) => item.eventId).sort()).toEqual([...eventIds].sort());
    expect(walk.withheld).toBe(false);
  });

  it("kogane.reports.read: the catalogue across its 50-row page", async () => {
    const walk = await walkPages({
      first: {},
      call: async (args) => {
        const data = (await overMcp("kogane.reports.read", args)).data;
        expect(validApiResponse("/api/v2/reports", data)).toBe(true);
        return data;
      },
      items: (answer) => answer.items as { reportId: string }[],
      id: (item) => item.reportId,
    });
    expect(walk.calls).toHaveLength(2);
    expect(walk.items.map((item) => item.reportId).sort()).toEqual([...reportIds].sort());
  });

  it("kogane.evidence.read: a source's runs and a run's artifacts by their id cursor", async () => {
    const runs = await walkPages({
      first: { page: "runs", source: "sony-bank" },
      call: async (args) => {
        const data = (await overMcp("kogane.evidence.read", args)).data;
        expect(validEvidenceResponse(`/api/evidence/v1/sources/sony-bank/runs`, data)).toBe(true);
        return data;
      },
      items: (answer) => answer.items as { id: string }[],
      id: (item) => item.id,
    });
    expect(runs.calls).toHaveLength(2);
    expect(runs.calls[1]).toEqual({
      page: "runs",
      source: "sony-bank",
      cursor: expect.stringMatching(/^c_/u),
    });
    expect(runs.items.map((item) => item.id).sort()).toEqual([...runIds].sort());
    const artifacts = await walkPages({
      first: { page: "artifacts", runId: artifactRun },
      call: async (args) => (await overMcp("kogane.evidence.read", args)).data,
      items: (answer) => answer.items as { id: string }[],
      id: (item) => item.id,
    });
    expect(artifacts.calls).toHaveLength(2);
    expect(artifacts.items.map((item) => item.id).sort()).toEqual([...artifactIds].sort());
  });

  it("kogane.identity.read: one source's references across the 100-row page", async () => {
    const walk = await walkPages({
      first: { collection: "accounts", source: "sony-bank" },
      call: async (args) => (await overMcp("kogane.identity.read", args)).data,
      items: (answer) => answer.rows as { referenceId: string }[],
      id: (item) => item.referenceId,
    });
    expect(walk.calls[1]).toEqual({ collection: "accounts", source: "sony-bank", offset: 100 });
    expect(walk.items.map((item) => item.referenceId).sort()).toEqual([...accountRefs].sort());
  });

  it("kogane.audit.search: one operation's records across the 50-record page", async () => {
    const first = { filters: { operation: "capabilities" } };
    const walk = await walkPages({
      first,
      call: async (args) => {
        const body = await overMcp("kogane.audit.search", args);
        expect(validAuditPage(body)).toBe(true);
        return body;
      },
      items: (answer) => answer.records as { auditId: string }[],
      id: (item) => item.auditId,
    });
    expect(walk.calls).toHaveLength(3);
    expect(walk.calls.slice(1).every((call) => call.filters === first.filters)).toBe(true);
    expect(walk.items.map((item) => item.auditId).sort()).toEqual([...auditIds].sort());
    // Changing a filter mid-walk is the family's mismatch, naming what must repeat.
    const second = walk.calls[1]!;
    const refused = await page.mcp("kogane.audit.search", {
      ...second,
      filters: { operation: "audit.search" },
    });
    expect(refused).toEqual({
      isError: true,
      body: { error: "cursor_mismatch", mustMatch: ["filters"] },
    });
    expect(await page.mcp("kogane.audit.search", { ...first, cursor: "not-a-cursor" })).toEqual({
      isError: true,
      body: { error: "invalid_cursor" },
    });
  });

  it("kogane.ops.operation.list: over MCP and on its route, by the last row's id, 20 a page", async () => {
    const items = (answer: Record<string, any>) => answer.operations as { operationId: string }[];
    const overTool = await walkPages({
      first: { kind: "projection", limit: 20 },
      call: async (args) => {
        const answer = await operator.mcp("kogane.ops.operation.list", args);
        expect(answer.isError).not.toBe(true);
        expect(validOperationListPage(answer.body, { kind: "projection" })).toBe(true);
        return answer.body as Record<string, any>;
      },
      items,
      id: (item) => item.operationId,
    });
    expect(overTool.calls).toHaveLength(3);
    expect(overTool.items.map((item) => item.operationId).sort()).toEqual([...operationIds].sort());
    const overRoute = await walkPages({
      first: { kind: "projection", limit: 20 },
      call: async (args) => {
        const query = new URLSearchParams(
          Object.entries(args).map(([key, value]) => [key, String(value)]),
        );
        const answer = await operator.route(`/api/ops/v1/operations?${query}`);
        expect(answer.status).toBe(200);
        return answer.body as Record<string, any>;
      },
      items,
      id: (item) => item.operationId,
    });
    expect(overRoute.calls).toEqual(overTool.calls);
    expect(overRoute.items).toEqual(overTool.items);
    // A cursor naming no operation is not one the list issued.
    const refused = await operator.route(`/api/ops/v1/operations?cursor=op_${"f".repeat(64)}`);
    expect(refused).toMatchObject({ status: 400, body: { error: "invalid_cursor" } });
  });
});
