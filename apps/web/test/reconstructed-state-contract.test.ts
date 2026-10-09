// The wire contract of `GET /api/v2/reconstructed-state` against answers the
// service itself produces (packages/application/test/reconstructed-state-world.ts):
// every world's answer passes, and an answer that carries an adjustment, a
// total or a net worth, an unknown code, or a computed figure without its
// reasons is refused rather than displayed. The contract's restated code lists
// are pinned to the query's own, and the page has words for every code.
import { describe, expect, test } from "bun:test";
import {
  LATE_UNAVAILABLE_REASONS,
  RECONSTRUCTED_STATE_QUERY_SCHEMA,
  RECONSTRUCTED_STATE_REASONS,
  RECONSTRUCTED_STATE_STATUS_REASONS,
  RECONSTRUCTED_STATE_STATUSES,
} from "../../../packages/application/src/query/reconstructed-state.ts";
import { RECONSTRUCTED_STATE_REFUSAL_CODES } from "../../../packages/application/src/query/reconstructed-state-read.ts";
import {
  reconstructedStateOutcome,
  reconstructedStateWorlds,
  WORLD_BANK,
  WORLD_CARD,
  WORLD_EMPTY_LOG,
  WORLD_FROM,
  WORLD_NO_GUARD,
  WORLD_PRE_LOG,
  WORLD_TO,
} from "../../../packages/application/test/reconstructed-state-world.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import {
  validApiCapabilities,
  validApiResponse,
} from "../../../packages/observation-shared/src/api-validation.ts";
import {
  RECONSTRUCTED_STATE_LATE_UNAVAILABLE,
  RECONSTRUCTED_STATE_STATUS_GROUPS,
  RECONSTRUCTED_STATE_QUERY_SCHEMA as WIRE_SCHEMA,
  RECONSTRUCTED_STATE_WIRE_REASONS,
  RECONSTRUCTED_STATE_WIRE_STATUSES,
  statusOfReasons,
  validReconstructedState,
} from "../../../packages/observation-shared/src/reconstructed-state-contract.ts";
import { clientFeatures } from "../src/capabilities.ts";
import {
  RECONSTRUCTION_REASON_LABELS,
  RECONSTRUCTION_REFUSAL_MESSAGES,
} from "../src/pages/ReconstructedState.tsx";
import { reconstructedStateSearch } from "../src/reconstructed-state-api.ts";
import { matchRoute } from "../src/router.tsx";

const PATH = "/api/v2/reconstructed-state";
const NOW = "2026-04-30T00:00:00.000Z";

async function answer(account: string) {
  const outcome = await reconstructedStateOutcome(
    reconstructedStateWorlds(),
    new URLSearchParams({ account, from: WORLD_FROM, to: WORLD_TO }),
    NOW,
  );
  if (!outcome.ok) throw new Error(outcome.refusal);
  return outcome.body;
}

