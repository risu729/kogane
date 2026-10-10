// U09 for Vpass: the shared DATA target. Synthetic fixtures only — every
// value below is invented and no provider is contacted.
//
// Acceptance rows: G1-01 (a failed put writes no terminal), G1-02 (the
// terminal follows every put and its references match what is stored), G1-08
// (coverage stays partial for a rolling statement window), G1-09 (a failed run
// persists no artifact), G1-15 (shared mode never calls the legacy importer or
// bucket), G1-16 (one session, one run per card, provenance kept),
// G3-07/G3-08 (no cookie, auth blob, card reference or provider text is
// stored or logged).
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  objectKey,
  readTerminal,
  terminalKey,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import { sanitizedEnvelopeBytes, VpassSanitizeError } from "../src/sanitize";
import { deriveVpassCardBinding } from "../src/card-binding";
import {
  persistCardRun,
  persistFailedRun,
  sharedRunDiagnostic,
  vpassCardRunPlan,
  type VpassCardRun,
} from "../src/shared-collection";
import worker from "../src/worker";

const sessionRunId = "2026-09-11T21-00-00-000Z";
const secret = "synthetic-session-material";

function envelope(content: Record<string, unknown>): string {
  return JSON.stringify({
    header: { resultCode: 0, requestHash: 1, requestTimestamp: 1 },
    body: { content },
  });
}

const cardListRawJson = envelope({
  DropdownListInitDisplayServiceBean: {
    multiCardInfoList: [
      { name: "SYNTHETIC CARD NAME", value: "synthetic-card-identify-key" },
      { name: "SECOND SYNTHETIC CARD", value: "second-synthetic-key" },
    ],
  },
});
const selectCardRawJson = envelope({
  MultiCardUpdateBean: { cardIdentifyKey: "synthetic-card-identify-key", sessionToken: secret },
});
const webMeisaiTopRawJson = envelope({
  WebMeisaiTopDisplayServiceBean: {
    seikyuYMList: [{ value: "202609" }, { value: "202608" }],
    authToken: secret,
  },
});
// The live finalized page states `allCnt` as a JSON string (2026-09-27, field
// types only); the fixture mirrors that type.
const pageRawJson = envelope({
  WebMeisaiTopDisplayServiceBean: {
    meisaiList: [{ amount: 1234, shop: "SYNTHETIC SHOP" }],
    webMeisaiTopK3Vo: { allCnt: "1", nextPageRow: 2 },
  },
});

function run(overrides: Partial<VpassCardRun> = {}): VpassCardRun {
  return {
    sessionRunId,
    cardLabel: "card-001",
    startedAt: "2026-09-11T21:00:00.000Z",
    completedAt: "2026-09-11T21:04:00.000Z",
    cardListRawJson,
    selectCardRawJson,
    webMeisaiTopRawJson,
    months: {
      "202609": { pages: [{ kind: "top", index: 0, rawJson: pageRawJson }], transactionCount: 1 },
      "202608": { pages: [{ kind: "top", index: 0, rawJson: pageRawJson }], transactionCount: 1 },
    },
    ...overrides,
  };
}

describe("G3-07/G3-08 the sanitizer runs before anything is stored", () => {
  test("session material and card references never reach the stored bytes", () => {
    const bytes = sanitizedEnvelopeBytes(selectCardRawJson, "card_selection_json_invalid");
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain(secret);
    expect(text).toContain("<redacted-vpass-sensitive>");
    // Canonical encoding with the trailing newline central storage holds.
    expect(text.endsWith("\n")).toBe(true);
    expect(text.startsWith('{"body":')).toBe(true);
  });

  test("the card inventory keeps ordinal labels instead of names and references", () => {
    const text = new TextDecoder().decode(
      sanitizedEnvelopeBytes(cardListRawJson, "card_list_json_invalid", true),
    );
    expect(text).not.toContain("SYNTHETIC CARD NAME");
    expect(text).not.toContain("synthetic-card-identify-key");
    expect(text).toContain("card-001");
    expect(text).toContain("<redacted-card-reference>");
  });

  test("a response that is not a successful envelope is refused, not stored", () => {
    expect(() => sanitizedEnvelopeBytes("{", "statement_page_json_invalid")).toThrow(
      VpassSanitizeError,
    );
    expect(() =>
      sanitizedEnvelopeBytes(
        JSON.stringify({ header: { resultCode: "9" }, body: {} }),
        "statement_page_json_invalid",
      ),
    ).toThrow("statement_page_json_invalid");
  });
});

