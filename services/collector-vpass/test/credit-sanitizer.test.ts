import { expect, test } from "bun:test";
import { sanitizedCreditEnvelopeBytes, sanitizedEnvelopeBytes } from "../src/sanitize";
import { authori, revo } from "../../../packages/parsers/test/fixtures/vpass-credit";
import { vpassCreditRunPlan } from "../src/shared-collection";
import { envelope } from "../../../packages/parsers/test/fixtures/vpass-credit";
test("credit sanitizer keeps Authori financial data and precision while removing auth and card references", () => {
  const source = authori();
  const raw = JSON.stringify({
    ...source,
    header: {
      ...source.header,
      authToken: "synthetic-secret",
      cardIdentifyKey: "synthetic-card-key",
    },
  });
  const sanitized = new TextDecoder().decode(
    sanitizedCreditEnvelopeBytes(raw, "credit_json_invalid"),
  );
  expect(sanitized).toContain('"authoriShokaiVo":{');
  expect(sanitized).toContain('"cardBalance":"123"');
  expect(sanitized).not.toContain("synthetic-secret");
  expect(sanitized).not.toContain("synthetic-card-key");
  expect(sanitized).not.toContain("externalId");
  const old = new TextDecoder().decode(sanitizedEnvelopeBytes(raw, "credit_json_invalid"));
  expect(old).toContain('"AuthoriShokaiDisplayServiceBean":"<redacted-vpass-sensitive>"');
});
test("snapshot run keeps the existing card-NNN plus durable-binding unit shape", async () => {
  const run = {
    sessionRunId: "synthetic-session",
    cardLabel: "card-001",
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:01:00Z",
    cardListRawJson: JSON.stringify(
      envelope({
        DropdownListInitDisplayServiceBean: {
          multiCardInfoList: [{ name: "Synthetic card 1", value: "synthetic-key" }],
        },
      }),
    ),
    selectCardRawJson: JSON.stringify(envelope({})),
    webMeisaiTopRawJson: JSON.stringify(envelope({})),
    months: {},
  };
  const plan = await vpassCreditRunPlan(run, {
    authori: JSON.stringify(authori()),
    revo: JSON.stringify(revo()),
  });
  const wrongCard = { ...revo(), header: envelope({}, 2).header };
  await expect(
    vpassCreditRunPlan(run, {
      authori: JSON.stringify(authori()),
      revo: JSON.stringify(wrongCard),
    }),
  ).rejects.toThrow("credit_binding_mismatch");
  expect(plan.run.runId).toBe("synthetic-session-credit-card-001");
  expect(plan.run.acquisitionSessionRef).toBe("synthetic-session");
  expect(plan.run.units).toHaveLength(2);
  expect(plan.run.units[0]).toMatchObject({
    unitKey: "card-001",
    artifactCount: 5,
    coverageStatus: "complete",
  });
  expect(plan.run.units[1]?.unitKey).toMatch(/^vpass-card-v2-[a-f0-9]{64}$/u);
  expect(
    plan.run.transformations
      .filter((row) => row.outputArtifactKey.startsWith("credit/"))
      .map((row) => row.transformerId),
  ).toEqual(["vpass-credit-json-sanitizer", "vpass-credit-json-sanitizer"]);
});
