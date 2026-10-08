import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { alarmCollection } from "./worker";
import type { ScheduledResult } from "../../../packages/collection/src/schedule-result";
import { runCollectorOperation } from "../../../packages/collection/src/operation-rpc";
export class ScheduledCollection extends WorkerEntrypoint<Env> {
  async runScheduled(cron: string, scheduledTime: number): Promise<ScheduledResult> {
    if (
      !["35 21 * * *"].includes(cron) ||
      !Number.isSafeInteger(scheduledTime) ||
      scheduledTime < 0
    )
      return { status: "failed", runIds: [], failureCode: "invalid_schedule" };
    return alarmCollection(this.env, cron, scheduledTime);
  }
  /**
   * One accepted operations-API request for this collector's connection
   * (ADR 0048): checked against the closed connection table, then run exactly
   * as the connection's alarm runs it, under the same execution lease.
   */
  async runOperation(request: unknown): Promise<ScheduledResult> {
    return runCollectorOperation(request, "collector-st-george", (cron, time) =>
      this.runScheduled(cron, time),
    );
  }
}
export default worker;
export { StGeorgeCollectorContainer, StGeorgeCollectionState } from "./worker";
