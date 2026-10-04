import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { alarmCollection } from "./worker";
import type { ScheduledResult } from "../../../packages/collection/src/schedule-result";
export class ScheduledCollection extends WorkerEntrypoint<Env> {
  async runScheduled(cron: string, scheduledTime: number): Promise<ScheduledResult> {
    if (
      !["15 21 * * *"].includes(cron) ||
      !Number.isSafeInteger(scheduledTime) ||
      scheduledTime < 0
    )
      return { status: "failed", runIds: [], failureCode: "invalid_schedule" };
    return alarmCollection(this.env, cron, scheduledTime);
  }
}
export default worker;
