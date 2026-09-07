import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ACCOUNT_ID, QUEUE_NAME, CONFIRMATION } from "./r2-reconciler-notifications";
import { weeklyRepairSeeds } from "../src/reconciler";

const wrangler = resolve(import.meta.dirname, "../node_modules/wrangler/bin/wrangler.js");
const mode = process.argv[2] ?? "status";
const auth = spawnSync(process.execPath, [wrangler, "auth", "token", "--json"], {
  encoding: "utf8",
});
if (auth.status !== 0) throw new Error("authentication failed");
const credential = JSON.parse(auth.stdout);
if (!credential.token || !["oauth", "api_token"].includes(credential.type))
  throw new Error("unsupported authentication");
async function api(path: string, body?: unknown) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const value = (await response.json()) as any;
  if (!response.ok || value.success !== true)
    throw new Error(
      `API failed status=${response.status} codes=${JSON.stringify(value.errors?.map((e: any) => e.code))}`,
    );
  return value.result;
}
const queues = await api("queues?per_page=100");
const managed = [QUEUE_NAME, `${QUEUE_NAME}-dlq`].map((name) => {
  const matches = queues.filter((q: any) => q.queue_name === name);
  if (matches.length !== 1) throw new Error("queue identity ambiguous");
  return matches[0];
});
if (mode === "seed") {
  if (process.argv[3] !== CONFIRMATION) throw new Error("explicit confirmation argument required");
  const seeds = weeklyRepairSeeds();
  if (seeds.length !== 12) throw new Error("unexpected seed count");
  await api(`queues/${managed[0].queue_id}/messages/batch`, {
    messages: seeds.map((body) => ({ body, content_type: "json" })),
  });
  console.log(
    JSON.stringify({
      operation: "seed",
      accepted: seeds.length,
      sources: seeds.map((s) => s.source),
    }),
  );
} else if (mode === "status") {
  const schedules = await api("workers/scripts/kogane-collector-r2-importer/schedules");
  console.log(
    JSON.stringify({
      checkedAt: new Date().toISOString(),
      operation: "schedules",
      crons: schedules.schedules?.map((item: any) => item.cron),
    }),
  );
  for (const queue of managed) {
    const detail = await api(`queues/${queue.queue_id}`);
    const metrics = await api(`queues/${queue.queue_id}/metrics`);
    console.log(
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        queue: queue.queue_name,
        id: queue.queue_id,
        consumers: detail.consumers?.map((consumer: any) => ({
          type: consumer.type,
          script: consumer.script,
          settings: consumer.settings,
          dead_letter_queue: consumer.dead_letter_queue,
        })),
        producers: detail.producers?.length,
        settings: detail.settings,
        metrics: {
          backlog_count: metrics.backlog_count,
          backlog_bytes: metrics.backlog_bytes,
          oldest_message_timestamp_ms: metrics.oldest_message_timestamp_ms,
        },
      }),
    );
  }
} else if (mode === "watch") {
  const duration = Number(process.argv[3] ?? 180);
  if (!Number.isInteger(duration) || duration < 10 || duration > 900)
    throw new Error("duration must be 10..900 seconds");
  const counts: Record<string, number> = {};
  let buffer = "";
  let events = 0;
  let stopped = false;
  let tailFailed = false;
  const child = spawn(
    process.execPath,
    [wrangler, "tail", "kogane-collector-r2-importer", "--format", "json"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.on("error", () => {
    tailFailed = true;
  });
  child.on("exit", () => {
    if (!stopped) tailFailed = true;
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let boundary;
    while ((boundary = buffer.indexOf("\n}")) >= 0) {
      const raw = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2).trimStart();
      try {
        const event = JSON.parse(raw.slice(raw.indexOf("{")));
        events++;
        for (const log of event.logs ?? [])
          for (const message of log.message ?? []) {
            try {
              const entry = typeof message === "string" ? JSON.parse(message) : message;
              if (entry?.event !== "r2-outbox-reconciler") continue;
              const values = [
                entry.lifecycle,
                entry.kind,
                entry.source ?? "none",
                entry.outcome,
                String(entry.attempts),
              ];
              if (!values.every((v) => typeof v === "string" && /^[a-z0-9_-]{1,100}$/.test(v)))
                continue;
              const key = values.join(":");
              counts[key] = (counts[key] ?? 0) + 1;
            } catch {}
          }
      } catch {}
    }
    if (buffer.length > 2000000) buffer = "";
  });
  child.stderr.resume();
  const report = () =>
    console.log(
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        operation: "watch",
        events,
        tailFailed,
        counts,
      }),
    );
  const interval = setInterval(report, 30000);
  await new Promise<void>((done) =>
    setTimeout(() => {
      stopped = true;
      child.kill("SIGTERM");
      done();
    }, duration * 1000),
  );
  clearInterval(interval);
  report();
  if (tailFailed) process.exitCode = 1;
} else throw new Error("usage: status|seed [confirmation]|watch [seconds]");
