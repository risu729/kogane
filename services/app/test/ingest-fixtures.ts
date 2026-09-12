import { env } from "cloudflare:test";
import {
  createRun,
  addArtifact,
  addRunReport,
  sealRun,
  addUnit,
  addUnitReport,
  type RecordValue,
} from "../../../packages/application/src/ingest/index.ts";
import { directRegistrationPort } from "../../../packages/application/src/ingest/port.ts";

/** Synthetic evidence uses the same in-process registration as the Processor. */
export async function seedFixturePost(
  clientId: string,
  path: string,
  value: unknown,
): Promise<Record<string, any>> {
  const body = value as RecordValue;
  if (path === "/v1/runs") return createRun(env, clientId, body);
  const unit = /^\/v1\/units\/(\d+)\/reports$/.exec(path);
  if (unit) return addUnitReport(env, clientId, Number(unit[1]), body);
  const run = /^\/v1\/runs\/(\d+)\/(units|artifacts|reports|seal)$/.exec(path);
  if (!run) throw new Error(`Unsupported fixture operation: ${path}`);
  const id = Number(run[1]);
  switch (run[2]) {
    case "units":
      return addUnit(env, clientId, id, body);
    case "artifacts":
      return addArtifact(env, clientId, id, body);
    case "reports":
      return addRunReport(env, clientId, id, body);
    case "seal":
      return sealRun(env, clientId, id, body);
    default:
      throw new Error("Unsupported fixture operation");
  }
}
export async function seedFixtureObject(
  clientId: string,
  runId: number,
  sha256: string,
  bytes: Uint8Array,
): Promise<void> {
  await directRegistrationPort(env, clientId).uploadObject(runId, sha256, bytes);
}
