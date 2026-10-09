import { Container } from "@cloudflare/containers";
import { storageState, worker, type HarnessEnv } from "./common";
import { checkBackpressure } from "./backpressure-check";
import { checkReaderLifetime } from "./reader-lifetime-check";
import { compareBackpressure } from "./backpressure-compare";
import { compareStreamError } from "./stream-error-compare";
import { checkStreamError } from "./stream-error-check";

export class VerificationContainer extends Container<HarnessEnv> {
  defaultPort = 8080;
  sleepAfter = "30s";
  enableInternet = false;
  private startCallbacks = 0;
  private stops = 0;
  private errors = 0;
  onStart() {
    // SDK 0.3.7 calls this for each readiness caller, even when startup is shared.
    this.startCallbacks++;
  }
  onStop() {
    this.stops++;
  }
  onError() {
    this.errors++;
  }
  override async onActivityExpired(): Promise<void> {
    // Same SDK default action without its free-text log message.
    await this.stop();
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/initialize" || path === "/state")
      return Response.json({
        ...(await storageState(this.ctx, path === "/initialize")),
        revision: this.env.HARNESS_REVISION,
        running: Number(this.ctx.container?.running),
        startCallbacks: this.startCallbacks,
        stops: this.stops,
        errors: this.errors,
        signaled: 0,
        exitSeven: 0,
      });
    if (path === "/stream-error-check")
      return Response.json(
        await checkStreamError({
          fetchBoundary: (inner) => this.containerFetch(inner),
          running: () => Boolean(this.ctx.container?.running),
          outerSignal: request.signal,
        }),
      );
    if (path === "/stream-error-compare")
      return Response.json(
        await compareStreamError({
          sdkFetch: (inner) => this.containerFetch(inner),
          rawFetch: (inner) => this.ctx.container!.getTcpPort(8080).fetch(inner),
          running: () => Boolean(this.ctx.container?.running),
          renewActivityTimeout: () => this.renewActivityTimeout(),
          outerSignal: request.signal,
        }),
      );
    if (path === "/backpressure-compare")
      return Response.json(
        await compareBackpressure({
          sdkFetch: (inner) => this.containerFetch(inner),
          rawFetch: (inner) => this.ctx.container!.getTcpPort(8080).fetch(inner),
          running: () => Boolean(this.ctx.container?.running),
          renewActivityTimeout: () => this.renewActivityTimeout(),
          outerSignal: request.signal,
        }),
      );
    if (path === "/reader-resume-check" || path === "/reader-cancel-check")
      return Response.json(
        await checkReaderLifetime({
          arm: path === "/reader-resume-check" ? "resume" : "cancel",
          fetchBoundary: (inner) => this.containerFetch(inner),
          running: () => Boolean(this.ctx.container?.running),
          outerSignal: request.signal,
        }),
      );
    if (path === "/backpressure-check")
      return Response.json(
        await checkBackpressure({
          fetchBoundary: (inner) => this.containerFetch(inner),
          running: () => Boolean(this.ctx.container?.running),
          outerSignal: request.signal,
        }),
      );
    if (path === "/destroy") {
      await this.destroy();
      return Response.json({ destroyed: 1 });
    }
    if (path === "/signal") {
      await this.stop();
      return Response.json({ signaled: 1 });
    }
    return this.containerFetch(request);
  }
}
export default worker();
