// Unit tests for the trusted release decisions (U14, acceptance G5-11, G5-12,
// G5-16, G5-17). The workflow wiring and the live Cloudflare upload cannot be
// proven offline; everything the release refuses on is decided by the pure
// modules under tasks/_lib/ci and is decided here — the ledger interlock
// against a real git history in a temporary repository, and the manifest
// against a fixture tree.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  appliedMigrations,
  buildManifest,
  bundleDigest,
  canonicalJson,
  isMigrationPrefix,
  manifestDifferences,
  migrationsDirectory,
  releaseRecord,
  requiredSecretNames,
  sameMigrations,
} from "../tasks/_lib/ci/release-manifest.mjs";
import {
  decideRelease,
  describeRecord,
  gitIsAncestor,
  isReleaseRecord,
  latestRelease,
  normalizeRecord,
  readLedger,
  recordedWorkerShas,
  releaseProgress,
  undeployedWorkers,
} from "../tasks/_lib/ci/release-ledger.mjs";

const temporary: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

function write(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** A linear main (a → b → c) plus a commit on a branch that left after `a`. */
function historyFixture(): { root: string; a: string; b: string; c: string; side: string } {
  const root = temporaryDirectory("kogane-history-");
  git(root, "init", "--quiet", "--initial-branch=main");
  const commit = (message: string): string => {
    write(root, "file.txt", `${message}\n`);
    git(root, "add", "file.txt");
    git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "--message", message);
    return git(root, "rev-parse", "HEAD");
  };
  const a = commit("a");
  const b = commit("b");
  const c = commit("c");
  git(root, "checkout", "--quiet", "-b", "side", a);
  const side = commit("side");
  git(root, "checkout", "--quiet", "main");
  return { root, a, b, c, side };
}

/** The deployable Workers, as `infra/deploy-order.json` names them. */
const DEPLOYABLE = [
  { name: "processor", worker: "kogane-observation-pipeline" },
  { name: "app", worker: "kogane-evidence-browser" },
  { name: "ingest", worker: "kogane-ingest" },
];

/** A v2 record: the named Workers at `sha`, the others absent. */
function ledgerRecord(sha: string, names: readonly string[]): Record<string, unknown> {
  return {
    manifestVersion: "release-manifest-v2",
    mode: "release",
    sha,
    coreMigrations: ["0001_a.sql"],
    readMigrations: null,
    workers: names.map((name) => ({
      name,
      worker: DEPLOYABLE.find((worker) => worker.name === name)?.worker ?? name,
      sha,
      outcome: "planned",
    })),
  };
}

