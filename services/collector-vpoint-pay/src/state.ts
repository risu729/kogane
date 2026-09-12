import { DurableObject } from "cloudflare:workers";
import { credentialFromSecrets, inspectCredential, type CredentialStatus } from "./credentials";
import { persistVPointPayRun } from "./shared-run";
import type {
  CollectionFailure,
  CollectionManifest,
  CollectionResult,
  RawArtifact,
  VPointPayCredential,
} from "./types";
import { collectVPointPay } from "./vpoint-pay";
const REFRESH_TOKEN_KEY = "refresh-token";
const DEVICE_UUID_KEY = "device-uuid";
export class VPointPayCredentialState extends DurableObject<Env> {
  private collectionInFlight: Promise<CollectionResult> | null = null;
  private readonly state: DurableObjectState;
  private readonly environment: Env;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.environment = env;
  }
  async runCollection(): Promise<CollectionResult> {
    if (this.collectionInFlight) return await this.collectionInFlight;
    this.collectionInFlight = this.runCollectionOnce();
    try {
      return await this.collectionInFlight;
    } finally {
      this.collectionInFlight = null;
    }
  }
  async credentialStatus(): Promise<CredentialStatus> {
    const [refreshToken, deviceUuid] = await Promise.all([
      this.state.storage.get<string>(REFRESH_TOKEN_KEY),
      this.state.storage.get<string>(DEVICE_UUID_KEY),
    ]);
    if (refreshToken && deviceUuid) {
      return inspectCredential({ refreshToken, deviceUuid }, "durable-object");
    }
    return inspectCredential(
      {
        refreshToken: this.environment.VPOINT_PAY_REFRESH_TOKEN,
        deviceUuid: this.environment.VPOINT_PAY_DEVICE_UUID,
      },
      "worker-secrets",
    );
  }
  async resetFromSecrets(): Promise<{
    status: "reset";
  }> {
    const credential = credentialFromSecrets(this.environment);
    await this.state.storage.put({
      [REFRESH_TOKEN_KEY]: credential.refreshToken,
      [DEVICE_UUID_KEY]: credential.deviceUuid,
    });
    return { status: "reset" };
  }
  private async credential(): Promise<VPointPayCredential> {
    const [refreshToken, deviceUuid] = await Promise.all([
      this.state.storage.get<string>(REFRESH_TOKEN_KEY),
      this.state.storage.get<string>(DEVICE_UUID_KEY),
    ]);
    if (refreshToken && deviceUuid) return { refreshToken, deviceUuid };
    const seeded = credentialFromSecrets(this.environment);
    await this.state.storage.put({
      [REFRESH_TOKEN_KEY]: seeded.refreshToken,
      [DEVICE_UUID_KEY]: seeded.deviceUuid,
    });
    return seeded;
  }
  private async runCollectionOnce(): Promise<CollectionResult> {
    const startedAt = new Date().toISOString();
    const runId = crypto.randomUUID();

    const artifacts: CollectionManifest["artifacts"] = [];
    const collected: RawArtifact[] = [];
    const failureCodes: string[] = [];
    const failures: CollectionFailure[] = [];
    let earliestMonth: string | null = null;
    let latestMonth: string | null = null;
    let transactionMonthCount = 0;
    let transactionCount = 0;
    try {
      const credential = await this.credential();
      const collection = await collectVPointPay({
        credential,
        saveRotatedRefreshToken: async (refreshToken) => {
          await this.state.storage.put(REFRESH_TOKEN_KEY, refreshToken);
        },
      });
      earliestMonth = collection.earliestMonth;
      latestMonth = collection.latestMonth;
      transactionMonthCount = collection.transactionMonthCount;
      transactionCount = collection.transactionCount;
      {
        // One terminal-last run replaces the per-artifact writes below.
        collected.push(...collection.artifacts);
      }
    } catch (error) {
      failures.push(failure("collect", error));
      failureCodes.push(safeFailureCode(error));
    }
    const completedAt = new Date().toISOString();
    const storedCount = collected.length;
    const status = failures.length === 0 ? "success" : storedCount === 0 ? "failed" : "partial";
    const manifest: CollectionManifest = {
      schemaVersion: this.environment.COLLECTOR_SCHEMA_VERSION,
      source: "v-point-pay",
      runId,
      startedAt,
      completedAt,
      status,
      earliestMonth,
      latestMonth,
      transactionMonthCount,
      transactionCount,
      artifacts,
      failures,
    };
    {
      const persisted = await persistVPointPayRun(this.environment.DATA, {
        runId,
        producerVersion: this.environment.COLLECTOR_SCHEMA_VERSION,
        attemptId: `attempt-${runId}`,
        startedAt,
        completedAt,
        status,
        artifacts: collected,
        earliestMonth,
        latestMonth,
        failureCodes,
      });
      console.log(
        JSON.stringify({
          event: "vpoint-pay-collection-persisted",
          runId,
          status,
          earliestMonth,
          latestMonth,
          transactionMonthCount,
          transactionCount,
          artifactCount: collected.length,
          failureCount: failures.length,
          terminalOutcome: persisted.outcome,
          terminalKey: persisted.terminalKey,
          terminalDigest: persisted.terminalDigest,
        }),
      );
      // A run whose objects were not all written has no terminal and is not a
      // stored run, whatever the provider outcome was (G1-01).
      if (persisted.outcome !== "persisted" && persisted.outcome !== "already_persisted") {
        throw new Error(`V Point Pay run was not persisted; outcome=${persisted.outcome}`);
      }
      return { ...manifest, target: "shared", manifestKey: persisted.terminalKey };
    }
  }
}
/**
 * The machine code a terminal may carry. Deliberately not `publicError`: that
 * is a redacted provider message, and a terminal states codes only (12 §6).
 */
function safeFailureCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name.includes("CredentialConfiguration")) return "credential_configuration_required";
  if (name.includes("ReauthenticationRequired")) return "authentication_required";
  if (name.includes("Protocol")) return "provider_protocol_failed";
  if (name.includes("Http")) return "provider_http_failed";
  return "operation_failed";
}
function failure(operation: string, error: unknown): CollectionFailure {
  return {
    operation,
    errorType: error instanceof Error ? error.name : "UnknownError",
    message: publicError(error),
  };
}
function publicError(error: unknown): string {
  const value = error instanceof Error ? error.message : "Unknown error";
  return value
    .replace(/(cookie|session|token|device[-_ ]?id)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 300);
}
