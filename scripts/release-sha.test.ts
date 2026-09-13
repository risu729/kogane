// The build identity a release stamps into the Workers it deploys (U14, plan
// 11 §6). The postcheck can only ask a deployed Worker "which commit are you"
// if the answer is in its configuration, and the pinned deploy Action has no
// input for a variable — so the value is written into the runner's checkout
// before the manifest is computed. What is asserted here is everything that
// can be wrong with that: a sha that is not one, a configuration that already
// carries one, a declaration that appears twice, and — the one that matters
// for the repository itself — that the committed configurations are empty.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { RELEASE_SHA_VAR, stampConfig, stampReleaseSha } from "../tasks/_lib/ci/release-sha.mjs";
import { readDeployOrder } from "../tasks/_lib/deploy-order.ts";
import { REPO_ROOT } from "../tasks/_lib/repo-root.ts";

const SHA = "0".repeat(39) + "1";
const temporary: string[] = [];

afterAll(() => {
  for (const directory of temporary) rmSync(directory, { recursive: true, force: true });
});

/** A checkout with a ledger and the configurations it names. */
function fixture(configs: Record<string, string>, workers: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "kogane-release-sha-"));
  temporary.push(root);
  mkdirSync(join(root, "infra"), { recursive: true });
  writeFileSync(join(root, "infra/deploy-order.json"), JSON.stringify({ workers }, null, 2));
  for (const [file, text] of Object.entries(configs)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const CONFIG = (value: string) =>
  `{\n  "name": "kogane-x",\n  "vars": {\n    "OTHER": "keep",\n    "${RELEASE_SHA_VAR}": "${value}"\n  }\n}\n`;

describe("the release sha is stamped into one variable and nothing else", () => {
  test("an empty declaration becomes the sha, and the rest of the file is untouched", () => {
    const { text, stamped } = stampConfig(CONFIG(""), SHA);
    expect(stamped).toBe(true);
    expect(text).toBe(CONFIG(SHA));
  });

  test("a configuration without the variable is skipped, not rewritten", () => {
    const text = '{\n  "name": "kogane-x",\n  "vars": { "OTHER": "keep" }\n}\n';
    expect(stampConfig(text, SHA)).toEqual({ text, stamped: false });
  });

  test("re-stamping the same sha is a no-op; a different one is an error", () => {
    expect(stampConfig(CONFIG(SHA), SHA)).toEqual({ text: CONFIG(SHA), stamped: true });
    expect(() => stampConfig(CONFIG("b".repeat(40)), SHA)).toThrow("already holds");
  });

  test("two declarations are an error rather than a guess", () => {
    const text = `{\n  "vars": { "${RELEASE_SHA_VAR}": "" },\n  "env": { "a": { "vars": { "${RELEASE_SHA_VAR}": "" } } }\n}\n`;
    expect(() => stampConfig(text, SHA)).toThrow("more than once");
  });
});

describe("stamping a checkout follows the deployment ledger", () => {
  const workers = [
    {
      name: "app",
      path: "services/app",
      config: "wrangler.jsonc",
      deploy: true,
    },
    {
      name: "ingest",
      path: "services/raw-evidence",
      config: "wrangler.jsonc",
      deploy: true,
    },
    {
      name: "app-test",
      path: "services/app",
      config: "wrangler.test.jsonc",
      deploy: false,
    },
  ];

  test("every deployed configuration that declares the variable is stamped", () => {
    const root = fixture(
      {
        "services/app/wrangler.jsonc": CONFIG(""),
        "services/raw-evidence/wrangler.jsonc": '{\n  "name": "kogane-ingest"\n}\n',
        // A configuration that is not deployed is never touched, even though it
        // declares the variable.
        "services/app/wrangler.test.jsonc": CONFIG(""),
      },
      workers,
    );
    expect(stampReleaseSha({ root, sha: SHA })).toEqual({
      stamped: ["services/app/wrangler.jsonc"],
      skipped: ["services/raw-evidence/wrangler.jsonc"],
    });
    expect(readFileSync(join(root, "services/app/wrangler.jsonc"), "utf8")).toBe(CONFIG(SHA));
    expect(readFileSync(join(root, "services/app/wrangler.test.jsonc"), "utf8")).toBe(CONFIG(""));
  });

  test("a ledger where nothing declares the variable is an error", () => {
    // Otherwise a rename or a lost variable would make the postcheck compare
    // an empty build identity and quietly pass.
    const root = fixture(
      {
        "services/app/wrangler.jsonc": '{\n  "name": "kogane-x"\n}\n',
        "services/raw-evidence/wrangler.jsonc": '{\n  "name": "kogane-ingest"\n}\n',
        "services/app/wrangler.test.jsonc": CONFIG(""),
      },
      workers,
    );
    expect(() => stampReleaseSha({ root, sha: SHA })).toThrow("no deployed configuration");
  });

  test("only a full commit sha is stamped", () => {
    for (const sha of ["", "abc", "A".repeat(40), `${SHA}0`])
      expect(() => stampReleaseSha({ root: REPO_ROOT, sha, write: false })).toThrow(
        "full commit sha",
      );
  });
});

describe("the repository's own configurations carry no sha", () => {
  test("the App and the Processor declare the variable, empty", () => {
    // The postcheck's whole assertion is that the *deployed* Worker reports the
    // released commit; a sha committed to the repository would be a lie the
    // moment the next commit lands.
    for (const config of ["services/app/wrangler.jsonc", "services/processor/wrangler.jsonc"]) {
      const text = readFileSync(`${REPO_ROOT}/${config}`, "utf8");
      expect(text).toContain(`"${RELEASE_SHA_VAR}": ""`);
      expect(stampConfig(text, SHA).stamped).toBe(true);
    }
  });

  test("stamping this checkout would cover the Workers whose health reports it", () => {
    // A dry run over the real ledger: the App must be stamped, because its
    // health route is the one CD authenticates and compares (the Processor's
    // answer is relayed through it).
    const { stamped } = stampReleaseSha({ root: REPO_ROOT, sha: SHA, write: false });
    const order = readDeployOrder();
    const authenticated = order.workers.filter((worker) => worker.healthAuth === "access");
    for (const worker of authenticated)
      expect(stamped).toContain(`${worker.path}/${worker.config}`);
    expect(stamped).toContain("services/processor/wrangler.jsonc");
    // And the files on disk are still empty: `write: false` wrote nothing.
    expect(readFileSync(`${REPO_ROOT}/services/app/wrangler.jsonc`, "utf8")).toContain(
      `"${RELEASE_SHA_VAR}": ""`,
    );
  });
});
