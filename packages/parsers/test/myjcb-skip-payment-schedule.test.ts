// `myjcb-skip-payment-schedule` 0.1.2 (ADR 0005 amendments e, f and k) on
// synthetic pages only: the observed three-cell head is read, every other shape
// is refused with a closed code, and nothing is a transaction or a balance.
import { describe, expect, test } from "bun:test";
import { myJcbSkipPaymentSchedule } from "../src/parsers/myjcb-skip-payment-schedule.ts";
import { SKIP_PAYMENT_SCHEDULE_PARSER_CODES } from "../src/parsers/myjcb-skip-payment-schedule.ts";
import { PARSERS, PARSER_DIGESTS } from "../src/parsers/registry.ts";
import {
  BONUS_HEAD,
  BONUS_HEADING,
  EMPTY_ITEM_CELL,
  EMPTY_ROW,
  FOUR_CELL_HEAD,
  REFUSAL_CASES,
  ROWS,
  SKIP_HEAD,
  SPAN_SKIP_HEAD,
  bytes,
  ledger,
  skipMeta,
  skipPage,
  skipRow,
  WRAPPED_EMPTY_ROW,
  wrappedRow,
} from "./myjcb-skip-payment-fixture.ts";

const parse = (html: string, meta = skipMeta()) =>
  myJcbSkipPaymentSchedule.parse(bytes(html), meta);

