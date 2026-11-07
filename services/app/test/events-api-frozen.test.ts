// `GET /api/v2/activity` and `GET /api/v2/obligations` against the route
// handler as main shipped it before its request rules moved into
// `readEconomicEvents` (packages/application, ADR 0081's 2026-11-07
// amendment). The frozen copy below is that handler's text; both are run on a
// scaled store (more than one page of each list) over fixed and random query
// strings, and must answer the same status, code and bytes. The read model's
// SQL did not change, so this pins only the move. Every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import {
  createEventsReader,
  d1Executor,
  isActivityBasis,
  type ActivityBasis,
} from "../../../packages/read-model/src/index";
import { eventsApi } from "../src/events-api";
import { HttpError, json } from "../src/http";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

// ── Frozen: services/app/src/events-api.ts on main ed17ba31 ─────────────
const LEGACY_V2_PATHS = ["/api/v2/activity", "/api/v2/obligations"] as const;
const LEGACY_DEFAULT_ACTIVITY_BASIS: ActivityBasis = "cash-movement";
const LEGACY_EVENTS_PAGE_SIZE = 200;

async function legacyEventsV2Available(env: Env): Promise<boolean> {
  return storeHasFeature(d1Executor(env.DB), "economicEvents");
}

function legacyOffsetOf(url: URL): number {
  const text = url.searchParams.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  return offset;
}

async function legacyEventsApi(env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (!(LEGACY_V2_PATHS as readonly string[]).includes(path)) return null;
  if (!(await legacyEventsV2Available(env))) throw new HttpError(404, "not_found");
  const allowed = path === "/api/v2/activity" ? ["basis", "offset"] : ["offset"];
  for (const key of url.searchParams.keys()) {
    const value = url.searchParams.get(key)!;
    if (
      !allowed.includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value ||
      value.length > 64
    )
      throw new HttpError(400, "invalid_query");
  }
  const offset = legacyOffsetOf(url);
  const reader = createEventsReader(d1Executor(env.DB), { pageSize: LEGACY_EVENTS_PAGE_SIZE });
  if (path === "/api/v2/obligations")
    return json({ apiVersion: 2, ...(await reader.obligations({ offset })) });
  const basisParam = url.searchParams.get("basis");
  if (basisParam !== null && !isActivityBasis(basisParam))
    throw new HttpError(400, "invalid_query");
  const basis: ActivityBasis = basisParam ?? LEGACY_DEFAULT_ACTIVITY_BASIS;
  return json({ apiVersion: 2, basis, ...(await reader.activity({ basis, offset })) });
}
// ── End of the frozen copy ───────────────────────────────────────────────

const EVENTS = 230;
const OBLIGATIONS = 230;
const DATE = '{"kind":"local-date","value":"2026-03-01","zone":null,"basis":"provider"}';

/**
 * More than one page of each list: events with one or both bases, some
 * read from published transaction rows (raw refs), some legs not exact;
 * obligations exact or not, some unknown, half with a settlement.
 */
