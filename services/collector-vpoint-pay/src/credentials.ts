import type { VPointPayCredential } from "./types";

type CredentialSecrets = Partial<Pick<Env, "VPOINT_PAY_REFRESH_TOKEN" | "VPOINT_PAY_DEVICE_UUID">>;

export interface CredentialStatus {
  source: "durable-object" | "worker-secrets";
  structurallyReady: boolean;
  missingFields: Array<"refresh-token" | "device-uuid">;
  invalidFields: Array<"device-uuid">;
}

// This only checks local configuration, never calls the provider or rotates tokens.
export function inspectCredential(
  credential: Partial<VPointPayCredential>,
  source: CredentialStatus["source"],
): CredentialStatus {
  const missingFields: CredentialStatus["missingFields"] = [];
  const invalidFields: CredentialStatus["invalidFields"] = [];
  if (!credential.refreshToken?.trim()) missingFields.push("refresh-token");
  if (!credential.deviceUuid?.trim()) missingFields.push("device-uuid");
  else if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(credential.deviceUuid)
  ) {
    invalidFields.push("device-uuid");
  }
  return {
    source,
    structurallyReady: missingFields.length === 0 && invalidFields.length === 0,
    missingFields,
    invalidFields,
  };
}

export function credentialFromSecrets(env: CredentialSecrets): VPointPayCredential {
  const credential = {
    refreshToken: env.VPOINT_PAY_REFRESH_TOKEN,
    deviceUuid: env.VPOINT_PAY_DEVICE_UUID,
  };
  const status = inspectCredential(credential, "worker-secrets");
  if (!status.structurallyReady) {
    throw new VPointPayCredentialConfigurationError(status);
  }
  // inspectCredential has established both fields without logging their values.
  return {
    refreshToken: credential.refreshToken!,
    deviceUuid: credential.deviceUuid!,
  };
}

export class VPointPayCredentialConfigurationError extends Error {
  constructor(status: CredentialStatus) {
    super(
      `V Point Pay credential configuration required: missing=${status.missingFields.join(",") || "none"}; invalid=${status.invalidFields.join(",") || "none"}`,
    );
    this.name = "VPointPayCredentialConfigurationError";
  }
}
