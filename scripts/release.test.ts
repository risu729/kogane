// Unit tests for the trusted release decisions (U14, acceptance G5-11, G5-12,
// G5-16, G5-17). The workflow wiring and the live Cloudflare upload cannot be
// proven offline; everything the release refuses on is decided by the pure
// modules under .github/scripts and is decided here — the ledger interlock
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
} from "../.github/scripts/release-manifest.mjs";
import { decideRelease, gitIsAncestor, latestRelease } from "../.github/scripts/release-ledger.mjs";

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

describe("the release ledger interlock (G5-12)", () => {
  const history = historyFixture();
  const isAncestor = (a: string, b: string): boolean => gitIsAncestor(a, b, history.root);

  test("git ancestry is read, not guessed", () => {
    expect(isAncestor(history.a, history.c)).toBe(true);
    expect(isAncestor(history.c, history.a)).toBe(false);
    expect(isAncestor(history.c, history.c)).toBe(true);
    expect(isAncestor(history.side, history.c)).toBe(false);
  });

  test("an unknown commit is an error, never an answer", () => {
    expect(() => isAncestor("0".repeat(40), history.c)).toThrow();
  });

  test("the first release proceeds", () => {
    const decision = decideRelease({
      mode: "release",
      head: history.c,
      recorded: null,
      isAncestor,
    });
    expect(decision).toMatchObject({ proceed: true, fail: false });
  });

  test("a newer commit moves the release forward", () => {
    expect(
      decideRelease({ mode: "release", head: history.c, recorded: history.a, isAncestor }),
    ).toMatchObject({ proceed: true, fail: false });
  });

  test("an overtaken run deploys nothing and still succeeds", () => {
    // The point of the interlock: a run that started earlier must not overwrite
    // the newer release that finished first (plan 11 §3).
    const decision = decideRelease({
      mode: "release",
      head: history.a,
      recorded: history.c,
      isAncestor,
    });
    expect(decision.proceed).toBe(false);
    expect(decision.fail).toBe(false);
    expect(decision.reason).toContain("older");
  });

  test("re-running the recorded commit changes nothing", () => {
    const decision = decideRelease({
      mode: "release",
      head: history.c,
      recorded: history.c,
      isAncestor,
    });
    expect(decision).toMatchObject({ proceed: false, fail: false });
  });

  test("a diverged history fails loudly", () => {
    const decision = decideRelease({
      mode: "release",
      head: history.side,
      recorded: history.c,
      isAncestor,
    });
    expect(decision).toMatchObject({ proceed: false, fail: true });
  });
});

describe("the rollback interlock (G5-16)", () => {
  const history = historyFixture();
  const isAncestor = (a: string, b: string): boolean => gitIsAncestor(a, b, history.root);

  test("a rollback to an ancestor of the live release proceeds", () => {
    expect(
      decideRelease({ mode: "rollback", head: history.a, recorded: history.c, isAncestor }),
    ).toMatchObject({ proceed: true, fail: false });
  });

  test("a rollback forward is refused", () => {
    expect(
      decideRelease({ mode: "rollback", head: history.c, recorded: history.a, isAncestor }),
    ).toMatchObject({ proceed: false, fail: true });
  });

  test("a rollback with nothing recorded is refused", () => {
    expect(
      decideRelease({ mode: "rollback", head: history.a, recorded: null, isAncestor }),
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
        { id: 2, sha: "b".repeat(40), created_at: "2026-09-11T10:00:00Z", payload: { sha: "b" } },
        { id: 1, sha: "a".repeat(40), created_at: "2026-09-10T10:00:00Z", payload: { sha: "a" } },
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
    expect(release?.record).toEqual({ sha: "a" });
  });

  test("no successful deployment means no recorded release", async () => {
    const fetchImpl = fetchStub({ "/deployments?": [] }) as unknown as typeof fetch;
    expect(await latestRelease(client, { fetchImpl })).toBeNull();
  });

  test("a page of failures with more pages behind it is an error, not an empty ledger", async () => {
    const fetchImpl = fetchStub(
      {
        "/deployments?": [{ id: 9, sha: "c".repeat(40), created_at: "2026-09-11T10:00:00Z" }],
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
      coreMigrations: ["0001_first.sql", "0002_second.sql", "0003_third.sql"],
      readMigrations: null,
      workers: ["kogane-processor"],
      runId: "7",
    });
    expect(String(record.manifestSha256)).toMatch(/^[0-9a-f]{64}$/u);
    expect(canonicalJson(record).length).toBeLessThan(2000);
  });
});