describe("the release ledger interlock (G5-12)", () => {
  const history = historyFixture();
  const isAncestor = (a: string, b: string): boolean => gitIsAncestor(a, b, history.root);
  const decide = (
    head: string,
    recorded: string | null,
    previous: unknown = null,
  ): ReturnType<typeof decideRelease> =>
    decideRelease({
      mode: "release",
      head,
      recorded,
      previous,
      deployable: DEPLOYABLE,
      isAncestor,
    });

  test("git ancestry is read, not guessed", () => {
    expect(isAncestor(history.a, history.c)).toBe(true);
    expect(isAncestor(history.c, history.a)).toBe(false);
    expect(isAncestor(history.c, history.c)).toBe(true);
    expect(isAncestor(history.side, history.c)).toBe(false);
  });

  test("an unknown commit is an error, never an answer", () => {
    expect(() => isAncestor("0".repeat(40), history.c)).toThrow();
  });

  test("the first release deploys every deployable Worker", () => {
    const decision = decide(history.c, null);
    expect(decision).toMatchObject({ proceed: true, fail: false });
    expect(decision.selected).toEqual(["processor", "app", "ingest"]);
  });

  test("a newer commit moves every Worker forward", () => {
    const decision = decide(
      history.c,
      history.a,
      ledgerRecord(history.a, ["processor", "app", "ingest"]),
    );
    expect(decision).toMatchObject({ proceed: true, fail: false });
    expect(decision.selected).toEqual(["processor", "app", "ingest"]);
    expect(decision.kept).toEqual([]);
  });

  test("a record that covers every Worker at this commit means nothing to do", () => {
    const decision = decide(
      history.c,
      history.c,
      ledgerRecord(history.c, ["processor", "app", "ingest"]),
    );
    expect(decision).toMatchObject({ proceed: false, fail: false });
    expect(decision.selected).toEqual([]);
    expect(decision.reason).toContain("nothing to do");
  });

  test("a partial record of the same commit is resumed, not skipped (finding 2)", () => {
    // The bug this replaces: a run that deployed one Worker recorded the whole
    // commit as released, so the next run of the same commit reported "nothing
    // to do" and the other Workers stayed behind for good.
    const decision = decide(history.c, history.c, ledgerRecord(history.c, ["processor"]));
    expect(decision).toMatchObject({ proceed: true, fail: false });
    expect(decision.selected).toEqual(["app", "ingest"]);
    expect(decision.kept).toEqual([{ name: "processor", sha: history.c }]);
    expect(decision.notes.join(" ")).toContain("already at");
  });

  test("a record with no Worker in it at all deploys everything", () => {
    // What a failed release leaves once its record is ignored, and what the
    // very first enable looks like when a previous attempt recorded nothing.
    const decision = decide(history.c, history.b, ledgerRecord(history.b, []));
    expect(decision.selected).toEqual(["processor", "app", "ingest"]);
  });

  test("an overtaken run deploys nothing when the newer release is complete", () => {
    // The point of the interlock: a run that started earlier must not overwrite
    // the newer release that finished first (plan 11 §3).
    const decision = decide(
      history.a,
      history.c,
      ledgerRecord(history.c, ["processor", "app", "ingest"]),
    );
    expect(decision.proceed).toBe(false);
    expect(decision.fail).toBe(false);
    expect(decision.reason).toContain("older");
  });

  test("an overtaken run still finishes what the newer release never deployed", () => {
    const decision = decide(history.a, history.c, ledgerRecord(history.c, ["processor"]));
    expect(decision).toMatchObject({ proceed: true, fail: false });
    // Never backwards: `processor` is at a descendant of this commit and is
    // left alone; the two the ledger cannot account for are deployed.
    expect(decision.selected).toEqual(["app", "ingest"]);
    expect(decision.kept).toEqual([{ name: "processor", sha: history.c }]);
    expect(decision.notes.join(" ")).toContain("left alone");
  });

  test("a diverged history fails loudly", () => {
    const decision = decide(history.side, history.c, ledgerRecord(history.c, ["processor"]));
    expect(decision).toMatchObject({ proceed: false, fail: true });
  });

  test("a release refuses a subset", () => {
    const decision = decideRelease({
      mode: "release",
      head: history.c,
      recorded: null,
      deployable: DEPLOYABLE,
      targets: ["ingest"],
      isAncestor,
    });
    expect(decision).toMatchObject({ proceed: false, fail: true });
    expect(decision.reason).toContain("rollback");
  });

  test("an unknown target is refused in either mode", () => {
    for (const mode of ["release", "rollback"] as const) {
      expect(
        decideRelease({
          mode,
          head: history.a,
          recorded: history.c,
          deployable: DEPLOYABLE,
          targets: ["nope"],
          isAncestor,
        }),
      ).toMatchObject({ proceed: false, fail: true });
    }
  });
});

