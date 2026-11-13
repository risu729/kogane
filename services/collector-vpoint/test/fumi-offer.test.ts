import { describe, expect, test } from "bun:test";
import {
  FUMI_MANIFEST_JSON,
  FUMI_MANIFEST_VERSION,
  FUMI_PLUGIN_ID,
  fumiRequestSha256,
  freshAttempt,
  parseFumiOffer,
  sha256,
  type FumiOfferRequest,
} from "../src/fumi-offer";
import { VPOINT_EMAIL_SUBJECT } from "../src/email";

async function request(): Promise<FumiOfferRequest> {
  const receivedAt = new Date().toISOString();
  const value: FumiOfferRequest = {
    schemaVersion: 1,
    kind: "owner",
    operationId: "a".repeat(64),
    requestSha256: "",
    attempt: { generation: 1, expiresAt: Date.now() + 5000 },
    source: { eventId: "b".repeat(64), rawSha256: "c".repeat(64), receivedAt },
    pluginId: FUMI_PLUGIN_ID,
    manifestVersion: FUMI_MANIFEST_VERSION,
    manifestSha256: await sha256(FUMI_MANIFEST_JSON),
    input: {
      subject: VPOINT_EMAIL_SUBJECT,
      envelope: {
        from: "provider@example.invalid",
        to: "synthetic-otp@example.invalid",
        receivedAt,
      },
      text: "1234",
    },
  };
  value.requestSha256 = await fumiRequestSha256(value);
  return value;
}
describe("Fumi owner protocol", () => {
  test("pins owner-maintained metadata matching and explicit body/envelope disclosure", () => {
    expect(JSON.parse(FUMI_MANIFEST_JSON)).toMatchObject({
      protocol: "fumi-offer-v1",
      inputFields: ["subject"],
      offerInputFields: ["subject", "envelope", "text"],
      capabilities: ["offer"],
      mode: "exclusive",
    });
  });
  test("hashes canonical immutable inputs while generation/expiry stay outside the digest", async () => {
    const value = await request();
    expect(await parseFumiOffer(value)).toEqual(value);
    expect(await fumiRequestSha256({ ...value, attempt: { generation: 10, expiresAt: 0 } })).toBe(
      value.requestSha256,
    );
    expect(await fumiRequestSha256({ ...value, input: { ...value.input, text: "5678" } })).not.toBe(
      value.requestSha256,
    );
    await expect(
      parseFumiOffer({ ...value, input: { ...value.input, text: "5678" } }),
    ).rejects.toThrow("Invalid Fumi owner request");
  });
  test("rejects unknown fields, invalid envelope time and excessive disclosures", async () => {
    const value = await request();
    for (const changed of [
      { ...value, url: "https://untrusted.invalid" },
      { ...value, input: { ...value.input, text: "x".repeat(16385) } },
      {
        ...value,
        input: { ...value.input, envelope: { ...value.input.envelope, receivedAt: "invalid" } },
      },
    ]) {
      await expect(parseFumiOffer(changed)).rejects.toThrow("Invalid Fumi owner request");
    }
  });
  test("bounds attempt expiry without extending a stale generation", async () => {
    const value = await request(),
      now = Date.now();
    expect(freshAttempt(value, now)).toBe(true);
    expect(freshAttempt({ attempt: { generation: 1, expiresAt: now } }, now)).toBe(false);
    expect(freshAttempt({ attempt: { generation: 1, expiresAt: now + 10001 } }, now)).toBe(false);
  });
});
