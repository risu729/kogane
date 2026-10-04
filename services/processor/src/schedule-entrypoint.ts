import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { meteredInvocation, runScheduled } from "./worker";
export { ScheduleAlarm } from "./schedule-alarm";
export class ScheduledPipeline extends WorkerEntrypoint<Env> {
  async runTick(): Promise<void> {
    await meteredInvocation("scheduled", this.env, (env, context) =>
      runScheduled(env, undefined, undefined, context),
    );
  }
}
export default worker;