describe("records of either version are understood", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);

  test("a v1 record puts every Worker it names at the record's own commit", () => {
    const v1 = {
      manifestVersion: "release-manifest-v1",
      sha,
      coreMigrations: ["0001_a.sql"],
      readMigrations: null,
      workers: ["kogane-observation-pipeline", "kogane-ingest"],
    };
    expect([...recordedWorkerShas(v1, DEPLOYABLE)]).toEqual([
      ["processor", sha],
      ["ingest", sha],
    ]);
  });

  test("a v2 record keeps each Worker's own commit", () => {
    const v2 = {
      sha,
      workers: [
        { name: "processor", worker: "kogane-observation-pipeline", sha, outcome: "planned" },
        { name: "app", worker: "kogane-evidence-browser", sha: other, outcome: "kept" },
      ],
    };
    expect([...recordedWorkerShas(v2, DEPLOYABLE)]).toEqual([
      ["processor", sha],
      ["app", other],
    ]);
  });

  test("a kept Worker with no recorded commit stays unrecorded", () => {
    // A rollback that leaves a never-released Worker alone writes it as `kept`
    // with an empty sha. Reading that back as "at the record's commit" would
    // let a later run of that commit skip a Worker nothing ever deployed.
    const record = {
      manifestVersion: "release-manifest-v2",
      sha,
      workers: [
        { name: "processor", worker: "kogane-observation-pipeline", sha, outcome: "planned" },
        { name: "ingest", worker: "kogane-ingest", sha: "", outcome: "kept" },
      ],
    };
    expect([...recordedWorkerShas(record, DEPLOYABLE)]).toEqual([["processor", sha]]);
    expect(normalizeRecord(record)?.workers[1]?.sha).toBe("");
  });

  test("a Worker the ledger no longer deploys is ignored, and a missing record is empty", () => {
    expect([...recordedWorkerShas(ledgerRecord(sha, []), DEPLOYABLE)]).toEqual([]);
    expect([...recordedWorkerShas({ sha, workers: ["kogane-gone"] }, DEPLOYABLE)]).toEqual([]);
    expect([...recordedWorkerShas(null, DEPLOYABLE)]).toEqual([]);
    expect(normalizeRecord(null)).toBeNull();
  });

  test("a record describes itself for the log", () => {
    const lines = describeRecord(ledgerRecord(sha, ["processor"])).join("\n");
    expect(lines).toContain(sha);
    expect(lines).toContain("0001_a.sql");
    expect(lines).toContain("processor: planned");
    expect(describeRecord(null)).toEqual(["(no release record)"]);
  });
});

