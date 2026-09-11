// G0-02: the CORE migrations moved directory, not content. The move is the one
// time a migration file may change path (unified plan 09 §2, decision D3); the
// filenames, the numbers and the bytes are immutable, because D1 keeps the
// applied history by filename and re-applying a rewritten 0001 would be a
// different database.
//
// Two independent checks, so neither can quietly pass alone:
//
//   * every recorded file is present, every number is unique and ascending,
//     and the digest of each recorded file equals the value below, which was
//     taken from `git show <ref>:services/raw-evidence/migrations/<name>` at
//     the commit named beside it;
//   * when that commit is reachable in this checkout (it is in a full clone; a
//     shallow CI checkout may not have it), the same bytes are read back out
//     of git and compared again, so the table cannot drift away from what
//     history holds. The refs are commit ids, not branch names: a branch
//     moves on and stops holding the old path, a commit does not.
//
// A migration that lands after this table was written may exist beyond it
// (numbers above every recorded one, following the naming rule); once it is
// on main, record its digest here so a later edit is caught.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CORE_MIGRATIONS_URL,
  MIGRATION_FILENAME,
  READ_MIGRATIONS_URL,
  migrationNumber,
} from "../src/migrations.ts";

/** Where git holds the bytes of a recorded file: the last commit that carried
 * it at the old path, before the directory moved (or, for a later number, the
 * commit that added it there before this move was merged). */
interface HistoricalSource {
  ref: string;
  directory: string;
}

/** The commit before the move: the parent of the `git mv` commit. */
const BEFORE_MOVE: HistoricalSource = {
  ref: "e5372d6",
  directory: "services/raw-evidence/migrations",
};

/** 0040 landed on main at the old path while this move was in review (U06). */
const OPERATIONS_API: HistoricalSource = {
  ref: "3bb3a5e",
  directory: "services/raw-evidence/migrations",
};

/** 0038 was written at the old path while this move was in review (U10), and
 * git relocated it with the rest of the directory. */
const SOURCE_REVISION: HistoricalSource = {
  ref: "38c7f51",
  directory: "services/raw-evidence/migrations",
};

/**
 * Migrations written straight into `packages/storage-d1/migrations/core/`,
 * after the move. They have no bytes at the old path, so the history check
 * has nothing to compare for them; the digest table below is their only
 * anchor, and it still catches a later edit.
 */
const INTRODUCED_AT_THE_NEW_PATH = new Set(["0039_collection_runs.sql"]);

