import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { alarmCollection } from "./worker";
import type { ScheduledResult } from "../../../packages/collection/src/schedule-result";
import { runCollectorOperation } from "../../../packages/collection/src/operation-rpc";
import { FUMI_MANIFEST_JSON, sha256 } from "./fumi-offer";
import type { FumiReceipt } from "./fumi-offer";

/** Private capability: no public HTTP route delegates to this entrypoint. */
export class FumiOffer extends WorkerEntrypoint<Env> {
  async manifest(): Promise<{ json: string; sha256: string }> {
    return { json: FUMI_MANIFEST_JSON, sha256: await sha256(FUMI_MANIFEST_JSON) };
  }
  async offer(request: unknown): Promise<FumiReceipt> {
    return this.env.VPOINT_SESSION.get(this.env.VPOINT_SESSION.idFromName("primary")).fumiOffer(
      request,
    );
  }
  async receipt(request: unknown): Promise<FumiReceipt> {
    return this.env.VPOINT_SESSION.get(this.env.VPOINT_SESSION.idFromName("primary")).fumiReceipt(
      request,
    );
  }
}
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
  /**
   * One accepted operations-API request for this collector's connection
   * (ADR 0048): checked against the closed connection table, then run exactly
   * as the connection's alarm runs it, under the same execution lease.
   */
  async runOperation(request: unknown): Promise<ScheduledResult> {
    return runCollectorOperation(request, "collector-vpoint", (cron, time) =>
      this.runScheduled(cron, time),
    );
  }
}
export default worker;

export { VPointSession } from "./worker";