describe("the rollback interlock (G5-16)", () => {
  const history = historyFixture();
  const isAncestor = (a: string, b: string): boolean => gitIsAncestor(a, b, history.root);

  test("a rollback to an ancestor of the live release proceeds", () => {
    const decision = decideRelease({
      mode: "rollback",
      head: history.a,
      recorded: history.c,
      previous: ledgerRecord(history.c, ["processor", "app", "ingest"]),
      deployable: DEPLOYABLE,
      isAncestor,
    });
    expect(decision).toMatchObject({ proceed: true, fail: false });
    expect(decision.selected).toEqual(["processor", "app", "ingest"]);
  });

  test("a rollback with targets rolls back those Workers and keeps the rest", () => {
    const decision = decideRelease({
      mode: "rollback",
      head: history.a,
      recorded: history.c,
      previous: ledgerRecord(history.c, ["processor", "app", "ingest"]),
      deployable: DEPLOYABLE,
      targets: ["ingest"],
      isAncestor,
    });
    expect(decision.selected).toEqual(["ingest"]);
    expect(decision.kept).toEqual([
      { name: "processor", sha: history.c },
      { name: "app", sha: history.c },
    ]);
  });

  test("a rollback forward is refused", () => {
    const decision = decideRelease({
      mode: "rollback",
      head: history.c,
      recorded: history.a,
      previous: ledgerRecord(history.a, ["processor", "app", "ingest"]),
      deployable: DEPLOYABLE,
      isAncestor,
    });
    expect(decision).toMatchObject({ proceed: false, fail: true });
    expect(decision.reason).toContain("roll forward");
  });

  test("a rollback is judged per target, against the commit each Worker is recorded at", () => {
    // After `ingest` was rolled back to `a`, the recorded release's own sha is
    // `a` while the other Workers are still at `c`. Rolling `processor` back
    // to `b`, or to `a`, is a real rollback for that Worker and must not be
    // refused because the deployment-level sha happens to be older.
    const afterIngestRollback = {
      ...ledgerRecord(history.a, ["ingest"]),
      workers: [
        {
          name: "processor",
          worker: "kogane-observation-pipeline",
          sha: history.c,
          outcome: "kept",
        },
        { name: "app", worker: "kogane-evidence-browser", sha: history.c, outcome: "kept" },
        { name: "ingest", worker: "kogane-ingest", sha: history.a, outcome: "planned" },
      ],
    };
    const toB = decideRelease({
      mode: "rollback",
      head: history.b,
      recorded: history.a,
      previous: afterIngestRollback,
      deployable: DEPLOYABLE,
      targets: ["processor"],
      isAncestor,
    });
    expect(toB).toMatchObject({ proceed: true, fail: false, selected: ["processor"] });
    expect(toB.kept).toEqual([
      { name: "app", sha: history.c },
      { name: "ingest", sha: history.a },
    ]);
    // `ingest` is already at `a`: left alone, not refused and not re-uploaded.
    const everythingToA = decideRelease({
      mode: "rollback",
      head: history.a,
      recorded: history.a,
      previous: afterIngestRollback,
      deployable: DEPLOYABLE,
      isAncestor,
    });
    expect(everythingToA).toMatchObject({ proceed: true, fail: false });
    expect(everythingToA.selected).toEqual(["processor", "app"]);
    expect(everythingToA.kept).toEqual([{ name: "ingest", sha: history.a }]);
    // Rolling `ingest` "back" to `b` would move it forward: refused.
    expect(
      decideRelease({
        mode: "rollback",
        head: history.b,
        recorded: history.a,
        previous: afterIngestRollback,
        deployable: DEPLOYABLE,
        targets: ["ingest"],
        isAncestor,
      }),
    ).toMatchObject({ proceed: false, fail: true });
  });

  test("a rollback whose every target is already there has nothing to do", () => {
    const decision = decideRelease({
      mode: "rollback",
      head: history.a,
      recorded: history.a,
      previous: ledgerRecord(history.a, ["processor", "app", "ingest"]),
      deployable: DEPLOYABLE,
      isAncestor,
    });
    expect(decision).toMatchObject({ proceed: false, fail: false, selected: [] });
    expect(decision.reason).toContain("nothing to do");
  });

  test("a target no successful release ever recorded cannot be rolled back", () => {
    // Nothing says what that Worker is running, so a "rollback" to any commit
    // could be a roll forward; a release is the path that records it.
    const decision = decideRelease({
      mode: "rollback",
      head: history.a,
      recorded: history.c,
      previous: ledgerRecord(history.c, ["processor", "app"]),
      deployable: DEPLOYABLE,
      targets: ["ingest"],
      isAncestor,
    });
    expect(decision).toMatchObject({ proceed: false, fail: true });
    expect(decision.reason).toContain("ingest");
  });

  test("a rollback with nothing recorded is refused", () => {
    expect(
      decideRelease({
        mode: "rollback",
        head: history.a,
        recorded: null,
        deployable: DEPLOYABLE,
        isAncestor,
      }),
    ).toMatchObject({ proceed: false, fail: true });
  });

  test("the target's migrations must be a prefix of the deployed ones", () => {
    expect(isMigrationPrefix(["0001.sql"], ["0001.sql", "0002.sql"])).toBe(true);
    expect(isMigrationPrefix(["0001.sql", "0002.sql"], ["0001.sql", "0002.sql"])).toBe(true);
    expect(isMigrationPrefix(["0001.sql", "0002.sql"], ["0001.sql"])).toBe(false);
    expect(isMigrationPrefix(["0001.sql"], ["0000.sql", "0001.sql"])).toBe(false);
  });

  test("a changed migration list is recognised", () => {
    expect(sameMigrations(["a"], ["a"])).toBe(true);
    expect(sameMigrations(["a"], ["a", "b"])).toBe(false);
  });

  test("a rollback's record keeps the migrations the database holds", () => {
    // Deployed [1, 2, 3], rolled back to a commit that knows [1, 2]: the
    // database still holds 3, so the record must say so, or a later rollback to
    // the commit that added 3 would be refused against a list it is not a
    // prefix of.
    const previous = { coreMigrations: ["1", "2", "3"], readMigrations: null };
    const current = { coreMigrations: ["1", "2"], readMigrations: null };
    expect(appliedMigrations({ mode: "rollback", current, previous })).toEqual(previous);
    expect(appliedMigrations({ mode: "release", current, previous })).toEqual(current);
    expect(appliedMigrations({ mode: "rollback", current, previous: null })).toEqual(current);
    expect(isMigrationPrefix(["1", "2", "3"], previous.coreMigrations)).toBe(true);
  });
});