/** sha256 of every CORE migration as `services/raw-evidence/migrations/` held it. */
const CORE_DIGESTS: Record<string, string> = {
  "0001_initial.sql": "0dbb5f288be06b8cadff9e37708eb35628e6dbbf7a39ee9af7686ad6c40c3aae",
  "0002_registry.sql": "48bb99573af85c83a2c33e850f3ac14188ab647e236341d69a5bf3de431a35f6",
  "0003_runtime_contract.sql": "a59840153f2992e4b927f1750ce675e30cc3ad2bcf375167e9751073d9c73713",
  "0004_exclude_synthetic_view.sql":
    "599c14291e3b8ec8b3c454a94ea1e9824489b2191e27bada7931ca9a28b6cf4c",
  "0005_sbi_securities_collector_r2.sql":
    "1f581ada6801840cb17e4cce3f98947980d0cc219f7a323dad2108a8c421a222",
  "0006_sbi_vc_trade_collector_r2.sql":
    "c464ff505568f17e3447620f54de4b4b1f3c32eb86ea80277efd2cb5e66670f4",
  "0007_sony_bank_collector_r2.sql":
    "1d3d3637d7711c9137b8df828ff503d867656e5aff54aba913803b19bcddadd3",
  "0008_sbi_shinsei_collector_r2.sql":
    "b60b86bc0600e1eda22bd1fade4ac72263b10f8bbe6c65316a635c44960623d0",
  "0009_mobile_suica_collector_r2.sql":
    "b79553b9a29edcb815208aa539d00a4ed61339c870872209cf44ac16f7a348b6",
  "0010_global_pass_collector_r2.sql":
    "ab3c2dd55745e33bd340ceded226c68762c2f3150fb63f98c278b0dde515d979",
  "0011_myjcb_collector_r2.sql": "41173e5eb7b7c16cd8fba171e7a87a2c7c3472a3ab332ae2c368d22188bc49d1",
  "0012_v_point_collector_r2.sql":
    "aaee0e8c2eee4e35f105b40c5e2b907962a956742f6574a38765b9abdf7342fd",
  "0013_vpass_collector_r2.sql": "ac9ed6947486c4f5b518add4572bde72cde96eda029518958ba18e9b284779b5",
  "0014_moneyforward_collector_r2.sql":
    "b4d8788acbf9e514ee8fbe8f83917712e350810afa87c5fc1aae160e29bdbf27",
  "0015_v_point_pay_email_collector_r2.sql":
    "5000a010c2662851fe5bb686cc4f808e1b46c71a57120fc4d781712abc9cee50",
  "0016_smbc_direct_collector_r2.sql":
    "96a68ce49e273e4a86c2fc13aca995dfd898be38f44e0ed6479498c25bd25ed0",
  "0017_observation_pipeline.sql":
    "119518c2e75962b7e4aa4e01e57626e6dba69c970dd0d3673a6e7ee074c5f330",
  "0018_identity.sql": "f25c98e8478e89e8c9f0f8bbb5ef97cc8c6990607e40d00ce17a490d763a39bb",
  "0019_identity_seal_provenance.sql":
    "24ff47e2c3f36faeae49395b058fc9e7b0e5bc989ff88db22153852a66ee8768",
  "0020_vpass_identity_binding.sql":
    "6447c09c872d8faf74d4d1b0a1755a4e3df79cf516edb8c846448b7478f675c9",
  "0021_vpass_binding_lookup_plan.sql":
    "14d5e81f4958f82fd59d98f126c25e8094c50b1e079ff4b4b9f51b8e4f1eb9ae",
  "0022_identity_current_run_plan.sql":
    "fef0f12683221530f3dcf202b5d521ab4cad043f9a59941c810a66b7920e8805",
  "0023_account_connections.sql":
    "90fa9cffe3c8b2b881028542bc35902206976a7c0e9a4ee03acf5d7982a6d122",
  "0024_observation_decimals.sql":
    "6a84267f6800381f9a6f1afd212fd45a9f777b4abc1fe74dae5fb38006396724",
  "0025_parse_coverage.sql": "dc911ab1890f408f4d8d591a76008c9d6ddc7fb2525c761e0c63d2d57c292a93",
  "0026_publication_gate.sql": "4d2e50570ad57641d99fef57a0cc666822c35e1395c10de3bb285e85610ddc53",
  "0027_metadata_projections.sql":
    "23a869d2e5ef7c4882836285c4cc4ed9aade705def1d23c43436168064b68ee1",
  "0028_parse_releases.sql": "60e85f43b65b20dd7f1957ae22b75885869a8c1f457ba1edf13f9358c94771a9",
  "0029_decision_log.sql": "3bea85c105d7b7a7ce609bb7bdeee37e83ec65ece0efa5fda17a3d9496806b8e",
  "0030_balance_read_model.sql": "fffebe5e2973ae7a173e9d9d44005a74ccc6ffcf9d5f600093acbe0bbbbe9cf1",
  "0031_operations.sql": "fe73a1a44a03f9b19cd3abee30780ca02b1e30517aa143f678212c964534e2a8",
  "0032_economic_events.sql": "372bd0f8533b6be1e10bc4b9e3aa180f44ab806bf361091b52aa5d33a3294e49",
  "0033_reward_buckets.sql": "c05ed0a5d278550c8f54c883018493c5e1f554460167433be80e204aff80aadd",
  "0034_reports.sql": "3bb7f6aaf6bf57ec99c0ea13028a5ed9dbcc185bf836942c6003e3e772d8b29f",
  "0035_observation_job_lanes.sql":
    "16abe13cc0869ae2effd01a32526a6e638c661e59ee9d0880e3cd5ee27a7943d",
  "0036_publication_event_guard.sql":
    "0f56c0fb0ed45b9ab689725bc7a02a5fa6d1839a99cd1791227f68c1d8ac0f25",
  "0037_unit_scope_eligibility.sql":
    "9cb89c077a066a32968403169e4197582580e1af638fc97747ebda11faa82634",
  "0038_source_revision.sql": "803f41c024792e46e259212558fa71e49b4caeb2c9e2632dbfee7e8540359b48",
  "0039_collection_runs.sql": "3472b423845147a610c2051e7b3233a2bc73f7c399774e5b0ab5b2b741bdc8b8",
  "0040_operations_api.sql": "edca64e3fc1675e463faec3b04ca90cde3ed2055269b483ee56c99f28e519002",
};