describe("G1-02/G1-08/G1-16 a card run persists its sanitized set and then the terminal", () => {
  test("objects, roles and the terminal describe what is stored", async () => {
    const bucket = new FakeR2Bucket();
    const outcome = await persistCardRun(bucket, run());
    expect(outcome.result.outcome).toBe("persisted");

    const runId = `${sessionRunId}-card-001`;
    expect(bucket.putKeys.at(-1)).toBe(terminalKey("vpass", runId));
    const read = await readTerminal(bucket, "vpass", runId);
    if (read.outcome !== "found") throw new Error("unreachable");
    const manifest = read.manifest;
    expect(manifest.producer).toBe("collector-vpass");
    expect(manifest.producerVersion).toBe("vpass-worker-card-v1");
    // G1-16: the card is its own run and keeps the session it came from.
    expect(manifest.runId).toBe(runId);
    expect(manifest.acquisitionSessionRef).toBe(sessionRunId);
    expect(manifest.providerOutcome).toBe("success");
    // G1-08: a card exposes a rolling window of months, so a finished run is
    // not a claim about the card's whole history.
    expect(manifest.coverageStatus).toBe("partial");
    expect(
      manifest.artifacts.map((artifact) => [artifact.artifactKey, artifact.role] as const),
    ).toEqual([
      ["card-list.json", "sanitized_provider_capture"],
      ["manifest.json", "collector_manifest"],
      // A statement page is sanitizer output with a `redacted` step, which
      // CORE seals only on a sanitized capture (ADR 0021).
      ["months/202608/top-000.json", "sanitized_provider_capture"],
      ["months/202609/top-000.json", "sanitized_provider_capture"],
      ["select-card.json", "sanitized_provider_capture"],
      ["web-meisai-top.json", "sanitized_provider_capture"],
    ]);
    // The card unit counts its five envelopes; the run manifest belongs to the
    // run and names no unit (ADR 0021). The unit collected every month the
    // provider listed, so it is complete; the rolling window's gap is the
    // run's (ADR 0023).
    expect(manifest.units).toEqual([
      { unitKey: "card-001", unitKind: "card", artifactCount: 5, coverageStatus: "complete" },
    ]);
    expect(
      manifest.artifacts.find((artifact) => artifact.artifactKey === "manifest.json")?.unitKey,
    ).toBeUndefined();
    expect(manifest.ranges).toEqual([
      {
        rangeKey: "statement-months",
        rangeKind: "declared_coverage",
        precision: "month",
        basis: "manifest",
        startValue: "2026-08",
        endValue: "2026-09",
        unitKey: "card-001",
      },
    ]);
    // Every stored object is the sanitizer's output and the provider bytes
    // were deliberately not retained.
    expect(manifest.transformations).toHaveLength(5);
    expect(manifest.transformations[0]).toEqual({
      transformationId: "redacted:card-list.json",
      stepKind: "redacted",
      transformerId: "vpass-json-sanitizer",
      transformerVersion: "v1",
      inputArtifactKeys: [],
      outputArtifactKey: "card-list.json",
    });
    expect(await verifyReferencedObjects(bucket, manifest)).toMatchObject({
      outcome: "ok",
      problems: [],
    });

    // Nothing raw was stored anywhere in the bucket.
    for (const entry of bucket.entries.values()) {
      expect(new TextDecoder().decode(entry.bytes)).not.toContain(secret);
    }
    const summary = manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!;
    const body = await bucket.get(summary.storageRef.key);
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer())))).toEqual(
      {
        schemaVersion: "vpass-worker-card-v1",
        source: "vpass",
        runId: sessionRunId,
        card: "card-001",
        startedAt: "2026-09-11T21:00:00.000Z",
        completedAt: "2026-09-11T21:04:00.000Z",
        status: "success",
        coverage: "complete",
        monthCount: 2,
        pageCount: 2,
        transactionCount: 2,
        months: {
          "202608": {
            pages: 1,
            transactions: 1,
            capturedRows: 1,
            statedTotal: 1,
            coverage: "complete",
          },
          "202609": {
            pages: 1,
            transactions: 1,
            capturedRows: 1,
            statedTotal: 1,
            coverage: "complete",
          },
        },
      },
    );
  });

  test("two cards of one session are two runs that share the session ref", async () => {
    const bucket = new FakeR2Bucket();
    await persistCardRun(bucket, run());
    await persistCardRun(bucket, run({ cardLabel: "card-002" }));
    const terminals = [...bucket.entries.keys()].filter((key) => key.startsWith("runs/vpass/"));
    expect(terminals.sort()).toEqual([
      terminalKey("vpass", `${sessionRunId}-card-001`),
      terminalKey("vpass", `${sessionRunId}-card-002`),
    ]);
    for (const card of ["card-001", "card-002"]) {
      const read = await readTerminal(bucket, "vpass", `${sessionRunId}-${card}`);
      if (read.outcome !== "found") throw new Error("unreachable");
      expect(read.manifest.acquisitionSessionRef).toBe(sessionRunId);
      expect(read.manifest.units[0]?.unitKey).toBe(card);
    }
  });

  test("the same card written twice is a resend, not a second run", async () => {
    const bucket = new FakeR2Bucket();
    await persistCardRun(bucket, run());
    const objects = bucket.entries.size;
    const again = await persistCardRun(bucket, run());
    expect(again.result.outcome).toBe("already_persisted");
    expect(bucket.entries.size).toBe(objects);
  });
});