describe("the recorded release is read from the Deployments API", () => {
  const client = {
    apiUrl: "https://api.example.invalid",
    owner: "o",
    repo: "r",
    token: "t",
  };

  function fetchStub(
    routes: Record<string, unknown>,
    headersFor: (route: string) => Headers = () => new Headers(),
  ): (url: string) => Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    text: () => Promise<string>;
    headers: Headers;
  }> {
    return (url: string) => {
      const key = [...Object.keys(routes)].find((route) => url.includes(route));
      if (key === undefined) throw new Error(`unexpected request ${url}`);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(JSON.stringify(routes[key])),
        headers: headersFor(key),
      });
    };
  }

  test("the newest deployment whose latest status is success wins", async () => {
    const fetchImpl = fetchStub({
      "/deployments?": [
        {
          id: 2,
          sha: "b".repeat(40),
          created_at: "2026-09-11T10:00:00Z",
          payload: { manifestVersion: "release-manifest-v2", sha: "b" },
        },
        {
          id: 1,
          sha: "a".repeat(40),
          created_at: "2026-09-10T10:00:00Z",
          payload: { manifestVersion: "release-manifest-v2", sha: "a" },
        },
      ],
      "/deployments/2/statuses": [
        { state: "in_progress", created_at: "2026-09-11T10:01:00Z" },
        { state: "failure", created_at: "2026-09-11T10:02:00Z" },
      ],
      "/deployments/1/statuses": [
        { state: "in_progress", created_at: "2026-09-10T10:01:00Z" },
        { state: "success", created_at: "2026-09-10T10:05:00Z" },
      ],
    }) as unknown as typeof fetch;
    const release = await latestRelease(client, { fetchImpl });
    expect(release).toMatchObject({ id: 1, sha: "a".repeat(40) });
    expect(release?.record).toEqual({ manifestVersion: "release-manifest-v2", sha: "a" });
  });

  test("no successful deployment means no recorded release", async () => {
    const fetchImpl = fetchStub({ "/deployments?": [] }) as unknown as typeof fetch;
    expect(await latestRelease(client, { fetchImpl })).toBeNull();
  });

  test("a newer deployment that failed is reported separately, never as the state", async () => {
    // It is not the environment's state — but it ran, so its record says what
    // it may have applied, which is what the release job prints (finding 2).
    const fetchImpl = fetchStub({
      "/deployments?": [
        {
          id: 3,
          sha: "c".repeat(40),
          created_at: "2026-09-11T12:00:00Z",
          payload: { manifestVersion: "release-manifest-v2", sha: "c" },
        },
        {
          id: 1,
          sha: "a".repeat(40),
          created_at: "2026-09-10T10:00:00Z",
          payload: { manifestVersion: "release-manifest-v2", sha: "a" },
        },
      ],
      "/deployments/3/statuses": [{ state: "failure", created_at: "2026-09-11T12:05:00Z" }],
      "/deployments/1/statuses": [{ state: "success", created_at: "2026-09-10T10:05:00Z" }],
    }) as unknown as typeof fetch;
    const ledger = await readLedger(client, { fetchImpl });
    expect(ledger.release).toMatchObject({ id: 1, sha: "a".repeat(40) });
    expect(ledger.attempts).toEqual([
      {
        id: 3,
        sha: "c".repeat(40),
        state: "failure",
        record: { manifestVersion: "release-manifest-v2", sha: "c" },
      },
    ]);
  });

  test("GitHub's own environment deployment is not a release record", async () => {
    // A job that declares `environment: production` opens one of these, with an
    // empty payload, and closes it with the job's result. A release job that
    // decided it had nothing to do therefore leaves a *successful* production
    // deployment that names no Worker; reading it as the ledger would hide the
    // real record behind it (finding 2).
    const fetchImpl = fetchStub({
      "/deployments?": [
        { id: 5, sha: "c".repeat(40), created_at: "2026-09-11T12:00:00Z", payload: {} },
        {
          id: 4,
          sha: "a".repeat(40),
          created_at: "2026-09-10T10:00:00Z",
          payload: { manifestVersion: "release-manifest-v2", sha: "a".repeat(40), workers: [] },
        },
      ],
      "/deployments/5/statuses": [{ state: "success", created_at: "2026-09-11T12:05:00Z" }],
      "/deployments/4/statuses": [{ state: "success", created_at: "2026-09-10T10:05:00Z" }],
    }) as unknown as typeof fetch;
    const ledger = await readLedger(client, { fetchImpl });
    expect(ledger.release).toMatchObject({ id: 4 });
    expect(ledger.attempts).toEqual([]);
    expect(isReleaseRecord({})).toBe(false);
    expect(isReleaseRecord(null)).toBe(false);
    expect(isReleaseRecord([{ manifestVersion: "release-manifest-v2" }])).toBe(false);
    expect(isReleaseRecord({ manifestVersion: "release-manifest-v1" })).toBe(true);
  });

  test("a page of failures with more pages behind it is an error, not an empty ledger", async () => {
    const fetchImpl = fetchStub(
      {
        "/deployments?": [
          {
            id: 9,
            sha: "c".repeat(40),
            created_at: "2026-09-11T10:00:00Z",
            payload: { manifestVersion: "release-manifest-v2", sha: "c".repeat(40) },
          },
        ],
        "/deployments/9/statuses": [{ state: "failure", created_at: "2026-09-11T10:02:00Z" }],
      },
      (route) =>
        new Headers(
          route === "/deployments?"
            ? { link: '<https://api.example.invalid/repos/o/r/deployments?page=2>; rel="next"' }
            : {},
        ),
    ) as unknown as typeof fetch;
    await expect(latestRelease(client, { fetchImpl })).rejects.toThrow(/goes on/u);
  });
});

