// Real workerd Durable Object alarms, named service RPC and ctx.exports loopback.
// Provider service is synthetic and cannot reach an external account.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import jobs from "../../../config/alarm-jobs.json";
import { LAYER_A_SQL, layerBMigrations, applyMigration } from "./harness";
import { applyReadMigrations } from "../../../packages/storage-d1/src/migrations";
let mf: Miniflare, db: D1Database, alarms: Env["SCHEDULE_ALARMS"];
beforeAll(async () => {
  const bundle = await Bun.build({
    entrypoints: [new URL("../src/schedule-entrypoint.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
  });
  if (!bundle.success) throw new Error("native_alarm_bundle_failed");
  const serviceBindings = Object.fromEntries(
    jobs
      .filter((job) => job.workspace?.startsWith("collector-"))
      .map((job) => [
        `SCHEDULE_${job.workspace!.replace("collector-", "").replaceAll("-", "_").toUpperCase()}`,
        { name: "provider", entrypoint: "ScheduledCollection" },
      ]),
  );
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "processor",
          modules: true,
          script: await bundle.outputs[0]!.text(),
          compatibilityDate: "2026-09-07",
          compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"],
          d1Databases: ["DB", "READ"],
          r2Buckets: ["EVIDENCE", "DATA"],
          bindings: { SCHEDULES_ENABLED: "true" },
          serviceBindings,
          durableObjects: { SCHEDULE_ALARMS: { className: "ScheduleAlarm", useSQLite: true } },
        },
        {
          name: "provider",
          modules: true,
          script: `import {WorkerEntrypoint} from "cloudflare:workers";let calls=0;export class ScheduledCollection extends WorkerEntrypoint {async runScheduled(cron,time) {calls++;return {status:"completed",runIds:["synthetic-native-run"],failureCode:null};}}export default {fetch(){return Response.json({calls});}};`,
          compatibilityDate: "2026-09-07",
        },
      ],
    }),
  );
  db = (await mf.getD1Database("DB", "processor")) as unknown as D1Database;
  await db.exec(LAYER_A_SQL);
  for (const name of layerBMigrations()) await applyMigration(db, name);
  await applyReadMigrations((await mf.getD1Database("READ", "processor")) as unknown as D1Database);
  await db.prepare("UPDATE collection_schedules SET enabled=0").run();
  await db
    .prepare(
      "INSERT INTO provider_maintenance_rules(id,revision,source,timezone,pattern_json,enabled,reference_url,verified_at,scope,actor,created_at) SELECT id,revision+1,source,timezone,pattern_json,0,reference_url,verified_at,scope,'synthetic','2026-01-01T00:00:00.000Z' FROM provider_maintenance_rules",
    )
    .run();
  const bindings = await mf.getBindings("processor");
  alarms = bindings["SCHEDULE_ALARMS"] as Env["SCHEDULE_ALARMS"];
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
async function completed(id: string, nominal: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = await db
      .prepare(
        "SELECT status,failure_code,run_ids_json FROM collection_schedule_occurrences WHERE schedule_id=? AND nominal_at=?",
      )
      .bind(id, nominal)
      .first<{ status: string; failure_code: string | null; run_ids_json: string }>();
    if (row?.status === "completed" || row?.status === "failed" || row?.status === "uncertain")
      return row;
    await Bun.sleep(20);
  }
  throw new Error("native_alarm_completion_deadline");
}
test("native alarm invokes the named synthetic collector once and retains a future reservation", async () => {
  const nominal = new Date(Date.now() - 120000).toISOString();
  await db
    .prepare(
      "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id='mizuho-bank'",
    )
    .bind(nominal, nominal)
    .run();
  const stub = alarms.getByName("mizuho-bank");
  await stub.reconcile("mizuho-bank");
  const row = await completed("mizuho-bank", nominal);
  expect(row.status).toBe("completed");
  expect(JSON.parse(row.run_ids_json)).toEqual(["synthetic-native-run"]);
  expect(Date.parse((await stub.alarmTime())!)).toBeGreaterThan(Date.now());
  await stub.reconcile("mizuho-bank");
  const provider = await mf.getWorker("provider");
  expect(await (await provider.fetch("https://synthetic.internal/count")).json()).toEqual({
    calls: 1,
  });
}, 10000);
test("native processor alarm uses ctx.exports and can reconcile its own object without deadlock", async () => {
  await db.prepare("UPDATE collection_schedules SET enabled=0 WHERE id='mizuho-bank'").run();
  await alarms.getByName("mizuho-bank").reconcile("mizuho-bank");
  const nominal = new Date(Date.now() - 120000).toISOString();
  await db
    .prepare(
      "UPDATE collection_schedules SET enabled=1,next_nominal_at=?,next_run_at=? WHERE id='processor-tick'",
    )
    .bind(nominal, nominal)
    .run();
  const stub = alarms.getByName("processor-tick");
  await stub.reconcile("processor-tick");
  const row = await completed("processor-tick", nominal);
  expect(row).toMatchObject({ status: "completed", failure_code: null });
  expect(Date.parse((await stub.alarmTime())!)).toBeGreaterThan(Date.now());
  const provider = await mf.getWorker("provider");
  expect(await (await provider.fetch("https://synthetic.internal/count")).json()).toEqual({
    calls: 1,
  });
}, 10000);