async function seedScaledProjection() {
  await seedRegistry().catch(() => undefined);
  const run = await seedRun({ count: 1 });
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'events-frozen-fixture','1','2026-03-01','ok','[]') RETURNING id`)
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const rows: number[] = [];
  for (let index = 0; index < 5; index++) {
    const row = await env.DB.prepare(`INSERT INTO transaction_observations
      (parse_run_id,source_account,external_id,as_of,amount_minor,currency,raw_locator,extra_json,description)
      VALUES (?,'synthetic-card',?,'2026-03-01',100,'JPY',?,'{}','synthetic') RETURNING id`)
      .bind(parse!.id, `f${index}`, `json:$.rows[${index}]`)
      .first<{ id: number }>();
    rows.push(row!.id);
  }
  const decision = (id: string, subjectRef: string) =>
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,1,'accept','rule','rule:test',NULL,'synthetic','[]',NULL,NULL,'2026-03-01T00:00:00Z')`,
    ).bind(id, subjectRef);
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < EVENTS; index++) {
    const id = `fev-${String(index).padStart(4, "0")}`;
    // Two in seven name no published row, so their refs carry no raw object.
    const row = rows[index % 7] ?? 999_000 + index;
    const evidence = JSON.stringify([
      { kind: "transaction", id: `transaction:${row}`, revision: `parse_run:${parse!.id}` },
    ]);
    statements.push(
      decision(`dr_${id}`, `event:${id}`),
      env.DB.prepare(
        `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
         VALUES(?,1,'purchase','captured',NULL,?,'purchase-recognition',?,?,NULL,'2026-03-01T00:00:00Z')`,
      ).bind(id, DATE, evidence, `dr_${id}`),
      index % 11 === 0
        ? env.DB.prepare(
            "INSERT INTO economic_legs VALUES(?,1,0,'account:card','JPY','missing',NULL,NULL,'amount_absent','decrease','cash-movement')",
          ).bind(id)
        : env.DB.prepare(
            "INSERT INTO economic_legs VALUES(?,1,0,'account:card','JPY','exact',?,0,NULL,'decrease','cash-movement')",
          ).bind(id, String(100 + index)),
    );
    if (index % 3 === 0)
      statements.push(
        env.DB.prepare(
          "INSERT INTO economic_legs VALUES(?,1,1,'claim:cost','JPY','exact',?,2,NULL,'increase','purchase-recognition')",
        ).bind(id, String(10_000 + index)),
      );
  }
  for (let index = 0; index < OBLIGATIONS; index++) {
    const id = `fobl-${String(index).padStart(4, "0")}`;
    const exact = index % 5 !== 0;
    const unknown = index % 13 === 0;
    statements.push(
      decision(`dr_${id}`, `obligation:${id}`),
      env.DB.prepare(
        `INSERT INTO obligation_revisions(obligation_id,revision,creditor_ref,debtor_ref,principal_unit_ref,principal_status,principal_coefficient,principal_scale,fee_components_json,schedule_json,state,unknown_reason,state_evidence_refs_json,decision_revision_id,superseded_by,created_at)
         VALUES(?,1,'party:issuer','party:self','JPY',?,?,?,'[]','[]',?,?,'[]',?,NULL,'2026-03-01T00:00:00Z')`,
      ).bind(
        id,
        exact ? "exact" : "missing",
        exact ? String(5_000 + index) : null,
        exact ? 0 : null,
        unknown ? "unknown" : index % 2 === 0 ? "partially-settled" : "open",
        unknown ? "provider_status_absent" : null,
        `dr_${id}`,
      ),
    );
    if (index % 2 === 0)
      statements.push(
        decision(`dr_st_${id}`, `settlement:st-${id}`),
        env.DB.prepare(
          `INSERT INTO settlement_relations(id,obligation_id,settlement_component_ref,unit_ref,coefficient,scale,occurred_json,unresolved_coefficient,unresolved_scale,decision_revision_id,superseded_by,created_at)
           VALUES(?,?,'leg:fev-0001#0','JPY','1000',0,?,NULL,NULL,?,NULL,'2026-03-01T00:00:00Z')`,
        ).bind(`st-${id}`, id, DATE, `dr_st_${id}`),
      );
  }
  for (let start = 0; start < statements.length; start += 200)
    await env.DB.batch(statements.slice(start, start + 200));
}

beforeAll(seedScaledProjection);

/** One answer as text: `null`, a closed refusal, or status, type and bytes. */
async function answer(
  handler: (env: Env, url: URL) => Promise<Response | null>,
  url: URL,
): Promise<string> {
  try {
    const response = await handler(env as Env, url);
    if (response === null) return "null";
    return `${response.status} ${response.headers.get("content-type")} ${await response.text()}`;
  } catch (error) {
    if (error instanceof HttpError) return `refused ${error.status} ${error.code}`;
    throw error;
  }
}

