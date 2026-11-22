// `publishBatch` (src/atomic/publication.ts): every statement that writes is
// fenced on the live lease, the second one ("supersede older successes")
// included. A writer that no longer holds the lease — its lease expired, its
// job was closed, or another attempt took the job over — must not supersede
// anything, even for a run that is already `ok` and current.
//
// The fence is proven against the statement as it shipped without it
// (./publish-batch-legacy-sql.ts): equal results for a writer that holds the
// lease on random and scaled stores, nothing written for one that does not,
// and a plan that adds only the lease lookup the batch's first statement
// already makes. Every row is synthetic: invented artifacts, parser names and
// versions; no provider value appears.
import { Database } from "bun:sqlite";
import { beforeAll, expect, test } from "bun:test";
import { publishBatch, type PublishInput } from "../src/atomic/publication.ts";
import type { D1RunResultLike } from "../src/d1.ts";
import { legacySupersedeOlderSuccesses } from "./publish-batch-legacy-sql.ts";
import { planOf, preparedStatements, tableScans } from "./plan-check.ts";
import { coreDatabase, fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

let image: Uint8Array;
// Both images migrate every CORE migration once; pay it here under its own
// budget (see ./sqlite.ts).
beforeAll(() => {
  const db = coreDatabase();
  image = db.serialize();
  db.close();
  fullCoreDatabase().close();
}, 60_000);

const NOW = 1_000_000;
const LIVE = NOW + 60_000;
const EXPIRED = NOW - 1;
const TOKEN = "writer-synthetic";
const PUBLISHED_AT = "2000-01-02T00:00:00.000Z";

type RunStatus = "pending" | "ok" | "error";
interface RunSeed {
  id: number;
  artifact: number;
  parser: string;
  version: string;
  status: RunStatus;
  supersededBy: number | null;
  candidate: boolean;
}
interface JobSeed {
  artifact: number;
  parser: string;
  version: string;
  status: "pending" | "running" | "done" | "failed";
  token: string;
  leaseUntil: number;
}
interface StoreSeed {
  runs: RunSeed[];
  /** Run id per key, written as a `normal` pointer. */
  pointers: number[];
  jobs: JobSeed[];
}

function store(seed: StoreSeed): Database {
  const db = Database.deserialize(image);
  const run = db.query(
    `INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?1,?2,?3,?4,'2000-01-01T00:00:00.000Z',?5,'[]')`,
  );
  for (const r of seed.runs) run.run(r.id, r.artifact, r.parser, r.version, r.status);
  // Pointers are set once every run exists: a run may point at a later id.
  const supersede = db.query("UPDATE parse_runs SET superseded_by_parse_run_id=?2 WHERE id=?1");
  for (const r of seed.runs) if (r.supersededBy !== null) supersede.run(r.id, r.supersededBy);
  const candidate = db.query(
    `INSERT INTO parse_run_candidates(parse_run_id,release_id,fingerprint,state,created_at)
     VALUES(?1,'release-synthetic','fingerprint-synthetic','candidate','2000-01-01T00:00:00.000Z')`,
  );
  for (const r of seed.runs) if (r.candidate) candidate.run(r.id);
  const pointer = db.query(
    `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
     SELECT fetch_artifact_id,parser_name,id,parser_version,'2000-01-01T00:00:00.000Z','normal' FROM parse_runs WHERE id=?1`,
  );
  for (const id of seed.pointers) pointer.run(id);
  const job = db.query(
    `INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lease_token,lease_until_ms)
     VALUES(?1,?2,?3,?4,?5,?6)`,
  );
  for (const j of seed.jobs)
    job.run(j.artifact, j.parser, j.version, j.status, j.token, j.leaseUntil);
  return db;
}

function inputFor(target: RunSeed): PublishInput {
  return {
    parseId: target.id,
    token: TOKEN,
    version: target.version.split(".").map(Number),
    artifactId: target.artifact,
    parserName: target.parser,
    publishedAt: PUBLISHED_AT,
    now: NOW,
  };
}

/** Every table the publish batch can write, in a stable order. */
function state(db: Database): Record<string, unknown[]> {
  const all = (sql: string) => db.query(sql).all();
  return {
    runs: all(
      "SELECT id,status,superseded_by_parse_run_id AS supersededBy FROM parse_runs ORDER BY id",
    ),
    pointers: all(
      "SELECT fetch_artifact_id,parser_name,parse_run_id,published_at FROM published_parse_runs ORDER BY fetch_artifact_id,parser_name",
    ),
    events: all(
      "SELECT fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind FROM publication_events ORDER BY id",
    ),
    jobs: all(
      "SELECT fetch_artifact_id,parser_name,parser_version,status,lease_token FROM observation_parse_jobs ORDER BY 1,2,3",
    ),
    revision: all("SELECT source_revision FROM core_source_revision"),
  };
}

interface Outcome {
  changes: number[] | null;
  error: string | null;
  state: Record<string, unknown[]>;
}

/** Runs the shipped batch, or the batch with its second statement swapped for
 * the frozen legacy text, on its own copy of the store. */
async function publish(seed: StoreSeed, target: RunSeed, legacy: boolean): Promise<Outcome> {
  const db = store(seed);
  const d1 = sqliteD1(db);
  const input = inputFor(target);
  const statements = publishBatch(d1, input);
  if (legacy)
    statements[1] = legacySupersedeOlderSuccesses(
      d1,
      input.parseId,
      input.artifactId,
      input.parserName,
    );
  let changes: number[] | null = null;
  let error: string | null = null;
  try {
    changes = (await d1.batch(statements)).map((r: D1RunResultLike) => r.meta.changes);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "unknown";
  }
  const after = state(db);
  db.close();
  return { changes, error, state: after };
}

const PARSER = "parser-synthetic";

/** A key whose run 11 is already `ok` and current, next to an older `ok` run
 * 10 that nothing superseded: the state statement 2 acts on. */
function displacedStore(job: Partial<JobSeed>): { seed: StoreSeed; target: RunSeed } {
  const older: RunSeed = {
    id: 10,
    artifact: 1,
    parser: PARSER,
    version: "1.0.0",
    status: "ok",
    supersededBy: null,
    candidate: false,
  };
  const target: RunSeed = { ...older, id: 11, version: "1.1.0" };
  return {
    target,
    seed: {
      runs: [older, target],
      pointers: [11],
      jobs: [
        {
          artifact: 1,
          parser: PARSER,
          version: "1.1.0",
          status: "running",
          token: TOKEN,
          leaseUntil: LIVE,
          ...job,
        },
      ],
    },
  };
}

const DISPLACED: Record<string, Partial<JobSeed>> = {
  "its lease expired": { leaseUntil: EXPIRED },
  "its job was closed": { status: "done" },
  "another attempt took the job over": { token: "successor-synthetic" },
};

for (const [why, job] of Object.entries(DISPLACED))
  test(`a writer whose ${why.replace(/^its /u, "")} supersedes nothing (${why})`, async () => {
    const { seed, target } = displacedStore(job);
    const before = state(store(seed));
    const shipped = await publish(seed, target, false);
    expect(shipped.error).toBeNull();
    expect(shipped.changes?.[1]).toBe(0);
    expect(shipped.state.runs).toEqual(before.runs);
    expect(shipped.state.runs).toContainEqual({ id: 10, status: "ok", supersededBy: null });
    // Without the fence the same writer turned run 10 into replaced history.
    const legacy = await publish(seed, target, true);
    expect(legacy.error).toBeNull();
    expect(legacy.changes?.[1]).toBeGreaterThan(0);
    expect(legacy.state.runs).toContainEqual({ id: 10, status: "ok", supersededBy: 11 });
  });

test("a writer that holds the lease supersedes the older success, as before", async () => {
  const { seed, target } = displacedStore({});
  const shipped = await publish(seed, target, false);
  expect(shipped.error).toBeNull();
  expect(shipped.state.runs).toContainEqual({ id: 10, status: "ok", supersededBy: 11 });
  expect(shipped).toEqual(await publish(seed, target, true));
});

/** mulberry32: a small seeded generator, so a failing store can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERSIONS = ["0.9.5", "1.0.0", "1.2.0", "1.10.0", "2.0.0", "2.0.1"];

/** A random store: up to `artifacts` × 2 keys of up to five runs each, random
 * statuses, supersession, candidates and pointers, and one target run with a
 * job whose lease may or may not be held. */
function randomStore(
  next: () => number,
  artifacts: number,
): { seed: StoreSeed; target: RunSeed; holds: boolean } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const runs: RunSeed[] = [];
  const pointers: number[] = [];
  let id = 1;
  for (let artifact = 1; artifact <= artifacts; artifact++)
    for (const parser of ["parser-a", "parser-b"]) {
      const versions = [...VERSIONS].sort(() => next() - 0.5).slice(0, Math.floor(next() * 6));
      const key = versions.map((version): RunSeed => ({
        id: id++,
        artifact,
        parser,
        version,
        status: pick(["pending", "ok", "ok", "error"] as const),
        supersededBy: null,
        candidate: next() < 0.2,
      }));
      for (const r of key)
        if (r.status === "ok" && key.length > 1 && next() < 0.4)
          r.supersededBy = pick(key.filter((other) => other.id !== r.id)).id;
      const ok = key.filter((r) => r.status === "ok");
      if (ok.length > 0 && next() < 0.5) pointers.push(pick(ok).id);
      runs.push(...key);
    }
  const open = runs.filter((r) => r.status !== "error");
  let target: RunSeed;
  if (open.length === 0) {
    target = {
      id: id++,
      artifact: 1,
      parser: "parser-a",
      version: "9.9.9",
      status: "pending",
      supersededBy: null,
      candidate: false,
    };
    runs.push(target);
  } else target = pick(open);
  const status = pick(["running", "running", "done", "pending", "failed"] as const);
  const leaseUntil = pick([LIVE, LIVE, EXPIRED]);
  const token = pick([TOKEN, TOKEN, TOKEN, "successor-synthetic"]);
  return {
    target,
    holds: status === "running" && leaseUntil > NOW && token === TOKEN,
    seed: {
      runs,
      pointers,
      jobs: [
        {
          artifact: target.artifact,
          parser: target.parser,
          version: target.version,
          status,
          token,
          leaseUntil,
        },
      ],
    },
  };
}

