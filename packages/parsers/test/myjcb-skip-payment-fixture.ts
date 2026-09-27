// Synthetic MyJCB ショッピングスキップ払い schedule pages (ADR 0005 amendment e),
// in the structure the round-4 survey recorded: the page's h1, its "as of"
// heading, and one `div.detail-list-01` whose `div.head` has three cells, the
// middle one 「ご利用先など」 and 「お支払日」 on two lines. The survey did not
// record body cells; these rows mirror the head. Every date, merchant and
// amount is invented.
import type { ArtifactMeta } from "../src/types.ts";

export const SKIP_HEADING = "ショッピングスキップ払いご利用明細(未確定分)";
export const AS_OF_HEADING =
  "2026年3月20日(金)時点のショッピングスキップ払いご利用明細(2026年5月以降のお支払い分)";
export const SKIP_HEAD =
  '<div class="head"><div class="cell">ご利用日</div><div class="cell">ご利用先など<br>お支払日</div><div class="cell">今後のお支払い金額</div></div>';
export const FOUR_CELL_HEAD =
  '<div class="head"><div class="cell">ご利用日</div><div class="cell">ご利用先など</div><div class="cell">お支払日</div><div class="cell">今後のお支払い金額</div></div>';
export const EMPTY_ROW =
  '<div class="content"><div class="item-cell"><div class="cell w-100per">ご利用明細はありません。</div></div></div>';

export function skipRow(usage: string, middle: string, amount: string): string {
  return `<div class="content"><div class="item-cell"><div class="cell">${usage}</div><div class="cell">${middle}</div><div class="cell">${amount}</div></div></div>`;
}

export const ROWS = [
  skipRow("2026/03/02", "架空スキップ店<br>2026/05/11", "12,000円"),
  skipRow("2026/03/05", "架空スキップ商会<br>2026/06/10", "3,400円"),
];

export function skipPage(
  options: {
    readonly h1?: readonly string[];
    readonly asOf?: readonly string[];
    readonly ledgers?: readonly string[];
  } = {},
): string {
  const h1 = (options.h1 ?? [SKIP_HEADING]).map((text) => `<h1>${text}</h1>`).join("");
  const asOf = (options.asOf ?? [AS_OF_HEADING]).map((text) => `<h2>${text}</h2>`).join("");
  const ledgers = (options.ledgers ?? [ledger(SKIP_HEAD, ROWS)]).join("");
  return `<!doctype html><html lang="ja"><body><h1>MyJCB</h1>${h1}<p class="em-02">ご請求内容確定前のご利用明細を表示しており、確定後のご請求内容は現在表示されている内容と異なる場合があります。</p>${asOf}${ledgers}<h3 class="hdg-H3">カード情報</h3></body></html>`;
}

export function ledger(head: string, rows: readonly string[]): string {
  return `<div class="detail-list-01">${head}${rows.join("")}</div>`;
}

export function skipMeta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    id: 1,
    sourceId: "myjcb",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "credit-schedule",
    artifactKey: "synthetic-conn/credit-skip-payment-08.html",
    statementState: "unknown",
    period: "detailMonth-8",
    url: null,
    mime: "text/html",
    fetchedAt: "2026-03-20T01:00:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

export const bytes = (html: string) => new TextEncoder().encode(html);

/**
 * One synthetic input per closed code the parser throws, each reaching that
 * code and no earlier one (the checks run in a fixed order).
 */
