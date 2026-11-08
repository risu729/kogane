import { expect, test } from "vitest";
import { credentialDigest } from "../src/worker-policy";

// The pause's credential-change exit depends on this digest running in workerd,
// whose PBKDF2 accepts at most 100,000 iterations. If it threw there, the
// fingerprint would be null and a changed credential could never lift a pause.
test("the credential digest runs in the Workers runtime", async () => {
  const salt = btoa("synthetic-salt-0");
  const credential = { userId: "u", securityNumber: "1", password: "p" };
  const digest = await credentialDigest(credential, salt);
  expect(digest).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
  expect(await credentialDigest(credential, salt)).toBe(digest);
  expect(await credentialDigest({ ...credential, password: "q" }, salt)).not.toBe(digest);
});
