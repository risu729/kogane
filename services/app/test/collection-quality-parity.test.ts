// The collection quality routes answer byte for byte what they answered
// before they became thin adapters over the shared services (ADR 0081): every
// request below goes through the frozen route (legacy-collection-quality-api.ts)
// and the current one against the same store, and the two answers (status,
// headers and body bytes, or the HTTP error thrown, or no answer) must be
// equal. The matrix crosses paths and query strings, methods, reader grants,
// the store's scheduling tables, the Alarm relay and the row bound. One
// synthetic Sony Bank capture is seeded; every value is invented.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as agentApi from "../src/agent-api";
import { collectionQualityApi } from "../src/collection-quality-api";
import { HttpError } from "../src/http";
import { legacyCollectionQualityApi } from "./legacy-collection-quality-api";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const PATH = "/api/collection-quality";

/** Every path and query string the matrix sends: answers, refusals and paths that are not this route's. */
const TARGETS = [
  PATH,
  `${PATH}?`,
  `${PATH}?x=1`,
  `${PATH}?source=sony-bank`,
  `${PATH}/`,
  `${PATH}/sony-bank`,
  `${PATH}/sony-bank?`,
  `${PATH}/sony-bank?&`,
  `${PATH}/sony-bank?offset=0`,
  `${PATH}/sony-bank?offset=500`,
  `${PATH}/sony-bank?offset=9999999`,
  `${PATH}/sony-bank?offset=10000000`,
  `${PATH}/sony-bank?offset=01`,
  `${PATH}/sony-bank?offset=-1`,
  `${PATH}/sony-bank?offset=1.5`,
  `${PATH}/sony-bank?offset=`,
  `${PATH}/sony-bank?offset`,
  `${PATH}/sony-bank?offset=1&offset=2`,
  `${PATH}/sony-bank?offset=abc&x=1`,
  `${PATH}/sony-bank?limit=5`,
  `${PATH}/sony-bank?source=vpass`,
  `${PATH}/vpass`,
  `${PATH}/no-such-source`,
  `${PATH}/no-such-source?offset=01`,
  `${PATH}/kogane-synthetic`,
  `${PATH}/Sony_Bank`,
  `${PATH}/Sony_Bank?offset=01`,
  `${PATH}/sony-bank/extra`,
  `${PATH}/${"a".repeat(101)}`,
  `${PATH}/sony-bank/accounts`,
  `${PATH}/sony-bank/accounts?`,
  `${PATH}/sony-bank/accounts?offset=0`,
  `${PATH}/sony-bank/accounts/extra`,
  `${PATH}/vpass/accounts`,
  `${PATH}/no-such-source/accounts`,
  `${PATH}/no-such-source/accounts?x=1`,
  `${PATH}/Sony_Bank/accounts?x=1`,
  `${PATH}/accounts`,
  `${PATH}/accounts/accounts`,
  `${PATH}//accounts`,
  `${PATH}x`,
  "/api/collection-qualities",
  "/api/other",
];
const METHODS = ["GET", "HEAD", "POST", "DELETE"];
const isSummaryTarget = (target: string) => target === PATH || target.startsWith(`${PATH}?`);

/** The reader grant, and the narrowed or incapable grants a reader might be given. */
const GRANTS = {
  reader: null,
  "no evidence.read": { capabilities: ["summary.read", "records.read"] },
  "narrowed sources": { scopes: { sources: ["sony-bank"], accounts: "*" } },
  "narrowed accounts": { scopes: { sources: "*", accounts: ["synthetic-account"] } },
} as const;