test("on random stores the fenced statement answers as the shipped one for a lease holder and writes nothing for anyone else", async () => {
  const next = random(0x5eed);
  const seen = { holders: 0, displaced: 0, displacedLegacyWrites: 0, holderWrites: 0 };
  for (let index = 0; index < 400; index++) {
    const { seed, target, holds } = randomStore(next, 3);
    const shipped = await publish(seed, target, false);
    const legacy = await publish(seed, target, true);
    if (holds) {
      seen.holders++;
      expect({ index, ...shipped }).toEqual({ index, ...legacy });
      if ((shipped.changes?.[1] ?? 0) > 0) seen.holderWrites++;
      continue;
    }
    seen.displaced++;
    const before = state(store(seed));
    expect({ index, error: shipped.error }).toEqual({ index, error: null });
    expect({ index, changes: shipped.changes?.[1] }).toEqual({ index, changes: 0 });
    expect({ index, runs: shipped.state.runs }).toEqual({ index, runs: before.runs });
    if ((legacy.changes?.[1] ?? 0) > 0) seen.displacedLegacyWrites++;
  }
  // The generator reaches every case the proof is about.
  expect(seen.holders).toBeGreaterThan(50);
  expect(seen.holderWrites).toBeGreaterThan(5);
  expect(seen.displaced).toBeGreaterThan(50);
  expect(seen.displacedLegacyWrites).toBeGreaterThan(5);
}, 60_000);

