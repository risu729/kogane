// The reconstructed state's route cost on workerd: builds the measurement
// store of packages/application/test/reconstructed-state-scale-store.ts on
// `bun:sqlite`, copies it into the SQLite file of a local Miniflare D1 under
// `wrangler dev`, and times `readReconstructedState` running on workerd over
// that D1 (`reconstructed-state-workerd-worker.ts`), wall time from this
// process, median of three after one warm-up. Local only: no remote D1, no
// deployed Worker, synthetic values only. Opt-in, never in CI:
//
//   bun services/app/scripts/reconstructed-state-workerd.ts        # CI scale
//   bun services/app/scripts/reconstructed-state-workerd.ts full   # full scale
//
// Node must be on the PATH: `wrangler dev` is run from Node.
//
// The figures are quoted in the ADR 0058 amendment (Cost).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconstructedScaleStore } from "../../../packages/application/test/reconstructed-state-scale-store.ts";

// `bun:sqlite` builds the store; `wrangler dev` runs under Node
// (`reconstructed-state-workerd-driver.mjs`), whose Miniflare it is pinned to.
const full = process.argv[2] === "full";
const started = performance.now();
const store = await reconstructedScaleStore(full);
const builtMs = Math.round(performance.now() - started);
const logStart = (
  store.db.query("SELECT known_at FROM economic_commit_log ORDER BY commit_seq LIMIT 1").get() as {
    known_at: string;
  }
).known_at;
const work = mkdtempSync(join(tmpdir(), "kogane-reconstructed-workerd-"));
try {
  const database = join(work, "store.sqlite");
  writeFileSync(database, store.db.serialize());
  const commits = store.existingCommits + store.events * store.revisions;
  const plan = {
    work,
    database,
    worker: join(import.meta.dir, "reconstructed-state-workerd-worker.ts"),
    now: store.now,
    body: { account: store.account, from: store.from, to: store.to },
    middle: store.existingCommits + Math.floor((store.events * store.revisions) / 2),
    logStart,
  };
  const run = spawnSync(
    "node",
    [join(import.meta.dir, "reconstructed-state-workerd-driver.mjs"), JSON.stringify(plan)],
    { cwd: join(import.meta.dir, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (run.status !== 0) throw new Error(`driver exited ${String(run.status)}`);
  const figures = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
  console.log(
    `reconstructed-state workerd ${store.scale}: ${JSON.stringify({
      builtMs,
      events: store.events,
      revisions: store.events * store.revisions,
      commits,
      ...figures,
    })}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
