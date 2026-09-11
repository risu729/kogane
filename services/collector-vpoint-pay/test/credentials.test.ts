import { describe, expect, test } from "bun:test";
import { credentialFromSecrets, inspectCredential } from "../src/credentials";

const UUID = "00112233-4455-6677-8899-aabbccddeeff";

describe("V Point Pay credential diagnostics", () => {
  test("reports both missing inputs without making up a device identity", () => {
    expect(inspectCredential({}, "worker-secrets")).toEqual({
      source: "worker-secrets",
      structurallyReady: false,
      missingFields: ["refresh-token", "device-uuid"],
      invalidFields: [],
    });
    expect(() => credentialFromSecrets({})).toThrow("missing=refresh-token,device-uuid");
  });

  test("rejects missing UUID before credentials can be seeded", () => {
    expect(() => credentialFromSecrets({ VPOINT_PAY_REFRESH_TOKEN: "private-test-token" })).toThrow(
      "missing=device-uuid",
    );
  });

  test("malformed UUID errors never include either secret value", () => {
    const secrets = {
      VPOINT_PAY_REFRESH_TOKEN: "private-test-token",
      VPOINT_PAY_DEVICE_UUID: "private-malformed-device-value",
    };
    try {
      credentialFromSecrets(secrets);
      throw new Error("Expected configuration failure");
    } catch (error) {
      expect(error).toHaveProperty("name", "VPointPayCredentialConfigurationError");
      const message = String(error);
      expect(message).toContain("invalid=device-uuid");
      expect(message).not.toContain(secrets.VPOINT_PAY_REFRESH_TOKEN);
      expect(message).not.toContain(secrets.VPOINT_PAY_DEVICE_UUID);
    }
  });

  test("ready means structural configuration only and returns no values", () => {
    const credential = { refreshToken: "latest-rotated-test-token", deviceUuid: UUID };
    const status = inspectCredential(credential, "durable-object");
    expect(status).toEqual({
      source: "durable-object",
      structurallyReady: true,
      missingFields: [],
      invalidFields: [],
    });
    expect(JSON.stringify(status)).not.toContain(credential.refreshToken);
    expect(JSON.stringify(status)).not.toContain(UUID);
    expect(
      credentialFromSecrets({
        VPOINT_PAY_REFRESH_TOKEN: credential.refreshToken,
        VPOINT_PAY_DEVICE_UUID: credential.deviceUuid,
      }),
    ).toEqual(credential);
  });

  test("blank configuration is reported as missing", () => {
    expect(
      inspectCredential({ refreshToken: "  ", deviceUuid: " " }, "worker-secrets").missingFields,
    ).toEqual(["refresh-token", "device-uuid"]);
  });
});
