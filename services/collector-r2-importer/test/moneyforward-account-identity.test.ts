import { expect, test } from "bun:test";
import { moneyForwardAccountKeys } from "../src/moneyforward-account-identity";
import type { VerifiedMoneyForwardArtifact } from "../src/moneyforward-schema";

const key = "ab".repeat(32);
function detail(ordinal: number, account: string, service: string): VerifiedMoneyForwardArtifact {
  return {
    artifact: {
      kind: "account-detail",
      accountOrdinal: ordinal,
    } as VerifiedMoneyForwardArtifact["artifact"],
    bytes: new TextEncoder().encode(
      `<input name="account[id_hash]" value="${account}"><input name="service[id]" value="${service}">`,
    ),
  };
}
function index(accounts: string[]): VerifiedMoneyForwardArtifact {
  return {
    artifact: { kind: "accounts-index" } as VerifiedMoneyForwardArtifact["artifact"],
    bytes: new TextEncoder().encode(
      accounts.map((account) => `<a href="/accounts/show/${account}">synthetic</a>`).join(""),
    ),
  };
}

test("HMAC identity survives ordinal movement and separates exact account/service tuples", async () => {
  const before = await moneyForwardAccountKeys(
    [index(["beta"]), detail(1, "beta", "service")],
    key,
  );
  const after = await moneyForwardAccountKeys(
    [index(["alpha", "beta"]), detail(1, "alpha", "service"), detail(2, "beta", "service")],
    key,
  );
  expect(before.get(1) === after.get(2)).toBe(true);
  expect(after.get(1) !== after.get(2)).toBe(true);
  const differentService = await moneyForwardAccountKeys([detail(1, "beta", "other")], key);
  expect(before.get(1) !== differentService.get(1)).toBe(true);
  const tupleA = await moneyForwardAccountKeys([detail(1, "ab", "c")], key);
  const tupleB = await moneyForwardAccountKeys([detail(1, "a", "bc")], key);
  expect(tupleA.get(1) !== tupleB.get(1)).toBe(true);
  expect(
    [...after.values()].every((value) => /^moneyforward-account-v1-[0-9a-f]{64}$/u.test(value)),
  ).toBe(true);
  expect(JSON.stringify([...after.values()])).not.toContain("beta");
});

test("rejects duplicate identities, index/detail mismatch and invalid opaque input", async () => {
  await expect(
    moneyForwardAccountKeys([detail(1, "same", "service"), detail(2, "same", "service")], key),
  ).rejects.toThrow("account_identity_duplicate");
  await expect(
    moneyForwardAccountKeys([index(["alpha", "beta"]), detail(1, "beta", "service")], key),
  ).rejects.toThrow("account_identity_index_mismatch");
  for (const invalid of ["", "has space", "opaque/slash", "x".repeat(4097)]) {
    await expect(moneyForwardAccountKeys([detail(1, invalid, "service")], key)).rejects.toThrow(
      "account_identity_invalid",
    );
  }
});
