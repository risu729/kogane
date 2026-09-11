import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository checkout these helpers belong to. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Tracked files matching the given pathspecs, relative to REPO_ROOT and sorted. */
export function trackedFiles(...patterns: string[]): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", ...patterns], { cwd: REPO_ROOT });
  if (result.exitCode !== 0) throw new Error("git ls-files failed");
  return result.stdout.toString().split("\0").filter(Boolean).sort();
}
