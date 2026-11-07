// The trusted release helpers decide whether they are the program being run by
// comparing their own module path with `process.argv[1]`. Node resolves the
// main module through symlinks but leaves `argv[1]` as typed, so a comparison
// of the two raw paths is false when the helper is started through a symlinked
// directory: the helper then skips its whole command and exits 0, a silent
// no-op that a release step reads as success.
//
// Each helper is started here through a symlink with arguments and an
// environment it must refuse before any network or file write (no command, no
// credentials, no runner directories), so a passing guard shows as exit 1.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, trackedFiles } from "./repo-root.ts";

const scratch = mkdtempSync(join(tmpdir(), "kogane entrypoints "));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const linked = join(scratch, "linked ci");
symlinkSync(join(REPO_ROOT, "tasks/_lib/ci"), linked, "dir");

const HELPERS = [
  "alarm-bootstrap.mjs",
  "cf-container-release.mjs",
  "cf-do-identity.mjs",
  "container-preflight.mjs",
  "release-health.mjs",
  "release-ledger.mjs",
  "release-manifest.mjs",
  "release-resume.mjs",
  "release-sha.mjs",
] as const;

function run(path: string) {
  return spawnSync("node", [path], {
    cwd: REPO_ROOT,
    // Nothing that could reach GitHub or Cloudflare: no token, no account.
    env: { PATH: process.env.PATH ?? "", HOME: scratch },
    encoding: "utf8",
    timeout: 30_000,
  });
}

test.each(HELPERS)("%s runs its command when started through a symlink", (helper) => {
  const direct = run(join(REPO_ROOT, "tasks/_lib/ci", helper));
  expect(direct.status).toBe(1);
  const viaLink = run(join(linked, helper));
  // The same refusal, not a silent success.
  expect({ status: viaLink.status, stderr: viaLink.stderr !== "" }).toEqual({
    status: 1,
    stderr: true,
  });
});

test("every command-line helper is covered", () => {
  const withEntrypoint = trackedFiles("tasks/_lib/ci/*.mjs")
    .filter((file) => readFileSync(join(REPO_ROOT, file), "utf8").includes("process.argv[1]"))
    .map((file) => file.slice("tasks/_lib/ci/".length));
  expect(withEntrypoint).toEqual([...HELPERS]);
});
