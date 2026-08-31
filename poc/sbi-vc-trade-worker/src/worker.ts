import { DurableObject } from "cloudflare:workers";
import { collectSbiVcTrade } from "./collector";
import { decryptSession, encryptSession } from "./crypto";
import { createPasskeySession, parsePasskeyCredential } from "./passkey";
import { applySessionUpdates, cookieHeader, parseGatewayMeta, parseSession } from "./session";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type {
  CollectionFailure,
  CollectionManifest,
  CollectionSummary,
  EncryptedSession,
  HealthState,
  SessionMaterial,
  StoredArtifact,
} from "./types";

const ORIGIN = "https://simple.sbivc.co.jp";
const TRADE_URL = `${ORIGIN}/api/cccmdipresen/gw/trade`;
const MAX_RESPONSE_BYTES = 64 * 1024;
const KEEPALIVE_CRON = "*/15 * * * *";
const COLLECTION_CRON = "5 21 * * *";
const INITIAL_HEALTH: HealthState = {
  initializedAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastHttpStatus: null,
  lastGatewayStatus: null,
  lastCookieUpdateCount: 0,
  consecutiveFailures: 0,
  lastErrorCode: null,
  lastReauthAttemptAt: null,
  lastReauthSuccessAt: null,
  lastReauthErrorCode: null,
};
const REAUTH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export class SbiVcSessionState extends DurableObject<Env> {
  #running: Promise<HealthState> | null = null;
  #reauthRunning: Promise<HealthState> | null = null;
  #collectionRunning: Promise<CollectionSummary> | null = null;
  #operationTail: Promise<void> = Promise.resolve();

  async getHealth(): Promise<HealthState> {
    return { ...INITIAL_HEALTH, ...(await this.ctx.storage.get<HealthState>("health")) };
  }

  async runKeepAlive(): Promise<HealthState> {
    if (this.#running) return this.#running;
    this.#running = this.#exclusive(() => this.#performKeepAlive());
    try {
      return await this.#running;
    } finally {
      this.#running = null;
    }
  }

  async runReauthenticate(force = false): Promise<HealthState> {
    if (this.#reauthRunning) return this.#reauthRunning;
    this.#reauthRunning = this.#exclusive(() => this.#performReauthenticate(force));
    try {
      return await this.#reauthRunning;
    } finally {
      this.#reauthRunning = null;
    }
  }

  async runCollection(): Promise<CollectionSummary> {
    if (this.#collectionRunning) return this.#collectionRunning;
    this.#collectionRunning = this.#exclusive(() => this.#performCollection());
    try {
      return await this.#collectionRunning;
    } finally {
      this.#collectionRunning = null;
    }
  }

  async #performCollection(): Promise<CollectionSummary> {
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    const prefix = runPrefix(startedAt, runId);
    const artifacts: StoredArtifact[] = [];
    const failures: CollectionFailure[] = [];
    let operation = "load_session";
    try {
      const session = await this.loadSession(startedAt);
      operation = "collect";
      await collectSbiVcTrade({
        session,
        onSession: async (updated) => {
          operation = "persist_session";
          await this.ctx.storage.put("session", await encryptSession(updated, this.env.SESSION_ENCRYPTION_KEY));
          operation = "collect";
        },
        onArtifact: async (artifact) => {
          operation = `r2_${artifact.dataset}`;
          artifacts.push(await storeArtifact({ bucket: this.env.SNAPSHOTS, prefix, artifact }));
          operation = "collect";
        },
      });
    } catch (error) {
      failures.push({ operation, errorCode: classifyError(error) });
    }
    const completedAt = new Date().toISOString();
    const status: CollectionManifest["status"] = failures.length === 0
      ? "success"
      : artifacts.length === 0
        ? "failed"
        : "partial";
    const manifest: CollectionManifest = {
      schemaVersion: this.env.COLLECTOR_SCHEMA_VERSION,
      source: "sbi-vc-trade",
      runId,
      startedAt,
      completedAt,
      status,
      artifacts,
      failures,
    };
    const manifestKey = await storeManifest({ bucket: this.env.SNAPSHOTS, prefix, manifest });
    console.log(JSON.stringify({
      message: "sbi_vc_collection",
      runId,
      status,
      artifactCount: artifacts.length,
      failureCount: failures.length,
      manifestKey,
    }));
    return { runId, status, artifactCount: artifacts.length, failureCount: failures.length, manifestKey };
  }

  async #performReauthenticate(force: boolean): Promise<HealthState> {
    const previous = await this.getHealth();
    const attemptAt = new Date().toISOString();
    if (!force && previous.lastReauthAttemptAt) {
      const elapsed = Date.now() - Date.parse(previous.lastReauthAttemptAt);
      if (Number.isFinite(elapsed) && elapsed < REAUTH_COOLDOWN_MS) return previous;
    }
    try {
      if (typeof this.env.PASSKEY_CREDENTIAL !== "string" || !this.env.PASSKEY_CREDENTIAL) {
        throw new Error("missing_passkey_credential");
      }
      const credential = parsePasskeyCredential(JSON.parse(this.env.PASSKEY_CREDENTIAL) as unknown);
      const session = await createPasskeySession(credential);
      const encrypted = await encryptSession(session, this.env.SESSION_ENCRYPTION_KEY);
      const health: HealthState = {
        ...previous,
        initializedAt: previous.initializedAt ?? attemptAt,
        lastReauthAttemptAt: attemptAt,
        lastReauthSuccessAt: attemptAt,
        lastReauthErrorCode: null,
      };
      await this.ctx.storage.put({ session: encrypted, health });
      console.log(JSON.stringify({ message: "sbi_vc_reauth", outcome: "success" }));
      return health;
    } catch (error) {
      const errorCode = classifyError(error);
      const health: HealthState = {
        ...previous,
        lastReauthAttemptAt: attemptAt,
        lastReauthErrorCode: errorCode,
      };
      await this.ctx.storage.put("health", health);
      console.error(JSON.stringify({ message: "sbi_vc_reauth", outcome: "failure", errorCode }));
      return health;
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release!: () => void;
    this.#operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #performKeepAlive(): Promise<HealthState> {
    const attemptAt = new Date().toISOString();
    const previous = await this.getHealth();
    let stage = "load_session";
    try {
      const session = await this.loadSession(attemptAt);
      stage = "fetch_gateway";
      const response = await fetch(TRADE_URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Cookie: cookieHeader(session),
          Origin: ORIGIN,
          Referer: `${ORIGIN}/`,
        },
        body: JSON.stringify({ event: "informationTitle", data: { secureKey: session.secureKey } }),
      });
      if (!response.ok) {
        return await this.recordFailure(previous, attemptAt, response.status, "http_rejected");
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        return await this.recordFailure(previous, attemptAt, response.status, "non_json_response");
      }
      stage = "read_body";
      const parsed = JSON.parse(await readBoundedText(response, MAX_RESPONSE_BYTES)) as unknown;
      stage = "parse_gateway";
      const meta = parseGatewayMeta(parsed);
      if (meta.status !== "OK") {
        return await this.recordFailure(previous, attemptAt, response.status, "gateway_rejected", meta.status);
      }
      stage = "apply_cookie";
      const updated = applySessionUpdates(session, response.headers.getSetCookie(), meta);
      stage = "persist_session";
      const encrypted = await encryptSession(updated.session, this.env.SESSION_ENCRYPTION_KEY);
      const health: HealthState = {
        ...previous,
        initializedAt: previous.initializedAt ?? attemptAt,
        lastAttemptAt: attemptAt,
        lastSuccessAt: attemptAt,
        lastHttpStatus: response.status,
        lastGatewayStatus: meta.status,
        lastCookieUpdateCount: updated.updateCount,
        consecutiveFailures: 0,
        lastErrorCode: null,
      };
      await this.ctx.storage.put({ session: encrypted, health });
      console.log(JSON.stringify({ message: "sbi_vc_keepalive", outcome: "success", httpStatus: response.status, cookieUpdateCount: updated.updateCount }));
      return health;
    } catch (error) {
      const code = `${stage}_${classifyError(error)}`;
      return await this.recordFailure(previous, attemptAt, null, code);
    }
  }

  private async loadSession(initializedAt: string): Promise<SessionMaterial> {
    const encrypted = await this.ctx.storage.get<EncryptedSession>("session");
    if (encrypted) return decryptSession(encrypted, this.env.SESSION_ENCRYPTION_KEY);
    if (typeof this.env.SESSION_SEED !== "string" || !this.env.SESSION_SEED) throw new Error("missing_session_seed");
    if (typeof this.env.SESSION_ENCRYPTION_KEY !== "string" || !this.env.SESSION_ENCRYPTION_KEY) {
      throw new Error("missing_encryption_key");
    }
    let seed: unknown;
    try {
      seed = JSON.parse(this.env.SESSION_SEED) as unknown;
    } catch {
      throw new Error("session_seed_json_invalid");
    }
    const session = parseSession(seed);
    let stored: EncryptedSession;
    try {
      stored = await encryptSession(session, this.env.SESSION_ENCRYPTION_KEY);
    } catch (error) {
      throw new Error(classifyCryptoError(error));
    }
    const health = await this.getHealth();
    if (!health.initializedAt) {
      await this.ctx.storage.put({ session: stored, health: { ...health, initializedAt } });
    } else {
      await this.ctx.storage.put("session", stored);
    }
    return session;
  }

  private async recordFailure(
    previous: HealthState,
    attemptAt: string,
    httpStatus: number | null,
    errorCode: string,
    gatewayStatus: string | null = null,
  ): Promise<HealthState> {
    const health: HealthState = {
      ...previous,
      lastAttemptAt: attemptAt,
      lastHttpStatus: httpStatus,
      lastGatewayStatus: gatewayStatus,
      lastCookieUpdateCount: 0,
      consecutiveFailures: previous.consecutiveFailures + 1,
      lastErrorCode: errorCode,
    };
    await this.ctx.storage.put("health", health);
    console.error(JSON.stringify({ message: "sbi_vc_keepalive", outcome: "failure", httpStatus, errorCode }));
    return health;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!(await isAuthorized(request, env.ADMIN_TOKEN))) return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    const stub = env.SESSION_STATE.getByName("singleton");
    if (request.method === "POST" && path === "/run") return Response.json(await stub.runKeepAlive());
    if (request.method === "POST" && path === "/reauth") {
      const reauthenticated = await stub.runReauthenticate(true);
      if (reauthenticated.lastReauthErrorCode !== null) return Response.json(reauthenticated, { status: 502 });
      return Response.json(await stub.runKeepAlive());
    }
    if (request.method === "POST" && path === "/collect") {
      const health = await ensureHealthySession(stub);
      if (health.lastErrorCode !== null) return Response.json(health, { status: 502 });
      const result = await stub.runCollection();
      return Response.json(result, { status: result.status === "success" ? 200 : 502 });
    }
    if (request.method === "GET" && path === "/health") return Response.json(await stub.getHealth());
    return new Response(null, { status: 404 });
  },

  async scheduled(controller, env): Promise<void> {
    const stub = env.SESSION_STATE.getByName("singleton");
    if (controller.cron === KEEPALIVE_CRON) {
      const health = await ensureHealthySession(stub);
      if (health.lastErrorCode !== null) throw new Error("scheduled_keepalive_failed");
      return;
    }
    if (controller.cron === COLLECTION_CRON) {
      const health = await ensureHealthySession(stub);
      if (health.lastErrorCode !== null) throw new Error("scheduled_collection_session_failed");
      const result = await stub.runCollection();
      if (result.status !== "success") throw new Error("scheduled_collection_failed");
      return;
    }
    throw new Error("unknown_cron_trigger");
  },
} satisfies ExportedHandler<Env>;

