import { describe, expect, test } from "bun:test";
import { canonicalDigest, canonicalJson } from "../src/context.ts";
import {
  selectInstrumentTemporal,
  instrumentTemporalContextRequested,
  type InstrumentDecisionVersion,
  type InstrumentPeriod,
  type InstrumentTemporalInput,
  type InstrumentTemporalRequest,
  type InstrumentTemporalSelection,
} from "../src/instrument-temporal.ts";

const epoch = "synthetic-core";
const zone = "Asia/Tokyo";
const firstTime = "2099-01-01T00:00:00.000Z";
const secondTime = "2099-01-02T00:00:00.000Z";
const req = (date = "2099-01-31"): InstrumentTemporalRequest => ({
  identifierIds: ["identifier:A"],
  knowledge: { mode: "current" },
  effective: {
    role: "trade",
    confirmed: true,
    time: { kind: "local-date", value: date, zone, basis: "provider" },
  },
  contract: {
    version: "synthetic-interval-v1",
    endpoints: "half-open",
    basis: "business-date",
    zone,
    openEnded: "allowed",
    referenceRole: "trade",
  },
});
function period(
  from = "2099-01-01",
  to: string | null = "2099-02-01",
  targetRef = "instrument:A",
): InstrumentPeriod {
  return {
    from,
    end: to === null ? { kind: "open-ended" } : { kind: "bounded", to },
    evidenceRefs: ["evidence:period"],
    reasonCode: "owner_stated",
    assertion: { targetRef },
  };
}
function version(id = "m1", seq = 1, supersedes: string | null = null): InstrumentDecisionVersion {
  return {
    versionId: id,
    series: { kind: "mapping", identifierId: "identifier:A" },
    coreEpoch: epoch,
    acceptanceSeq: seq,
    supersedes,
    supersedesLegacy: [],
    contractVersion: "synthetic-interval-v1",
    zone,
    validity: { kind: "periods", periods: [period()] },
    evidenceRefs: ["evidence:version"],
    reasonCode: "owner_stated",
  };
}
function relation(id = "r1", seq = 1, supersedes: string | null = null): InstrumentDecisionVersion {
  const v = version(id, seq, supersedes);
  v.series = { kind: "listed_as", fromRef: "instrument:A", toRef: "identifier:A" };
  v.validity = {
    kind: "periods",
    periods: [{ ...period("2099-02-01", "2099-03-01"), assertion: { disposition: "rejected" } }],
  };
  return v;
}
function input(...versions: InstrumentDecisionVersion[]): InstrumentTemporalInput {
  const sequences = [...new Set(versions.map((v) => v.acceptanceSeq))].sort((a, b) => a - b);
  return {
    coreEpoch: epoch,
    versions,
    legacy: [],
    acceptances: sequences.map((sequence) => ({
      coreEpoch: epoch,
      sequence,
      knownAt: sequence === 1 ? firstTime : secondTime,
      members: versions
        .filter((v) => v.acceptanceSeq === sequence)
        .map((v) => ({
          versionId: v.versionId,
          series: v.series,
          supersedes: v.supersedes,
        })),
    })),
  };
}
test("pins copy before hashing yields; non-JSON prototypes refuse", async () => {
  const data = input(version());
  const pending = selectInstrumentTemporal(data, req());
  data.versions[0]!.evidenceRefs.push("evidence:concurrent");
  const pinned = selected(await pending);
  expect(pinned.manifest.selection.versions[0]!.evidenceRefs).toEqual(["evidence:version"]);
  expect(outcome(pinned).evidenceRefs).not.toContain("evidence:concurrent");
  const nonJson = input(version());
  Object.setPrototypeOf(nonJson, { inherited: true });
  expect(await selectInstrumentTemporal(nonJson, req())).toEqual({
    status: "refused",
    reasonCode: "invalid_input",
  });
});

function selected(result: InstrumentTemporalSelection) {
  expect(result.status).toBe("selected");
  if (result.status !== "selected") throw new Error(result.reasonCode);
  return result;
}
const select = async (data = input(version()), request = req()) =>
  selected(await selectInstrumentTemporal(data, request));
