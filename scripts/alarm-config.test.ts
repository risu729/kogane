import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import jobs from "../config/alarm-jobs.json";
import research from "../config/maintenance-research.json";
import { validPattern, validMaintenance } from "../packages/collection/src/schedule-model";
import { parseJsonc } from "./jsonc";
describe("alarm activation configuration", () => {
  test("all 14 prior jobs are preserved, manual/email sources stay disabled", () => {
    expect(jobs.filter((j) => j.enabled)).toHaveLength(14);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(17);
    for (const job of jobs) {
      expect(validPattern(job.pattern)).toBe(true);
      if (!job.supported) expect(job.enabled).toBe(false);
      if (job.workspace) {
        const config = parseJsonc(
          readFileSync(`services/${job.workspace}/wrangler.jsonc`, "utf8"),
        ) as { triggers: { crons: string[] }; name: string };
        expect(config.triggers.crons).toEqual([]);
        expect(config.name).toBe(job.worker);
      }
    }
    expect(jobs.find((j) => j.id === "prestia-bank")).toMatchObject({
      enabled: false,
      supported: true,
      pattern: { time: "06:30" },
    });
    expect(jobs.find((j) => j.id === "st-george")?.pattern).toMatchObject({ time: "06:35" });
  });
  test("migration seeds exactly the reviewed jobs and provenance without arming", () => {
    const db = new Database(":memory:");
    db.exec(readFileSync("packages/storage-d1/migrations/core/0065_alarm_schedules.sql", "utf8"));
    db.exec(
      "CREATE TABLE dataset_snapshot_policies (source_id TEXT,dataset TEXT,parser_name TEXT,policy_id TEXT,required_parser_version TEXT,replaces_previous_on_complete_empty INTEGER,unit_scope TEXT)",
    );
    db.exec(
      readFileSync(
        "packages/storage-d1/migrations/core/0066_prestia_bank_snapshot_schedule.sql",
        "utf8",
      ),
    );
    const seeded = db
      .query(
        "SELECT id,pattern_json,enabled,next_nominal_at,next_run_at FROM collection_schedules ORDER BY id",
      )
      .all() as {
      id: string;
      pattern_json: string;
      enabled: number;
      next_nominal_at: null;
      next_run_at: null;
    }[];
    expect(seeded.map((s) => s.id)).toEqual(jobs.map((j) => j.id).sort());
    for (const row of seeded) {
      const job = jobs.find((j) => j.id === row.id)!;
      expect(JSON.parse(row.pattern_json)).toEqual(job.pattern);
      expect(row.enabled).toBe(Number(job.enabled));
      expect(row.next_nominal_at).toBeNull();
      expect(row.next_run_at).toBeNull();
    }
    const rules = db
      .query("SELECT id,pattern_json,reference_url FROM provider_maintenance_rules")
      .all() as { id: string; pattern_json: string; reference_url: string }[];
    expect(rules).toHaveLength(research.rules.length);
    for (const r of rules) {
      expect(validMaintenance(JSON.parse(r.pattern_json))).toBe(true);
      expect(r.reference_url).toBe(research.rules.find((s) => s.id === r.id)?.referenceUrl);
    }
    db.close();
  });
  test("research distinguishes unrelated maintenance and absent public rules", () => {
    expect(research.references.find((r) => r.source === "moneyforward-me")?.status).toBe(
      "not-found",
    );
    expect(research.references.find((r) => r.source === "sbi-shinsei")?.status).toBe(
      "no-applicable-rule",
    );
    expect(research.rules.find((r) => r.id === "globalpass-members")?.pattern).toEqual({
      kind: "monthly",
      weekday: 6,
      nth: 3,
      offsetDays: 1,
      start: "01:00",
      end: "05:00",
    });
    expect(
      research.rules.some(
        (r) =>
          r.source === "sbi-securities" &&
          r.pattern.kind === "weekly" &&
          r.pattern.start === "23:00",
      ),
    ).toBe(false);
  });
});