/** A minimal repository the manifest can be computed over. */
function manifestFixture(): string {
  const root = temporaryDirectory("kogane-manifest-");
  write(root, "bun.lock", '{"lockfileVersion":1}\n');
  write(root, "packages/parsers/src/parsers/digests.ts", "export const PARSER_DIGESTS = {};\n");
  write(
    root,
    "services/processor/wrangler.jsonc",
    [
      "{",
      "  // the migrations directory the release reads from the config",
      '  "name": "kogane-processor",',
      '  "d1_databases": [',
      "    {",
      '      "binding": "DB",',
      '      "database_name": "kogane-core",',
      '      "migrations_dir": "../store/migrations",',
      "    },",
      "  ],",
      "}",
      "",
    ].join("\n"),
  );
  write(root, "services/store/migrations/0001_first.sql", "select 1;\n");
  write(root, "services/store/migrations/0002_second.sql", "select 2;\n");
  write(root, "services/store/migrations/notes.md", "ignored\n");
  write(root, "dist/processor/worker.js", "export default {};\n");
  write(root, "dist/processor/worker.js.map", "{ machine specific }\n");
  write(
    root,
    "infra/deploy-order.json",
    `${JSON.stringify(
      {
        workersDevSubdomain: "example.workers.dev",
        schema: {
          core: {
            database: "kogane-core",
            binding: "DB",
            path: "services/processor",
            config: "wrangler.jsonc",
          },
          read: null,
        },
        workers: [
          {
            name: "processor",
            path: "services/processor",
            config: "wrangler.jsonc",
            worker: "kogane-processor",
            role: "consumer",
            deploy: true,
            healthPath: "",
            bundleTask: "processor:bundle",
            bundleDir: "dist/processor",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    "infra/resources.json",
    `${JSON.stringify(
      {
        directories: [
          {
            directory: "services/processor",
            workers: [
              {
                config: "services/processor/wrangler.jsonc",
                requiredSecretNames: ["SECOND_TOKEN", "FIRST_TOKEN"],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

const SHA = "f".repeat(40);

describe("the release manifest (G5-11)", () => {
  const root = manifestFixture();

  test("the migrations directory comes from the Wrangler configuration", () => {
    // Unified plan D3: the directory moves in U05 and no workflow changes with
    // it, because both Wrangler and this script read the same field.
    expect(
      migrationsDirectory(root, {
        database: "kogane-core",
        binding: "DB",
        path: "services/processor",
        config: "wrangler.jsonc",
      }),
    ).toBe(join(root, "services/store/migrations"));
  });

  test("a configuration that binds another database is refused", () => {
    expect(() =>
      migrationsDirectory(root, {
        database: "kogane-other",
        binding: "DB",
        path: "services/processor",
        config: "wrangler.jsonc",
      }),
    ).toThrow(/not kogane-other/u);
  });

  test("it is byte-identical over the same tree", () => {
    expect(canonicalJson(buildManifest({ root, sha: SHA }))).toBe(
      canonicalJson(buildManifest({ root, sha: SHA })),
    );
  });

  test("it records the migration files in order, without the notes beside them", () => {
    const manifest = buildManifest({ root, sha: SHA });
    expect(manifest.migrations.core.files.map((entry) => entry.file)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
    expect(manifest.migrations.read).toBeNull();
  });

  test("it records secret names, never values (G5-17)", () => {
    const manifest = buildManifest({ root, sha: SHA });
    expect(manifest.requiredSecretNames).toEqual([
      { worker: "kogane-processor", names: ["FIRST_TOKEN", "SECOND_TOKEN"] },
    ]);
    expect(
      requiredSecretNames({ directories: [] }, [{ path: "a", config: "b", worker: "kogane-x" }]),
    ).toEqual([{ worker: "kogane-x", names: [] }]);
  });

  test("the bundle digest covers the modules and not the source maps", () => {
    const before = bundleDigest(join(root, "dist/processor"));
    writeFileSync(join(root, "dist/processor/worker.js.map"), "{ other machine }\n");
    expect(bundleDigest(join(root, "dist/processor"))).toBe(before);
    writeFileSync(join(root, "dist/processor/worker.js"), "export default { changed: true };\n");
    expect(bundleDigest(join(root, "dist/processor"))).not.toBe(before);
  });

  test("a changed input is reported by name, so the deployment stops", () => {
    const manifest = buildManifest({ root, sha: SHA });
    expect(manifestDifferences(manifest, buildManifest({ root, sha: SHA }))).toEqual([]);
    writeFileSync(join(root, "bun.lock"), '{"lockfileVersion":2}\n');
    expect(manifestDifferences(manifest, buildManifest({ root, sha: SHA }))).toEqual(["lock"]);
    writeFileSync(join(root, "services/store/migrations/0003_third.sql"), "select 3;\n");
    expect(manifestDifferences(manifest, buildManifest({ root, sha: SHA }))).toEqual([
      "lock",
      "migrations",
    ]);
  });

  test("the deployment payload stays small and carries what the next run needs", () => {
    const manifest = buildManifest({ root, sha: SHA });
    const record = releaseRecord(manifest, { runId: "7", runUrl: "https://example.invalid/7" });
    expect(record).toMatchObject({
      sha: SHA,
      coreDatabase: "kogane-core",
      coreMigrations: ["0001_first.sql", "0002_second.sql", "0003_third.sql"],
      readMigrations: null,
      runId: "7",
    });
    // One entry per deployable Worker, each with the commit it is at: without
    // that, a partial release records the whole commit as live and the next run
    // of the same commit skips the Workers it never deployed (finding 2).
    expect(record.workers).toEqual([
      {
        name: "processor",
        worker: "kogane-processor",
        config: "services/processor/wrangler.jsonc",
        sha: SHA,
        outcome: "planned",
      },
    ]);
    expect(String(record.manifestSha256)).toMatch(/^[0-9a-f]{64}$/u);
    expect(canonicalJson(record).length).toBeLessThan(4000);
  });

  test("a plan decides which Workers the record claims and which it leaves alone", () => {
    const manifest = buildManifest({ root, sha: SHA });
    const kept = releaseRecord(manifest, {
      plan: { selected: [], kept: [{ name: "processor", sha: "e".repeat(40) }] },
    });
    expect(kept.workers).toEqual([
      expect.objectContaining({ name: "processor", sha: "e".repeat(40), outcome: "kept" }),
    ]);
    // A Worker that was never recorded and is not being deployed has no commit
    // to claim, and the record says so rather than guessing this one.
    const unknown = releaseRecord(manifest, { plan: { selected: [], kept: [] } });
    expect(unknown.workers).toEqual([
      expect.objectContaining({ name: "processor", sha: "", outcome: "kept" }),
    ]);
  });
});

describe("what a run actually did (finding 2)", () => {
  const root = manifestFixture();
  const manifest = buildManifest({ root, sha: SHA });
  const record = releaseRecord(manifest, { runId: "7", runUrl: "https://example.invalid/7" });

  test("a successful upload is recorded with the Action's deployment targets", () => {
    const progress = releaseProgress(record, {
      "migrate-core": { outcome: "success" },
      "deploy-processor": {
        outcome: "success",
        outputs: { "deployment-targets": '["kogane-processor"]' },
      },
    });
    expect(progress.workers).toEqual([
      expect.objectContaining({
        name: "processor",
        outcome: "deployed",
        targets: '["kogane-processor"]',
      }),
    ]);
    expect(progress.summary).toContain("1/1 deployed");
    expect(progress.summary).toContain("CORE migrations done");
  });

  test("a failed upload, a skipped one and one that was never reached are distinguished", () => {
    const failed = releaseProgress(record, { "deploy-processor": { outcome: "failure" } });
    expect(failed.workers).toEqual([expect.objectContaining({ outcome: "failed" })]);
    expect(failed.summary).toContain("failed: processor");
    const skipped = releaseProgress(record, { "deploy-processor": { outcome: "skipped" } });
    expect(skipped.workers).toEqual([expect.objectContaining({ outcome: "skipped" })]);
    // No step of that name in the context at all: the run stopped before it.
    const stopped = releaseProgress(record, {});
    expect(stopped.workers).toEqual([expect.objectContaining({ outcome: "not reached" })]);
    expect(stopped.migrations).toMatchObject({
      core: { database: "kogane-core", step: "not reached" },
      read: null,
    });
  });

  test("a success status is refused while any planned Worker is not deployed", () => {
    // The workflow's `success()` condition is what normally prevents this; the
    // status writer checks the progress record too, so a rewiring of the steps
    // can never record a run that skipped or failed a Worker as the state.
    const failed = releaseProgress(record, { "deploy-processor": { outcome: "failure" } });
    expect(undeployedWorkers(failed)).toEqual(["processor: failed"]);
    const skipped = releaseProgress(record, { "deploy-processor": { outcome: "skipped" } });
    expect(undeployedWorkers(skipped)).toEqual(["processor: skipped"]);
    expect(undeployedWorkers(releaseProgress(record, {}))).toEqual(["processor: not reached"]);
    const deployed = releaseProgress(record, { "deploy-processor": { outcome: "success" } });
    expect(undeployedWorkers(deployed)).toEqual([]);
    const kept = releaseRecord(manifest, {
      plan: { selected: [], kept: [{ name: "processor", sha: "e".repeat(40) }] },
    });
    expect(undeployedWorkers(releaseProgress(kept, {}))).toEqual([]);
  });

  test("a Worker the run left alone keeps its recorded commit and outcome", () => {
    const kept = releaseRecord(manifest, {
      plan: { selected: [], kept: [{ name: "processor", sha: "e".repeat(40) }] },
    });
    expect(releaseProgress(kept, {}).workers).toEqual([
      expect.objectContaining({ outcome: "kept", sha: "e".repeat(40) }),
    ]);
    expect(String(releaseProgress(kept, {}).summary)).toContain("0/0 deployed");
  });
});
