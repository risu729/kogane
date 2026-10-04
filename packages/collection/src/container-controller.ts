/** Direct Container API lifecycle; retries never include an application request. */
export interface ContainerProcess {
  readonly running: boolean;
  start(options: { enableInternet: boolean; env: Record<string, string> }): void;
  monitor(): Promise<void>;
  destroy(): Promise<void>;
  signal(signal: number): void;
  setInactivityTimeout(duration: number): Promise<void>;
  getTcpPort(port: number): { fetch(request: Request): Promise<Response> };
}
export interface ContainerContext {
  container?: ContainerProcess | undefined;
  storage: { deleteAlarm(): Promise<void> };
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
}
export interface ContainerStop {
  reason: "exit" | "runtime_signal" | "destroyed";
  exitCode?: number;
}
export interface ContainerHooks {
  onStart?(): void;
  onStop?(details: ContainerStop): void;
  onError?(error: unknown): void;
}
export class ContainerController {
  private starting: Promise<void> | undefined;
  private destroying: Promise<void> | undefined;
  private generation = 0;
  private monitorToken = 0;
  private monitoring = false;
  private healthyToken: number | undefined;
  private stoppedBySignal = false;
  private lastFailure: unknown;
  private readonly ready: Promise<void>;
  private readonly process: ContainerProcess;
  constructor(
    private readonly ctx: ContainerContext,
    private readonly env: Record<string, string>,
    private readonly hooks: ContainerHooks = {},
    private readonly timing = { startupMs: 20_000, pollMs: 300, pingMs: 5_000 },
  ) {
    if (!ctx.container) throw new Error("container-not-configured");
    this.process = ctx.container;
    // Retire only the SDK alarm. Its KV/SQL remain intact for old-source rollback.
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await this.retireAlarm();
      if (this.process.running) {
        await this.process.setInactivityTimeout(30_000);
        if (!this.destroying) this.observe(this.generation);
      }
    });
    // Handle initialization errors even before the first caller arrives.
    ctx.waitUntil(this.ready.catch((error: unknown) => this.error(error)));
  }
  async retireAlarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
  startAndWaitForPorts(): Promise<void> {
    if (this.destroying) return this.destroying.then(() => this.startAndWaitForPorts());
    if (!this.starting) {
      const pending = this.startReady();
      this.starting = pending;
      void pending
        .finally(() => {
          if (this.starting === pending) this.starting = undefined;
        })
        .catch(() => {});
    }
    return this.starting;
  }
  private async startReady(): Promise<void> {
    await this.ready;
    const generation = this.generation;
    const deadline = Date.now() + this.timing.startupMs;
    let started = false;
    while (Date.now() < deadline) {
      if (generation !== this.generation) throw new Error("container-start-canceled");
      if (!this.process.running) {
        // A process that exits after start is not restarted: it may have done work.
        if (started && !allocationUnavailable(this.lastFailure))
          throw new Error("container-start-process-exit");
        try {
          // Invalidate the old process before any startup await can deliver its result.
          this.monitorToken++;
          this.monitoring = false;
          this.lastFailure = undefined;
          this.process.start({ enableInternet: true, env: this.env });
          started = true;
          this.stoppedBySignal = false;
          this.observe(generation, true);
          await this.beforeDeadline(this.process.setInactivityTimeout(30_000), deadline);
        } catch (error) {
          if (generation !== this.generation)
            throw new Error("container-start-canceled", { cause: error });
          if (error instanceof StartupTimeout) break;
          if (!allocationUnavailable(error)) {
            this.error(error);
            throw new Error("container-start-failed", { cause: error });
          }
          await this.pause(deadline);
          continue;
        }
      }
      if (generation !== this.generation) throw new Error("container-start-canceled");
      try {
        const response = await this.beforeDeadline(
          this.process.getTcpPort(8080).fetch(
            new Request("http://container/health", {
              signal: AbortSignal.timeout(
                Math.max(1, Math.min(this.timing.pingMs, deadline - Date.now())),
              ),
            }),
          ),
          deadline,
        );
        if (response.body) await this.beforeDeadline(response.body.cancel(), deadline);
        if (!response.ok) throw new Error("container-health-unavailable");
        if (generation !== this.generation) throw new Error("container-start-canceled");
        if (this.healthyToken !== this.monitorToken) {
          this.healthyToken = this.monitorToken;
          this.safe(() => this.hooks.onStart?.());
        }
        return;
      } catch (error) {
        if (generation !== this.generation)
          throw new Error("container-start-canceled", { cause: error });
        if (error instanceof StartupTimeout) break;
        if (!this.process.running) {
          if (allocationUnavailable(this.lastFailure) || allocationUnavailable(error))
            started = false;
          else throw new Error("container-start-process-exit", { cause: error });
        }
        await this.pause(deadline);
      }
    }
    const error = new StartupTimeout();
    this.error(error);
    throw error;
  }
  private pause(deadline: number): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(this.timing.pollMs, deadline - Date.now()))),
    );
  }
  private async beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = deadline - Date.now();
    const timeout =
      remaining <= 0
        ? Promise.reject<never>(new StartupTimeout())
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StartupTimeout()), remaining);
          });
    try {
      const result = await Promise.race([timeout, operation]);
      if (Date.now() >= deadline) throw new StartupTimeout();
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private observe(generation: number, force = false): void {
    if (this.monitoring && !force) return;
    const token = ++this.monitorToken;
    this.monitoring = true;
    const monitor = this.process
      .monitor()
      .then(
        () => {
          if (generation !== this.generation || token !== this.monitorToken) return;
          this.safe(() =>
            this.hooks.onStop?.({
              reason: this.stoppedBySignal ? "runtime_signal" : "exit",
              exitCode: 0,
            }),
          );
        },
        (error: unknown) => {
          if (generation !== this.generation || token !== this.monitorToken) return;
          this.lastFailure = error;
          const code = exitCode(error);
          if (code !== undefined)
            this.safe(() =>
              this.hooks.onStop?.({
                reason: this.stoppedBySignal ? "runtime_signal" : "exit",
                exitCode: code,
              }),
            );
          else this.error(error);
        },
      )
      .finally(() => {
        if (token === this.monitorToken) this.monitoring = false;
      });
    // Like the former SDK, attach handlers without waitUntil on the long monitor.
    // A native pending monitor itself delays eviction up to 15 minutes.
    // That is separate from inactivity timeout; verify idle behavior on real Containers.
    void monitor;
  }
  async fetch(request: Request): Promise<Response> {
    await this.startAndWaitForPorts();
    if (this.destroying) await this.startAndWaitForPorts();
    if (this.destroying || !this.process.running) throw new Error("container-not-ready");
    // Forward once. A disconnect must never cause another bank login or POST.
    const response = await this.process.getTcpPort(8080).fetch(request);
    if (!response.body) return response;
    // This is DurableObjectState.waitUntil, not the outer Worker ExecutionContext.
    // Keep actual response consumption alive, then release it on EOF/error/cancel.
    const reader = response.body.getReader();
    let finish!: () => void;
    let finished = false;
    const lifetime = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const done = () => {
      if (!finished) {
        finished = true;
        finish();
      }
    };
    this.ctx.waitUntil(lifetime);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            done();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          done();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          done();
        }
      },
    });
    return new Response(body, response);
  }
  async stop(): Promise<void> {
    await this.ready;
    if (this.stoppedBySignal || !this.process.running) return;
    this.process.signal(15);
    this.stoppedBySignal = true;
  }
  destroy(): Promise<void> {
    if (!this.destroying) {
      const pending = this.destroyProcess();
      this.destroying = pending;
      void pending
        .finally(() => {
          if (this.destroying === pending) this.destroying = undefined;
        })
        .catch(() => {});
    }
    return this.destroying;
  }
  private async destroyProcess(): Promise<void> {
    const wasHealthy = this.healthyToken === this.monitorToken;
    this.generation++;
    this.monitorToken++;
    this.monitoring = false;
    this.starting = undefined;
    // Initialization failure must not prevent the caller's finally teardown.
    await this.ready.catch(() => {});
    try {
      await this.process.destroy();
    } catch (error) {
      // A rejected destroy may leave the old process running. Keep observing it
      // under the new generation without restoring any canceled startup.
      if (this.process.running) {
        try {
          this.observe(this.generation);
          if (wasHealthy) this.healthyToken = this.monitorToken;
        } catch (monitorError) {
          this.error(monitorError);
        }
      }
      throw error;
    }
    this.safe(() => this.hooks.onStop?.({ reason: "destroyed" }));
  }

  private error(error: unknown): void {
    this.safe(() => this.hooks.onError?.(error));
  }
  private safe(callback: () => void): void {
    try {
      callback();
    } catch {
      /* Diagnostics cannot interrupt collection. */
    }
  }
}
class StartupTimeout extends Error {
  constructor() {
    super("container-start-timeout");
  }
}
function allocationUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      "there is no container instance that can be provided to this durable object",
      "you are requesting too many containers per second",
    ].includes(error.message)
  );
}
function exitCode(error: unknown): number | undefined {
  try {
    const value =
      error && typeof error === "object" ? (error as { exitCode?: unknown }).exitCode : undefined;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255)
      return value;
  } catch {
    /* No provider text or arbitrary properties are logged. */
  }
  return undefined;
}
