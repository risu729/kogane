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
  MIZUHO_POLICY_VERSION,
  MYJCB_POLICY_VERSION,
  NO_EVIDENCE,
  SBI_SECURITIES_POLICY_VERSION,
  SBI_SHINSEI_POLICY_VERSION,
  SMBC_BANK_POLICY_VERSION,
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
  expect(selectIdentityPolicy(parse("st-george"), { vpassBindings: [binding()] })).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v1",
    policyVersion: 1,
    dependencySet: [],
    eligibility: { status: "eligible" },
  });
  expect(selectIdentityPolicy(parse("smbc-bank"), { vpassBindings: [binding()] })).toMatchObject({
    policyFamily: DEFAULT_POLICY_FAMILY,
    policyVersion: 1,
    dependencySet: [],
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

test("every Mizuho parse requires policy 2 of the default family, with no evidence", () => {
  expect(MIZUHO_POLICY_VERSION).toBe(2);
  // Policy-1 runs sealed before the resolver's `mizuho-bank` rule are
  // re-identified; the rule depends on no evidence, so nothing can fall back.
  const expected = {
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v2",
    policyVersion: 2,
    dependencySet: [],
    eligibility: { status: "eligible" as const },
  };
  expect(selectIdentityPolicy(parse("mizuho-bank"), NO_EVIDENCE)).toEqual(expected);
  expect(selectIdentityPolicy(parse("mizuho-bank"), { vpassBindings: [binding()] })).toEqual(
    expected,
  );
  expect(selectIdentityPolicy(parse("mizuho-bank"), NO_EVIDENCE, 1)).toMatchObject({
    release: "identity-default-v1",
    policyVersion: 1,
  });
  expect(selectIdentityPolicy(parse("mizuho-bank"), NO_EVIDENCE, 10)).toMatchObject({
    release: "identity-default-v10",
    policyVersion: 10,
  });
});

test("every SBI Shinsei parse requires policy 2 of the default family, with no evidence", () => {
  expect(SBI_SHINSEI_POLICY_VERSION).toBe(2);
  // Policy-1 runs mapped the parser's non-account references as deposits;
  // they are re-identified append-only (ADR 0076), and nothing can fall back.
  const expected = {
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v2",
    policyVersion: 2,
    dependencySet: [],
    eligibility: { status: "eligible" as const },
  };
  expect(selectIdentityPolicy(parse("sbi-shinsei-bank"), NO_EVIDENCE)).toEqual(expected);
  expect(selectIdentityPolicy(parse("sbi-shinsei-bank"), { vpassBindings: [binding()] })).toEqual(
    expected,
  );
  // An explicit policy-1 run is stored as requested and keeps policy 1's rule.
  expect(selectIdentityPolicy(parse("sbi-shinsei-bank"), NO_EVIDENCE, 1)).toMatchObject({
    release: "identity-default-v1",
    policyVersion: 1,
  });
  expect(selectIdentityPolicy(parse("sbi-shinsei-bank"), NO_EVIDENCE, 10)).toMatchObject({
    release: "identity-default-v10",
    policyVersion: 10,
  });
  // SBI Securities is a different source: without its own evidence it keeps
  // the base policy.
  expect(selectIdentityPolicy(parse("sbi-securities"), NO_EVIDENCE)).toMatchObject({
    policyVersion: BASE_IDENTITY_POLICY_VERSION,
  });
});

test("only SBI Securities foreign positions captures require policy 2 of the default family", () => {
  expect(SBI_SECURITIES_POLICY_VERSION).toBe(2);
  // Policy-1 runs gave a code with no RIC, MIC or country the shared
  // `unknown-country` scope (ADR 0113); only the positions parser can emit
  // that shape, so only its parses are re-identified append-only.
  const positions = { ...NO_EVIDENCE, sbiForeignPositionsArtifact: true };
  expect(selectIdentityPolicy(parse("sbi-securities"), positions)).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v2",
    policyVersion: 2,
    dependencySet: [],
    eligibility: { status: "eligible" },
  });
  // An explicit policy-1 run is stored as requested and keeps policy 1's rule.
  expect(selectIdentityPolicy(parse("sbi-securities"), positions, 1)).toMatchObject({
    release: "identity-default-v1",
    policyVersion: 1,
  });
  // Every other SBI Securities capture keeps the base policy, so its source
  // accounts and identifiers gain no revision.
  expect(selectIdentityPolicy(parse("sbi-securities"), NO_EVIDENCE)).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v1",
    policyVersion: BASE_IDENTITY_POLICY_VERSION,
    dependencySet: [],
    eligibility: {
      status: "fallback",
      family: DEFAULT_POLICY_FAMILY,
      reason: "not-a-foreign-positions-capture",
    },
  });
  expect(
    selectIdentityPolicy(parse("sbi-securities"), {
      ...NO_EVIDENCE,
      sbiForeignPositionsArtifact: false,
    }),
  ).toMatchObject({ policyVersion: BASE_IDENTITY_POLICY_VERSION });
  // Another source never consumes the flag.
  expect(selectIdentityPolicy(parse("st-george"), positions)).toMatchObject({
    policyVersion: BASE_IDENTITY_POLICY_VERSION,
    eligibility: { status: "eligible" },
  });
  expect(selectIdentityPolicy(parse("smbc-bank"), positions)).toMatchObject({
    policyVersion: BASE_IDENTITY_POLICY_VERSION,
    eligibility: { status: "fallback", reason: "not-a-foreign-ordinary-aud-balance-capture" },
  });
});

