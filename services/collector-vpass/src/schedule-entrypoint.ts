import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { alarmCollection, type Env } from "./worker";
import type { ScheduledResult } from "../../../packages/collection/src/schedule-result";
import { runCollectorOperation } from "../../../packages/collection/src/operation-rpc";
import { logVpassDiagnostic, scheduledResultDiagnostic } from "./log-diagnostic";
export class ScheduledCollection extends WorkerEntrypoint<Env> {
  async runScheduled(cron: string, scheduledTime: number): Promise<ScheduledResult> {
    const startedMs = Date.now();
    const result: ScheduledResult =
      !["0 21 * * *"].includes(cron) || !Number.isSafeInteger(scheduledTime) || scheduledTime < 0
        ? { status: "failed", runIds: [], failureCode: "invalid_schedule" }
        : await alarmCollection(this.env, cron, scheduledTime);
    logVpassDiagnostic(scheduledResultDiagnostic(result, scheduledTime, Date.now() - startedMs));
    return result;
  }
  /**
   * One accepted operations-API request for this collector's connection
   * (ADR 0048): checked against the closed connection table, then run exactly
   * as the connection's alarm runs it, under the same execution lease.
   */
  async runOperation(request: unknown): Promise<ScheduledResult> {
    return runCollectorOperation(request, "collector-vpass", (cron, time) =>
      this.runScheduled(cron, time),
    );
  }
}
export default worker;