describe("ADR 0023 and ADR 0029 the collector derives the card binding before it sanitizes", () => {
  // The card binding token is derived from the selection and discovery
  // headers' session bean (external id, global id, card code), with no key.
  // Synthetic values of the lengths the importer required (32, 32 and 13).
  const externalId = "E".repeat(32);
  const globalid = "G".repeat(32);
  const cardCode = "C".repeat(13);
  const bean = (overrides: Record<string, unknown> = {}) => ({
    externalId,
    globalid,
    cardCode,
    cardName: "SYNTHETIC CARD NAME",
    ...overrides,
  });
  const withBean = (raw: string, value: unknown = bean()) => {
    const parsed = JSON.parse(raw) as { header: Record<string, unknown> };
    parsed.header["vpSessionBean"] = value;
    return JSON.stringify(parsed);
  };
  const bound = (overrides: Partial<VpassCardRun> = {}) =>
    run({
      selectCardRawJson: withBean(selectCardRawJson),
      webMeisaiTopRawJson: withBean(webMeisaiTopRawJson),
      ...overrides,
    });

  /** The v2 construction, written out independently of the module. */
  function independentToken(domain: string, tuple: readonly string[]): string {
    const digest = createHash("sha256")
      .update(JSON.stringify([domain, ...tuple]))
      .digest("hex");
    return `vpass-card-v2-${digest}`;
  }

  function texts(bucket: FakeR2Bucket): Map<string, string> {
    return new Map(
      [...bucket.entries].map(([key, entry]) => [key, new TextDecoder().decode(entry.bytes)]),
    );
  }

  test("the run holds one binding unit and artifact carrying the v2 token", async () => {
    const token = independentToken("vpass-card-binding-v2", [externalId, globalid, cardCode]);
    const bucket = new FakeR2Bucket();
    const outcome = await persistCardRun(bucket, bound());
    expect(outcome.result.outcome).toBe("persisted");
    expect(outcome.binding).toBe("bound");
    const read = await readTerminal(bucket, "vpass", `${sessionRunId}-card-001`);
    if (read.outcome !== "found") throw new Error("unreachable");
    const manifest = read.manifest;
    expect(manifest.units).toEqual([
      { unitKey: "card-001", unitKind: "card", artifactCount: 5, coverageStatus: "complete" },
      { unitKey: token, unitKind: "card", artifactCount: 1, coverageStatus: "complete" },
    ]);
    const binding = manifest.artifacts.find(
      (artifact) => artifact.artifactKey === "card-identity-binding.json",
    )!;
    expect(binding).toMatchObject({
      role: "collector_derived",
      mediaType: "application/json",
      unitKey: token,
    });
    // Lineage is stated: an `extracted` step with no input, because the
    // responses it was read from are stored only redacted.
    expect(
      manifest.transformations.filter(
        (step) => step.outputArtifactKey === "card-identity-binding.json",
      ),
    ).toEqual([
      {
        transformationId: "extracted:card-identity-binding.json",
        stepKind: "extracted",
        transformerId: "vpass-card-binding",
        transformerVersion: "v2",
        inputArtifactKeys: [],
        outputArtifactKey: "card-identity-binding.json",
      },
    ]);
    const body = await bucket.get(binding.storageRef.key);
    // The token and the derivation that made it; no key version, since the
    // v2 derivation has no key, and never the tuple.
    expect(JSON.parse(new TextDecoder().decode(new Uint8Array(await body!.arrayBuffer())))).toEqual(
      {
        schemaVersion: "vpass-card-binding-v2",
        accountIdentity: token,
        sourceSession: sessionRunId,
        sourceNamespace: "vpass-worker-card-v1",
        sourceCardOrdinal: "card-001",
        checks: { selectedCardDescriptor: true, selectionDiscoveryCardCode: true },
      },
    );
    expect(await verifyReferencedObjects(bucket, manifest)).toMatchObject({ outcome: "ok" });

    // No tuple value is stored anywhere, and the token appears only where it
    // is meant to: the terminal's unit key and the binding object itself.
    const bindingObject = objectKey(binding.sha256);
    const terminal = terminalKey("vpass", `${sessionRunId}-card-001`);
    for (const [key, text] of texts(bucket)) {
      for (const value of [externalId, globalid, cardCode, secret]) {
        expect(text).not.toContain(value);
      }
      if (key === bindingObject || key === terminal) {
        expect(text.replaceAll(token, "")).not.toContain("vpass-card-v");
      } else {
        expect(text).not.toContain("vpass-card-v");
      }
    }
    // The diagnostic carries a closed code, not the token.
    const diagnostic = JSON.stringify(sharedRunDiagnostic(manifest.runId, "card-001", outcome));
    expect(diagnostic).toContain('"binding":"bound"');
    expect(diagnostic).not.toContain("vpass-card-v");
  });

  test("a known-answer vector: the v2 token of the synthetic tuple is pinned", async () => {
    // Computed outside this code with
    //   printf '["vpass-card-binding-v2","E…E","G…G","C…C"]' | sha256sum
    // (32, 32 and 13 characters) and independently here with node:crypto. A
    // change to the construction (the domain string, the tuple order, the
    // JSON array, the prefix) fails here even if the module and
    // `independentToken` change together.
    const expected =
      "vpass-card-v2-22266091efe6bc3b708aef8f2063065035a8768d476ec4d2ba1558f5fa456821";
    expect(independentToken("vpass-card-binding-v2", [externalId, globalid, cardCode])).toBe(
      expected,
    );
    expect(await deriveVpassCardBinding(bound())).toEqual({ status: "derived", token: expected });
    // The domain string separates the derivation: the v1 domain, or the tuple
    // in another order, is another digest.
    expect(independentToken("vpass-card-binding-v1", [externalId, globalid, cardCode])).not.toBe(
      expected,
    );
    expect(independentToken("vpass-card-binding-v2", [globalid, externalId, cardCode])).not.toBe(
      expected,
    );
    // No key parameter exists any more.
    expect(deriveVpassCardBinding.length).toBe(1);
    expect(vpassCardRunPlan.length).toBe(1);
  });

  test("the token depends on the card tuple, not on the session or ordinal", async () => {
    const plan = async (overrides: Partial<VpassCardRun>) =>
      (await vpassCardRunPlan(bound(overrides))).run.units.at(-1)?.unitKey;
    const token = await plan({});
    expect(await plan({ sessionRunId: "2026-09-12T21-00-00-000Z" })).toBe(token);
    // The same card at another position in a later inventory keeps its token.
    const reordered = envelope({
      DropdownListInitDisplayServiceBean: {
        multiCardInfoList: [
          { name: "SECOND SYNTHETIC CARD", value: "rotated-selector-1" },
          { name: "SYNTHETIC CARD NAME", value: "rotated-selector-2" },
        ],
      },
    });
    expect(await plan({ cardLabel: "card-002", cardListRawJson: reordered })).toBe(token);
    expect(
      await plan({
        selectCardRawJson: withBean(selectCardRawJson, bean({ cardCode: "D".repeat(13) })),
        webMeisaiTopRawJson: withBean(webMeisaiTopRawJson, bean({ cardCode: "D".repeat(13) })),
      }),
    ).not.toBe(token);
  });

  test("without a tuple nothing is bound, and the responses are still redacted", async () => {
    {
      const bucket = new FakeR2Bucket();
      const outcome = await persistCardRun(bucket, run());
      expect(outcome.result.outcome).toBe("persisted");
      expect(outcome.binding).toBe("binding_tuple_absent");
      const read = await readTerminal(bucket, "vpass", `${sessionRunId}-card-001`);
      if (read.outcome !== "found") throw new Error("unreachable");
      expect(read.manifest.artifacts.map((artifact) => artifact.artifactKey)).not.toContain(
        "card-identity-binding.json",
      );
      expect(read.manifest.artifacts.map((artifact) => artifact.role)).not.toContain(
        "collector_derived",
      );
      expect(read.manifest.units.map((unit) => unit.unitKey)).toEqual(["card-001"]);
      for (const text of texts(bucket).values()) {
        for (const value of [externalId, globalid, cardCode, "vpass-card-v"]) {
          expect(text).not.toContain(value);
        }
      }
    }
  });

  test("every doubtful input fails closed with a closed code and stores no binding", async () => {
    const cases: [string, Partial<VpassCardRun>][] = [
      ["binding_tuple_absent", { selectCardRawJson, webMeisaiTopRawJson }],
      ["binding_tuple_invalid", { webMeisaiTopRawJson }],
      [
        "binding_tuple_invalid",
        {
          selectCardRawJson: withBean(selectCardRawJson, bean({ externalId: "E".repeat(31) })),
        },
      ],
      [
        "binding_tuple_invalid",
        { selectCardRawJson: withBean(selectCardRawJson, bean({ globalid: "G/".repeat(16) })) },
      ],
      [
        "binding_selection_mismatch",
        {
          webMeisaiTopRawJson: withBean(webMeisaiTopRawJson, bean({ cardCode: "D".repeat(13) })),
        },
      ],
      [
        "binding_selection_mismatch",
        { webMeisaiTopRawJson: withBean(webMeisaiTopRawJson, bean({ cardName: "OTHER" })) },
      ],
      // The selected card's name must be the inventory's name at this ordinal.
      ["binding_selection_mismatch", { cardLabel: "card-002" }],
      [
        "binding_inventory_invalid",
        {
          cardListRawJson: envelope({
            DropdownListInitDisplayServiceBean: {
              multiCardInfoList: [
                { name: "SYNTHETIC CARD NAME", value: "one" },
                { name: "SYNTHETIC CARD NAME", value: "two" },
              ],
            },
          }),
        },
      ],
    ];
    for (const [code, overrides] of cases) {
      const bucket = new FakeR2Bucket();
      const outcome = await persistCardRun(bucket, bound(overrides));
      expect([code, outcome.result.outcome, outcome.binding]).toEqual([code, "persisted", code]);
      for (const text of texts(bucket).values()) {
        for (const value of [externalId, globalid, cardCode, "vpass-card-v"]) {
          expect(text).not.toContain(value);
        }
      }
    }
    // A response that is not a successful envelope is not a binding either;
    // the sanitizer then refuses the run as before.
    expect(
      await deriveVpassCardBinding({
        ...bound(),
        selectCardRawJson: JSON.stringify({ header: { resultCode: "9" } }),
      }),
    ).toEqual({ status: "unavailable", code: "binding_envelope_invalid" });
  });
});

