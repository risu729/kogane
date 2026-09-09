// The policy selector is pure: no database, no clock. These tests pin which
// family and release a parse gets for a given evidence set, and that the
// dependency digest names the evidence, not only the release.
import { expect, test } from "bun:test";
import {
  BASE_IDENTITY_POLICY_VERSION,
  canonicalDependencySet,
  DEFAULT_POLICY_FAMILY,
  dependencyDigest,
  IDENTITY_POLICY_VERSION,
  NO_EVIDENCE,
  requiredIdentityPolicySql,
  selectIdentityPolicy,
  VPASS_POLICY_FAMILY,
  type VpassBinding,
} from "../src/identity-policies/index.ts";

const parse = (source: string) => ({
  id: 1,
  artifact_id: 1,
  source_id: source,
  producer_id: "collector-r2-importer",
  fetch_run_id: 1,
});
const binding = (token = "a"): VpassBinding => ({
  financial_unit_id: 10,
  financial_unit_key: "card-001",
  binding_artifact_id: 20,
  card_token: `vpass-card-v1-${token.repeat(64)}`,
});

test("policy 2 is selected only with exactly one trusted Vpass binding; otherwise policy 1", () => {
  const trusted = selectIdentityPolicy(parse("vpass"), { vpassBindings: [binding()] });
  expect(trusted).toMatchObject({
    policyFamily: VPASS_POLICY_FAMILY,
    release: "vpass-card-binding-v2",
    policyVersion: 2,
    eligibility: { status: "eligible" },
  });
  expect(trusted.dependencySet).toEqual([
    {
      kind: "trusted-vpass-card-binding",
      financialUnitId: 10,
      bindingArtifactId: 20,
      cardToken: `vpass-card-v1-${"a".repeat(64)}`,
    },
  ]);
  expect(selectIdentityPolicy(parse("vpass"), NO_EVIDENCE)).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v1",
    policyVersion: BASE_IDENTITY_POLICY_VERSION,
    dependencySet: [],
    eligibility: { status: "fallback", family: VPASS_POLICY_FAMILY, reason: "binding-missing" },
  });
  expect(
    selectIdentityPolicy(parse("vpass"), { vpassBindings: [binding("a"), binding("b")] })
      .eligibility,
  ).toEqual({ status: "fallback", family: VPASS_POLICY_FAMILY, reason: "binding-ambiguous" });
  // Other sources never consume Vpass evidence, even if a caller passes some.
  expect(selectIdentityPolicy(parse("smbc-bank"), { vpassBindings: [binding()] })).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v1",
    policyVersion: 1,
    dependencySet: [],
    eligibility: { status: "eligible" },
  });
});

test("explicit versions are stored as requested; the standard request falls back to base", () => {
  expect(
    selectIdentityPolicy(parse("smbc-bank"), NO_EVIDENCE, IDENTITY_POLICY_VERSION),
  ).toMatchObject({ policyVersion: BASE_IDENTITY_POLICY_VERSION });
  expect(selectIdentityPolicy(parse("smbc-bank"), NO_EVIDENCE, 10)).toMatchObject({
    release: "identity-default-v10",
    policyVersion: 10,
  });
  expect(selectIdentityPolicy(parse("vpass"), NO_EVIDENCE, 10)).toMatchObject({
    policyFamily: DEFAULT_POLICY_FAMILY,
    policyVersion: 10,
  });
  expect(selectIdentityPolicy(parse("vpass"), { vpassBindings: [binding()] }, 10)).toMatchObject({
    policyFamily: VPASS_POLICY_FAMILY,
    policyVersion: 10,
  });
  expect(selectIdentityPolicy(parse("vpass"), { vpassBindings: [binding()] }, 1)).toMatchObject({
    policyFamily: DEFAULT_POLICY_FAMILY,
    policyVersion: 1,
  });
  for (const version of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(() => selectIdentityPolicy(parse("smbc-bank"), NO_EVIDENCE, version)).toThrow(
      "identity_version_invalid",
    );
});

test("the same release over a different evidence set has a different dependency digest", async () => {
  const a = selectIdentityPolicy(parse("vpass"), { vpassBindings: [binding("a")] });
  const b = selectIdentityPolicy(parse("vpass"), { vpassBindings: [binding("b")] });
  expect(a.release).toBe(b.release);
  const [digestA, digestB, again] = await Promise.all([
    dependencyDigest(a.dependencySet),
    dependencyDigest(b.dependencySet),
    dependencyDigest(a.dependencySet),
  ]);
  expect(digestA).toMatch(/^[0-9a-f]{64}$/u);
  expect(digestA).not.toBe(digestB);
  expect(again).toBe(digestA);
  expect(await dependencyDigest([])).toBe(
    await dependencyDigest(selectIdentityPolicy(parse("smbc-bank"), NO_EVIDENCE).dependencySet),
  );
  // Set order is not part of the identity of the evidence.
  const set = [a.dependencySet[0]!, b.dependencySet[0]!];
  expect(canonicalDependencySet([...set].reverse())).toEqual(canonicalDependencySet(set));
  expect(await dependencyDigest([...set].reverse())).toBe(await dependencyDigest(set));
});

test("the required-policy SQL keeps the audited eligibility expression and validates its alias", () => {
  expect(requiredIdentityPolicySql("a").replace(/\s+/gu, " ")).toBe(
    "CASE WHEN a.source_id='vpass' AND EXISTS( SELECT 1 FROM trusted_vpass_card_bindings binding WHERE binding.financial_artifact_id=a.id) THEN 2 ELSE 1 END",
  );
  for (const alias of ["", "1a", "a.b", "a;", "a b"])
    expect(() => requiredIdentityPolicySql(alias)).toThrow("identity_sql_alias_invalid");
});