export const REFUSAL_CASES: readonly {
  readonly code: string;
  readonly html: string;
  readonly meta: ArtifactMeta;
}[] = [
  {
    code: "schedule_run_ineligible",
    html: skipPage(),
    meta: skipMeta({ runStatus: "partial", runFailureCount: 1 }),
  },
  {
    code: "schedule_artifact_metadata_invalid",
    html: skipPage(),
    meta: skipMeta({ artifactKey: "synthetic-conn/credit-schedule-08.html" }),
  },
  {
    code: "schedule_artifact_metadata_invalid",
    html: skipPage(),
    meta: skipMeta({ period: "detailMonth-7" }),
  },
  {
    code: "schedule_artifact_metadata_invalid",
    html: skipPage(),
    meta: skipMeta({ statementState: "unconfirmed" }),
  },
  {
    code: "schedule_html_boundary",
    html: skipPage().replace("<body>", '<body><a href="/x">x</a>'),
    meta: skipMeta(),
  },
  {
    code: "schedule_html_boundary",
    html: "<p>not a document</p>",
    meta: skipMeta(),
  },
  {
    code: "schedule_kind_unobserved",
    html: skipPage({ h1: ["ボーナス払いご利用明細(未確定分)"] }),
    meta: skipMeta(),
  },
  {
    code: "schedule_kind_unobserved",
    html: skipPage({ h1: [SKIP_HEADING, SKIP_HEADING] }),
    meta: skipMeta(),
  },
  { code: "schedule_ledger_missing", html: skipPage({ ledgers: [] }), meta: skipMeta() },
  {
    code: "schedule_ledger_ambiguous",
    html: skipPage({ ledgers: [ledger(SKIP_HEAD, ROWS), ledger(SKIP_HEAD, ROWS)] }),
    meta: skipMeta(),
  },
  {
    code: "schedule_head_unobserved",
    html: skipPage({ ledgers: [ledger(FOUR_CELL_HEAD, ROWS)] }),
    meta: skipMeta(),
  },
  {
    code: "schedule_row_limit",
    html: skipPage({
      ledgers: [
        ledger(
          SKIP_HEAD,
          Array.from({ length: 1001 }, () => ROWS[0]!),
        ),
      ],
    }),
    meta: skipMeta(),
  },
  { code: "schedule_as_of_invalid", html: skipPage({ asOf: [] }), meta: skipMeta() },
  {
    code: "schedule_as_of_invalid",
    html: skipPage({
      asOf: [
        "2026年2月30日(月)時点のショッピングスキップ払いご利用明細(2026年5月以降のお支払い分)",
      ],
    }),
    meta: skipMeta(),
  },
  {
    code: "schedule_row_shape_unobserved",
    html: skipPage({
      ledgers: [
        ledger(SKIP_HEAD, [
          '<div class="content"><div class="item-cell"><div class="cell">2026/03/02</div><div class="cell">架空スキップ店</div><div class="cell">2026/05/11</div><div class="cell">12,000円</div></div></div>',
        ]),
      ],
    }),
    meta: skipMeta(),
  },
  {
    code: "schedule_row_shape_unobserved",
    html: skipPage({
      ledgers: [ledger(SKIP_HEAD, [skipRow("2026/03/02", "架空スキップ店", "12,000円")])],
    }),
    meta: skipMeta(),
  },
  // Rows nested under a wrapper are not the observed grid: refused, never
  // read as an empty ledger (INV05).
  {
    code: "schedule_row_shape_unobserved",
    html: skipPage({
      ledgers: [
        `<div class="detail-list-01">${SKIP_HEAD}<div class="body">${ROWS.join("")}</div></div>`,
      ],
    }),
    meta: skipMeta(),
  },
  {
    code: "schedule_row_shape_unobserved",
    html: skipPage({
      asOf: [],
      ledgers: [
        `<div class="detail-list-01">${SKIP_HEAD}${EMPTY_ROW}<div class="note">x</div></div>`,
      ],
    }),
    meta: skipMeta(),
  },
  {
    code: "schedule_date_invalid",
    html: skipPage({
      ledgers: [
        ledger(SKIP_HEAD, [skipRow("2026/02/30", "架空スキップ店<br>2026/05/11", "12,000円")]),
      ],
    }),
    meta: skipMeta(),
  },
  {
    code: "schedule_amount_invalid",
    html: skipPage({
      ledgers: [ledger(SKIP_HEAD, [skipRow("2026/03/02", "架空スキップ店<br>2026/05/11", "")])],
    }),
    meta: skipMeta(),
  },
];