describe("G1-09 a card that collected nothing stays a failure", () => {
  test("the failed terminal carries a code and no artifact", async () => {
    const bucket = new FakeR2Bucket();
    const outcome = await persistFailedRun(bucket, {
      sessionRunId,
      unitKey: "card-001",
      startedAt: "2026-09-11T21:00:00.000Z",
      failedAt: "2026-09-11T21:00:30.000Z",
    });
    expect(outcome.artifactCount).toBe(0);
    const read = await readTerminal(bucket, "vpass", `${sessionRunId}-card-001`);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.providerOutcome).toBe("failed");
    expect(read.manifest.coverageStatus).toBe("unknown");
    expect(read.manifest.safeErrorCode).toBe("collector_failed");
    expect(read.manifest.artifacts).toEqual([]);
    expect([...bucket.entries.keys()]).toEqual([terminalKey("vpass", `${sessionRunId}-card-001`)]);
  });

  test("a session that failed before a card was selected is its own unit", async () => {
    const bucket = new FakeR2Bucket();
    await persistFailedRun(bucket, {
      sessionRunId,
      unitKey: "run",
      startedAt: "2026-09-11T21:00:00.000Z",
      failedAt: "2026-09-11T21:00:10.000Z",
    });
    const read = await readTerminal(bucket, "vpass", `${sessionRunId}-run`);
    if (read.outcome !== "found") throw new Error("unreachable");
    expect(read.manifest.units).toEqual([
      {
        unitKey: "run",
        unitKind: "session",
        artifactCount: 0,
        coverageStatus: "unknown",
        safeErrorCode: "collector_failed",
      },
    ]);
  });
});

