// The activity list's filters (ADR 0081, amendment of 2026-11-20):
// `GET /api/v2/activity`, `POST /api/agent/v1/events.read` and
// `kogane.events.read` on `/mcp` answer the same for every filter, cursor and
// refusal; a cursor is bound to the basis and the filters; the unfiltered list
// is unchanged; the changes digest's events handler names an argument the
// tool takes. Equality with the shipped query is proven in
// packages/read-model/test/events-filters.test.ts. Every event, account,
// source capture and amount is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { CHANGES_SINCE_HANDLERS } from "../../../packages/domain/src/changes-since";
import { ACTIVITY_CURSOR_INPUTS, filteredPaging } from "../src/events-api";
import { pageReadMcpTools, pageReadStore } from "../src/page-read-tools";
import { seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness, RECORDS_GRANT, tableCounts } from "./page-read-harness";

const EVENTS = "kogane.events.read";
const page = pageReadHarness("events-filters");
const DATE = '{"kind":"local-date","value":"2099-01-01","zone":null,"basis":"provider"}';
/** Events of `account_bulk`: more than one page of 200. */
const BULK = 205;

let sonyParse = 0;
let otherParse = 0;

async function parseRun(artifact: number): Promise<number> {
  return (await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'synthetic-parser','1','2099-01-01T00:00:00Z','pending','[]') RETURNING id`,
  )
    .bind(artifact)
    .first<number>("id"))!;
}

function event(
  id: string,
  createdAt: string,
  legs: { subject: string; basis: string }[],
  parse: number,
  revision = 1,
) {
  const decision = `dr_${id}_${revision}`;
  return [
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation',?,1,'accept','rule','rule:test',NULL,'synthetic','[]',NULL,NULL,'2099-01-01T00:00:00Z')`,
    ).bind(decision, `event:${id}`),
    env.DB.prepare(
      `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
       VALUES(?,?,'purchase','captured',NULL,?,'purchase-recognition',?,?,NULL,?)`,
    ).bind(
      id,
      revision,
      DATE,
      JSON.stringify([
        { kind: "transaction", id: "transaction:1", revision: `parse_run:${parse}` },
      ]),
      decision,
      createdAt,
    ),
    ...legs.map((leg, index) =>
      env.DB.prepare(
        `INSERT INTO economic_legs VALUES(?,?,?,?,'JPY','exact','1000',0,NULL,'decrease',?)`,
      ).bind(id, revision, index, leg.subject, leg.basis),
    ),
  ];
}

async function seed() {
  await seedRegistry().catch(() => undefined);
  sonyParse = await parseRun((await seedRun({ source: "sony-bank", count: 1 })).artifacts[0]!.id);
  otherParse = await parseRun((await seedRun({ source: "other-test", count: 1 })).artifacts[0]!.id);
  const cash = (subject: string) => [{ subject, basis: "cash-movement" }];
  await env.DB.batch([
    ...event("ev-a", "2099-02-01T00:00:00.000Z", cash("account:account_x"), sonyParse),
    ...event("ev-b", "2099-02-02T00:00:00.000Z", cash("account_y"), otherParse),
    ...event(
      "ev-c",
      "2099-02-03T00:00:00.000Z",
      [
        { subject: "account:account_x", basis: "cash-movement" },
        { subject: "claim:cost", basis: "purchase-recognition" },
      ],
      otherParse,
    ),
  ]);
  for (let start = 0; start < BULK; start += 25)
    await env.DB.batch(
      Array.from({ length: Math.min(25, BULK - start) }, (_, n) =>
        event(
          `ev-bulk-${String(start + n).padStart(4, "0")}`,
          "2099-01-15T00:00:00.000Z",
          cash("account:account_bulk"),
          sonyParse,
        ),
      ).flat(),
    );
}

beforeAll(seed);

const ids = (body: { items: { eventId: string }[] }) => body.items.map((item) => item.eventId);