describe("myjcb-skip-payment-schedule", () => {
  test("is registered at 0.1.2 with a recorded digest, and accepts only MyJCB credit-schedule HTML", () => {
    expect(PARSERS).toContain(myJcbSkipPaymentSchedule);
    // 0.1.0 and 0.1.1 are registered in production with their own digests, so
    // each changed empty-row rule is a new version (migration 0028's digest
    // trigger).
    expect(myJcbSkipPaymentSchedule.version).toBe("0.1.2");
    expect(PARSER_DIGESTS.releases["myjcb-skip-payment-schedule"]?.version).toBe("0.1.2");
    expect(myJcbSkipPaymentSchedule.accepts(skipMeta())).toBe(true);
    expect(myJcbSkipPaymentSchedule.accepts(skipMeta({ mime: "text/html; charset=utf-8" }))).toBe(
      true,
    );
    expect(myJcbSkipPaymentSchedule.accepts(skipMeta({ dataset: "credit-detail" }))).toBe(false);
    expect(myJcbSkipPaymentSchedule.accepts(skipMeta({ dataset: null }))).toBe(false);
    expect(myJcbSkipPaymentSchedule.accepts(skipMeta({ sourceId: "vpass" }))).toBe(false);
    expect(myJcbSkipPaymentSchedule.accepts(skipMeta({ mime: "application/json" }))).toBe(false);
    // No other parser accepts the schedule page.
    expect(
      PARSERS.filter((parser) => parser.accepts(skipMeta())).map((parser) => parser.name),
    ).toEqual(["myjcb-skip-payment-schedule"]);
  });

  test("two rows become two scheduled payments with exact decimal text and the page's dates", () => {
    const result = parse(skipPage());
    expect(result.warnings).toEqual([]);
    expect(result.observations).toHaveLength(2);
    const [first, second] = result.observations as unknown as Record<string, unknown>[];
    expect(first).toMatchObject({
      kind: "scheduled_payment",
      sourceAccount: "myjcb:synthetic-conn:root",
      scheduleKind: "card-skip-payment",
      usageDate: "2026-03-02",
      dueDate: "2026-05-11",
      amountText: "12000",
      amountScale: 0,
      currency: "JPY",
      counterparty: "架空スキップ店",
      asOf: "2026-03-20",
      observedAt: "2026-03-20T01:00:00.000Z",
      rawLocator: "html:div.detail-list-01>div.content[0]",
    });
    expect(second).toMatchObject({
      usageDate: "2026-03-05",
      dueDate: "2026-06-10",
      amountText: "3400",
      counterparty: "架空スキップ商会",
      rawLocator: "html:div.detail-list-01>div.content[1]",
    });
    expect((first!["extra"] as Record<string, unknown>)["_kogane"]).toMatchObject({
      canonicalDataset: "credit-schedule",
      detailMonth: 8,
      paymentFromMonth: "2026-05",
      amountBasis: "future-payment-amount",
    });
    expect(first!["externalId"]).toMatch(/^myjcb-skip-payment:[0-9a-f]+:0$/u);
    expect(first!["externalId"]).not.toBe(second!["externalId"]);
    // No row is any kind a transaction, balance, position or valuation reader reads.
    expect(result.observations.every((row) => (row.kind as string) === "scheduled_payment")).toBe(
      true,
    );
  });

  test("0.1.2's whole observation is frozen (unchanged from 0.1.0 and 0.1.1): a change to it is a new release", () => {
    expect(parse(skipPage()).observations[0]).toEqual({
      kind: "scheduled_payment",
      sourceAccount: "myjcb:synthetic-conn:root",
      externalId: "myjcb-skip-payment:b64795a091c7842c74441c6a68b6d9b0:0",
      scheduleKind: "card-skip-payment",
      usageDate: "2026-03-02",
      dueDate: "2026-05-11",
      amountText: "12000",
      amountScale: 0,
      currency: "JPY",
      counterparty: "架空スキップ店",
      asOf: "2026-03-20",
      observedAt: "2026-03-20T01:00:00.000Z",
      rawLocator: "html:div.detail-list-01>div.content[0]",
      extra: {
        cells: ["2026/03/02", "架空スキップ店 2026/05/11", "12,000円"],
        _kogane: {
          canonicalDataset: "credit-schedule",
          scheduleKind: "card-skip-payment",
          detailMonth: 8,
          paymentFromMonth: "2026-05",
          sourceAccountScope: "root-statement-aggregate",
          amountBasis: "future-payment-amount",
          providerAmountSign: "credit-liability-positive-refund-negative",
          notA: ["purchase", "statement-row", "balance"],
          identityOrigin: "displayed-cells+occurrence",
        },
      },
    } as never);
  });

  test("identical rows keep distinct ids by occurrence; the id does not depend on the as-of date", () => {
    const twice = parse(skipPage({ ledgers: [ledger(SKIP_HEAD, [ROWS[0]!, ROWS[0]!])] }))
      .observations as unknown as { externalId: string }[];
    expect(twice.map((row) => row.externalId.split(":").at(-1))).toEqual(["0", "1"]);
    const later = parse(
      skipPage({
        asOf: [
          "2026年3月21日(土)時点のショッピングスキップ払いご利用明細(2026年5月以降のお支払い分)",
        ],
      }),
    ).observations as unknown as { externalId: string; asOf: string }[];
    const earlier = parse(skipPage()).observations as unknown as { externalId: string }[];
    expect(later.map((row) => row.externalId)).toEqual(earlier.map((row) => row.externalId));
    expect(later[0]!.asOf).toBe("2026-03-21");
  });

  test("a refund amount keeps its sign; whitespace and full-width digits in cells read as displayed", () => {
    const result = parse(
      skipPage({
        ledgers: [
          ledger(SKIP_HEAD, [
            skipRow(" 2026/03/02 ", "<span>架空 スキップ店</span><br> 2026/05/11 ", "-１,２００円"),
          ]),
        ],
      }),
    ).observations as unknown as Record<string, unknown>[];
    expect(result[0]).toMatchObject({
      amountText: "-1200",
      counterparty: "架空 スキップ店",
      dueDate: "2026-05-11",
    });
  });

  test("the two lines of the middle cell may be block elements instead of a line break", () => {
    const result = parse(
      skipPage({
        ledgers: [
          ledger(SKIP_HEAD, [
            skipRow("2026/03/02", "<p>架空スキップ店</p><p>2026/05/11</p>", "12,000円"),
          ]),
        ],
      }),
    ).observations as unknown as Record<string, unknown>[];
    expect(result[0]).toMatchObject({ counterparty: "架空スキップ店", dueDate: "2026-05-11" });
  });

  test("an empty ledger is zero rows, not a failure, with or without the as-of heading", () => {
    expect(parse(skipPage({ ledgers: [ledger(SKIP_HEAD, [EMPTY_ROW])] }))).toEqual({
      observations: [],
      warnings: [],
    });
    // The stored empty page's shape: the head's middle cell as two span.row,
    // the lone empty row, no item-more (ADR 0005 amendment f).
    expect(parse(skipPage({ ledgers: [ledger(SPAN_SKIP_HEAD, [EMPTY_ROW])] }))).toEqual({
      observations: [],
      warnings: [],
    });
    expect(parse(skipPage({ asOf: [], ledgers: [ledger(SPAN_SKIP_HEAD, [EMPTY_ROW])] }))).toEqual({
      observations: [],
      warnings: [],
    });
    expect(parse(skipPage({ asOf: [], ledgers: [ledger(SKIP_HEAD, [])] }))).toEqual({
      observations: [],
      warnings: [],
    });
  });

  test.each(REFUSAL_CASES.map((entry, index) => [index, entry.code, entry] as const))(
    "case %d refuses with %s",
    (_index, code, entry) => {
      expect(() => myJcbSkipPaymentSchedule.parse(bytes(entry.html), entry.meta)).toThrow(
        new RegExp(`^${code}$`, "u"),
      );
    },
  );

  test("every code the parser throws is reached by a case, and every message is a closed code", () => {
    expect([...new Set(REFUSAL_CASES.map((entry) => entry.code))].sort()).toEqual(
      [...SKIP_PAYMENT_SCHEDULE_PARSER_CODES].sort(),
    );
    for (const entry of REFUSAL_CASES) {
      let message = "";
      try {
        myJcbSkipPaymentSchedule.parse(bytes(entry.html), entry.meta);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(SKIP_PAYMENT_SCHEDULE_PARSER_CODES as readonly string[]).toContain(message);
      expect(message).not.toMatch(/架空|2026|円/u);
    }
  });

  test("a bonus page that reached the parser is refused and stays unread", () => {
    expect(() =>
      parse(
        skipPage({ h1: ["ボーナス払いご利用明細(未確定分)"], ledgers: [ledger(SKIP_HEAD, ROWS)] }),
      ),
    ).toThrow(/^schedule_kind_unobserved$/u);
    // The bonus page as stored: its own h1 and head, the lone empty row. Its
    // kind is unobserved with rows, so even the empty page is not read.
    expect(() =>
      parse(
        skipPage({ h1: [BONUS_HEADING], asOf: [], ledgers: [ledger(BONUS_HEAD, [EMPTY_ROW])] }),
      ),
    ).toThrow(/^schedule_kind_unobserved$/u);
  });
});

describe("myjcb-skip-payment-schedule: the wrapped empty row (ADR 0005 amendment k)", () => {
  const empty = { observations: [], warnings: [] };
  /** What a `content` row holds, without the row itself. */
  const inner = (row: string) => row.slice('<div class="content">'.length, -"</div>".length);
  /** `ROWS[0]`'s `item-cell`: a data row's. */
  const DATA_ITEM_CELL = inner(ROWS[0]!);
  /** The empty `item-cell` under two wrapper levels. */
  const TWICE_WRAPPED_EMPTY_ROW = wrappedRow(inner(WRAPPED_EMPTY_ROW));
  /** `EMPTY_ITEM_CELL` with a `span` in place of the `item-cell`'s `div`. */
  const SPAN_ITEM_CELL =
    '<span class="item-cell"><div class="cell w-100per">ご利用明細はございません。</div></span>';
  /** `EMPTY_ITEM_CELL` with a `span` in place of the cell's `div`. */
  const SPAN_CELL_ITEM_CELL =
    '<div class="item-cell"><span class="cell w-100per">ご利用明細はございません。</span></div>';
  const ROW_SHAPE = /^schedule_row_shape_unobserved$/u;

  test("the lone wrapped empty row is zero rows, with or without the as-of heading", () => {
    expect(parse(skipPage({ ledgers: [ledger(SKIP_HEAD, [WRAPPED_EMPTY_ROW])] }))).toEqual(empty);
    expect(parse(skipPage({ ledgers: [ledger(SPAN_SKIP_HEAD, [WRAPPED_EMPTY_ROW])] }))).toEqual(
      empty,
    );
    expect(
      parse(skipPage({ asOf: [], ledgers: [ledger(SPAN_SKIP_HEAD, [WRAPPED_EMPTY_ROW])] })),
    ).toEqual(empty);
    // The wrapper may carry classes the reader does not read (this one is
    // invented), and whitespace between the levels is not text.
    expect(
      parse(
        skipPage({
          ledgers: [
            ledger(SPAN_SKIP_HEAD, [wrappedRow(EMPTY_ITEM_CELL, '<div class="synthetic-wrap">')]),
          ],
        }),
      ),
    ).toEqual(empty);
    expect(
      parse(
        skipPage({
          ledgers: [
            ledger(SPAN_SKIP_HEAD, [
              '<div class="content">\n  <div>\n    <div class="item-cell">\n      <div class="cell w-100per">\n        ご利用明細は ございません。\n      </div>\n    </div>\n  </div>\n</div>',
            ]),
          ],
        }),
      ),
    ).toEqual(empty);
    // 0.1.1's empty row is still the empty row.
    expect(parse(skipPage({ ledgers: [ledger(SPAN_SKIP_HEAD, [EMPTY_ROW])] }))).toEqual(empty);
  });

  test("wherever it stands, the wrapped empty row reads exactly as 0.1.1's empty row", () => {
    const outcome = (html: string) => {
      try {
        return parse(html);
      } catch (error) {
        return (error as Error).message;
      }
    };
    const pages = (row: string) => [
      skipPage({ ledgers: [ledger(SKIP_HEAD, [row])] }),
      skipPage({ asOf: [], ledgers: [ledger(SKIP_HEAD, [row])] }),
      skipPage({ ledgers: [ledger(SKIP_HEAD, [row, ...ROWS])] }),
      skipPage({ ledgers: [ledger(SKIP_HEAD, [...ROWS, row])] }),
      skipPage({ asOf: [], ledgers: [ledger(SKIP_HEAD, [row, ROWS[0]!])] }),
      skipPage({ ledgers: [ledger(SKIP_HEAD, [row, row])] }),
      skipPage({ ledgers: [ledger(SKIP_HEAD, [row]), ledger(SKIP_HEAD, ROWS)] }),
      skipPage({ ledgers: [ledger(SKIP_HEAD, [row]), ledger(SKIP_HEAD, [row])] }),
      skipPage({ ledgers: [ledger(FOUR_CELL_HEAD, [row])] }),
      skipPage({ h1: [BONUS_HEADING], asOf: [], ledgers: [ledger(BONUS_HEAD, [row])] }),
    ];
    const wrapped = pages(WRAPPED_EMPTY_ROW).map(outcome);
    expect(wrapped).toEqual(pages(EMPTY_ROW).map(outcome));
    // The comparison is not vacuous: it covers zero rows, rows read beside
    // an empty ledger, and refusals at four different checks.
    expect(wrapped.filter((result) => typeof result !== "string")).toHaveLength(4);
    expect(new Set(wrapped.filter((result) => typeof result === "string"))).toEqual(
      new Set([
        "schedule_row_shape_unobserved",
        "schedule_as_of_invalid",
        "schedule_head_unobserved",
        "schedule_kind_unobserved",
      ]),
    );
  });

  test.each([
    ...["detail-list-01", "head", "content", "item-cell", "cell", "w-100per"].map(
      (name) =>
        [
          `the wrapper carries the reader's class ${name}`,
          wrappedRow(EMPTY_ITEM_CELL, `<div class="${name}">`),
        ] as const,
    ),
    ["two wrapper levels", TWICE_WRAPPED_EMPTY_ROW],
    ["a wrapper with a second element child", wrappedRow(`${EMPTY_ITEM_CELL}<span></span>`)],
    ["a wrapper with two empty item-cells", wrappedRow(`${EMPTY_ITEM_CELL}${EMPTY_ITEM_CELL}`)],
    ["text in the wrapper beside the item-cell", wrappedRow(`x${EMPTY_ITEM_CELL}`)],
    [
      "text in the row beside the wrapper",
      `<div class="content">x<div>${EMPTY_ITEM_CELL}</div></div>`,
    ],
    [
      "text in the item-cell beside the cell",
      wrappedRow(EMPTY_ITEM_CELL.replace('<div class="item-cell">', '<div class="item-cell">x')),
    ],
    ["another label in the wrapped cell", WRAPPED_EMPTY_ROW.replace("ございません", "ありません")],
    [
      "an element inside the wrapped cell",
      wrappedRow(EMPTY_ITEM_CELL.replace(/>(ご利用明細はございません。)</u, "><span>$1</span><")),
    ],
    // Every observed level is a `div`; any other element is a row, in the
    // wrapped shape and, since 0.1.2, in the unwrapped one too.
    ["a span wrapper", `<div class="content"><span>${EMPTY_ITEM_CELL}</span></div>`],
    ["a section wrapper", `<div class="content"><section>${EMPTY_ITEM_CELL}</section></div>`],
    // The HTML parser closes a `p` before a `div`, so this reaches the reader
    // as siblings, not as a wrapper; refused either way.
    ["a p wrapper", `<div class="content"><p>${EMPTY_ITEM_CELL}</p></div>`],
    ["a span.content row, wrapped", `<span class="content"><div>${EMPTY_ITEM_CELL}</div></span>`],
    ["a span.content row, unwrapped", `<span class="content">${EMPTY_ITEM_CELL}</span>`],
    ["a span.item-cell, wrapped", wrappedRow(SPAN_ITEM_CELL)],
    ["a span.item-cell, unwrapped", `<div class="content">${SPAN_ITEM_CELL}</div>`],
    ["a span.cell.w-100per, wrapped", wrappedRow(SPAN_CELL_ITEM_CELL)],
    ["a span.cell.w-100per, unwrapped", `<div class="content">${SPAN_CELL_ITEM_CELL}</div>`],
    ["a wrapped data row", wrappedRow(DATA_ITEM_CELL)],
  ])("%s is a row, and the page is refused", (_name, row) => {
    expect(() => parse(skipPage({ ledgers: [ledger(SKIP_HEAD, [row])] }))).toThrow(ROW_SHAPE);
  });

  test("beside any other row, or twice, the wrapped empty row is refused", () => {
    for (const rows of [
      [WRAPPED_EMPTY_ROW, ROWS[0]!],
      [ROWS[0]!, WRAPPED_EMPTY_ROW],
      [WRAPPED_EMPTY_ROW, ...ROWS],
      [WRAPPED_EMPTY_ROW, WRAPPED_EMPTY_ROW],
      [WRAPPED_EMPTY_ROW, EMPTY_ROW],
      [EMPTY_ROW, WRAPPED_EMPTY_ROW],
      [wrappedRow(DATA_ITEM_CELL), ...ROWS],
    ])
      expect(() => parse(skipPage({ ledgers: [ledger(SKIP_HEAD, rows)] }))).toThrow(ROW_SHAPE);
  });
});