test("on a scaled store the fenced statement answers as the shipped one for a lease holder", async () => {
  const next = random(0x5ca1ed);
  let compared = 0;
  for (let index = 0; index < 8; index++) {
    const { seed, target } = randomStore(next, 150);
    // The writer holds the lease here: the scaled store is about equality.
    seed.jobs = seed.jobs.map((job) => ({
      ...job,
      status: "running",
      token: TOKEN,
      leaseUntil: LIVE,
    }));
    compared++;
    expect({ index, ...(await publish(seed, target, false)) }).toEqual({
      index,
      ...(await publish(seed, target, true)),
    });
  }
  expect(compared).toBe(8);
}, 60_000);

test("without table statistics the fence adds only the lease lookup the first statement already makes", () => {
  const db = fullCoreDatabase();
  const input = inputFor({
    id: 1,
    artifact: 1,
    parser: PARSER,
    version: "1.0.0",
    status: "pending",
    supersededBy: null,
    candidate: false,
  });
  const shipped = preparedStatements();
  publishBatch(shipped.db, input);
  const legacy = preparedStatements();
  legacySupersedeOlderSuccesses(legacy.db, input.parseId, input.artifactId, input.parserName);
  const fenced = planOf(db, shipped.prepared[1]!);
  const unfenced = planOf(db, legacy.prepared[0]!);
  const first = planOf(db, shipped.prepared[0]!);
  // Everything the unfenced statement did, it still does the same way.
  for (const step of unfenced) expect(fenced).toContain(step);
  // The fence is one uncorrelated subquery, evaluated once per statement
  // rather than once per row, through the index the first statement uses.
  const added = fenced.filter((step) => !unfenced.includes(step));
  expect(added).toEqual([
    expect.stringMatching(/^SCALAR SUBQUERY \d+$/u),
    "SEARCH observation_parse_jobs USING INDEX observation_jobs_ready (status=?)",
  ]);
  expect(first).toContain(added[1]!);
  // No base table is read end to end that was not before.
  expect(tableScans(db, shipped.prepared[1]!, fenced)).toEqual(
    tableScans(db, legacy.prepared[0]!, unfenced),
  );
  db.close();
});