async function ensureHealthySession(
  stub: DurableObjectStub<SbiVcSessionState>,
): Promise<HealthState> {
  let health = await stub.runKeepAlive();
  if (!shouldReauthenticate(health)) return health;
  const previousReauthSuccessAt = health.lastReauthSuccessAt;
  const reauthenticated = await stub.runReauthenticate(false);
  if (
    reauthenticated.lastReauthErrorCode === null
    && reauthenticated.lastReauthSuccessAt !== previousReauthSuccessAt
  ) {
    health = await stub.runKeepAlive();
  } else {
    health = reauthenticated;
  }
  return health;
}

function shouldReauthenticate(health: HealthState): boolean {
  return health.lastHttpStatus === 401
    || health.lastHttpStatus === 403
    || health.lastErrorCode === "gateway_rejected"
    || health.lastErrorCode === "load_session_missing_session_seed";
}

function classifyError(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) return error.message;
  if (error instanceof SyntaxError) return "json_parse_failed";
  if (error instanceof DOMException) return classifyCryptoError(error);
  if (error instanceof TypeError) return "type_error";
  return "unexpected_error";
}

function classifyCryptoError(error: unknown): string {
  if (!(error instanceof DOMException)) return "session_encrypt_failed";
  switch (error.name) {
    case "DataError": return "crypto_data_error";
    case "InvalidAccessError": return "crypto_invalid_access";
    case "NotSupportedError": return "crypto_not_supported";
    case "OperationError": return "crypto_operation_error";
    default: return "crypto_error";
  }
}

async function isAuthorized(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(authorization.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const provided = new Uint8Array(providedHash);
  const wanted = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < wanted.length; index += 1) {
    difference |= provided[index]! ^ wanted[index]!;
  }
  return difference === 0;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("missing_response_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("response_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
