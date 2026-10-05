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
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<unknown>;
    setAlarm(timestamp: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
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
const IDLE_STATE_KEY = "__kogane_container_idle_v1";
function storedIdleDeadline(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return;
  const deadline = (value as { deadline?: unknown }).deadline;
  return typeof deadline === "number" && Number.isSafeInteger(deadline) && deadline > 0
    ? deadline
    : undefined;
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
  private readonly activeOperations = new Set<symbol>();
  private idleDeadline: number | undefined;
  private idleRevision = 0;
  private idleWrites: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly process: ContainerProcess;
  constructor(
    private readonly ctx: ContainerContext,
    private readonly env: Record<string, string>,
    private readonly hooks: ContainerHooks = {},
    private readonly timing: {
      startupMs: number;
      pollMs: number;
      pingMs: number;
      idleMs?: number;
    } = { startupMs: 20_000, pollMs: 300, pingMs: 5_000 },
  ) {
    if (!ctx.container) throw new Error("container-not-configured");
    this.process = ctx.container;
    // Retire only the SDK alarm. Its KV/SQL remain intact for old-source rollback.
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAlarm();
      const previousIdle = await this.ctx.storage.get(IDLE_STATE_KEY);
      if (this.process.running) {
        await this.process.setInactivityTimeout(30_000);
        if (!this.destroying) {
          this.observe(this.generation);
          // A persisted idle deadline survives eviction. An interrupted operation
          // gets the same fresh idle window that the old SDK constructor granted.
          if (this.activeOperations.size === 0)
            this.idleDeadline = storedIdleDeadline(previousIdle) ?? this.nextIdleDeadline();
        }
      }
      await this.syncIdleAlarm();
    });
    // Handle initialization errors even before the first caller arrives.
    ctx.waitUntil(this.ready.catch((error: unknown) => this.error(error)));
  }
  private nextIdleDeadline(): number {
    return Date.now() + (this.timing.idleMs ?? 30_000);
  }
  private beginActivity(): symbol {
    const operation = Symbol();
    this.activeOperations.add(operation);
    this.idleDeadline = undefined;
    this.idleRevision++;
    return operation;
  }
  private async endActivity(operation: symbol): Promise<void> {
    // Teardown invalidates old response lifetimes without touching newer ones.
    if (!this.activeOperations.delete(operation)) return;
    if (this.activeOperations.size === 0 && this.process.running && !this.destroying)
      this.idleDeadline = this.nextIdleDeadline();
    this.idleRevision++;
    await this.syncIdleAlarm();
  }
  private syncIdleAlarm(): Promise<void> {
    const pending = this.idleWrites.then(async () => {
      // A pre-existing await may finish while storage writes yield. Persist the
      // newest state before releasing the queue, never an old process's deadline.
      for (;;) {
        const revision = this.idleRevision;
        if (!this.process.running || this.destroying) {
          await this.ctx.storage.delete(IDLE_STATE_KEY);
          await this.ctx.storage.deleteAlarm();
        } else if (this.activeOperations.size > 0 || this.idleDeadline === undefined) {
          await this.ctx.storage.put(IDLE_STATE_KEY, { deadline: null });
          await this.ctx.storage.deleteAlarm();
        } else {
          const deadline = this.idleDeadline;
          await this.ctx.storage.put(IDLE_STATE_KEY, { deadline });
          await this.ctx.storage.setAlarm(deadline);
        }
        if (revision === this.idleRevision) return;
      }
    });
    this.idleWrites = pending.catch(() => {});
    return pending;
  }
  async alarm(): Promise<void> {
    await this.ready;
    const generation = this.generation;
    await this.idleWrites;
    const persisted = await this.ctx.storage.get(IDLE_STATE_KEY);
    if (generation !== this.generation || this.destroying) return;
    if (!this.process.running || this.activeOperations.size > 0) {
      await this.syncIdleAlarm();
      return;
    }
    if (this.idleDeadline === undefined) {
      this.idleDeadline = this.nextIdleDeadline();
      this.idleRevision++;
    }
    // A queued SDK alarm or old idle alarm must not stop a newer operation.
    if (storedIdleDeadline(persisted) !== this.idleDeadline || Date.now() < this.idleDeadline) {
      await this.syncIdleAlarm();
      return;
    }
    try {
      this.process.signal(15);
      this.stoppedBySignal = true;
    } catch (error) {
      this.error(error);
    }
    // Like sleepAfter, retry the idle signal if it failed or the process ignored
    // it. A pending monitor never counts as application activity.
    this.idleDeadline = this.nextIdleDeadline();
    this.idleRevision++;
    await this.syncIdleAlarm();
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
    const activity = this.beginActivity();
    let deadline: number | undefined;
    try {
      await this.ready;
      deadline = Date.now() + this.timing.startupMs;
      await this.beforeDeadline(this.syncIdleAlarm(), deadline);
      if (!this.activeOperations.has(activity)) throw new Error("container-start-canceled");
      const generation = this.generation;
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
          const response = await this.healthCheck(deadline);
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
    } finally {
      const ownsActivity = this.activeOperations.has(activity);
      const ending = this.endActivity(activity);
      if (deadline === undefined || !ownsActivity) await ending;
      else await this.beforeDeadline(ending, deadline);
    }
  }
  private async healthCheck(deadline: number): Promise<Response> {
    const pending = this.process.getTcpPort(8080).fetch(
      new Request("http://container/health", {
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(this.timing.pingMs, deadline - Date.now())),
        ),
      }),
    );
    try {
      return await this.beforeDeadline(pending, deadline);
    } catch (error) {
      // A response can arrive at or after the deadline. Release its port stream
      // without waiting for cleanup or letting it affect a newer process.
      void pending.then((response) => response.body?.cancel()).catch(() => {});
      throw error;
    }
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
    const activity = this.beginActivity();
    try {
      await this.startAndWaitForPorts();
      if (this.destroying) await this.startAndWaitForPorts();
      if (!this.activeOperations.has(activity)) throw new Error("container-start-canceled");
      if (this.destroying || !this.process.running) throw new Error("container-not-ready");
      // Forward once. A disconnect must never cause another bank login or POST.
      const response = await this.process.getTcpPort(8080).fetch(request);
      if (!response.body) {
        await this.endActivity(activity);
        return response;
      }
      // Track headers and the complete body lifetime, including backpressure.
      // This waitUntil belongs to the DO; the monitor is not application activity.
      const reader = response.body.getReader();
      let finish!: () => void;
      let finished: Promise<void> | undefined;
      const lifetime = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const done = () => {
        finished ??= this.endActivity(activity)
          .catch((error: unknown) => this.error(error))
          .finally(finish);
        return finished;
      };
      this.ctx.waitUntil(lifetime);
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              await done();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            controller.error(error);
            await done();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await done();
          }
        },
      });
      return new Response(body, response);
    } catch (error) {
      // Cleanup may outlive a failed readiness deadline, but must not extend it.
      this.ctx.waitUntil(
        this.endActivity(activity).catch((idleError: unknown) => this.error(idleError)),
      );
      throw error;
    }
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
          if (this.destroying === pending) {
            this.destroying = undefined;
            if (this.process.running && this.activeOperations.size === 0)
              this.idleDeadline = this.nextIdleDeadline();
            this.idleRevision++;
            return this.syncIdleAlarm().catch((error: unknown) => this.error(error));
          }
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
    this.activeOperations.clear();
    this.idleDeadline = undefined;
    this.idleRevision++;
    // Initialization failure must not prevent the caller's finally teardown.
    await this.ready.catch(() => {});
    await this.syncIdleAlarm().catch((error: unknown) => this.error(error));
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
    this.idleDeadline = undefined;
    this.idleRevision++;
    await this.syncIdleAlarm().catch((error: unknown) => this.error(error));
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
