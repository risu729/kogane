// Seeded property tests of the knowledge selector (ADR 0058) and the
// reconstruction fold (ADR 0052): random histories of revisions, unlogged
// rows, supersession, shared claims and boundary dates. Every id, amount and
// date is invented; each property lists the seeds that break it.
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/context.ts";
import { selectAdopted } from "../src/knowledge-selector.ts";
import {
  PROVISIONAL_EVENT_CONTRACT,
  reconstructState,
  RECONSTRUCTION_FOLD_V1,
  selectKnowledge,
  type ProvisionalAdoptedEventSet,
  type ProvisionalEventRevision,
  type ProvisionalLeg,
  type ReconstructionReportedBalance,
  type ReconstructionRequest,
  type StartSnapshot,
} from "../src/reconstruction.ts";
import type { TemporalValue } from "../src/time.ts";
import {
  absentQuantity,
  addDecimals,
  decimalEquals,
  isZeroDecimal,
  subtractDecimals,
  type Quantity,
} from "../src/values.ts";
import { q } from "./helpers.ts";
import { between, pad2, pick, seededRandom, seeds, shuffled, type Random } from "./property.ts";
import { A, B, CARD, posting, Rows } from "./selector-fixture.ts";

const KEYS = [0, 1, 2].map((index) =>
  JSON.stringify(["synthetic-source", "producer-test", "ns-test", "account-test", `row-${index}`]),
);