test("only SMBC AUD foreign ordinary balance captures require policy 2 of the default family", () => {
  expect(SMBC_BANK_POLICY_VERSION).toBe(2);
  // Policy-1 runs mapped the AUD reference as unrecognized (ADR 0118); only
  // the balance parser emits it, so only its parses are re-identified.
  const aud = { ...NO_EVIDENCE, smbcForeignOrdinaryAudBalanceArtifact: true };
  expect(selectIdentityPolicy(parse("smbc-bank"), aud)).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v2",
    policyVersion: 2,
    dependencySet: [],
    eligibility: { status: "eligible" },
  });
  // An explicit policy-1 run is stored as requested and keeps policy 1's rule.
  expect(selectIdentityPolicy(parse("smbc-bank"), aud, 1)).toMatchObject({
    release: "identity-default-v1",
    policyVersion: 1,
  });
  // Every other SMBC capture (the yen deposit, the empty AUD history) keeps
  // the base policy, so the yen account's mapping, which card-settlement
  // ownership evidence cites by id, gains no revision.
  expect(selectIdentityPolicy(parse("smbc-bank"), NO_EVIDENCE)).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v1",
    policyVersion: BASE_IDENTITY_POLICY_VERSION,
    dependencySet: [],
    eligibility: {
      status: "fallback",
      family: DEFAULT_POLICY_FAMILY,
      reason: "not-a-foreign-ordinary-aud-balance-capture",
    },
  });
  expect(
    selectIdentityPolicy(parse("smbc-bank"), {
      ...NO_EVIDENCE,
      smbcForeignOrdinaryAudBalanceArtifact: false,
    }),
  ).toMatchObject({ policyVersion: BASE_IDENTITY_POLICY_VERSION });
  // Another source never consumes the flag.
  for (const source of ["sbi-securities", "myjcb", "st-george"])
    expect(selectIdentityPolicy(parse(source), aud)).toMatchObject({
      policyVersion: BASE_IDENTITY_POLICY_VERSION,
    });
});

test("only MyJCB J-POINT captures require policy 2 of the default family", () => {
  expect(MYJCB_POLICY_VERSION).toBe(2);
  // Policy-1 runs sealed before the resolver's J-POINT rule mapped the total
  // as unrecognized; those parses are re-identified append-only.
  const jpoint = { ...NO_EVIDENCE, myJcbJPointArtifact: true };
  expect(selectIdentityPolicy(parse("myjcb"), jpoint)).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v2",
    policyVersion: 2,
    dependencySet: [],
    eligibility: { status: "eligible" },
  });
  expect(selectIdentityPolicy(parse("myjcb"), jpoint, 1)).toMatchObject({
    release: "identity-default-v1",
    policyVersion: 1,
  });
  // A statement capture keeps the base policy, so its root mapping is never
  // re-revised (card-settlement ownership evidence cites the mapping id).
  expect(selectIdentityPolicy(parse("myjcb"), NO_EVIDENCE)).toEqual({
    policyFamily: DEFAULT_POLICY_FAMILY,
    release: "identity-default-v1",
    policyVersion: BASE_IDENTITY_POLICY_VERSION,
    dependencySet: [],
    eligibility: {
      status: "fallback",
      family: DEFAULT_POLICY_FAMILY,
      reason: "not-a-jpoint-capture",
    },
  });
  expect(
    selectIdentityPolicy(parse("myjcb"), { ...NO_EVIDENCE, myJcbJPointArtifact: false }),
  ).toMatchObject({ policyVersion: BASE_IDENTITY_POLICY_VERSION });
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
    "CASE WHEN a.source_id='vpass' AND EXISTS( SELECT 1 FROM trusted_vpass_card_bindings binding WHERE binding.financial_artifact_id=a.id) THEN 2 WHEN a.source_id='mizuho-bank' THEN 2 WHEN a.source_id='sbi-shinsei-bank' THEN 2 WHEN a.source_id='myjcb' AND a.dataset='jpoint-balance' THEN 2 WHEN a.source_id='sbi-securities' AND a.dataset='foreign-cash-positions' THEN 2 WHEN a.source_id='smbc-bank' AND a.dataset='foreign-ordinary-aud-balance' THEN 2 ELSE 1 END",
  );
  for (const alias of ["", "1a", "a.b", "a;", "a b"])
    expect(() => requiredIdentityPolicySql(alias)).toThrow("identity_sql_alias_invalid");
});
