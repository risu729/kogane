import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { alarmCollection } from "./worker";
import type { ScheduledResult } from "../../../packages/collection/src/schedule-result";
import { runCollectorOperation } from "../../../packages/collection/src/operation-rpc";
export class ScheduledCollection extends WorkerEntrypoint<Env> {
  async runScheduled(cron: string, scheduledTime: number): Promise<ScheduledResult> {
    return this.#run(cron, scheduledTime, false);
  }
  /**
   * One accepted operations-API request for this collector's connection
   * (ADR 0048): checked against the closed connection table, then run as the
   * connection's alarm runs it, under the same execution lease. A requested
   * session refresh is the operator's decision to log in again now: a failed
   * keepalive is followed by a passkey login without the alarm's cooldown
   * (ADR 0069, 2026-11-08 amendment).
   */
  async runOperation(request: unknown): Promise<ScheduledResult> {
    return runCollectorOperation(request, "collector-sbi-vc-trade", (cron, time, accepted) =>
      this.#run(cron, time, accepted.action === "refresh-session"),
    );
  }
  async #run(cron: string, scheduledTime: number, forceReauth: boolean) {
    if (
      !["5 21 * * *", "*/15 * * * *"].includes(cron) ||
      !Number.isSafeInteger(scheduledTime) ||
      scheduledTime < 0
    )
      return { status: "failed" as const, runIds: [], failureCode: "invalid_schedule" };
    return alarmCollection(this.env, cron, scheduledTime, { forceReauth });
  }
}
export default worker;
export { SbiVcSessionState } from "./worker";
