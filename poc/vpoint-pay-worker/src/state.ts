import { DurableObject } from "cloudflare:workers";
import { credentialFromSecrets, inspectCredential, type CredentialStatus } from "./credentials";
import { collectVPointPay } from "./vpoint-pay";
import { runPrefix, storeArtifact, storeManifest } from "./storage";
import type {
  CollectionFailure,
  CollectionManifest,
  CollectionResult,
  VPointPayCredential,
} from "./types";

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
    return inspectCredential({
      refreshToken: this.environment.VPOINT_PAY_REFRESH_TOKEN,
      deviceUuid: this.environment.VPOINT_PAY_DEVICE_UUID,
    }, "worker-secrets");
  }

  async resetFromSecrets(): Promise<{ status: "reset" }> {
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
    const prefix = runPrefix(startedAt, runId);
    const artifacts = [];
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
      for (const artifact of collection.artifacts) {
        try {
          artifacts.push(await storeArtifact({
            bucket: this.environment.SNAPSHOTS,
            prefix,
            artifact,
          }));
        } catch (error) {
          failures.push(failure(`r2:${artifact.dataset}`, error));
        }
      }
    } catch (error) {
      failures.push(failure("collect", error));
    }

    const completedAt = new Date().toISOString();
    const status = failures.length === 0
      ? "success"
      : artifacts.length === 0
        ? "failed"
        : "partial";
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
    const manifestKey = await storeManifest({
      bucket: this.environment.SNAPSHOTS,
      prefix,
      manifest,
    });
    console.log(JSON.stringify({
      event: "vpoint-pay-collection-stored",
      runId,
      status,
      earliestMonth,
      latestMonth,
      transactionMonthCount,
      transactionCount,
      artifactCount: artifacts.length,
      failureCount: failures.length,
      manifestKey,
    }));
    return { ...manifest, manifestKey };
  }
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
