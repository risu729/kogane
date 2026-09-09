import { describe, expect, test } from "bun:test";
import { openContext } from "../src/context/open.ts";
import { explain, parseExplainRequest } from "../src/explain.ts";
import {
  parseProposalRequest,
  type ProposalStore,
  proposeReconciliation,
  type StoredProposal,
} from "../src/propose.ts";
import { CONTEXT_INPUTS, explainReader, grant, observationDetail } from "./fixture.ts";
import type { Grant } from "../src/grants.ts";

async function opened(grantValue: Grant) {
  return openContext(grantValue, CONTEXT_INPUTS);
}

describe("explanation graphs are bounded, id-only and re-authorised", () => {
  test("records.read without evidence.read cannot reach a raw locator", async () => {
    const records = grant({ capabilities: ["summary.read", "records.read"] });
    const outcome = await explain({
      grant: records,
      opened: await opened(records),
      reader: explainReader(observationDetail("fixture-a", "account-a")),
      request: { ref: "observation:transaction:1", depth: null },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.graph.nodes.some((node) => node.kind === "parse-run")).toBe(true);
    expect(outcome.graph.nodes.some((node) => node.kind === "raw-locator")).toBe(false);
    expect(outcome.graph.restricted).toEqual(["evidence.read"]);
    expect(JSON.stringify(outcome.graph)).not.toContain("a".repeat(64));
  });

  test("evidence.read adds the locators and nothing else", async () => {
    const full = grant();
    const outcome = await explain({
      grant: full,
      opened: await opened(full),
      reader: explainReader(observationDetail("fixture-a", "account-a")),
      request: { ref: "observation:transaction:1", depth: null },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const refs = outcome.graph.nodes.map((node) => node.ref);
    expect(refs).toContain("fetch_artifact:5");
    expect(refs).toContain(`raw:${"a".repeat(64)}`);
    // The provider URL and the provider text stay out of the graph entirely.
    const serialized = JSON.stringify(outcome.graph);
    expect(serialized).not.toContain("provider.invalid");
    expect(serialized).not.toContain("auth token");
    expect(outcome.graph.restricted).toEqual([]);
  });

  test("depth bounds the graph", async () => {
    const full = grant();
    const outcome = await explain({
      grant: full,
      opened: await opened(full),
      reader: explainReader(observationDetail("fixture-a", "account-a")),
      request: { ref: "observation:transaction:1", depth: 2 },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.graph.nodes.every((node) => node.depth <= 2)).toBe(true);
    expect(outcome.graph.truncated).toBe(true);
  });

  test("an out-of-scope row and a missing row give the same answer", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const context = await opened(narrow);
    const hidden = await explain({
      grant: narrow,
      opened: context,
      reader: explainReader(observationDetail("fixture-b", "account-b")),
      request: { ref: "observation:transaction:1", depth: null },
    });
    const absent = await explain({
      grant: narrow,
      opened: context,
      reader: explainReader(undefined),
      request: { ref: "observation:transaction:999", depth: null },
    });
    expect(hidden.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (hidden.ok || absent.ok) return;
    expect(hidden.error.code).toBe("evidence_restricted");
    expect(absent.error.code).toBe("evidence_restricted");
    expect(hidden.error.message).toBe(absent.error.message);
    expect(hidden.error.refs).toEqual(absent.error.refs);
  });

  test("a ref that is not a known reference kind is refused", async () => {
    const full = grant();
    for (const ref of [
      "https://provider.invalid/x",
      "parse_runs",
      "'; DROP TABLE parse_runs; --",
    ]) {
      const outcome = await explain({
        grant: full,
        opened: await opened(full),
        reader: explainReader(observationDetail("fixture-a", "account-a")),
        request: { ref, depth: null },
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.code).toBe("unsupported_semantics");
    }
  });

  test("the explain body accepts two keys and nothing else", () => {
    expect(parseExplainRequest({ ref: "observation:transaction:1" }).ok).toBe(true);
    expect(parseExplainRequest({ ref: "x", url: "https://provider.invalid" }).ok).toBe(false);
  });
});

function store(
  known: Record<string, { sourceId: string; account: string | null }>,
): ProposalStore & {
  written: StoredProposal[];
} {
  const written: StoredProposal[] = [];
  return {
    written,
    resolveTarget: async (ref) => known[ref] ?? null,
    resolveEvidence: async (ref) => known[ref] ?? null,
    appendProposal: async (proposal) => {
      written.push(proposal);
    },
  };
}

const KNOWN = {
  "source_account:sa_1": { sourceId: "fixture-a", account: "account-a" },
  "source_account:sa_2": { sourceId: "fixture-a", account: "account-a" },
  "source_account:sa_hidden": { sourceId: "fixture-b", account: "account-b" },
  "observation:transaction:1": { sourceId: "fixture-a", account: "account-a" },
};

const BODY = {
  kind: "same_account",
  from: "source_account:sa_1",
  to: "source_account:sa_2",
  evidenceRefs: ["observation:transaction:1"],
  reason: "the two references share an evidenced identifier",
  method: "ai",
};

describe("proposals are immutable claims, never adoptions", () => {
  test("a stored proposal is a proposed relation with a propose decision", async () => {
    const full = grant();
    const parsed = parseProposalRequest(BODY, full.budget.maxProposalTargets);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = store(KNOWN);
    const outcome = await proposeReconciliation({
      grant: full,
      opened: await opened(full),
      store: target,
      request: parsed.value,
      now: "2026-09-09T00:00:00Z",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.receipt.status).toBe("proposed");
    expect(outcome.receipt.adopted).toBe(false);
    expect(target.written).toHaveLength(1);
    expect(target.written[0]!.actorId).toBe(full.principal);
  });

  test("a proposal naming evidence that does not exist is refused", async () => {
    const full = grant();
    const parsed = parseProposalRequest(
      { ...BODY, evidenceRefs: ["observation:transaction:999"] },
      full.budget.maxProposalTargets,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = store(KNOWN);
    const outcome = await proposeReconciliation({
      grant: full,
      opened: await opened(full),
      store: target,
      request: parsed.value,
      now: "2026-09-09T00:00:00Z",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("incomplete_evidence");
    expect(target.written).toHaveLength(0);
  });

  test("a proposal naming a target outside the grant is refused and writes nothing", async () => {
    const narrow = grant({ scopes: { sources: ["fixture-a"], accounts: "*" } });
    const parsed = parseProposalRequest(
      { ...BODY, to: "source_account:sa_hidden" },
      narrow.budget.maxProposalTargets,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const target = store(KNOWN);
    const outcome = await proposeReconciliation({
      grant: narrow,
      opened: await opened(narrow),
      store: target,
      request: parsed.value,
      now: "2026-09-09T00:00:00Z",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("incomplete_evidence");
    expect(target.written).toHaveLength(0);
  });

  test("interpretation.propose is required, and no capability reaches adoption", async () => {
    const reader = grant({ capabilities: ["summary.read", "records.read", "evidence.read"] });
    const parsed = parseProposalRequest(BODY, reader.budget.maxProposalTargets);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const outcome = await proposeReconciliation({
      grant: reader,
      opened: await opened(reader),
      store: store(KNOWN),
      request: parsed.value,
      now: "2026-09-09T00:00:00Z",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("unauthorized");
  });

  test("the proposal body rejects free-form refs, self relations and unknown keys", () => {
    for (const body of [
      { ...BODY, from: "https://provider.invalid" },
      { ...BODY, to: BODY.from },
      { ...BODY, evidenceRefs: ["SELECT 1"] },
      { ...BODY, status: "accepted" },
      { ...BODY, kind: "adopted" },
    ])
      expect(parseProposalRequest(body, 20).ok).toBe(false);
  });

  test("too many refs are a budget refusal, not a partial write", () => {
    const outcome = parseProposalRequest(
      { ...BODY, evidenceRefs: ["observation:transaction:1", "observation:transaction:2"] },
      3,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("budget_exceeded");
  });
});
