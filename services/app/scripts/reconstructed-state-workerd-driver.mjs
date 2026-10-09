// Runs under Node, started by reconstructed-state-workerd.ts with one JSON
// argument: starts `wrangler dev` on reconstructed-state-workerd-worker.ts with
// a local D1, replaces the D1's SQLite file with the measurement store, and
// prints one JSON line of medians (three runs after one warm-up): the wall
// time of one request from this process; and, on instrumented runs, the time
// the Worker spent waiting on D1 (the union of its statements' intervals,
// measured inside the Worker) and the rest of the instrumented wall time, an
// upper bound on the Worker's own CPU time. Local only; synthetic values only.
import { copyFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { unstable_dev } from "wrangler";

const plan = JSON.parse(process.argv[2]);
const persist = join(plan.work, "state");
const config = join(plan.work, "wrangler.json");
writeFileSync(
  config,
  JSON.stringify({
    name: "kogane-reconstructed-state-measurement",
    main: plan.worker,
    compatibility_date: "2026-09-05",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: [
      {
        binding: "DB",
        database_name: "measurement",
        database_id: "00000000-0000-4000-8000-000000000550",
      },
    ],
  }),
);
const options = {
  config,
  persistTo: persist,
  logLevel: "warn",
  experimental: { disableExperimentalWarning: true },
};
const post = (worker, body, split = false) =>
  worker.fetch("/", {
    method: "POST",
    headers: split ? { "x-split": "1" } : {},
    body: JSON.stringify({ body, now: plan.now }),
  });

// Miniflare creates the D1's SQLite file on first use (a read against the
// empty database, which fails); it is then replaced by the store.
let worker = await unstable_dev(plan.worker, options);
await post(worker, plan.body);
await worker.stop();
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const files = walk(persist).filter((file) =>
  /miniflare-D1DatabaseObject\/[0-9a-f]{64}\.sqlite$/u.test(file),
);
if (files.length !== 1) throw new Error(`expected one D1 file, found ${files.length}`);
for (const suffix of ["-wal", "-shm"]) rmSync(`${files[0]}${suffix}`, { force: true });
copyFileSync(plan.database, files[0]);
// What Miniflare's D1 object keeps beside the user's tables, and its journal mode.
const copied = new DatabaseSync(files[0]);
copied.exec(
  "CREATE TABLE IF NOT EXISTS _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB); INSERT OR IGNORE INTO _cf_METADATA VALUES (2, 0); PRAGMA journal_mode=WAL;",
);
copied.close();

worker = await unstable_dev(plan.worker, options);
async function ask(cut, split) {
  const at = performance.now();
  const response = await post(worker, { ...plan.body, ...(cut === null ? {} : { cut }) }, split);
  const answer = await response.json();
  const ms = performance.now() - at;
  if (answer.status === undefined) throw new Error(`refused: ${answer.error}`);
  return {
    ms,
    d1Ms: Number(response.headers.get("x-d1-ms")),
    statements: Number(response.headers.get("x-statements")),
    status: answer.status,
    cut: answer.cut.resolved,
  };
}
const middleOf = (runs, key) => runs.map((run) => run[key]).sort((a, b) => a - b)[1];
/**
 * Medians of three runs after one warm-up: the plain wall time from here; then,
 * on three instrumented runs, the time the Worker waited on D1 and the rest of
 * the instrumented wall time.
 */
async function median(cut) {
  await ask(cut, false);
  const plain = [await ask(cut, false), await ask(cut, false), await ask(cut, false)];
  const split = [await ask(cut, true), await ask(cut, true), await ask(cut, true)];
  const splitWall = Math.round(middleOf(split, "ms"));
  const d1Ms = middleOf(split, "d1Ms");
  return {
    ...plain[0],
    ms: Math.round(middleOf(plain, "ms")),
    splitWallMs: splitWall,
    d1Ms,
    workerMs: splitWall - d1Ms,
  };
}
try {
  const latest = await median(null);
  const epoch = latest.cut.coreEpoch;
  const sequence = await median({ coreEpoch: epoch, commitSeq: plan.middle });
  const instant = await median({ coreEpoch: epoch, instant: plan.logStart });
  const figures = (run) => ({
    wallMs: run.ms,
    instrumentedWallMs: run.splitWallMs,
    d1Ms: run.d1Ms,
    restMs: run.workerMs,
  });
  console.log(
    JSON.stringify({
      status: latest.status,
      latestCut: latest.cut.commitSeq,
      statements: latest.statements,
      latest: figures(latest),
      sequenceMid: figures(sequence),
      instantNearStart: figures(instant),
    }),
  );
} finally {
  await worker.stop();
}