describe("reconstructed state HTTP contract", () => {
  test("every world's answer is valid", async () => {
    for (const account of [WORLD_BANK, WORLD_CARD, WORLD_PRE_LOG, WORLD_EMPTY_LOG, WORLD_NO_GUARD])
      expect([account, validApiResponse(PATH, await answer(account))]).toEqual([account, true]);
  });

  test("a figure, a code or a shape the contract does not name is refused", async () => {
    const body = await answer(WORLD_BANK);
    const mutate = (change: (copy: Record<string, any>) => void): boolean => {
      const copy = structuredClone(body) as Record<string, any>;
      change(copy);
      return validReconstructedState(copy);
    };
    expect(mutate(() => {})).toBe(true);
    const cell = (copy: Record<string, any>) => copy["reconstruction"]["cells"][0];
    // No adjustment absorbs a difference; no total or net worth is added.
    expect(mutate((copy) => (cell(copy)["explanation"]["adjustment"] = "500"))).toBe(false);
    expect(mutate((copy) => (cell(copy)["adjusted"] = cell(copy)["reconstructed"]))).toBe(false);
    expect(mutate((copy) => (copy["total"] = "9000"))).toBe(false);
    expect(mutate((copy) => (copy["reconstruction"]["netWorth"] = "9000"))).toBe(false);
    // Closed codes.
    expect(mutate((copy) => (copy["status"] = "ok"))).toBe(false);
    expect(mutate((copy) => copy["reasons"].push("looks_fine"))).toBe(false);
    expect(mutate((copy) => (cell(copy)["explanation"]["status"] = "adjusted"))).toBe(false);
    expect(mutate((copy) => cell(copy)["gaps"].push("unknown_gap"))).toBe(false);
    expect(mutate((copy) => (copy["cutStanding"] = "maybe"))).toBe(false);
    // A computed answer says why it is not complete, and a complete one has no reason.
    expect(mutate((copy) => (copy["reasons"] = []))).toBe(false);
    expect(mutate((copy) => (copy["status"] = "complete"))).toBe(false);
    // The difference is a quantity, never a bare number.
    expect(mutate((copy) => (cell(copy)["explanation"]["remainder"] = -500))).toBe(false);
    expect(mutate((copy) => delete copy["manifest"])).toBe(false);
    expect(mutate((copy) => (copy["late"] = null))).toBe(false);
  });

  test("an explanation's status is tied to its figures, and the status to its reasons", async () => {
    const body = await answer(WORLD_BANK);
    const mutate = (change: (copy: Record<string, any>) => void): boolean => {
      const copy = structuredClone(body) as Record<string, any>;
      change(copy);
      return validReconstructedState(copy);
    };
    const cell = (copy: Record<string, any>) => copy["reconstruction"]["cells"][0];
    /** The cell as the fold gives it once coverage is declared: complete, no gap. */
    const compared = (copy: Record<string, any>, status: string) => {
      copy["status"] = "complete";
      copy["reasons"] = [];
      cell(copy)["gaps"] = [];
      cell(copy)["partition"] = "complete";
      cell(copy)["explanation"]["status"] = status;
      cell(copy)["explanation"]["reasonCode"] = null;
    };
    // The bank cell's remainder is −500: unexplained, never matched.
    expect(mutate((copy) => compared(copy, "difference_unexplained"))).toBe(true);
    expect(mutate((copy) => compared(copy, "reconciled"))).toBe(false);
    expect(mutate((copy) => compared(copy, "consistent_with_boundary_exclusion"))).toBe(false);
    const zero = (copy: Record<string, any>) =>
      (cell(copy)["explanation"]["remainder"]["value"]["value"] = { coefficient: "0", scale: 0 });
    expect(
      mutate((copy) => {
        compared(copy, "reconciled");
        zero(copy);
      }),
    ).toBe(true);
    expect(
      mutate((copy) => {
        compared(copy, "difference_unexplained");
        zero(copy);
      }),
    ).toBe(false);
    // An unexplained difference has no gap, a complete cell, no reason and the reported end.
    expect(
      mutate((copy) => {
        compared(copy, "difference_unexplained");
        cell(copy)["gaps"] = ["history_gap"];
      }),
    ).toBe(false);
    expect(
      mutate((copy) => {
        compared(copy, "difference_unexplained");
        cell(copy)["partition"] = "partial-verified-scope";
      }),
    ).toBe(false);
    expect(
      mutate((copy) => {
        compared(copy, "difference_unexplained");
        cell(copy)["explanation"]["reasonCode"] = "reconstruction_incomplete";
      }),
    ).toBe(false);
    expect(
      mutate((copy) => {
        compared(copy, "difference_unexplained");
        cell(copy)["explanation"]["reported"] = null;
      }),
    ).toBe(false);
    // A status that does not compare names its reason.
    expect(mutate((copy) => (cell(copy)["explanation"]["reasonCode"] = null))).toBe(false);
    // ... from its own list.
    expect(
      mutate((copy) => (cell(copy)["explanation"]["reasonCode"] = "no_reported_container")),
    ).toBe(false);
    expect(
      mutate((copy) => {
        cell(copy)["explanation"]["status"] = "unavailable";
        cell(copy)["explanation"]["reasonCode"] = null;
      }),
    ).toBe(false);
    // The status is the group of the first reason, the reasons in the query's order.
    expect(mutate((copy) => (copy["status"] = "needs_review"))).toBe(false);
    expect(mutate((copy) => (copy["reasons"] = [...copy["reasons"]].reverse()))).toBe(false);
    expect(
      mutate((copy) => {
        copy["status"] = "unavailable";
        copy["reasons"] = ["economic_guard_missing", ...copy["reasons"]];
      }),
    ).toBe(false);
  });

  test("the status groups are the query's precedence", async () => {
    expect(statusOfReasons([])).toBe("complete");
    expect(statusOfReasons(["family_not_evented"])).toBe("incomplete");
    expect(statusOfReasons(["writer_unsupported", "family_not_evented"])).toBe("needs_review");
    expect(statusOfReasons(["family_not_evented", "writer_unsupported"])).toBeNull();
    const groups = Object.values(RECONSTRUCTED_STATE_STATUS_GROUPS).flat() as string[];
    expect(groups).toEqual([...RECONSTRUCTED_STATE_REASONS].slice(0, groups.length) as string[]);
    expect(Object.keys(RECONSTRUCTED_STATE_STATUS_GROUPS)).toEqual(
      [...RECONSTRUCTED_STATE_STATUSES].slice(0, 3),
    );
    for (const [status, group] of Object.entries(RECONSTRUCTED_STATE_STATUS_GROUPS))
      expect([status, [...group]]).toEqual([
        status,
        [
          ...RECONSTRUCTED_STATE_STATUS_REASONS[
            status as keyof typeof RECONSTRUCTED_STATE_STATUS_GROUPS
          ],
        ],
      ]);
  });

  test("an answer without a reconstruction must be the missing guard, with nothing else", async () => {
    const body = await answer(WORLD_NO_GUARD);
    expect(validReconstructedState(body)).toBe(true);
    expect(validReconstructedState({ ...body, reasons: ["no_reported_container"] })).toBe(false);
    expect(validReconstructedState({ ...body, status: "incomplete" })).toBe(false);
    const bank = await answer(WORLD_BANK);
    expect(validReconstructedState({ ...bank, reconstruction: null })).toBe(false);
  });

  test("the contract's code lists are the query's own, and the page has words for each", () => {
    expect(WIRE_SCHEMA).toBe(RECONSTRUCTED_STATE_QUERY_SCHEMA);
    expect([...RECONSTRUCTED_STATE_WIRE_STATUSES]).toEqual([...RECONSTRUCTED_STATE_STATUSES]);
    expect([...RECONSTRUCTED_STATE_WIRE_REASONS] as string[]).toEqual([
      ...RECONSTRUCTED_STATE_REASONS,
    ]);
    expect([...RECONSTRUCTED_STATE_LATE_UNAVAILABLE]).toEqual([...LATE_UNAVAILABLE_REASONS]);
    for (const code of RECONSTRUCTED_STATE_REASONS)
      expect([code, Object.hasOwn(RECONSTRUCTION_REASON_LABELS, code)]).toEqual([code, true]);
    expect(Object.keys(RECONSTRUCTION_REFUSAL_MESSAGES).sort()).toEqual(
      [...RECONSTRUCTED_STATE_REFUSAL_CODES].sort(),
    );
  });

  test("the capability, the feature, the route and the query string", () => {
    expect(
      validApiCapabilities({ ...CENTRAL_STORE_CAPABILITIES, reconstructedStateOnDate: true }),
    ).toBe(true);
    expect(clientFeatures(CENTRAL_STORE_CAPABILITIES).reconstructedStateOnDate).toBe(false);
    expect(
      clientFeatures({ ...CENTRAL_STORE_CAPABILITIES, reconstructedStateOnDate: true })
        .reconstructedStateOnDate,
    ).toBe(true);
    expect(matchRoute("/reconstruction")).toEqual({ name: "reconstructedState" });
    expect(matchRoute("/reconstruction/acct")).toEqual({
      name: "notFound",
      path: "/reconstruction/acct",
    });
    const base = { account: WORLD_BANK, from: WORLD_FROM, to: WORLD_TO };
    expect(reconstructedStateSearch({ ...base, cut: { kind: "latest" } }).toString()).toBe(
      `account=${WORLD_BANK}&from=${WORLD_FROM}&to=${WORLD_TO}`,
    );
    expect(
      reconstructedStateSearch({
        ...base,
        cut: { kind: "sequence", coreEpoch: "core-epoch-1", commitSeq: "2" },
      }).get("commitSeq"),
    ).toBe("2");
    expect(
      reconstructedStateSearch({
        ...base,
        cut: { kind: "instant", coreEpoch: "core-epoch-1", instant: NOW },
      }).get("instant"),
    ).toBe(NOW);
  });
});