/** A store before CORE 0065: the table check sees four of the five tables. */
function withoutTables(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("collection_schedules")
              ? "SELECT 4 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

type Relay = "off" | "ok" | "failed" | "invalid";

/** The relay of the Observation Pipeline's Alarm reservations, in one mode, counting its calls. */
function pipeline(mode: Relay, calls: { n: number }): Fetcher {
  return {
    fetch: async () => {
      calls.n += 1;
      if (mode === "failed") throw new Error("synthetic unavailable");
      if (mode === "invalid") return Response.json({ alarms: [], unexpected: true });
      // Observed for every job the store configures, enabled or not, as stored.
      const jobs = await env.DB.prepare(
        "SELECT id, enabled, next_nominal_at, next_run_at FROM collection_schedules",
      ).all<{
        id: string;
        enabled: number;
        next_nominal_at: string | null;
        next_run_at: string | null;
      }>();
      return Response.json({
        alarms: jobs.results.map((job) => ({
          id: job.id,
          enabled: job.enabled === 1,
          nextNominalAt: job.next_nominal_at,
          nextRunAt: job.next_run_at,
          alarm: { status: "observed", actualAt: null },
        })),
      });
    },
    connect() {
      throw new Error("unexpected synthetic connect");
    },
  } as unknown as Fetcher;
}

type Route = typeof collectionQualityApi;

/** One answer as bytes: no answer, a response, or the HTTP error thrown; and how often the relay was asked. */
async function answer(
  route: Route,
  target: string,
  method: string,
  routeEnv: Env,
  calls: { n: number },
) {
  const url = new URL(`https://fixture.test${target}`);
  const before = calls.n;
  try {
    const response = await route(new Request(url, { method }), routeEnv, url, "synthetic-reader");
    if (response === null) return { kind: "none", relayed: calls.n - before };
    return {
      kind: "response",
      status: response.status,
      headers: [...response.headers.entries()],
      body: await response.text(),
      relayed: calls.n - before,
    };
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    return {
      kind: "error",
      status: error.status,
      code: error.code,
      refs: error.refs,
      relayed: calls.n - before,
    };
  }
}

async function compareAll(options: { relays: readonly Relay[] }) {
  const grant = agentApi.readerGrant("synthetic-reader");
  const reader = vi.spyOn(agentApi, "readerGrant");
  const kinds = new Set<string>();
  let compared = 0;
  for (const [label, change] of Object.entries(GRANTS)) {
    reader.mockReturnValue(change === null ? grant : { ...grant, ...change });
    for (const tables of [true, false])
      for (const relay of options.relays) {
        const calls = { n: 0 };
        const routeEnv = {
          ...env,
          DB: tables ? env.DB : withoutTables(env.DB),
          SCHEDULES_ENABLED: relay === "off" ? "false" : "true",
          PIPELINE: pipeline(relay, calls),
        } as Env;
        // Only the summary asks the relay: the other paths run once, relay off.
        const targets = relay === "off" ? TARGETS : TARGETS.filter(isSummaryTarget);
        for (const target of targets)
          for (const method of METHODS) {
            const legacy = await answer(
              legacyCollectionQualityApi,
              target,
              method,
              routeEnv,
              calls,
            );
            const current = await answer(collectionQualityApi, target, method, routeEnv, calls);
            expect(
              current,
              `${label} tables=${String(tables)} relay=${relay} ${method} ${target}`,
            ).toEqual(legacy);
            kinds.add(
              legacy.kind === "response"
                ? `${legacy.status}`
                : legacy.kind === "error"
                  ? `${legacy.status}:${legacy.code}`
                  : "none",
            );
            compared += 1;
          }
      }
  }
  reader.mockRestore();
  return { kinds, compared };
}

beforeAll(async () => {
  await seedRegistry();
  const run = await seedRun({ source: "sony-bank", count: 1, dataset: "yen-history-page-0001" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'sony-bank-history-json','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
});
afterEach(() => vi.restoreAllMocks());

describe("collection quality routes: the adapters answer what the frozen route answered", () => {
  it("for every path, method, grant, store and relay, byte for byte", async () => {
    const { kinds, compared } = await compareAll({ relays: ["off", "ok", "failed", "invalid"] });
    const summaries = TARGETS.filter(isSummaryTarget).length;
    expect(compared).toBe(
      Object.keys(GRANTS).length * 2 * (TARGETS.length + 3 * summaries) * METHODS.length,
    );
    // The matrix reaches every answer the route gives, so equality is not vacuous.
    expect([...kinds].sort()).toEqual(
      [
        "200",
        "400:invalid_offset",
        "400:invalid_query",
        "403:forbidden",
        "403:scope_restricted",
        "404:not_found",
        "405:method_not_allowed",
        "none",
      ].sort(),
    );
  });

  // Last: it adds configured jobs to this file's store.
  it("past the row bound, the same 413 and the same pages", async () => {
    await env.DB.batch(
      Array.from({ length: 201 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by)
           VALUES(?,NULL,'processor',0,1,'UTC','{"kind":"interval","minutes":60}','2099-01-01T00:00:00.000Z','synthetic')`,
        ).bind(`synthetic-${index}`),
      ),
    );
    const { kinds } = await compareAll({ relays: ["off", "ok"] });
    expect(kinds).toContain("413:result_limit_exceeded");
  });
});
