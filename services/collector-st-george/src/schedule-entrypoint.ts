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
   * connection's alarm runs it, under the same execution lease. The request is
   * the operator's decision to try one login again, so it also clears a block
   * left by a refused or challenged login (ADR 0069, 2026-11-08 amendment).
   */
  async runOperation(request: unknown): Promise<ScheduledResult> {
    return runCollectorOperation(request, "collector-st-george", (cron, time) =>
      this.#run(cron, time, true),
    );
  }
  async #run(cron: string, scheduledTime: number, operatorRequested: boolean) {
    if (
      !["35 21 * * *"].includes(cron) ||
      !Number.isSafeInteger(scheduledTime) ||
      scheduledTime < 0
    )
      return { status: "failed" as const, runIds: [], failureCode: "invalid_schedule" };
    return alarmCollection(this.env, cron, scheduledTime, { operatorRequested });
  }
}
export default worker;
export { StGeorgeCollectorContainer, StGeorgeCollectionState } from "./worker";