function knownAt(
  request: InstrumentTemporalRequest,
  cut: { commitSeq: number } | { instant: string },
) {
  request.knowledge = { mode: "known-at", cut: { coreEpoch: epoch, ...cut } };
  return request;
}
const outcome = (result: ReturnType<typeof selected>) => result.manifest.selection.outcomes[0]!;

describe("pure temporal instrument selector", () => {
  test("the explicit context namespace refuses malformed suffix downgrade without labelling ordinary contexts", () => {
    for (const value of [
      "instrument-temporal:",
      "instrument-temporal:unknown",
      "instrument-temporal:" + "a".repeat(300),
    ])
      expect(instrumentTemporalContextRequested(value)).toBe(true);
    for (const value of [
      null,
      {},
      "manual:correction",
      "identity-current-v1",
      "a".repeat(64),
      "instrument-candidate:pair",
    ])
      expect(instrumentTemporalContextRequested(value)).toBe(false);
  });
  test("B1/B5 half-open adjacent periods resolve reused code to exactly one product", async () => {
    const v = version();
    v.validity = {
      kind: "periods",
      periods: [period(), period("2099-02-01", "2099-03-01", "instrument:B")],
    };
    expect(outcome(await select(input(v))).targetRef).toBe("instrument:A");
    expect(outcome(await select(input(v), req("2099-02-01"))).targetRef).toBe("instrument:B");
    expect(outcome(await select(input(v), req("2099-03-01"))).reasonCodes).toEqual([
      "outside_coverage",
    ]);
  });
  test("B2/B3 no default validity or open end; explicit policies differ", async () => {
    expect(outcome(await select(input())).reasonCodes).toEqual(["validity_unknown"]);
    const v = version();
    v.validity = { kind: "unknown" };
    expect(outcome(await select(input(v))).targetRef).toBeNull();
    v.validity = { kind: "periods", periods: [period("2099-01-01", null)] };
    expect(outcome(await select(input(v), req("2199-01-01"))).targetRef).toBe("instrument:A");
    const boundedOnly = req();
    boundedOnly.contract.openEnded = "refused";
    expect(await selectInstrumentTemporal(input(v), boundedOnly)).toEqual({
      status: "refused",
      reasonCode: "invalid_interval_set",
    });
    const absentPolicy = structuredClone(req()) as unknown as Record<string, unknown>;
    delete (absentPolicy.contract as Record<string, unknown>).openEnded;
    expect(await selectInstrumentTemporal(input(v), absentPolicy)).toEqual({
      status: "refused",
      reasonCode: "invalid_input",
    });
  });
  test("B4 overlapping same-target and different-target sets are refused", async () => {
    for (const target of ["instrument:A", "instrument:B"]) {
      const v = version();
      v.validity = {
        kind: "periods",
        periods: [period(), period("2099-01-15", "2099-03-01", target)],
      };
      expect(await selectInstrumentTemporal(input(v), req())).toEqual({
        status: "refused",
        reasonCode: "invalid_interval_set",
      });
    }
  });
  test("B6/B12 corrections choose knowledge first and never mutate retained inputs", async () => {
    const v1 = version(),
      v2 = version("m2", 2, "m1");
    v2.validity = {
      kind: "periods",
      periods: [period("2099-01-01", "2099-02-01", "instrument:B")],
    };
    const data = input(v1, v2),
      before = canonicalJson(data);
    const old = await select(data, knownAt(req(), { instant: firstTime }));
    expect(outcome(old).targetRef).toBe("instrument:A");
    expect(outcome(await select(data)).targetRef).toBe("instrument:B");
    const retained = canonicalJson(old);
    v2.evidenceRefs.push("evidence:later");
    await select(data);
    expect(canonicalJson(old)).toBe(retained);
    v2.evidenceRefs.pop();
    expect(canonicalJson(data)).toBe(before);
  });
  test("B7 rejects missing predecessors, fork successors and two roots without id ordering", async () => {
    for (const later of [version("m2", 2, "absent"), version("m2", 2)]) {
      expect(await selectInstrumentTemporal(input(version(), later), req())).toEqual({
        status: "refused",
        reasonCode: "chain_inconsistent",
      });
    }
    const data = input(version(), version("m2", 2, "m1"), version("m3", 3, "m1"));
    expect(await selectInstrumentTemporal(data, req())).toEqual({
      status: "refused",
      reasonCode: "chain_inconsistent",
    });
  });
  test("B8/B9/B21 unknown roles, settlement, collector dates, instants and zones remain unresolved", async () => {
    const variants = [req(), req(), req(), req(), req(), req()];
    variants[0]!.effective.confirmed = false;
    variants[1]!.effective.role = "position";
    variants[2]!.effective.time = { kind: "unknown", reasonCode: "undated" };
    variants[3]!.effective.time = {
      kind: "local-date",
      value: "2099-01-31",
      zone,
      basis: "collector",
    };
    variants[4]!.effective.time = {
      kind: "instant",
      value: "2099-01-31T23:59:59Z",
      zone,
      basis: "provider",
    };
    variants[5]!.effective.time = {
      kind: "local-date",
      value: "2099-01-31",
      zone: "America/New_York",
      basis: "provider",
    };
    for (const request of variants)
      expect(outcome(await select(input(version()), request)).reasonCodes).toContain(
        "reference_unresolved",
      );
    const settlement = req() as unknown as { effective: { role: string } };
    settlement.effective.role = "settlement";
    expect(await selectInstrumentTemporal(input(version()), settlement)).toEqual({
      status: "refused",
      reasonCode: "invalid_input",
    });
  });
  test("B10/B11 applicable rejection conflicts only on the exact target and period", async () => {
    const m = version();
    m.validity = { kind: "periods", periods: [period("2099-01-01", null)] };
    const data = input(m, relation());
    expect(outcome(await select(data)).status).toBe("resolved");
    const conflict = outcome(await select(data, req("2099-02-01")));
    expect(conflict.status).toBe("conflict");
    expect(conflict.targetRef).toBeNull();
    expect(conflict.mappingVersionId).toBe("m1");
    expect(conflict.relationVersionIds).toEqual(["r1"]);
    const other = relation();
    other.series = { kind: "listed_as", fromRef: "instrument:B", toRef: "identifier:A" };
    expect(outcome(await select(input(m, other), req("2099-02-01"))).status).toBe("resolved");
  });
  test("B13 canonical manifest ignores input/evidence/period/member order", async () => {
    const m = version();
    m.evidenceRefs = ["evidence:z", "evidence:a"];
    m.validity = {
      kind: "periods",
      periods: [period(), period("2099-02-01", null, "instrument:B")],
    };
    const data = input(m, relation());
    const one = await select(data);
    data.versions.reverse();
    data.acceptances[0]!.members.reverse();
    m.evidenceRefs.reverse();
    if (m.validity.kind === "periods") m.validity.periods.reverse();
    const two = await select(data);
    expect(two.contextId).toBe(one.contextId);
    expect(two.setVersion).toBe(one.setVersion);
    m.evidenceRefs.push("evidence:new");
    expect((await select(data)).setVersion).not.toBe(one.setVersion);
    expect(one.setVersion).toBe(await canonicalDigest(one.manifest.selection));
    expect(one.contextId).toBe(await canonicalDigest(one.manifest));
    expect(one.contextRef).toBe(`instrument-temporal:${one.contextId}`);
    expect(instrumentTemporalContextRequested(one.contextRef)).toBe(true);
  });
  test("B14/B15/B20 malformed atomic member data is purely rejected", async () => {
    const mutations: ((data: InstrumentTemporalInput) => void)[] = [
      (d) => {
        d.acceptances[0]!.members.pop();
      },
      (d) => {
        d.acceptances[0]!.members[0]!.supersedes = "tampered";
      },
      (d) => {
        d.versions[0]!.acceptanceSeq = 2;
      },
      (d) => {
        d.acceptances[0]!.members[0]!.series = { kind: "mapping", identifierId: "other" };
      },
      (d) => {
        d.acceptances[0]!.members.push(d.acceptances[0]!.members[0]!);
      },
    ];
    for (const mutate of mutations) {
      const data = input(version(), relation());
      mutate(data);
      expect(await selectInstrumentTemporal(data, req())).toEqual({
        status: "refused",
        reasonCode: "membership_inconsistent",
      });
    }
    // Missing an unrelated atomic member still refuses: closure filtering is later.
    const unrelated = version("other");
    unrelated.series = { kind: "mapping", identifierId: "identifier:other" };
    const data = input(version(), unrelated);
    data.versions.pop();
    expect(await selectInstrumentTemporal(data, req())).toEqual({
      status: "refused",
      reasonCode: "membership_inconsistent",
    });
  });
  test("B16/B19 legacy membership is never fabricated and honest replacement applies at its cut", async () => {
    const data = input(version());
    data.legacy = [
      {
        id: "legacy:relation",
        series: { kind: "listed_as", fromRef: "instrument:A", toRef: "identifier:A" },
        evidenceRefs: ["evidence:legacy"],
      },
    ];
    const original = canonicalJson(data);
    expect(outcome(await select(data)).reasonCodes).toEqual([
      "knowledge_unlogged",
      "relation_validity_unknown",
    ]);
    expect(canonicalJson(data)).toBe(original);
    const r = relation("r2", 2);
    r.supersedesLegacy = ["legacy:relation"];
    const fresh = input(version(), r);
    fresh.legacy = data.legacy;
    expect(outcome(await select(fresh, knownAt(req(), { commitSeq: 1 }))).status).toBe(
      "unresolved",
    );
    expect(outcome(await select(fresh)).status).toBe("resolved");
    expect(outcome(await select(fresh, req("2099-02-01"))).reasonCodes).toContain(
      "outside_coverage",
    );
  });
  test("B17 same-time global acceptance, provisional growth and final standing preserve pins", async () => {
    const m1 = version(),
      m2 = version("m2", 2, "m1");
    const data = input(m1),
      first = await select(data, knownAt(req(), { instant: firstTime }));
    expect(first.manifest.cutStanding).toBe("provisional");
    const two = input(m1, m2);
    two.acceptances[1]!.knownAt = firstTime;
    const advanced = await select(
      two,
      knownAt(req(), { instant: "2099-01-01T09:00:00.0009+09:00" }),
    );
    expect(advanced.manifest.selection.resolvedCut.commitSeq).toBe(2);
    expect(advanced.setVersion).not.toBe(first.setVersion);
    const pinned = await select(two, knownAt(req(), { commitSeq: 1 }));
    expect(pinned.setVersion).toBe(first.setVersion);
    const m3 = version("m3", 3, "m2");
    const three = input(m1, m2, m3);
    three.acceptances[1]!.knownAt = firstTime;
    const final = await select(three, knownAt(req(), { instant: firstTime }));
    expect(final.manifest.cutStanding).toBe("final");
    expect(final.setVersion).toBe(advanced.setVersion);
    expect(final.contextId).not.toBe(advanced.contextId);
  });
  test("B17 refuses journal gaps, global clock regression, noncanonical clock and other epochs", async () => {
    const data = input(version(), version("m2", 2, "m1"));
    const gap = structuredClone(data);
    gap.acceptances[1]!.sequence = 3;
    expect(await selectInstrumentTemporal(gap, req())).toEqual({
      status: "refused",
      reasonCode: "journal_inconsistent",
    });
    const regression = structuredClone(data);
    regression.acceptances[1]!.knownAt = "2098-12-31T00:00:00.000Z";
    expect(await selectInstrumentTemporal(regression, req())).toEqual({
      status: "refused",
      reasonCode: "journal_inconsistent",
    });
    const clock = structuredClone(data);
    clock.acceptances[0]!.knownAt = "2099-01-01T00:00:00Z";
    expect(await selectInstrumentTemporal(clock, req())).toEqual({
      status: "refused",
      reasonCode: "invalid_input",
    });
    const wrong = knownAt(req(), { commitSeq: 1 });
    if (wrong.knowledge.mode === "known-at") wrong.knowledge.cut.coreEpoch = "other";
    expect(await selectInstrumentTemporal(data, wrong)).toEqual({
      status: "refused",
      reasonCode: "epoch_mismatch",
    });
    expect(await selectInstrumentTemporal(data, knownAt(req(), { commitSeq: 3 }))).toEqual({
      status: "refused",
      reasonCode: "invalid_cut",
    });
  });
  test("B18 relation version is selected before dates/disposition and empty release does not resurrect", async () => {
    const m = version();
    m.validity = { kind: "periods", periods: [period("2099-01-01", null)] };
    const r1 = relation(),
      r2 = relation("r2", 2, "r1");
    r2.validity = { kind: "periods", periods: [] };
    const data = input(m, r1, r2);
    expect(outcome(await select(data, knownAt(req("2099-02-10"), { commitSeq: 1 }))).status).toBe(
      "conflict",
    );
    const released = await select(data, req("2099-02-10"));
    expect(outcome(released).status).toBe("resolved");
    expect(released.manifest.selection.relations[0]!.status).toBe("released");
    expect(released.manifest.selection.versions.map((v) => v.versionId)).toEqual(["m1", "r2"]);
    // An accepted relation never independently adopts a mapping.
    r2.validity = {
      kind: "periods",
      periods: [{ ...period(), assertion: { disposition: "accepted" } }],
    };
    expect(outcome(await select(input(r1, r2))).targetRef).toBeNull();
  });
  test("B20 pinned sequence selects a coherent earlier mapping and relation after a joint correction", async () => {
    const m1 = version(),
      r1 = relation(),
      m2 = version("m2", 2, "m1"),
      r2 = relation("r2", 2, "r1");
    const data = input(m1, r1, m2, r2);
    const previous = await select(data, knownAt(req(), { commitSeq: 1 }));
    expect(previous.manifest.selection.versions.map((v) => v.versionId)).toEqual(["m1", "r1"]);
    expect((await select(data)).manifest.selection.versions.map((v) => v.versionId)).toEqual([
      "m2",
      "r2",
    ]);
    const snapshot = structuredClone(data);
    snapshot.versions = snapshot.versions.filter((v) => v.versionId !== "r2");
    expect(await selectInstrumentTemporal(snapshot, req())).toEqual({
      status: "refused",
      reasonCode: "membership_inconsistent",
    });
  });
  test("empty/pre-log cut proves no coverage, unknown relations block and unrelated legacy stays outside closure", async () => {
    const before = await select(
      input(version()),
      knownAt(req(), { instant: "2098-12-31T00:00:00Z" }),
    );
    expect(outcome(before).status).toBe("unresolved");
    expect(before.manifest.selection.resolvedCut.commitSeq).toBe(0);
    const r = relation();
    r.validity = { kind: "unknown" };
    expect(outcome(await select(input(version(), r))).reasonCodes).toContain(
      "relation_validity_unknown",
    );
    const data = input(version());
    data.legacy = [
      {
        id: "legacy:unrelated",
        series: { kind: "mapping", identifierId: "other" },
        evidenceRefs: [],
      },
    ];
    expect(outcome(await select(data)).status).toBe("resolved");
  });
  test("sparse evidence never disappears during canonical copying", async () => {
    for (const mutate of [
      (d: InstrumentTemporalInput) => {
        d.versions[0]!.evidenceRefs = Array(1);
      },
      (d: InstrumentTemporalInput) => {
        if (d.versions[0]!.validity.kind === "periods")
          d.versions[0]!.validity.periods[0]!.evidenceRefs = Array(1);
      },
      (d: InstrumentTemporalInput) => {
        d.versions[0]!.supersedesLegacy = Array(1);
      },
      (d: InstrumentTemporalInput) => {
        d.legacy = [{ id: "legacy", series: d.versions[0]!.series, evidenceRefs: Array(1) }];
      },
    ]) {
      const d = input(version());
      mutate(d);
      expect(await selectInstrumentTemporal(d, req())).toEqual({
        status: "refused",
        reasonCode: "invalid_input",
      });
    }
  });
  test("sparse rejected relation periods cannot become an explicit release", async () => {
    const m = version();
    m.validity = { kind: "periods", periods: [period("2099-01-01", null)] };
    const r = relation();
    expect(outcome(await select(input(m, r), req("2099-02-10"))).status).toBe("conflict");
    r.validity = { kind: "periods", periods: Array(1) };
    expect(await selectInstrumentTemporal(input(m, r), req("2099-02-10"))).toEqual({
      status: "refused",
      reasonCode: "invalid_input",
    });
    r.validity = { kind: "periods", periods: [] };
    const released = await select(input(m, r), req("2099-02-10"));
    expect(released.manifest.selection.relations[0]!.status).toBe("released");
    expect(outcome(released).status).toBe("resolved");
  });
  test("sparse identifier closures and every loaded row/member array refuse", async () => {
    const request = req();
    request.identifierIds = Array(1);
    expect(await selectInstrumentTemporal(input(version()), request)).toEqual({
      status: "refused",
      reasonCode: "invalid_input",
    });
    for (const mutate of [
      (d: InstrumentTemporalInput) => {
        d.acceptances = Array(1);
      },
      (d: InstrumentTemporalInput) => {
        d.versions = Array(1);
      },
      (d: InstrumentTemporalInput) => {
        d.legacy = Array(1);
      },
      (d: InstrumentTemporalInput) => {
        d.acceptances[0]!.members = Array(1);
      },
      (d: InstrumentTemporalInput) => {
        delete d.versions[0];
      },
    ]) {
      const d = input(version());
      mutate(d);
      expect(await selectInstrumentTemporal(d, req())).toEqual({
        status: "refused",
        reasonCode: "invalid_input",
      });
    }
    // An inherited index still does not prove an own array member.
    const inherited = Array(1);
    Object.setPrototypeOf(
      inherited,
      Object.assign(Object.create(Array.prototype), { 0: "identifier:A" }),
    );
    request.identifierIds = inherited;
    expect(await selectInstrumentTemporal(input(version()), request)).toEqual({
      status: "refused",
      reasonCode: "invalid_input",
    });
  });
  test("a logged successor may explicitly supersede still-unlogged legacy of its exact series", async () => {
    const r1 = relation(),
      r2 = relation("r2", 2, "r1");
    r2.supersedesLegacy = ["legacy:relation"];
    const data = input(version(), r1, r2);
    data.legacy = [{ id: "legacy:relation", series: r1.series, evidenceRefs: ["evidence:legacy"] }];
    expect(outcome(await select(data, knownAt(req(), { commitSeq: 1 }))).reasonCodes).toContain(
      "knowledge_unlogged",
    );
    expect(outcome(await select(data)).status).toBe("resolved");
    const foreign = structuredClone(data);
    foreign.legacy[0]!.series = {
      kind: "listed_as",
      fromRef: "instrument:B",
      toRef: "identifier:A",
    };
    expect(await selectInstrumentTemporal(foreign, req())).toEqual({
      status: "refused",
      reasonCode: "chain_inconsistent",
    });
    const twice = structuredClone(data);
    twice.versions[1]!.supersedesLegacy = ["legacy:relation"];
    expect(await selectInstrumentTemporal(twice, req())).toEqual({
      status: "refused",
      reasonCode: "chain_inconsistent",
    });
  });

  test("closed shapes, explicit bounds and canonical zone are enforced", async () => {
    expect(await selectInstrumentTemporal({ ...input(version()), extra: true }, req())).toEqual({
      status: "refused",
      reasonCode: "invalid_input",
    });
    const request = req();
    request.identifierIds = Array.from({ length: 257 }, (_, n) => `id:${n}`);
    expect(await selectInstrumentTemporal(input(version()), request)).toEqual({
      status: "refused",
      reasonCode: "selector_bound_exceeded",
    });
    const alias = req();
    alias.contract.zone = "invalid/zone";
    expect(await selectInstrumentTemporal(input(version()), alias)).toEqual({
      status: "refused",
      reasonCode: "unsupported_contract",
    });
    const v = version();
    v.zone = "UTC";
    expect(await selectInstrumentTemporal(input(v), req())).toEqual({
      status: "refused",
      reasonCode: "invalid_interval_set",
    });
  });
});