describe("ADR 0023 option 8 / ADR 0026 the card unit is complete only when every month's rows equal its stated total", () => {
  const finalized = (rows: number, allCnt: unknown) =>
    envelope({
      WebMeisaiTopDisplayServiceBean: {
        meisaiList: Array.from({ length: rows }, () => ({ amount: 1, shop: "SYNTHETIC SHOP" })),
        ...(allCnt === undefined ? {} : { webMeisaiTopK3Vo: { allCnt, nextPageRow: rows + 1 } }),
      },
    });
  const customized = (rows: number, total: unknown) =>
    envelope({
      CustomizedMeisaiAnsDisplayServiceBean: {
        meisaiList: Array.from({ length: rows }, () => ({ amount: 1, shop: "SYNTHETIC SHOP" })),
        ...(total === undefined ? {} : { total }),
        pageFlg: "3",
      },
    });
  const month = (...rawJson: string[]) => ({
    pages: rawJson.map((raw, index) => ({
      kind: index === 0 ? ("top" as const) : ("answer" as const),
      index,
      rawJson: raw,
    })),
    transactionCount: 0,
  });
  const cardUnit = async (months: VpassCardRun["months"]) => {
    const plan = await vpassCardRunPlan(run({ months }));
    return plan.run.units[0]!.coverageStatus;
  };

  // Mirrors the live types: a finalized page's `allCnt` is a string, a
  // customized page's `total` a number (2026-09-27, field types only).
  test("stated totals met across pages and both statement shapes: complete", async () => {
    expect(
      await cardUnit({
        "202609": month(finalized(2, "3"), finalized(1, "3")),
        "202608": month(customized(0, 0), customized(2, 2)),
        "202607": month(finalized(0, "0")),
      }),
    ).toBe("complete");
  });

  test("a stated total reads the same as a digit string or a number", async () => {
    expect(await cardUnit({ "202609": month(finalized(2, 2)) })).toBe("complete");
    expect(await cardUnit({ "202609": month(finalized(2, "2")) })).toBe("complete");
    expect(await cardUnit({ "202609": month(finalized(2, "002")) })).toBe("complete");
    expect(await cardUnit({ "202609": month(customized(2, "2")) })).toBe("complete");
  });

  test("diagnostics distinguish short, excess and unverified months without leaking month or row values", async () => {
    const outcome = await persistCardRun(
      new FakeR2Bucket(),
      run({
        months: {
          "209901": month(finalized(1, "2")),
          "209902": month(finalized(3, "2")),
          "209903": month(finalized(1, undefined)),
          "209904": month(finalized(2, "2")),
        },
      }),
    );
    const diagnostic = sharedRunDiagnostic("r", "card-001", outcome);
    expect(diagnostic).toMatchObject({
      coverage: "stated_total_mismatch",
      coverageStatus: "partial",
      coverageReason: "rolling-window",
      coverageCounts: {
        monthCount: 4,
        completeMonthCount: 1,
        unverifiedMonthCount: 1,
        shortMonthCount: 1,
        excessMonthCount: 1,
      },
    });
    for (const forbidden of ["2099", "SYNTHETIC SHOP", "allCnt", "amount"])
      expect(JSON.stringify(diagnostic)).not.toContain(forbidden);
  });

  test("a missing, unparsable or unmet stated total makes the unit partial with its code", async () => {
    const cases: [VpassCardRun["months"], string][] = [
      [{ "202609": month(finalized(1, "2")) }, "stated_total_mismatch"],
      [{ "202609": month(finalized(3, "2")) }, "stated_total_mismatch"],
      [{ "202609": month(customized(1, 1), customized(0, 5)) }, "stated_total_mismatch"],
      [{ "202609": month(finalized(1, undefined)) }, "stated_total_unverified"],
      [{ "202609": month(customized(1, "one")) }, "stated_total_unverified"],
      [{ "202609": month(customized(1, -1)) }, "stated_total_unverified"],
      // A string that is not digits only is not read as a count.
      ...["-1", "+1", " 1", "1 ", "1,000", "1.0", "\uff11", "", "99999999999999999"].map(
        (allCnt): [VpassCardRun["months"], string] => [
          { "202609": month(finalized(1, allCnt)) },
          "stated_total_unverified",
        ],
      ),
      [
        { "202609": month(finalized(1, "1")), "202608": month(finalized(1, undefined)) },
        "stated_total_unverified",
      ],
      [{}, "statement_months_absent"],
    ];
    for (const [months, code] of cases) {
      expect([code, await cardUnit(months)]).toEqual([code, "partial"]);
      const bucket = new FakeR2Bucket();
      const outcome = await persistCardRun(bucket, run({ months }));
      expect([code, outcome.result.outcome, outcome.coverage]).toEqual([code, "persisted", code]);
      expect(sharedRunDiagnostic("r", "card-001", outcome)).toMatchObject({ coverage: code });
    }
  });
});