describe("the filtered activity list", () => {
  it("answers each filter as the route does, on both agent paths, and writes nothing", async () => {
    const before = await tableCounts();
    for (const [query, args, expected] of [
      ["since=2099-02-02T00:00:00Z", { since: "2099-02-02T00:00:00Z" }, ["ev-b", "ev-c"]],
      // The same instant at +09:00: the window is on instants, not on text.
      [
        "since=2099-02-02T09:00:00%2B09:00",
        { since: "2099-02-02T09:00:00+09:00" },
        ["ev-b", "ev-c"],
      ],
      [
        "since=2099-02-01T00:00:00Z&before=2099-02-03T00:00:00Z",
        { since: "2099-02-01T00:00:00Z", before: "2099-02-03T00:00:00Z" },
        ["ev-a", "ev-b"],
      ],
      ["account=account_x", { account: "account_x" }, ["ev-a", "ev-c"]],
      ["account=account%3Aaccount_x", { account: "account:account_x" }, ["ev-a", "ev-c"]],
      ["account=account_y", { account: "account_y" }, ["ev-b"]],
      [
        "source=other-test&since=2099-02-01T00:00:00Z",
        { source: "other-test", since: "2099-02-01T00:00:00Z" },
        ["ev-b", "ev-c"],
      ],
      [
        "source=sony-bank&since=2099-02-01T00:00:00Z",
        { source: "sony-bank", since: "2099-02-01T00:00:00Z" },
        ["ev-a"],
      ],
      [
        "basis=purchase-recognition&account=account_x",
        { basis: "purchase-recognition", account: "account_x" },
        ["ev-c"],
      ],
      ["source=wise", { source: "wise" }, []],
    ] as [string, Record<string, unknown>, string[]][]) {
      const served = await page.expectSameAnswer(`/api/v2/activity?${query}`, EVENTS, {
        collection: "activity",
        ...args,
      });
      expect(served.status, query).toBe(200);
      expect(ids(served.body as never), query).toEqual(expected);
    }
    expect(await tableCounts()).toEqual(before);
  });

  it("echoes its filters in their compared form and says how far it walked", async () => {
    const answer = (await page.route(
      "/api/v2/activity?since=2099-02-02T09:00:00%2B09:00&account=account%3Aaccount_x",
    )) as { status: number; body: Record<string, unknown> };
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body)).toEqual([
      "apiVersion",
      "basis",
      "filters",
      "walk",
      "items",
      "nextCursor",
      "next",
      "paging",
      "dataCoverage",
    ]);
    expect(answer.body).toMatchObject({
      apiVersion: 2,
      basis: "cash-movement",
      filters: {
        since: "2099-02-02T00:00:00.000Z",
        before: null,
        account: "account_x",
        source: null,
      },
      // Every live revision is walked: the three named ones and the bulk.
      walk: { bound: 5000, walked: BULK + 3 },
      nextCursor: null,
      // ADR 0128's paging surface: nothing follows.
      next: null,
      paging: { limit: 200, returned: 1, hasMore: false, stoppedBy: null },
      dataCoverage: { truncated: false },
    });
    expect(ids(answer.body as never)).toEqual(["ev-c"]);
  });

  it("pages by a cursor bound to its filters, and joins its pages with nothing repeated or skipped", async () => {
    const args = { collection: "activity", account: "account_bulk" };
    const first = await page.expectSameAnswer(
      "/api/v2/activity?account=account_bulk",
      EVENTS,
      args,
    );
    const body = first.body as {
      items: { eventId: string }[];
      nextCursor: string;
      next: unknown;
      paging: unknown;
    };
    expect(body.items).toHaveLength(200);
    expect(typeof body.nextCursor).toBe("string");
    // ADR 0128: the continuation is the cursor to merge into the same call.
    expect(body.next).toEqual({ arguments: { cursor: body.nextCursor } });
    expect(body.paging).toEqual({ limit: 200, returned: 200, hasMore: true, stoppedBy: "limit" });
    const cursor = encodeURIComponent(body.nextCursor);
    const second = await page.expectSameAnswer(
      `/api/v2/activity?account=account_bulk&cursor=${cursor}`,
      EVENTS,
      { ...args, cursor: body.nextCursor },
    );
    const rest = second.body as {
      items: { eventId: string }[];
      nextCursor: string | null;
      next: unknown;
      paging: unknown;
    };
    expect(rest.nextCursor).toBeNull();
    expect(rest.next).toBeNull();
    expect(rest.paging).toEqual({
      limit: 200,
      returned: BULK - 200,
      hasMore: false,
      stoppedBy: null,
    });
    expect([...ids(body), ...ids(rest)]).toEqual(
      Array.from({ length: BULK }, (_, n) => `ev-bulk-${String(n).padStart(4, "0")}`),
    );
    // Another filter, another basis or no filter at all: the cursor continues nothing.
    for (const [query, other] of [
      [`account=account_x&cursor=${cursor}`, { account: "account_x" }],
      [
        `account=account_bulk&source=sony-bank&cursor=${cursor}`,
        { account: "account_bulk", source: "sony-bank" },
      ],
      [
        `basis=purchase-recognition&account=account_bulk&cursor=${cursor}`,
        { basis: "purchase-recognition", account: "account_bulk" },
      ],
      [`cursor=${cursor}`, {}],
    ] as [string, Record<string, unknown>][]) {
      const refused = await page.expectSameAnswer(`/api/v2/activity?${query}`, EVENTS, {
        collection: "activity",
        ...other,
        cursor: body.nextCursor,
      });
      expect(refused.status, query).toBe(400);
      expect(refused.body, query).toMatchObject({
        error: "cursor_mismatch",
        mustMatch: [...ACTIVITY_CURSOR_INPUTS],
      });
    }
    // The same filters spelled another way are the same filters.
    const respelled = await page.route(
      `/api/v2/activity?account=account%3Aaccount_bulk&basis=cash-movement&cursor=${cursor}`,
    );
    expect(respelled).toEqual(second);
  });

  it("says a page the walk bound ended before it filled stopped by `walk`", () => {
    expect(filteredPaging(0, "c")).toEqual({
      next: { arguments: { cursor: "c" } },
      paging: { limit: 200, returned: 0, hasMore: true, stoppedBy: "walk" },
    });
    expect(filteredPaging(37, "c").paging.stoppedBy).toBe("walk");
    expect(filteredPaging(200, "c").paging.stoppedBy).toBe("limit");
    expect(filteredPaging(37, null)).toEqual({
      next: null,
      paging: { limit: 200, returned: 37, hasMore: false, stoppedBy: null },
    });
  });

  it("takes every instant whose UTC form is in the years 0000 to 9999, to the millisecond", async () => {
    for (const [query, args, compared, expected] of [
      // Years 0 to 99 are not read as 1900 to 1999.
      [
        "account=account_x&since=0000-01-01T00:00:00Z",
        { account: "account_x", since: "0000-01-01T00:00:00Z" },
        { since: "0000-01-01T00:00:00.000Z", before: null },
        ["ev-a", "ev-c"],
      ],
      [
        "account=account_x&before=0000-01-01T00:30:00-01:00",
        { account: "account_x", before: "0000-01-01T00:30:00-01:00" },
        { since: null, before: "0000-01-01T01:30:00.000Z" },
        [],
      ],
      [
        "account=account_x&since=0050-06-15T12:00:00Z",
        { account: "account_x", since: "0050-06-15T12:00:00Z" },
        { since: "0050-06-15T12:00:00.000Z", before: null },
        ["ev-a", "ev-c"],
      ],
      [
        "account=account_x&before=9999-12-31T23:59:59.999Z",
        { account: "account_x", before: "9999-12-31T23:59:59.999Z" },
        { since: null, before: "9999-12-31T23:59:59.999Z" },
        ["ev-a", "ev-c"],
      ],
      [
        "account=account_x&since=9999-12-31T22:00:00-01:59",
        { account: "account_x", since: "9999-12-31T22:00:00-01:59" },
        { since: "9999-12-31T23:59:00.000Z", before: null },
        [],
      ],
    ] as [string, Record<string, unknown>, Record<string, unknown>, string[]][]) {
      const answer = await page.expectSameAnswer(`/api/v2/activity?${query}`, EVENTS, {
        collection: "activity",
        ...args,
      });
      expect(answer.status, query).toBe(200);
      const body = answer.body as {
        filters: Record<string, unknown>;
        items: { eventId: string }[];
      };
      expect(body.filters, query).toMatchObject(compared);
      expect(ids(body), query).toEqual(expected);
    }
  });

  it("refuses a malformed filter, cursor or offset with a closed code naming it", async () => {
    for (const [query, args, error, refs] of [
      ["since=2099-02-01", { since: "2099-02-01" }, "invalid_query", ["since:format"]],
      [
        "since=2099-02-30T00:00:00Z",
        { since: "2099-02-30T00:00:00Z" },
        "invalid_query",
        ["since:format"],
      ],
      ["before=yesterday", { before: "yesterday" }, "invalid_query", ["before:format"]],
      // Instants whose UTC form leaves the four-digit years `created_at` is
      // compared in: `+010000-…` would sort before every recorded time.
      [
        "since=9999-12-31T23:00:00-02:00",
        { since: "9999-12-31T23:00:00-02:00" },
        "invalid_query",
        ["since:format"],
      ],
      [
        "before=0000-01-01T00:30:00%2B01:00",
        { before: "0000-01-01T00:30:00+01:00" },
        "invalid_query",
        ["before:format"],
      ],
      // Just past each end: `+010000-01-01T00:00:00Z` and `-000001-12-31T23:59:00Z`.
      [
        "since=9999-12-31T23:59:00-00:01",
        { since: "9999-12-31T23:59:00-00:01" },
        "invalid_query",
        ["since:format"],
      ],
      [
        "before=0000-01-01T00:00:00%2B00:01",
        { before: "0000-01-01T00:00:00+00:01" },
        "invalid_query",
        ["before:format"],
      ],
      [
        "since=2099-02-02T00:00:00Z&before=2099-02-02T09:00:00%2B09:00",
        { since: "2099-02-02T00:00:00Z", before: "2099-02-02T09:00:00+09:00" },
        "invalid_query",
        ["window:empty"],
      ],
      ["account=account%3A", { account: "account:" }, "invalid_query", ["account:format"]],
      ["account=a%20b", { account: "a b" }, "invalid_query", ["account:format"]],
      ["source=Sony", { source: "Sony" }, "invalid_query", ["source:format"]],
      [
        "since=bad&source=Sony",
        { since: "bad", source: "Sony" },
        "invalid_query",
        ["since:format", "source:format"],
      ],
      [
        "account=account_x&offset=0",
        { account: "account_x", offset: 0 },
        "invalid_query",
        ["offset"],
      ],
      [
        "account=account_x&cursor=c_1",
        { account: "account_x", cursor: "c_1" },
        "invalid_cursor",
        undefined,
      ],
    ] as [string, Record<string, unknown>, string, string[] | undefined][]) {
      const refused = await page.expectSameAnswer(`/api/v2/activity?${query}`, EVENTS, {
        collection: "activity",
        ...args,
      });
      expect(refused.status, query).toBe(400);
      expect(refused.body, query).toMatchObject({ error });
      expect((refused.body as { refs?: string[] }).refs, query).toEqual(refs);
    }
    // Obligations take no filter, as before.
    const obligations = await page.expectSameAnswer(
      "/api/v2/obligations?since=2099-02-01T00:00:00Z",
      EVENTS,
      { collection: "obligations", since: "2099-02-01T00:00:00Z" },
    );
    expect(obligations.status).toBe(400);
    expect(obligations.body).toMatchObject({ error: "invalid_query" });
  });

  it("grades the grant before it reads a filter", async () => {
    for (const [grant, code] of [
      [{ ...RECORDS_GRANT, capabilities: ["summary.read"] }, "unauthorized"],
      [
        { ...RECORDS_GRANT, scopes: { sources: ["sony-bank"], accounts: "*" } },
        "evidence_restricted",
      ],
    ] as const) {
      const answer = await page.direct(
        EVENTS,
        { collection: "activity", since: "not-a-time", cursor: "c_1" },
        grant,
      );
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ code });
    }
  });
});

