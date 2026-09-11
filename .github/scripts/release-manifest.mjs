// The release manifest of one production deployment (unified plan 11 §2).
//
// CD deploys the exact commit CI passed on, and the pinned Wrangler deploy
// Action re-bundles the Worker rather than uploading a prebuilt artefact. There
// is therefore no way to assert "the live script is byte-identical to the bundle
// that was tested": the Workers API exposes a version id, an author and a
// source, not a content digest of the uploaded script (`wrangler versions
// list|view`). What CD *can* prove is that nothing changed between the build it
// measured and the upload it performed, so this script
//
//   * records, for one commit, the digest of every input that decides what the
//     deployment contains — the root lockfile, every Wrangler configuration,
//     the CORE (and later READ) migration files, the parser build identity, the
//     emitted bundles, and the *names* of the secrets each Worker needs;
//   * re-computes that record immediately before the first upload and refuses
//     the deployment when it no longer matches (acceptance G5-11);
//   * derives a small release record that is attached to the GitHub deployment
//     as its payload, so the next run can compare schema state without
//     downloading an artefact (acceptance G5-12, G5-16).
//
// The manifest never contains a secret value — only secret names, which are
// already in `infra/resources.json` (acceptance G5-17).
//
// Run with node; the only import is the repository's own JSONC reader, so that
// `migrations_dir` is read from the same Wrangler configuration `wrangler d1
// migrations apply` reads (unified plan D3: the directory moves in U05 and no
// workflow or script changes with it).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../../scripts/jsonc.ts";

export const MANIFEST_VERSION = "release-manifest-v1";

/** Relative path of the file that carries the parser build identity. */
export const PARSER_DIGESTS_PATH = "packages/parsers/src/parsers/digests.ts";

/**
 * @param {import("node:crypto").BinaryLike} data
 * @returns {string}
 */
export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * JSON with the keys of every object sorted, so that two runs over the same
 * inputs produce the same bytes and a diff names the field that moved.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  const sort = (input) => {
    if (Array.isArray(input)) return input.map(sort);
    if (input === null || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, sort(input[key])]),
    );
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/**
 * Every file below `directory`, as paths relative to it, sorted.
 *
 * @param {string} directory
 * @returns {string[]}
 */
export function listFiles(directory) {
  const found = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const next = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), next);
      else found.push(next);
    }
  };
  walk(directory, "");
  return found.sort();
}

/**
 * Digest of the deployable bytes of one emitted bundle.
 *
 * Only the JavaScript modules count. The source maps that `--outdir` writes
 * alongside them carry absolute paths of the machine that produced them, and
 * Wrangler does not upload them, so including them would make the digest differ
 * between a developer's checkout and the runner for no gain.
 *
 * @param {string} directory
 * @returns {string}
 */
export function bundleDigest(directory) {
  const files = listFiles(directory).filter((file) => file.endsWith(".js"));
  if (files.length === 0) throw new Error(`${directory} holds no bundled module`);
  return sha256(
    files.map((file) => `${file} ${sha256(readFileSync(join(directory, file)))}\n`).join(""),
  );
}

/**
 * The migrations directory a Wrangler configuration declares for one binding,
 * resolved the way Wrangler resolves it: relative to the configuration file.
 *
 * @param {string} root
 * @param {{path: string, config: string, binding: string, database: string}} schema
 * @returns {string}
 */
export function migrationsDirectory(root, schema) {
  const relativeConfig = `${schema.path}/${schema.config}`;
  const config = parseJsonc(readFileSync(join(root, relativeConfig), "utf8"), relativeConfig);
  const databases = Array.isArray(config?.d1_databases) ? config.d1_databases : [];
  const entry = databases.find((candidate) => candidate?.binding === schema.binding);
  if (!entry) throw new Error(`${relativeConfig} declares no D1 binding ${schema.binding}`);
  if (entry.database_name !== schema.database) {
    throw new Error(
      `${relativeConfig} binds ${schema.binding} to ${String(entry.database_name)}, not ${schema.database}`,
    );
  }
  if (typeof entry.migrations_dir !== "string" || entry.migrations_dir === "") {
    throw new Error(`${relativeConfig} sets no migrations_dir for ${schema.binding}`);
  }
  return resolve(join(root, schema.path), entry.migrations_dir);
}

/**
 * The migration files of one database, in the order Wrangler applies them.
 *
 * @param {string} root
 * @param {{path: string, config: string, binding: string, database: string} | null | undefined} schema
 * @returns {{database: string, directory: string, files: {file: string, sha256: string}[]} | null}
 */