describe("G1-01 a failed put leaves no terminal", () => {
  test("the run reports incomplete and logs codes and counts only", async () => {
    const card = run();
    const plan = await vpassCardRunPlan(card);
    const failing = plan.artifacts.at(-1)!;
    const bucket = new FakeR2Bucket({ failPut: new Set([objectKey(failing.sha256)]) });
    const outcome = await persistCardRun(bucket, card);
    expect(outcome.result.outcome).toBe("incomplete");
    if (outcome.result.outcome !== "incomplete") throw new Error("unreachable");
    expect((await readTerminal(bucket, "vpass", `${sessionRunId}-card-001`)).outcome).toBe(
      "missing",
    );
    expect(outcome.result.checkpoint.pendingArtifactKeys).toContain(failing.artifactKey);

    const diagnostic = sharedRunDiagnostic(`${sessionRunId}-card-001`, "card-001", outcome);
    expect(diagnostic).toEqual({
      event: "vpass-shared-collection",
      runId: `${sessionRunId}-card-001`,
      unitKey: "card-001",
      persistence: "incomplete",
      artifactCount: plan.artifacts.length,
      binding: "binding_tuple_absent",
      coverage: "complete",
      coverageStatus: "partial",
      coverageReason: "rolling-window",
      coverageCounts: {
        monthCount: 2,
        completeMonthCount: 2,
        unverifiedMonthCount: 0,
        shortMonthCount: 0,
        excessMonthCount: 0,
      },
      reasonCode: "object_put_failed",
      persistedCount: outcome.result.checkpoint.persistedArtifactKeys.length,
      pendingCount: outcome.result.checkpoint.pendingArtifactKeys.length,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic");
  });
});

describe("G1-15 shared mode writes once", () => {
  test.each([false, true])(
    "a shared-target session touches neither the legacy bucket nor the queue (throwing logs=%s)",
    async (loggerThrows) => {
      const data = new FakeR2Bucket();
      let legacyWrites = 0;
      let enqueued = 0;
      let imports = 0;
      const records: Record<string, unknown>[] = [];
      const spies = [
        ...(["log", "error"] as const).map((level) =>
          spyOn(console, level).mockImplementation((value) => {
            records.push(JSON.parse(String(value)) as Record<string, unknown>);
            if (loggerThrows) throw new Error("private-logger-failure");
          }),
        ),
      ];
      const env = {
        COLLECTION_TARGET: "shared",
        DATA: data,
        // Missing secrets deliberately fail the session before any provider
        // request, which is the failed-run path.
        SNAPSHOTS: {
          put: async () => {
            legacyWrites += 1;
            throw new Error("the legacy bucket must not be written in shared mode");
          },
        },
        RAW_EVIDENCE_QUEUE: {
          send: async () => {
            enqueued += 1;
          },
        },
        RAW_EVIDENCE_IMPORTER: {
          fetch: async () => {
            imports += 1;
            return Response.json({ status: "sealed" });
          },
        },
      } as unknown as Parameters<typeof worker.scheduled>[1];
      try {
        await expect(
          worker.scheduled(
            { scheduledTime: Date.parse("2026-09-05T00:00:00Z") } as ScheduledController,
            env,
          ),
        ).rejects.toThrow("Missing Worker secret");
        expect(legacyWrites).toBe(0);
        expect(enqueued).toBe(0);
        expect(imports).toBe(0);
        expect(data.putKeys).toHaveLength(1);
        // The session failure is recorded as a failed run with no artifact.
        expect([...data.entries.keys()]).toEqual([
          terminalKey("vpass", "2026-09-05T00-00-00-000Z-run"),
        ]);
        const persisted = records.find((record) => record.event === "vpass-shared-collection");
        expect(persisted).toMatchObject({ persistence: "persisted", artifactCount: 0 });
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    },
  );
});