describe("selectAdopted over random histories", () => {
  test("any order of the loaded rows gives the same selection and set version", async () => {
    const broken: string[] = [];
    for (const seed of seeds(1, 60)) {
      const random = seededRandom(seed);
      const rows = new Rows();
      const latest = new Map<string, number>();
      let sequence = 0;
      for (let index = 0; index < between(random, 1, 7); index += 1) {
        const eventId = `ev-${between(random, 0, 2)}`;
        const revision = (latest.get(eventId) ?? 0) + 1;
        const logged = random() < 0.8;
        if (logged) sequence += 1;
        rows.add({
          eventId,
          revision,
          seq: logged ? sequence : null,
          legs: Array.from({ length: between(random, 1, 2) }, (_, leg) => ({
            subject: pick(random, [A, `account:${A}`, B, CARD, "claim:test-unknown"]),
            amount: random() < 0.9 ? pick(random, ["100", "12.5", "7"]) : null,
            role: pick(random, ["increase", "decrease"] as const),
            ...(leg === 0 && random() < 0.5 ? { effect: "movement" as const } : {}),
          })),
          times: random() < 0.5 ? [posting(`2026-03-${pad2(between(random, 1, 28))}`)] : [],
          claims:
            random() < 0.7
              ? [
                  {
                    key: pick(random, KEYS),
                    alias: random() < 0.3 ? pick(random, ['["alias",1]', '["alias",2]']) : null,
                  },
                ]
              : [],
        });
        latest.set(eventId, revision);
      }
      for (let cut = sequence === 0 ? 1 : 0; cut <= sequence; cut += 1) {
        if (sequence === 0) break;
        const input = rows.input(cut);
        const first = await selectAdopted(input);
        const again = await selectAdopted({
          ...input,
          revisions: shuffled(random, input.revisions),
          legs: shuffled(random, input.legs),
          subjects: shuffled(random, input.subjects),
          claims: shuffled(random, input.claims),
          times: shuffled(random, input.times),
          effects: shuffled(random, input.effects),
          seals: shuffled(random, input.seals),
          commits: shuffled(random, input.commits),
          scope: { ...input.scope, accounts: shuffled(random, input.scope.accounts) },
        });
        if (canonicalJson(first) !== canonicalJson(again)) broken.push(`${seed}@${cut}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

const ACCOUNT_A = "account:test:a";
const ACCOUNT_B = "account:test:b";
const EPOCH = "epoch:test:1";
const START_CAPTURE = "2026-03-01T03:00:00.000Z";
const END_CAPTURE = "2026-03-31T03:00:00.000Z";

function randomSet(random: Random): { set: ProvisionalAdoptedEventSet; lastCommit: number } {
  const revisions: ProvisionalEventRevision[] = [];
  let commit = 0;
  for (let event = 0; event < between(random, 1, 5); event += 1) {
    const eventId = `event:test:${event}`;
    const count = random() < 0.3 ? 2 : 1;
    for (let revision = 1; revision <= count; revision += 1) {
      commit += between(random, 1, 2);
      const day = pick(random, [1, 2, 15, 30, 31]);
      const time: TemporalValue =
        random() < 0.75
          ? {
              kind: "local-date",
              value: `2026-03-${pad2(day)}`,
              zone: "Asia/Tokyo",
              basis: "provider",
            }
          : {
              kind: "instant",
              value: `2026-03-${pad2(day)}T0${between(random, 0, 5)}:00:00.000Z`,
              zone: "Asia/Tokyo",
              basis: "provider",
            };
      const accountId = random() < 0.8 ? ACCOUNT_A : ACCOUNT_B;
      const quantity: Quantity =
        random() < 0.92
          ? q(pick(random, ["JPY", "JPY", "USD"]), pick(random, ["100", "250", "0.5", "1000"]))
          : absentQuantity("JPY", "missing", "synthetic_value_unknown");
      const legs: ProvisionalLeg[] = [
        {
          legIndex: 0,
          accountId,
          effect: "movement",
          role: pick(random, ["increase", "decrease"] as const),
          ofLegIndex: null,
          basis: "cash-movement",
          quantity,
        },
      ];
      const unknown = random() < 0.2;
      revisions.push({
        eventId,
        revision,
        kind: "card_settlement",
        state: unknown ? "unknown" : "debited",
        unknownReason: unknown ? "conflicting_evidence" : null,
        times: [{ role: "posting", time }],
        commitRef: random() < 0.9 ? { coreEpoch: EPOCH, commitSeq: commit } : null,
        recordedAt: "2026-03-16T00:00:00.000Z",
        supersededBy: revision < count ? `${eventId}@${revision + 1}` : null,
        legs,
        evidenceIds: [],
        claims:
          random() < 0.5
            ? [{ book: "cash-movement", key: `key:test:${between(random, 0, 3)}` }]
            : [],
        flags: random() < 0.05 ? ["writer_unsupported"] : [],
      });
    }
  }
  return {
    lastCommit: commit,
    set: {
      contract: PROVISIONAL_EVENT_CONTRACT,
      resolution: "full-chains",
      setVersion: "set:test:1",
      adapterRelease: "adapter:test:v0",
      writers: ["card-settlement-review"],
      pins: {
        identityRelease: "identity:test:1",
        evidenceAliasRelease: "alias:test:1",
        coverageRelease: "coverage:test:1",
        fxReferenceRef: null,
        policyRefs: [],
      },
      revisions,
      familyCoverage: [
        { accountId: ACCOUNT_A, families: ["bank-transactions"], status: "evented" },
        { accountId: ACCOUNT_B, families: ["bank-transactions"], status: "evented" },
      ],
      historyCoverage: [
        {
          accountId: ACCOUNT_A,
          from: "2026-01-01",
          to: "2026-04-30",
          status: "complete",
          reasonCode: null,
        },
        random() < 0.8
          ? {
              accountId: ACCOUNT_B,
              from: "2026-01-01",
              to: "2026-04-30",
              status: "complete",
              reasonCode: null,
            }
          : {
              accountId: ACCOUNT_B,
              from: "2026-01-01",
              to: "2026-04-30",
              status: "gap",
              reasonCode: "synthetic_gap",
            },
      ],
    },
  };
}

function balance(
  ref: string,
  accountId: string,
  amount: string,
  capturedAt: string,
): ReconstructionReportedBalance {
  return {
    ref,
    accountId,
    metricId: "bank.ledger-balance",
    measurementKind: "stock",
    signMeaning: "asset-positive",
    quantity: q("JPY", amount),
    snapshotRef: `artifact:test:${ref}`,
    capturedAt,
  };
}

describe("reconstructState over random event sets", () => {
  test("the fold is order-free, conserves start + applied, and reconciles only a clean zero", () => {
    const broken: string[] = [];
    let cells = 0;
    for (const seed of seeds(1, 150)) {
      const random = seededRandom(seed);
      const { set, lastCommit } = randomSet(random);
      const cut = between(random, 0, lastCommit + 1);
      const start: StartSnapshot = {
        contextId: "context:test:start",
        date: "2026-03-01",
        accountsWithoutContainer: [],
        balances: [
          balance("start-a", ACCOUNT_A, "10000", START_CAPTURE),
          balance("start-b", ACCOUNT_B, "500", START_CAPTURE),
        ],
        positions: [],
      };
      const end: StartSnapshot = {
        ...start,
        contextId: "context:test:end",
        date: "2026-03-31",
        balances: [
          balance("end-a", ACCOUNT_A, pick(random, ["10000", "9900", "10250"]), END_CAPTURE),
          balance("end-b", ACCOUNT_B, "500", END_CAPTURE),
        ],
      };
      const request: ReconstructionRequest = {
        accountIds: [ACCOUNT_A, ACCOUNT_B],
        startDate: "2026-03-01",
        endDate: "2026-03-31",
        basis: "cash",
        knowledgeAt: "2026-04-05T00:00:00.000Z",
        knowledgeCut: { coreEpoch: EPOCH, commitSeq: cut },
      };
      const fold = (
        events: ProvisionalAdoptedEventSet,
        from: StartSnapshot,
        to: StartSnapshot,
        asked: ReconstructionRequest,
      ) => {
        const selection = selectKnowledge(events, { coreEpoch: EPOCH, commitSeq: cut });
        if (!selection.ok) return null;
        const result = reconstructState({
          request: asked,
          policy: RECONSTRUCTION_FOLD_V1,
          start: from,
          end: to,
          selection: selection.selection,
          baseline: null,
        });
        return result.ok ? result.state : null;
      };
      const state = fold(set, start, end, request);
      if (state === null) continue;
      const again = fold(
        {
          ...set,
          revisions: shuffled(random, set.revisions).map((revision) => ({
            ...revision,
            legs: shuffled(random, revision.legs),
          })),
          familyCoverage: shuffled(random, set.familyCoverage),
          historyCoverage: shuffled(random, set.historyCoverage),
        },
        { ...start, balances: shuffled(random, start.balances) },
        { ...end, balances: shuffled(random, end.balances) },
        { ...request, accountIds: shuffled(random, request.accountIds) },
      );
      if (canonicalJson(again) !== canonicalJson(state)) broken.push(`${seed}: order`);
      for (const cell of state.cells) {
        cells += 1;
        if (cell.partition === "not-computable" && cell.gaps.length === 0)
          broken.push(`${seed}: no gap`);
        const figure = cell.reconstructed.value;
        if (figure.status === "exact") {
          const origin = cell.start?.oriented.value;
          const applied = cell.applied.total.value;
          if (
            origin?.status !== "exact" ||
            applied.status !== "exact" ||
            !decimalEquals(figure.value, addDecimals(origin.value, applied.value))
          )
            broken.push(`${seed}: figure is not start + applied`);
          const reported = cell.explanation.reported?.oriented.value;
          const remainder = cell.explanation.remainder.value;
          if (
            reported?.status === "exact" &&
            remainder.status === "exact" &&
            !decimalEquals(remainder.value, subtractDecimals(reported.value, figure.value))
          )
            broken.push(`${seed}: remainder is not reported − reconstructed`);
        }
        if (cell.explanation.status === "reconciled") {
          const remainder = cell.explanation.remainder.value;
          if (
            cell.gaps.length > 0 ||
            cell.boundary.count > 0 ||
            remainder.status !== "exact" ||
            !isZeroDecimal(remainder.value)
          )
            broken.push(`${seed}: reconciled without a clean zero`);
        }
        // One event moves a cell at most once (INV06).
        const events = cell.applied.refs.map((ref) => ref.split("@")[0]);
        if (new Set(events).size !== events.length) broken.push(`${seed}: an event applied twice`);
      }
    }
    expect(broken).toEqual([]);
    expect(cells).toBeGreaterThan(100);
  });
});