/** A deterministic generator (mulberry32), so a failure names its seed. */
function generator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["basis", "offset", "offset", "basis", "cursor", "Basis", "", "limit"];
const VALUES = [
  "",
  "0",
  "1",
  "199",
  "200",
  "201",
  "229",
  "230",
  "231",
  "1000000",
  "1000001",
  "-1",
  "-0",
  "+1",
  "01",
  "1.0",
  "1e2",
  " 1",
  "0x10",
  "9007199254740993",
  "cash-movement",
  "purchase-recognition",
  "trade-date",
  "unknown",
  "tax",
  "CASH-MOVEMENT",
  "a".repeat(64),
  "a".repeat(65),
  "%E2%9C%93",
];

describe("the route matches its frozen pre-move handler", () => {
  it("answers fixed requests with the same status, code and bytes", async () => {
    const paths = [
      "/api/v2/activity",
      "/api/v2/activity?basis=cash-movement",
      "/api/v2/activity?basis=purchase-recognition",
      "/api/v2/activity?offset=200",
      "/api/v2/activity?basis=cash-movement&offset=199",
      "/api/v2/activity?basis=purchase-recognition&offset=70",
      "/api/v2/activity?offset=1000000",
      "/api/v2/activity?offset=1000001",
      "/api/v2/activity?basis=tax&offset=-1",
      "/api/v2/activity?basis=tax",
      "/api/v2/activity?basis=",
      "/api/v2/activity?offset=1&offset=1",
      "/api/v2/obligations",
      "/api/v2/obligations?offset=200",
      "/api/v2/obligations?offset=229",
      "/api/v2/obligations?basis=cash-movement",
      "/api/v2/obligations?offset=01",
      `/api/v2/obligations?offset=${"1".repeat(64)}`,
      `/api/v2/obligations?offset=${"1".repeat(65)}`,
      `/api/v2/activity?basis=${"a".repeat(65)}`,
      "/api/v2/other",
      "/api/v2/activity/",
    ];
    let pages = 0;
    for (const path of paths) {
      const url = new URL(`https://fixture.test${path}`);
      const expected = await answer(legacyEventsApi, url);
      expect(await answer(eventsApi, url), path).toBe(expected);
      if (expected.startsWith("200 ")) pages++;
    }
    // The comparison reads real pages, both lists past their first page.
    expect(pages).toBeGreaterThanOrEqual(10);
    const first = JSON.parse(
      (await answer(eventsApi, new URL("https://fixture.test/api/v2/activity"))).replace(
        /^200 \S+ /u,
        "",
      ),
    ) as { items: unknown[]; nextCursor: string | null };
    expect(first.items).toHaveLength(200);
    expect(first.nextCursor).toBe("200");
    const obligations = JSON.parse(
      (await answer(eventsApi, new URL("https://fixture.test/api/v2/obligations"))).replace(
        /^200 \S+ /u,
        "",
      ),
    ) as { items: unknown[]; nextCursor: string | null };
    expect(obligations.items).toHaveLength(200);
    expect(obligations.nextCursor).toBe("200");
  });

  it("answers random query strings with the same status, code and bytes", async () => {
    const random = generator(0x0e7e);
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
    for (let index = 0; index < 600; index++) {
      const parameters: string[] = [];
      const count = Math.floor(random() * 4);
      for (let entry = 0; entry < count; entry++) parameters.push(`${pick(KEYS)}=${pick(VALUES)}`);
      const path = `${pick(["/api/v2/activity", "/api/v2/obligations"])}${
        parameters.length > 0 ? `?${parameters.join("&")}` : ""
      }`;
      const url = new URL(`https://fixture.test${path}`);
      expect(await answer(eventsApi, url), path).toBe(await answer(legacyEventsApi, url));
    }
  });
});
