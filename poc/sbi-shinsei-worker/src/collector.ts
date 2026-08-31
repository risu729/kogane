import { parseCredential } from "./credential";
import { UnknownResponseShapeError } from "./errors";
import { parseCollectionResult } from "./local/windows-chrome-collector";
import { assertReadAllowed, getReadRoute } from "./read-allowlist";
import type { RawArtifact, ReadOperationId } from "./types";

const REQUIRED_OPERATIONS = [
  "common.security-connect",
  "common.validate-token",
  "top.accounts-balance-and-activity",
  "top.balance-summary-and-stage",
  "common.exchange-rate",
  "yen-deposit.account",
] as const satisfies readonly ReadOperationId[];

export interface CollectorOutput {
  artifacts: RawArtifact[];
}

export async function collectSbiShinsei(options: {
  credentialJson: string;
  collectHandoff: (credentialJson: string) => Promise<string>;
  now?: () => Date;
}): Promise<CollectorOutput> {
  assertProductionRoutes();
  const credential = parseCredential(options.credentialJson);
  try {
    const handoffJson = await options.collectHandoff(JSON.stringify(credential));
    credential.powerDirectPassword = "";
    const handoff = parseHandoffEnvelope(handoffJson);
    if (handoff.ok !== true) {
      throw new Error(
        `SBI Shinsei browser collection stopped at ${handoff.stage}`,
      );
    }
    return {
      artifacts: parseCollectionResult(
        handoffJson,
        options.now?.() ?? new Date(),
      ).artifacts,
    };
  } finally {
    credential.powerDirectPassword = "";
  }
}

function parseHandoffEnvelope(value: unknown):
  | { ok: true }
  | { ok: false; stage: string } {
  if (typeof value !== "string" || value.length > 10 * 1024 * 1024) {
    throw new UnknownResponseShapeError(
      "Browser collection handoff was not bounded JSON text",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UnknownResponseShapeError("Browser collection handoff was invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UnknownResponseShapeError("Browser collection handoff was not an object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) return { ok: true };
  if (
    record.ok === false &&
    typeof record.stage === "string" &&
    /^[a-z0-9-]{1,80}$/u.test(record.stage) &&
    typeof record.authenticationAttempted === "boolean" &&
    Object.keys(record).length === 3
  ) {
    return { ok: false, stage: record.stage };
  }
  throw new UnknownResponseShapeError(
    "Browser collection handoff had an unknown envelope",
  );
}

function assertProductionRoutes(): void {
  for (const operation of REQUIRED_OPERATIONS) {
    const route = getReadRoute(operation);
    assertReadAllowed({
      operation,
      method: route.method,
      url: `${route.origin}${route.path}`,
    });
  }
}
