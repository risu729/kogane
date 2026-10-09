// The Worker `reconstructed-state-workerd.ts` starts under `wrangler dev`: one
// POST runs `readReconstructedState` on workerd over the D1 binding, exactly
// as `GET /api/v2/reconstructed-state` does after its Access and grant checks,
// and answers the route's body. A measurement entry only: it is never
// deployed and no wrangler config of this service names it.
import { readReconstructedState } from "../../../packages/application/src/index";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import type { SqlExecutor } from "../../../packages/read-model/src/reader.ts";

/** The reader authority the route grants a signed-in subject (`readerGrant`). */
const READER = {
  principal: "synthetic-measurement",
  scopes: { sources: "*" as const, accounts: "*" as const },
  capabilities: ["summary.read" as const, "records.read" as const, "evidence.read" as const],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

/**
 * The executor with each statement's interval recorded. workerd's clock only
 * moves when an I/O event is delivered, so a timestamp taken after CPU work
 * still reads the time of the last event; a zero-delay timer is awaited first
 * so the start is current. An interval then spans one D1 round trip; their
 * union is the time spent waiting on D1, and the rest of the request is the
 * Worker's own work (selection, adapter, fold, JSON) plus the request's
 * transport, an upper bound on its CPU time.
 */
function timed(sql: SqlExecutor, spans: [number, number][], split: boolean): SqlExecutor {
  const around = async <T>(run: () => Promise<T>): Promise<T> => {
    if (split) await new Promise((resolve) => setTimeout(resolve, 0));
    const start = Date.now();
    try {
      return await run();
    } finally {
      spans.push([start, Date.now()]);
    }
  };
  return {
    all: (text, args) => around(() => sql.all(text, args)),
    first: (text, args) => around(() => sql.first(text, args)),
  };
}

function union(spans: [number, number][]): number {
  let total = 0;
  let end = -Infinity;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const { body, now } = (await request.json()) as { body: unknown; now: string };
    const spans: [number, number][] = [];
    const started = Date.now();
    const outcome = await readReconstructedState({
      grant: READER,
      // The timers that make the split exact cost time of their own, so a
      // request asks for the split (`x-split: 1`) or for the plain wall time.
      sql: timed(d1Executor(env.DB), spans, request.headers.get("x-split") === "1"),
      body,
      now,
    });
    const headers = {
      "x-statements": String(spans.length),
      "x-d1-ms": String(union(spans)),
      "x-worker-ms": String(Date.now() - started),
    };
    return outcome.ok
      ? Response.json(outcome.body, { headers })
      : Response.json({ error: outcome.refusal }, { status: 400, headers });
  },
};
