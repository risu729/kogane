import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { globalPassActivity } from "../src/parsers/global-pass-activity-parser.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import type { ArtifactMeta } from "../src/types.ts";

const path = join(import.meta.dir, "..", "fixtures", "global-pass", "activity-2099-02.html");
const bytes = () => readFileSync(path);
const meta = (overrides: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  id: 1,
  sourceId: "global-pass",
  runStatus: "success",
  runFailureCount: 0,
  dataset: "globalpass-activity",
  url: null,
  mime: "text/html",
  fetchedAt: "2099-03-01T00:00:00Z",
  sha256: "0".repeat(64),
  ...overrides,
});

function mutate(search: string, replacement: string): Uint8Array {
  const text = bytes().toString("utf8");
  if (!text.includes(search)) throw new Error("test mutation target missing");
  return new TextEncoder().encode(text.replace(search, replacement));
}

describe("global-pass-activity", () => {
  test("is the sole registered parser for the Layer-A activity artifact", () => {
    expect(globalPassActivity.accepts(meta())).toBe(true);
    expect(PARSERS.filter((parser) => parser.accepts(meta()))).toEqual([globalPassActivity]);
    expect(globalPassActivity.accepts(meta({ sourceId: "prestia-globalpass" }))).toBe(false);
    expect(globalPassActivity.accepts(meta({ dataset: "collector-manifest" }))).toBe(false);
    expect(globalPassActivity.accepts(meta({ mime: "text/html; charset=utf-8" }))).toBe(false);
  });

  test("ignores the single unselected non-month option and emits one transaction without inventing direction", () => {
    const result = globalPassActivity.parse(bytes(), meta());
    expect(result.observations).toHaveLength(1);
    expect(result.warnings).toEqual([
      "global-pass: unsigned provider amounts were preserved without inferred minor-unit direction",
    ]);
    expect(result.observations[0]).toMatchObject({
      kind: "transaction",
      sourceAccount: "global-pass:card",
      amountText: "12.34",
      amountScale: 2,
      currency: "USD",
      description: "ANONYMOUS MERCHANT",
      asOf: "2099-02-03",
      rawLocator: "html:activity-record=1",
      extra: {
        _kogane: {
          selectedMonth: "2099-02",
          sourceView: "single-provider-html-with-responsive-duplicate",
          amountDirection: "unresolved-unsigned",
          pendingToConfirmedIdentity: "unproven",
        },
      },
    });
    expect(result.observations[0]).not.toHaveProperty("amountMinor");
    expect(result.observations[0]).not.toHaveProperty("status");
    expect(result.observations[0]!.extra).toMatchObject({
      expandedFields: { Status: "ANONYMOUS STATUS", "Approval Number": "ANON-001" },
    });
  });

  test("is deterministic and gives exact duplicates distinct occurrence identities", () => {
    const first = globalPassActivity.parse(bytes(), meta());
    expect(globalPassActivity.parse(bytes(), meta())).toEqual(first);
    const duplicate = mutate(
      '</tbody></table>\n<table data-view="activity">',
      "</tbody></table>\n" +
        bytes()
          .toString("utf8")
          .match(
            /<table data-view="compact">[\s\S]*?<\/table>\n<table data-view="expanded">[\s\S]*?<\/table>/u,
          )![0] +
        '\n<table data-view="activity">',
    );
    const withOuterRows = new TextDecoder()
      .decode(duplicate)
      .replace(
        "</tr>\n</tbody></table>\n</body>",
        "</tr><tr><td>2099/02/03</td><td>ANONYMOUS MERCHANT</td><td>USD 12.34</td><td>JPY 0</td><td>JPY 0</td><td>JPY 0</td><td>ANONYMOUS STATUS</td><td>ANON-001</td><td></td></tr><tr><td>USD 12.34</td><td>ANONYMOUS MERCHANT</td><td>JPY 1,900</td><td>JPY 1,900</td></tr>\n</tbody></table>\n</body>",
      );
    const parsed = globalPassActivity.parse(new TextEncoder().encode(withOuterRows), meta());
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.observations.every((observation) => observation.kind === "transaction")).toBe(
      true,
    );
    const transactions = parsed.observations.filter(
      (observation) => observation.kind === "transaction",
    );
    expect(transactions[0]!.externalId).not.toBe(transactions[1]!.externalId);
  });

  test("rejects nonterminal runs and every strict structural boundary", () => {
    expect(() => globalPassActivity.parse(bytes(), meta({ runStatus: "failed" }))).toThrow(
      /successful failure-free/u,
    );
    expect(() => globalPassActivity.parse(bytes(), meta({ runFailureCount: 1 }))).toThrow(
      /successful failure-free/u,
    );
    expect(() =>
      globalPassActivity.parse(bytes(), meta({ mime: "application/octet-stream" })),
    ).toThrow(/metadata/u);
    expect(() => globalPassActivity.parse(new Uint8Array([0xff]), meta())).toThrow(/UTF-8/u);
    expect(() => globalPassActivity.parse(new Uint8Array(2 * 1024 * 1024 + 1), meta())).toThrow(
      /size/u,
    );
    expect(() => globalPassActivity.parse(mutate("selected>2099-02", ">2099-02"), meta())).toThrow(
      /one selected/u,
    );
    expect(() =>
      globalPassActivity.parse(
        mutate('value="">Select month', 'value="" selected>Select month'),
        meta(),
      ),
    ).toThrow(/unselected default/u);
    expect(() =>
      globalPassActivity.parse(
        mutate(
          '<option value="">Select month</option>',
          '<option value="">Select month</option><option value="all">All months</option>',
        ),
        meta(),
      ),
    ).toThrow(/at most one unselected default/u);
    expect(() => globalPassActivity.parse(mutate("20990199", "20981198"), meta())).toThrow(
      /duplicates|contiguous/u,
    );
    expect(() => globalPassActivity.parse(mutate("2099/02/03", "2099/02/30"), meta())).toThrow(
      /calendar date/u,
    );
    expect(() => globalPassActivity.parse(mutate("2099/02/03", "2099/01/31"), meta())).toThrow(
      /selected month/u,
    );
    expect(
      globalPassActivity.parse(mutate("<th>Remarks</th>", "<th>New Field</th>"), meta())
        .observations[0]!.extra,
    ).toMatchObject({
      expandedFields: { "New Field": "" },
    });
    expect(() =>
      globalPassActivity.parse(mutate("<th>Status</th>", "<th>New Field</th>"), meta()),
    ).toThrow(/missing Status/u);
    expect(() =>
      globalPassActivity.parse(
        mutate("<td>USD 12.34</td></tr><tr><td>JPY 0", "<td>USD 99.99</td></tr><tr><td>JPY 0"),
        meta(),
      ),
    ).toThrow(/disagree/u);
    expect(() =>
      globalPassActivity.parse(
        mutate("<td>ANON-001</td>", "<td>ANON-001</td><td>extra</td>"),
        meta(),
      ),
    ).toThrow(/cardinality/u);
  });
});