describe("the unfiltered activity list", () => {
  it("is the shipped answer: the same fields, offset paging and offset cursor", async () => {
    const first = (await page.route("/api/v2/activity")) as {
      status: number;
      body: Record<string, unknown> & { items: unknown[]; nextCursor: string };
    };
    expect(first.status).toBe(200);
    expect(Object.keys(first.body)).toEqual([
      "apiVersion",
      "basis",
      "items",
      "nextCursor",
      "dataCoverage",
    ]);
    expect(first.body.items).toHaveLength(200);
    // A cursor issued before the filters (the next offset) still continues.
    expect(first.body.nextCursor).toBe("200");
    const next = await page.expectSameAnswer(
      `/api/v2/activity?offset=${first.body.nextCursor}`,
      EVENTS,
      { collection: "activity", offset: 200 },
    );
    expect((next.body as { items: unknown[] }).items).toHaveLength(BULK + 3 - 200);
  });
});

describe("the changes digest's events handler", () => {
  it("names only arguments the tool takes, and its since lists the revisions recorded since", async () => {
    // Every handler's tool is a page read, listed to a grant that reads
    // records and evidence where its tables exist.
    const tools = await pageReadMcpTools(
      { ...RECORDS_GRANT, capabilities: ["records.read", "evidence.read"] } as never,
      pageReadStore(env as Env, {
        economicEvents: async () => true,
        collectionQuality: async () => true,
      }),
    );
    for (const handler of Object.values(CHANGES_SINCE_HANDLERS)) {
      const tool = tools.find((entry) => entry.name === handler.tool);
      expect(tool, handler.tool).toBeDefined();
      const properties = Object.keys(
        (tool!.inputSchema as { properties: Record<string, unknown> }).properties,
      );
      const named = [
        ...Object.keys(handler.arguments),
        ...("sourceArgument" in handler ? [handler.sourceArgument] : []),
        ...("sinceArgument" in handler ? [handler.sinceArgument] : []),
        ...("idArgument" in handler ? [handler.idArgument.name] : []),
        ...("kindArgument" in handler ? [handler.kindArgument.name] : []),
      ];
      for (const name of named) expect(properties, `${handler.tool} ${name}`).toContain(name);
    }
    const handler = CHANGES_SINCE_HANDLERS.events;
    const listed = await page.mcp(EVENTS, {
      ...handler.arguments,
      [handler.sinceArgument]: "2099-02-02T00:00:00.000Z",
    });
    expect(listed.isError).toBe(false);
    expect(ids(listed.body.data)).toEqual(["ev-b", "ev-c"]);
  });
});
