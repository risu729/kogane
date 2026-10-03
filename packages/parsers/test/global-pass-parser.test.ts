import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { globalPassActivity } from "../src/parsers/global-pass-activity-parser.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

const path = join(FIXTURES_ROOT, "global-pass", "activity-2099-02.html");
const bytes = () => readFileSync(path);
const meta = (overrides: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  id: 1,
  sourceId: "global-pass",
  runStatus: "success",
  runFailureCount: 0,
  dataset: "globalpass-activity",
  artifactKey: "activity-2099-02.html",
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

  test("accepts the Layer-A one-to-fifteen-month selector range and a genuine empty month", () => {
    const html = bytes().toString("utf8");
    const oneMonth = html.replace(
      /<option value="20990199">[\s\S]*?<option value="20971299">2097-12<\/option>/u,
      "",
    );
    expect(
      globalPassActivity.parse(new TextEncoder().encode(oneMonth), meta()).observations,
    ).toHaveLength(1);

    const firstNested = html.indexOf('<table data-view="compact">');
    const outer = html.indexOf('<table data-view="activity">');
    if (firstNested < 0 || outer < 0) throw new Error("empty fixture boundary missing");
    const onlyOuter = html.slice(0, firstNested) + html.slice(outer);
    const empty = onlyOuter.replace(
      /(<table data-view="activity">[\s\S]*?<tbody>)[\s\S]*?(<\/tbody><\/table>)/u,
      "$1\n$2",
    );
    expect(globalPassActivity.parse(new TextEncoder().encode(empty), meta())).toEqual({
      observations: [],
      warnings: [],
    });
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
    expect(() =>
      globalPassActivity.parse(bytes(), meta({ artifactKey: "activity-2099-01.html" })),
    ).toThrow(/artifact key and selected month/u);
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

  // A walked month (ADR 0026's amendment of 2026-10-04): page 1 keeps its
  // key and every 1.0.0 output; page 2 onward is `activity-YYYY-MM-pN.html`
  // and names its page in the external id and the raw locator. The pager is
  // the observed `div.nablarch_currentPageNumber`, in English or Japanese.
  const withPager = (label: string) =>
    mutate(
      "<h1>ご利用明細</h1>",
      `<h1>ご利用明細</h1><div class="nablarch_paging"><div class="nablarch_currentPageNumber">${label}</div></div>` +
        `<div class="nablarch_paging"><div class="nablarch_currentPageNumber">${label}</div></div>`,
    );

  test("page 1 is read exactly as before, with or without its pager", () => {
    const plain = globalPassActivity.parse(bytes(), meta());
    expect(globalPassActivity.parse(withPager("[1/2page]"), meta())).toEqual(plain);
    expect(globalPassActivity.parse(withPager("[1/1ページ]"), meta())).toEqual(plain);
    const first = plain.observations[0]!;
    expect(first.kind === "transaction" && first.externalId).toMatch(/^global-pass:[^:]+:0$/u);
    expect(first.rawLocator).toBe("html:activity-record=1");
  });

  test("a later page qualifies its external id and locator by its page", () => {
    const pageOne = globalPassActivity.parse(withPager("[1/2page]"), meta()).observations[0]!;
    for (const label of ["[2/2page]", "[2/2ページ]"]) {
      const pageTwo = globalPassActivity.parse(
        withPager(label),
        meta({ artifactKey: "activity-2099-02-p2.html" }),
      ).observations[0]!;
      if (pageOne.kind !== "transaction" || pageTwo.kind !== "transaction") {
        throw new Error("unreachable");
      }
      // The same provider row on another page is another row: its id differs
      // only by the page segment, so nothing is counted twice or merged.
      expect(pageTwo.externalId).toBe(pageOne.externalId!.replace(/:0$/u, ":p2:0"));
      expect(pageTwo.rawLocator).toBe("html:activity-page=2;activity-record=1");
      expect(pageTwo.extra).toMatchObject({
        _kogane: {
          identityOrigin: "all-provider-fields+page+occurrence",
          selectedMonth: "2099-02",
        },
      });
      expect({ ...pageTwo, externalId: "", rawLocator: "", extra: {} }).toEqual({
        ...pageOne,
        externalId: "",
        rawLocator: "",
        extra: {},
      });
    }
  });

  test("the key, the pager and the selected month must agree", () => {
    const p2 = meta({ artifactKey: "activity-2099-02-p2.html" });
    // A later page without a pager, or naming another page.
    expect(() => globalPassActivity.parse(bytes(), p2)).toThrow(/no pager/u);
    expect(() => globalPassActivity.parse(withPager("[1/2page]"), p2)).toThrow(/different pages/u);
    expect(() => globalPassActivity.parse(withPager("[2/2page]"), meta())).toThrow(
      /different pages/u,
    );
    expect(() => globalPassActivity.parse(withPager("2/2"), meta())).toThrow(/unreadable/u);
    // Keys outside the scheme: page 1 is never qualified, at most page 9.
    for (const artifactKey of [
      "activity-2099-02-p1.html",
      "activity-2099-02-p10.html",
      "activity-2099-01-p2.html",
      "activity-2099-02-p2.htm",
    ]) {
      expect(() => globalPassActivity.parse(withPager("[2/2page]"), meta({ artifactKey }))).toThrow(
        /artifact key and selected month/u,
      );
    }
  });

  test("reads the observed English table labels in both line-break notations", () => {
    // The live English month page (2026-10-04) states twelve labels; the same
    // label may be written with or without a line break inside it.
    const live = bytes()
      .toString("utf8")
      .replace(
        /<th>Transaction Date<\/th>[\s\S]*?<th>Funded Currency and Amount<\/th>\n<\/tr><\/thead><tbody>\n<tr><td>2099/u,
        "<th>Transaction<br>Date</th><th>Transaction Detail</th><th>Transaction Currency<br>and Amount</th>" +
          "<th>Transaction Fee</th><th>ATM Fee</th><th>FX commissions</th><th>Status</th><th>Approval Number</th>" +
          "<th>Remarks</th><th>Local Currency and Amount</th><th>Local Fee</th><th>Applicable Rate</th>\n</tr></thead><tbody>\n<tr><td>2099",
      );
    expect(live).toContain("FX commissions");
    expect(
      globalPassActivity.parse(new TextEncoder().encode(live), meta()).observations,
    ).toHaveLength(1);
  });
});
