// Stamps the released commit into the Workers that report their build identity
// (unified plan 11 §6, U14).
//
// The postcheck has to be able to ask a deployed Worker *which commit are you*,
// and a Worker can only answer that if the sha is in its configuration: there
// is no runtime source for it. The pinned deploy Action
// (`risu729/wrangler-deploy-action@v1.2.0`) exposes `mode`,
// `working-directory`, `config`, `environment`, `preview-alias`, the two
// Cloudflare credentials and `secrets-json` — no input for a variable and no
// place to add `--var` — so the value is written into the configuration in the
// runner's checkout before the release manifest is computed, and the manifest
// therefore records exactly the configuration that was uploaded.
//
// Nothing else about the configuration changes: the variable is declared in the
// repository with an empty value, this replaces that one empty string, and a
// configuration that already carries a sha is an error rather than a second
// rewrite. The repository's own files are never stamped outside a release
// (`scripts/release-sha.test.ts` asserts they are committed empty).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The variable a Worker reads its build identity from. */
export const RELEASE_SHA_VAR = "RELEASE_SHA";

/** `"RELEASE_SHA": "<anything>"` as it appears in a Wrangler JSONC file. */
const DECLARATION = /"RELEASE_SHA"(\s*):(\s*)"([0-9a-f]*)"/gu;

/**
 * One configuration's text with the sha stamped in.
 *
 * @param {string} text
 * @param {string} sha
 * @returns {{text: string, stamped: boolean}}
 */
export function stampConfig(text, sha) {
  const matches = [...text.matchAll(DECLARATION)];
  if (matches.length === 0) return { text, stamped: false };
  if (matches.length > 1) throw new Error(`${RELEASE_SHA_VAR} is declared more than once`);
  const [match] = matches;
  const current = match[3] ?? "";
  if (current !== "") {
    if (current === sha) return { text, stamped: true };
    throw new Error(`${RELEASE_SHA_VAR} already holds ${current}`);
  }
  return {
    text: text.replace(DECLARATION, `"${RELEASE_SHA_VAR}"${match[1]}:${match[2]}"${sha}"`),
    stamped: true,
  };
}

/**
 * Stamps every deployed Worker's configuration that declares the variable.
 *
 * @param {{root: string, sha: string, write?: boolean}} options
 * @returns {{stamped: string[], skipped: string[]}}
 */
export function stampReleaseSha({ root, sha, write = true }) {
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error("the release sha must be a full commit sha");
  const order = JSON.parse(readFileSync(join(root, "infra/deploy-order.json"), "utf8"));
  /** @type {string[]} */
  const stamped = [];
  /** @type {string[]} */
  const skipped = [];
  for (const worker of order.workers) {
    if (worker.deploy !== true) continue;
    const relative = `${worker.path}/${worker.config}`;
    const file = join(root, relative);
    const text = readFileSync(file, "utf8");
    let result;
    try {
      result = stampConfig(text, sha);
    } catch (error) {
      throw new Error(`${relative}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (!result.stamped) {
      skipped.push(relative);
      continue;
    }
    if (write && result.text !== text) writeFileSync(file, result.text);
    stamped.push(relative);
  }
  if (stamped.length === 0)
    throw new Error(`no deployed configuration declares ${RELEASE_SHA_VAR}`);
  return { stamped, skipped };
}

/**
 * @param {readonly string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) continue;
    options[argument.slice(2)] = argv[index + 1] ?? "";
    index += 1;
  }
  return options;
}

/**
 * @param {readonly string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {number}
 */
export function main(argv, env) {
  const options = parseArgs(argv);
  const root = resolve(options["root"] ?? env["GITHUB_WORKSPACE"] ?? process.cwd());
  const { stamped, skipped } = stampReleaseSha({ root, sha: options["sha"] ?? "" });
  console.log(`Stamped ${RELEASE_SHA_VAR} into: ${stamped.join(", ")}`);
  if (skipped.length > 0)
    console.log(`No ${RELEASE_SHA_VAR} declared (nothing stamped): ${skipped.join(", ")}`);
  return 0;
}

// Not `import.meta.main`: that is only defined from node 24.2, and the
// runner's preinstalled interpreter must not be able to turn a guard into a
// silent no-op.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
