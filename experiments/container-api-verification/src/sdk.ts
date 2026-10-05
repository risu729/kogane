import { Container } from "@cloudflare/containers";
import { storageState, worker, type HarnessEnv } from "./common";

export class VerificationContainer extends Container<HarnessEnv> {
  defaultPort = 8080;
  sleepAfter = "30s";
  enableInternet = false;
  private starts = 0;
  private stops = 0;
  private errors = 0;
  onStart() {
    this.starts++;
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
        starts: this.starts,
        stops: this.stops,
        errors: this.errors,
        signaled: 0,
        exitSeven: 0,
      });
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