export function migrationList(root, schema) {
  if (schema === null || schema === undefined) return null;
  const directory = migrationsDirectory(root, schema);
  const files = listFiles(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return {
    database: schema.database,
    directory: directory.slice(root.endsWith("/") ? root.length : root.length + 1),
    files: files.map((file) => ({ file, sha256: sha256(readFileSync(join(directory, file))) })),
  };
}

/**
 * The secret names each deployed Worker expects to already exist in Cloudflare.
 * CD never writes a secret; it only records what the deployment depends on.
 *
 * @param {unknown} resources
 * @param {readonly {path: string, config: string, worker: string}[]} workers
 * @returns {{worker: string, names: string[]}[]}
 */
export function requiredSecretNames(resources, workers) {
  const byConfig = new Map();
  for (const directory of resources?.directories ?? []) {
    for (const worker of directory?.workers ?? []) {
      byConfig.set(worker.config, worker.requiredSecretNames ?? []);
    }
  }
  return workers.map((worker) => ({
    worker: worker.worker,
    names: [...(byConfig.get(`${worker.path}/${worker.config}`) ?? [])].sort(),
  }));
}

/**
 * @param {{root: string, sha: string, bundles?: boolean}} options
 * @returns {Record<string, unknown>}
 */
export function buildManifest({ root, sha, bundles = true }) {
  const order = JSON.parse(readFileSync(join(root, "infra/deploy-order.json"), "utf8"));
  const resources = JSON.parse(readFileSync(join(root, "infra/resources.json"), "utf8"));
  const deployed = order.workers.filter((worker) => worker.deploy === true);
  return {
    manifestVersion: MANIFEST_VERSION,
    sha,
    lock: { path: "bun.lock", sha256: sha256(readFileSync(join(root, "bun.lock"))) },
    parsers: {
      path: PARSER_DIGESTS_PATH,
      sha256: sha256(readFileSync(join(root, PARSER_DIGESTS_PATH))),
    },
    configs: order.workers.map((worker) => ({
      path: `${worker.path}/${worker.config}`,
      sha256: sha256(readFileSync(join(root, worker.path, worker.config))),
    })),
    migrations: {
      core: migrationList(root, order.schema?.core),
      read: migrationList(root, order.schema?.read),
    },
    bundles: bundles
      ? deployed.map((worker) => ({
          name: worker.name,
          directory: worker.bundleDir,
          sha256: bundleDigest(join(root, worker.bundleDir)),
        }))
      : [],
    workers: deployed.map((worker) => ({
      name: worker.name,
      worker: worker.worker,
      path: worker.path,
      config: worker.config,
      role: worker.role,
      healthPath: worker.healthPath,
    })),
    requiredSecretNames: requiredSecretNames(resources, deployed),
  };
}

/**
 * The compact record attached to the GitHub deployment as its payload. It holds
 * what the *next* run needs to decide without fetching an artefact: which
 * commit is live, which migrations the database holds once this deployment is
 * done (see `appliedMigrations`), and where to look.
 *
 * @param {Record<string, any>} manifest
 * @param {{runId?: string, runUrl?: string, mode?: string}} context
 * @returns {Record<string, unknown>}
 */
export function releaseRecord(manifest, { runId = "", runUrl = "", mode = "release" } = {}) {
  return {
    manifestVersion: MANIFEST_VERSION,
    mode,
    sha: manifest.sha,
    manifestSha256: sha256(canonicalJson(manifest)),
    coreMigrations: manifest.migrations.core?.files.map((entry) => entry.file) ?? [],
    readMigrations: manifest.migrations.read?.files.map((entry) => entry.file) ?? null,
    workers: manifest.workers.map((worker) => worker.worker),
    runId,
    runUrl,
  };
}

/**
 * The migration lists the release record carries, which are the ones the
 * database holds after this deployment — not the ones the commit knows.
 *
 * A release applies this commit's migrations, so the two are the same. A
 * rollback applies none: the database keeps every migration the recorded
 * release had, so the record must keep that list too. Otherwise the next
 * rollback would be compared against the *older* commit's shorter list and
 * refused, and the next release would re-apply nothing anyway (Wrangler skips
 * applied migrations) but could not tell the two apart.
 *
 * @param {{mode: string, current: {coreMigrations: readonly string[], readMigrations: readonly string[] | null}, previous: {coreMigrations?: readonly string[], readMigrations?: readonly string[] | null} | null}} input
 * @returns {{coreMigrations: readonly string[], readMigrations: readonly string[] | null}}
 */
export function appliedMigrations({ mode, current, previous }) {
  if (mode !== "rollback" || previous === null) {
    return { coreMigrations: current.coreMigrations, readMigrations: current.readMigrations };
  }
  return {
    coreMigrations: previous.coreMigrations ?? [],
    readMigrations: previous.readMigrations ?? null,
  };
}

/**
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 * @returns {boolean}
 */
export function sameMigrations(a, b) {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * Whether `target` is a prefix of (or equal to) `deployed`.
 *
 * This is the schema-compatibility rule of a rollback (unified plan 11 §7,
 * acceptance G5-16): migrations are additive and never reverted, so a commit
 * may be re-deployed over a database that has *more* migrations applied than it
 * knows about, but never over one that is missing migrations it needs. A
 * deployed list that dropped or renamed an entry is not a prefix and is
 * refused; nothing is restored automatically.
 *
 * @param {readonly string[]} target
 * @param {readonly string[]} deployed
 * @returns {boolean}
 */
export function isMigrationPrefix(target, deployed) {
  return (
    target.length <= deployed.length && target.every((entry, index) => entry === deployed[index])
  );
}

/**
 * @param {Record<string, any>} manifest
 * @param {Record<string, any>} recomputed
 * @returns {string[]}
 */
export function manifestDifferences(manifest, recomputed) {
  const keys = [...new Set([...Object.keys(manifest), ...Object.keys(recomputed)])].sort();
  return keys.filter(
    (key) => canonicalJson(manifest[key] ?? null) !== canonicalJson(recomputed[key] ?? null),
  );
}

/**
 * @param {Record<string, string>} outputs
 * @param {Record<string, string | undefined>} env
 */
function writeOutputs(outputs, env) {
  const file = env["GITHUB_OUTPUT"];
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (file) appendFileSync(file, text);
  else process.stdout.write(text);
}

/**
 * @param {readonly string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    options[argument.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }
  return options;
}

/**
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 */
export async function main(argv, env) {
  const [command] = argv;
  const options = parseArgs(argv.slice(1));
  const root = resolve(options["root"] ?? env["GITHUB_WORKSPACE"] ?? process.cwd());
  if (command === "write") {
    const sha = options["sha"] ?? "";
    if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("--sha must be a full commit sha");
    const manifest = buildManifest({ root, sha });
    const record = releaseRecord(manifest, {
      runId: options["run-id"] ?? "",
      runUrl: options["run-url"] ?? "",
      mode: options["mode"] ?? "release",
    });
    writeFileSync(options["out"] ?? "release-manifest.json", canonicalJson(manifest));
    writeFileSync(options["record"] ?? "release-record.json", canonicalJson(record));
    writeOutputs({ "manifest-sha256": record.manifestSha256 }, env);
    return 0;
  }
  if (command === "verify") {
    const file = options["manifest"] ?? "release-manifest.json";
    const recorded = JSON.parse(readFileSync(file, "utf8"));
    const recomputed = buildManifest({ root, sha: recorded.sha });
    const differences = manifestDifferences(recorded, recomputed);
    if (differences.length > 0) {
      console.error(
        `The working tree no longer matches the release manifest: ${differences.join(", ")}. Refusing to deploy.`,
      );
      return 1;
    }
    console.log(`Release manifest verified for ${recorded.sha}.`);
    return 0;
  }
  if (command === "compare") {
    const currentFile = options["current"] ?? "release-record.json";
    const current = JSON.parse(readFileSync(currentFile, "utf8"));
    const previousFile = options["previous"] ?? "";
    const previous =
      previousFile === "" || !existsSync(previousFile)
        ? null
        : JSON.parse(readFileSync(previousFile, "utf8"));
    const previousCore = previous?.coreMigrations ?? [];
    const previousRead = previous?.readMigrations ?? [];
    const mode = options["mode"] ?? current.mode ?? "release";
    // The record the deployment carries says what the database holds after
    // this run, which a rollback leaves as it is.
    writeFileSync(
      currentFile,
      canonicalJson({ ...current, ...appliedMigrations({ mode, current, previous }) }),
    );
    writeOutputs(
      {
        "previous-sha": previous?.sha ?? "",
        "core-changed": String(
          previous === null || !sameMigrations(current.coreMigrations, previousCore),
        ),
        // Applying is needed unless every migration this commit knows about is
        // already applied, which is exactly "the current list is a prefix of
        // the deployed one" (a rollback, or a re-run of the same commit).
        "core-apply": String(
          previous === null || !isMigrationPrefix(current.coreMigrations, previousCore),
        ),
        "read-apply": String(
          current.readMigrations !== null &&
            (previous === null || !isMigrationPrefix(current.readMigrations, previousRead ?? [])),
        ),
        "core-prefix": String(
          previous === null || isMigrationPrefix(current.coreMigrations, previousCore),
        ),
      },
      env,
    );
    return 0;
  }
  throw new Error(`Unknown command ${String(command)}`);
}

// Not `import.meta.main`: that is only defined from node 24.2, and the
// runner's preinstalled interpreter must not be able to turn a guard into a
// silent no-op.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
