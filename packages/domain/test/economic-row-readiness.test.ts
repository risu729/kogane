import { expect, test } from "bun:test";
import {
  evaluateEconomicRowReadiness,
  validEconomicRowReadinessRequest,
  type EconomicRowEvidence,
} from "../src/economic-row-readiness.ts";
const bank = (): EconomicRowEvidence => ({
  observation_id: 1,
  parse_run_id: 2,
  found: 1,
  restricted: 0,
  visible: 1,
  current_parse: 2,
  source_id: "smbc-bank",
  parser_name: "smbc-direct-transactions",
  source_account: "synthetic-account",
  external_id: "synthetic-row",
  extra_json: JSON.stringify({ id: "synthetic-row", _kogane: { identityOrigin: "provider-id" } }),
  key_text: JSON.stringify([
    "smbc-bank",
    "synthetic-producer",
    null,
    "synthetic-account",
    "synthetic-row",
  ]),
  alias_text: null,
  mapping_count: 1,
  mapping_status: "identified",
  account_id: "synthetic-canonical",
  owner_ref: null,
  key_holders: "[]",
  alias_holders: "[]",
  pins: "{}",
});
test("provider id identity admitted but owner principal contract remains unresolved", () => {
  expect(evaluateEconomicRowReadiness("bank-movement", bank())).toEqual({
    readiness: "blocked",
    identity: "admitted",
    reasons: ["ownership_unresolved"],
  });
});
test("security fingerprint cannot become admitted by declaring an origin or owner", () => {
  const row = {
    ...bank(),
    source_id: "sbi-securities",
    parser_name: "sbi-domestic-trade-records",
    owner_ref: "party:self",
  };
  const result = evaluateEconomicRowReadiness("securities-execution", row);
  expect(result.identity).toBe("blocked");
  expect(result.reasons).toContain("identity_fingerprint_only");
});
test.each([
  [{ found: 0 }, "observation_missing", "unavailable"],
  [{ restricted: 1, extra_json: "malformed" }, "evidence_restricted", "blocked"],
  [{ visible: 0 }, "evidence_unavailable", "unavailable"],
] as const)("early refusal %j", (patch, reason, readiness) => {
  expect(evaluateEconomicRowReadiness("bank-movement", { ...bank(), ...patch })).toEqual({
    identity: "unavailable",
    readiness,
    reasons: [reason],
  });
});
test.each([
  [{ mapping_count: 0 }, "account_mapping_unresolved"],
  [{ mapping_count: 2 }, "account_mapping_ambiguous"],
  [{ mapping_status: "aggregate" }, "account_mapping_unresolved"],
  [{ account_id: null }, "account_mapping_unresolved"],
  [{ extra_json: "bad json" }, "identity_origin_unrecorded"],
  [{ extra_json: null }, "identity_origin_unrecorded"],
  [{ source_id: "unknown" }, "family_mismatch"],
  [{ current_parse: 3 }, "evidence_not_current"],
  [{ key_text: null }, "identity_key_invalid"],
  [{ key_text: "[1]" }, "identity_key_invalid"],
  [{ key_holders: '[["e",1]]' }, "economic_claim_held"],
  [{ alias_holders: '[["e",1]]' }, "alias_conflict"],
] as const)("closed reason %j", (patch, reason) => {
  expect(evaluateEconomicRowReadiness("bank-movement", { ...bank(), ...patch }).reasons).toContain(
    reason,
  );
});
test("exact keys, integers, duplicate observations, bounds and current knowledge only", () => {
  const req = {
    schema: "economic-row-readiness-v1",
    family: "bank-movement",
    knowledge: "current",
    rows: [{ observationId: 1, parseRunId: 2 }],
  };
  expect(validEconomicRowReadinessRequest(req)).toBe(true);
  for (const x of [
    null,
    [],
    {},
    { ...req, family: "card-purchase" },
    { ...req, schema: "future" },
    { ...req, knowledge: "known-at" },
    { ...req, policy: {} },
    { ...req, rows: [] },
    { ...req, rows: [{ observationId: 0, parseRunId: 2 }] },
    { ...req, rows: [{ observationId: 1.5, parseRunId: 2 }] },
    { ...req, rows: [{ observationId: 1, parseRunId: -1 }] },
    { ...req, rows: [{ observationId: 1, parseRunId: 2, accountId: "unsafe" }] },
    {
      ...req,
      rows: [
        { observationId: 1, parseRunId: 2 },
        { observationId: 1, parseRunId: 3 },
      ],
    },
  ])
    expect(validEconomicRowReadinessRequest(x)).toBe(false);
});