/** Which commit holds each recorded file's original bytes, or null when the
 * file was never at the old path. */
function sourceOf(name: string): HistoricalSource | null {
  if (INTRODUCED_AT_THE_NEW_PATH.has(name)) return null;
  const number = migrationNumber(name) ?? 0;
  if (number <= 37) return BEFORE_MOVE;
  return number === 38 ? SOURCE_REVISION : OPERATIONS_API;
}

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function coreFiles(): string[] {
  return readdirSync(fileURLToPath(CORE_MIGRATIONS_URL)).sort();
}

function digest(bytes: Uint8Array | string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

/** The blob git holds at `<ref>:<path>`, or null when the ref is unreachable. */
function blobAt(ref: string, path: string): Uint8Array | null {
  const result = Bun.spawnSync(["git", "show", `${ref}:${path}`], { cwd: REPO_ROOT });
  return result.exitCode === 0 ? new Uint8Array(result.stdout) : null;
}

describe("CORE migrations (G0-02)", () => {
  test("the directory holds every recorded file, numbered uniquely and in order", () => {
    const files = coreFiles();
    expect(files.every((name) => MIGRATION_FILENAME.test(name))).toBe(true);
    const numbers = files.map((name) => migrationNumber(name) as number);
    // Unique and ascending: wrangler applies by number, and two files sharing
    // one would be applied in an order nobody chose.
    expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
    // 0001…0037 are the contiguous moved set; nothing may be missing from it.
    expect(numbers.slice(0, 37)).toEqual(Array.from({ length: 37 }, (_, index) => index + 1));
    const recorded = Object.keys(CORE_DIGESTS).sort();
    expect(files.filter((name) => name in CORE_DIGESTS)).toEqual(recorded);
    // Anything beyond the table is a later, additive migration.
    const last = Math.max(...recorded.map((name) => migrationNumber(name) as number));
    expect(
      files
        .filter((name) => !(name in CORE_DIGESTS))
        .every((name) => (migrationNumber(name) as number) > last),
    ).toBe(true);
  });

  test("every recorded file still has the bytes this table recorded", () => {
    const actual: Record<string, string> = {};
    for (const name of Object.keys(CORE_DIGESTS)) {
      actual[name] = digest(readFileSync(new URL(name, CORE_MIGRATIONS_URL)));
    }
    expect(actual).toEqual(CORE_DIGESTS);
  });

  test("the recorded digests are the bytes git history holds at the old path", () => {
    // A shallow checkout may not have the pre-move commits; then this check
    // has nothing to compare and the digest table above still stands on its
    // own. When a commit is reachable, every file it should hold must match.
    const historical: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const [name, recorded] of Object.entries(CORE_DIGESTS)) {
      const source = sourceOf(name);
      if (source === null) continue;
      if (blobAt(source.ref, `${source.directory}/0001_initial.sql`) === null) continue;
      const bytes = blobAt(source.ref, `${source.directory}/${name}`);
      expected[name] = recorded;
      historical[name] = bytes === null ? "missing from history" : digest(bytes);
    }
    expect(historical).toEqual(expected);
  });

  test("the READ directory holds its own baseline, under the same naming rule", () => {
    // U11 filled it. The READ database is built from its final schema rather
    // than migrated forward from CORE, so it starts at 0001 and shares nothing
    // with the numbers above; the two directories are never applied to the
    // same database (06 §2).
    const entries = readdirSync(fileURLToPath(READ_MIGRATIONS_URL));
    expect(entries.filter((name) => MIGRATION_FILENAME.test(name))).toEqual([
      "0001_read_baseline.sql",
    ]);
    expect(entries).toContain("README.md");
  });
});
