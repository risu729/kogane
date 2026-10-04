import { expect, test } from "bun:test";
import { smbcAccountContext, validSmbcAccountContext } from "../src/smbc-account-context.ts";
import { observedBankAccountReference } from "../src/card-debit-account.ts";

test("the selected branch and account retain leading zeros without copying credentials", () => {
  const context = smbcAccountContext("0123", "0012345");
  expect(context).toEqual({
    basis: "authenticated-request-v1",
    accountType: "ordinary",
    branchCode: "123",
    accountNumber: "0012345",
  });
  expect(smbcAccountContext("123", "0012345")).toEqual(context);
  for (const [branch, account] of [
    ["1123", "0012345"],
    ["12", "0012345"],
    ["123", "12345"],
    ["123", "１２３４５６７"],
  ])
    expect(smbcAccountContext(branch!, account!)).toBeNull();
  expect(validSmbcAccountContext({ ...context, password: "synthetic" })).toBe(false);
  expect(validSmbcAccountContext({ ...context, basis: "provider-confirmed" })).toBe(false);
});

test("only a pinned transaction can supply SMBC comparison evidence", () => {
  const input = {
    sourceId: "smbc-bank",
    sourceAccount: "smbc-bank:ordinary-yen",
    context: smbcAccountContext("123", "0012345"),
    ref: { kind: "transaction" as const, id: "transaction:12", revision: "parse_run:8" },
  };
  expect(observedBankAccountReference(input)).toMatchObject({
    comparable: true,
    accountNumber: "0012345",
    evidenceRefs: [input.ref],
  });
  for (const changed of [
    { context: null },
    { sourceId: "sbi-shinsei-bank" },
    { sourceAccount: "unknown" },
    { ref: { ...input.ref, revision: "unknown" } },
    { ref: { kind: "balance" as const, id: "balance:1", revision: "parse_run:8" } },
  ])
    expect(observedBankAccountReference({ ...input, ...changed }).comparable).toBe(false);
});
