import { DurableObject } from "cloudflare:workers";
import {
  ContainerController,
  type ContainerContext,
} from "../../../packages/collection/src/container-controller";
import { storageState, worker, type HarnessEnv } from "./common";
import { checkBackpressure } from "./backpressure-check";
import { checkReaderLifetime } from "./reader-lifetime-check";

export class VerificationContainer extends DurableObject<HarnessEnv> {
  private controller: ContainerController;
  private starts = 0;
  private stops = 0;
  private errors = 0;
  private signaled = 0;
  private exitSeven = 0;
  constructor(ctx: DurableObjectState, env: HarnessEnv) {
    super(ctx, env);
    const process = ctx.container;
    if (!process) throw new Error("synthetic_container_missing");
    // The real shared controller is used. Only synthetic egress and the explicitly
    // labelled no-native-monitor comparison are adapted; production code is unchanged.
    const context: ContainerContext = {
      storage: ctx.storage,
      blockConcurrencyWhile: (callback) => ctx.blockConcurrencyWhile(callback),
      waitUntil: (promise) => ctx.waitUntil(promise),
      container: {
        get running() {
          return process.running;
        },
        start: (options) => process.start({ ...options, enableInternet: false }),
        monitor: () =>
          env.HARNESS_MONITOR === "disabled" ? new Promise<void>(() => {}) : process.monitor(),
        destroy: () => process.destroy(),
        signal: (signal) => process.signal(signal),
        setInactivityTimeout: (duration) => process.setInactivityTimeout(duration),
        getTcpPort: (port) => process.getTcpPort(port),
      },
    };
    this.controller = new ContainerController(
      context,
      {},
      {
        onStart: () => {
          this.starts++;
        },
        onStop: (details) => {
          this.stops++;
          if (details.reason === "runtime_signal") this.signaled++;
          if (details.exitCode === 7) this.exitSeven++;
        },
        onError: () => {
          this.errors++;
        },
      },
    );
  }
  async alarm() {
    await this.controller.alarm();
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/initialize" || path === "/state")
      return Response.json({
        ...(await storageState(this.ctx, path === "/initialize")),
        revision: this.env.HARNESS_REVISION,
        running: Number(this.ctx.container?.running),
        starts: this.starts,
        stops: this.stops,
        errors: this.errors,
        signaled: this.signaled,
        exitSeven: this.exitSeven,
      });
    if (path === "/reader-resume-check" || path === "/reader-cancel-check")
      return Response.json(
        await checkReaderLifetime({
          arm: path === "/reader-resume-check" ? "resume" : "cancel",
          fetchBoundary: (inner) => this.controller.fetch(inner),
          running: () => Boolean(this.ctx.container?.running),
          outerSignal: request.signal,
        }),
      );
    if (path === "/backpressure-check")
      return Response.json(
        await checkBackpressure({
          fetchBoundary: (inner) => this.controller.fetch(inner),
          running: () => Boolean(this.ctx.container?.running),
          outerSignal: request.signal,
        }),
      );
    if (path === "/destroy") {
      await this.controller.destroy();
      return Response.json({ destroyed: 1 });
    }
    if (path === "/signal") {
      await this.controller.stop();
      return Response.json({ signaled: 1 });
    }
    return this.controller.fetch(request);
  }
}
export default worker();
