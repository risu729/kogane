import {
  creditDocumentOffers,
  documentBudget,
  MAX_DOCUMENT_RUN_BYTES,
  type DocumentBudget,
  fetchCreditDocument,
  type StatementDocumentResult,
} from "./documents";
import { validateMyJcbCreditCsvText } from "../../../packages/domain/src/myjcb-statement-export";
// Credit read collection is independent of browser authentication. The connection
// orchestrator supplies the same allowlisted client and preserves its exports.
import { safeErrorDetails } from "../../../packages/collector-diagnostics/src/index";
import { decodeMyJcbHtml, type MyJcbReadClient, type ReadResponse } from "./client";
import {
  creditStatementPeriod,
  creditPageRowCount,
  creditStatementState,
  discoverCreditExports,
  extractGeneralJsonDiscriminator,
  parseCreditLedger,
  parsePastMonthAvailability,
  readCreditMenuGroups,
  redactedStatementHtml,
  scheduledLedgerRowCount,
  schedulePageKind,
  settlementMonth,
  type MyJcbSchedulePageKind,
} from "./parsers";
import type {
  ConnectionStopCode,
  CreditExportKind,
  ExportOffer,
  RawArtifact,
  SchedulePage,
  UnreadMonth,
  UnreadMonthCode,
} from "./types";
import { HumanRequiredError, StopConditionError, type StopConditionCode } from "./types";

/**
 * The stage each stop condition names, as the closed stop code the terminal
 * and the manifest record (ADR 0005's amendment). A `Record` over every
 * condition, so a new condition cannot be added without a stage.
 */
const STOP_CODE_BY_CONDITION: Readonly<Record<StopConditionCode, ConnectionStopCode>> = {
  "unknown-upstream-state": "unclassified",
  login: "login",
  "passkey-browser-setup": "login",
  "passkey-cdp-enable": "login",
  "passkey-authenticator-add": "login",
  "passkey-credential-add": "login",
  "passkey-login-page": "login",
  "passkey-control": "login",
  "passkey-trigger": "login",
  "passkey-assertion": "login",
  "passkey-landing": "login",
  "passkey-session-import": "login",
  "collect-discovery": "discovery",
  "collect-credit": "unclassified",
  "collect-credit-menu": "credit_menu",
  "credit-menu-group": "credit_menu_group_unrecognized",
  "collect-credit-first-detail": "credit_first_detail",
  "collect-credit-past-months": "credit_past_months",
  "collect-credit-month-fetch": "month_fetch",
  "collect-credit-month-parse": "month_parse",
  "collect-credit-export": "export_fetch",
  "credit-ledger-headers": "ledger_parse",
  "credit-ledger-item-cell": "ledger_parse",
  "credit-ledger-cell-count": "ledger_parse",
  "credit-statement-state": "credit_statement_state",
  "credit-statement-period": "credit_statement_period",
  "credit-page-repeated": "credit_page_repeated",
  "collect-debit": "debit",
  "collect-route": "no_route",
};

/**
 * The stops a statement page causes by its own shape: the page at the stop is
 * kept as evidence (ADR 0005's second amendment).
 */
const STOP_PAGE_CODES: ReadonlySet<ConnectionStopCode> = new Set([
  "credit_statement_state",
  "credit_statement_period",
  "ledger_parse",
]);

/** The closed stop code for whatever stopped a connection. */
export function connectionStopCode(error: unknown): ConnectionStopCode {
  if (error instanceof HumanRequiredError) return "human_required";
  if (error instanceof StopConditionError) return STOP_CODE_BY_CONDITION[error.code];
  return "unclassified";
}

/** Where the credit months stopped, and how many were kept whole before it. */
export interface CreditStop {
  readonly code: ConnectionStopCode;
  /** The `detailMonth` whose fetch, state, period, ledger or export failed. */
  readonly position: number;
  readonly capturedMonthCount: number;
}

export async function collectionStage<T>(
  code: StopConditionCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof StopConditionError && error.code !== "unknown-upstream-state") throw error;
    throw Object.assign(new StopConditionError(`MyJCB collection stopped at ${code}`, code), {
      httpStatus: safeErrorDetails(error).httpStatus,
    });
  }
}

/** The reads the credit collection makes; the Worker passes a `MyJcbReadClient`. */
export type CreditReadClient = Pick<MyJcbReadClient, "get" | "postCreditPastJson">;

/** Production fetches observed original exports; record remains for historical callers. */
export type CreditExportMode = "record" | "fetch";

/**
 * The credit months of one connection. The credit menu (`detailMenu.html`)
 * is always read first, in the same session and before any detail page: a
 * detail page fetched without it was observed to be a different page (h1
 * `カードご利用明細一覧`, no ledger; docs/sources/myjcb.md). It is read once;
 * the months follow it in ascending order.
 *
 * The menu's headings say which positions are months and which are payment
 * schedule pages (`readCreditMenuGroups`, ADR 0005's amendments (c) and (j)).
 * Only the months are the connection's coverage. The schedule pages are read
 * after every month, each stored whole: the ショッピングスキップ払い page, known
 * by its h1, as `credit-skip-payment-NN.html`, which
 * `myjcb-skip-payment-schedule` reads (amendment (e)), and every other one
 * (the ボーナス払い page included) as `credit-schedule-NN.html` evidence that
 * no parser reads; a schedule page that cannot be fetched is recorded with a
 * closed code and is not a stop.
 *
 * What a stored page states is what the page itself states (ADR 0005's
 * amendment (h)). A month position whose page carries the ショッピングスキップ払い
 * h1 (amendment (h)) or the ボーナス払い h1 (amendment (j)) is that schedule
 * page, stored and recorded as one and not a month. An
 * `unknown` page's manifest entry states no period. The shared manifest
 * names a page by its bytes, so the same bytes kept at two positions must
 * state one state and one period; a page that would state another stops the
 * connection (`credit_page_repeated`) and is not kept again.
 */
export async function collectCredit(
  client: CreditReadClient,
  linkId: string,
  options: { readonly exports?: CreditExportMode; readonly documentBudget?: DocumentBudget } = {},
): Promise<{
  readonly periodCount: number;
  readonly artifacts: RawArtifact[];
  /**
   * Months whose page is kept but whose rows no parser reads, with the
   * closed reason: a page with rows that does not state its statement state
   * (`rows_unstated`, kept as `unknown` evidence without a ledger), or a
   * ledger under the observed third header (`scheduled_payments_page`). The
   * connection is then not whole (ADR 0026).
   */
  readonly unreadMonths: readonly UnreadMonth[];
  /** The export kinds each month's page offered for its own month. */
  readonly exportOffers: readonly ExportOffer[];
  readonly documentResults: readonly StatementDocumentResult[];
  readonly documentCode?: "partial";
  /**
   * Each schedule page, ascending by position, with its outcome: the
   * positions the menu listed, and the month positions whose page is the
   * ショッピングスキップ払い page (amendment (h)) or the ボーナス払い page
   * (amendment (j)) by its h1. After a stop only the latter read before it:
   * no schedule position is read after a stop.
   */
  readonly schedulePages: readonly SchedulePage[];
  /**
   * Set when a month's fetch, statement state, period, ledger or export
   * failed: the months before it are kept whole, that month keeps only its
   * redacted page when the page's own shape (state, period, ledger) stopped
   * it, and no later month is read (ADR 0005's
   * amendments). A failure before the month loop (menu, first detail, past
   * months) is thrown instead and keeps nothing.
   */
  readonly stop?: CreditStop;
}> {
  const exportMode = options.exports ?? "record";
  const budget = options.documentBudget ?? documentBudget();
  if (
    !Number.isInteger(budget.remainingBytes) ||
    budget.remainingBytes < 0 ||
    budget.remainingBytes > MAX_DOCUMENT_RUN_BYTES
  )
    throw new Error("myjcb_document_budget_invalid");
  const { menuHtml, initialMonths, schedulePositions } = await collectionStage(
    "collect-credit-menu",
    async () => {
      const menu = await client.get("credit-menu", new URLSearchParams({ link_id: linkId }));
      const menuHtml = decodeMyJcbHtml(menu.body, menu.contentType);
      const groups = readCreditMenuGroups(menuHtml);
      if (groups.months.length === 0) {
        throw new Error("MyJCB credit menu did not enumerate detailMonth values");
      }
      return { menuHtml, initialMonths: groups.months, schedulePositions: groups.schedules };
    },
  );
  const artifacts: RawArtifact[] = [
    {
      dataset: "credit-menu",
      filename: "credit-menu.html",
      body: redactedStatementHtml(menuHtml),
      mediaType: "text/html; charset=utf-8",
    },
  ];

  const firstMonth = initialMonths[0];
  if (firstMonth === undefined) throw new Error("MyJCB credit menu was empty");
  const detailCache = new Map<number, ReadResponse>();
  const { firstDetail, discriminator } = await collectionStage(
    "collect-credit-first-detail",
    async () => {
      const firstDetail = await fetchCreditDetail(client, firstMonth);
      const firstHtml = decodeMyJcbHtml(firstDetail.body, firstDetail.contentType);
      return { firstDetail, discriminator: extractGeneralJsonDiscriminator(firstHtml) };
    },
  );
  detailCache.set(firstMonth, firstDetail);
  const { pastResponse, pastMonths } = await collectionStage(
    "collect-credit-past-months",
    async () => {
      const pastResponse = await client.postCreditPastJson({
        generalJsonShikibetuId: discriminator,
        id: "030100601",
        detailMonth: firstMonth,
      });
      const pastJson = new TextDecoder("utf-8", { fatal: true }).decode(pastResponse.body);
      return { pastResponse, pastMonths: parsePastMonthAvailability(pastJson) };
    },
  );
  artifacts.push({
    dataset: "credit-past-months",
    filename: "credit-past-months.json",
    body: pastResponse.body,
    mediaType: "application/json",
  });
  const availableMonths = [
    ...new Set([
      ...initialMonths,
      ...pastMonths.filter((month) => month.available).map((month) => month.detailMonth),
    ]),
  ].sort((left, right) => left - right);
  // A position the menu shows as a schedule page cannot also be a month the
  // past-months response offers; that has not been observed, so it is not
  // resolved either way.
  if (availableMonths.some((month) => schedulePositions.includes(month))) {
    throw new StopConditionError(
      "MyJCB past-months response offered a position the menu lists as a schedule page",
      "collect-credit-past-months",
    );
  }

  const unreadMonths: UnreadMonth[] = [];
  const exportOffers: ExportOffer[] = [];
  const documentResults: StatementDocumentResult[] = [];
  const capturedDocuments = new Set<string>();
  let documentCode: "partial" | undefined;
  // Month positions whose page is the ショッピングスキップ払い (amendment (h))
  // or ボーナス払い (amendment (j)) schedule by its own h1: stored as schedule
  // pages, never months.
  const monthSchedulePages: SchedulePage[] = [];
  // Each kept statement page's redacted bytes and the state and period its
  // manifest entry states. The shared manifest names a page by its bytes, so
  // one page must state one thing wherever it was shown (amendment (h)).
  const keptPages = new Map<string, string>();
  const months = () => availableMonths.length - monthSchedulePages.length;
  let capturedMonthCount = 0;
  for (const detailMonth of availableMonths) {
    // Financial page and ledger stay atomic. Documents have independent outcomes.
    const monthArtifacts: RawArtifact[] = [];
    const settlementYM = pastMonths.find(
      (month) => month.detailMonth === detailMonth,
    )?.settlementYM;
    // The decoded page, kept so that a stop at this month can store it.
    let pageHtml: string | undefined;
    let unread: UnreadMonthCode | undefined;
    let offered: readonly CreditExportKind[] = [];
    // The page this month keeps and what its entry states, once it is read.
    let keptPage: { readonly body: string; readonly stated: string } | undefined;
    try {
      const detail = await collectionStage(
        "collect-credit-month-fetch",
        async () => detailCache.get(detailMonth) ?? (await fetchCreditDetail(client, detailMonth)),
      );
      const html = await collectionStage("collect-credit-month-parse", async () =>
        decodeMyJcbHtml(detail.body, detail.contentType),
      );
      pageHtml = html;
      // A page whose h1 is the observed ショッピングスキップ払い heading
      // (amendment (h)) or ボーナス払い heading (amendment (j)) is that
      // schedule page, whatever position showed it: the page says what it
      // is, and it names no statement month. It is stored as the menu's
      // schedule pages are, and is not a month. The ボーナス払い page's h2
      // has the dated statement heading's form, so it must never reach the
      // month reading below.
      const kind = schedulePageKind(html);
      if (kind !== "unobserved") {
        artifacts.push(schedulePageArtifact(html, detailMonth, kind));
        monthSchedulePages.push({ position: detailMonth, code: "scheduled_payments_page" });
        // Counts and codes only: the page's text never reaches the log.
        console.warn(
          JSON.stringify({
            event: "myjcb-credit-month-schedule-page",
            detailMonth,
            code: "scheduled_payments_page",
          }),
        );
        continue;
      }
      const month = await collectionStage("collect-credit-month-parse", async () => {
        const exports = discoverCreditExports(html, detailMonth);
        const hasLedgerContainer = /\bdetail-list-01\b/u.test(html);
        const hasEmptyMarker = /(?:ご利用|明細)[^<>]{0,80}(?:ありません|ございません)/u.test(html);
        if (!hasLedgerContainer && hasEmptyMarker) {
          throw new Error("MyJCB credit detail exposed an inconsistent empty state");
        }
        // The observed third ledger header (ADR 0005's second amendment):
        // its rows are not read as any statement. The page is kept as
        // `unknown` evidence without a ledger, the month is captured unread,
        // and the connection goes on to the next month. An empty ledger under
        // it withholds nothing and is read as before.
        if ((scheduledLedgerRowCount(html) ?? 0) > 0) {
          const state = "unknown" as const;
          const period = creditStatementPeriod({ html, detailMonth, state, settlementYM });
          return {
            exports,
            ledger: undefined,
            state,
            period,
            unread: "scheduled_payments_page" as const,
          };
        }
        // The page states whether it is a closed statement; export links are
        // not that statement.
        const state = creditStatementState(html, detailMonth);
        if (exports.length > 0 && state !== "confirmed") {
          // Exports belong to confirmed statements, so a page that offers
          // them must itself state that it is one.
          throw new StopConditionError(
            "MyJCB offered statement exports on a page that is not a confirmed statement",
            "credit-statement-state",
          );
        }
        const ledger = state === "unknown" ? undefined : parseCreditLedger(html, state);
        if (detailMonth === 0 && !ledger) {
          throw new Error("MyJCB unconfirmed detail page omitted .detail-list-01");
        }
        // A statement keeps one period while its position moves.
        const period = creditStatementPeriod({ html, detailMonth, state, settlementYM });
        return {
          exports,
          ledger,
          state,
          period,
          unread:
            state === "unknown" && creditPageRowCount(html) > 0
              ? ("rows_unstated" as const)
              : undefined,
        };
      });
      const { ledger, state, period } = month;
      unread = month.unread;
      offered = month.exports;
      const body = redactedStatementHtml(html);
      // An `unknown` page states no statement and no month, so its entry
      // states no period: a position's label is not the page's, and the
      // position stays in the artifact key (amendment (h)). A page with a
      // state keeps the period it was read with, as before.
      const pagePeriod = state === "unknown" ? undefined : period;
      const stated = JSON.stringify([state, pagePeriod ?? null]);
      const earlier = keptPages.get(body);
      if (earlier !== undefined && earlier !== stated) {
        // The same bytes at another position, read as another state or
        // month: which one they are is not chosen (ADR 0004). Counts and
        // codes only in the stop log.
        throw new StopConditionError(
          "MyJCB showed one statement page at two positions read differently",
          "credit-page-repeated",
        );
      }
      monthArtifacts.push({
        dataset: "credit-detail",
        filename: `credit-detail-${String(detailMonth).padStart(2, "0")}.html`,
        body,
        mediaType: "text/html; charset=utf-8",
        statementState: state,
        ...(pagePeriod === undefined ? {} : { period: pagePeriod }),
      });
      keptPage = { body, stated };
      if (ledger) {
        monthArtifacts.push({
          dataset: "credit-ledger",
          filename: `credit-ledger-${String(detailMonth).padStart(2, "0")}.json`,
          body: JSON.stringify({ schemaVersion: 1, detailMonth, period, ...ledger }),
          mediaType: "application/json",
          statementState: state,
          period,
        });
      }
      // Files are independent evidence: a bad file never drops the valid page,
      // ledger, sibling file or later statement. Session denial still stops reads.
      if (exportMode === "fetch" && unread === undefined && state === "confirmed") {
        const canonicalPeriod = settlementMonth(period);
        let actualOffers: readonly CreditExportKind[] = [];
        try {
          actualOffers = creditDocumentOffers(html, detailMonth);
        } catch {
          documentCode = "partial";
          if (canonicalPeriod !== null)
            for (const kind of offered) {
              const identity = `${canonicalPeriod}:${kind}`;
              if (!capturedDocuments.has(identity)) {
                capturedDocuments.add(identity);
                documentResults.push({ period: canonicalPeriod, kind, code: "unavailable" });
              }
            }
        }
        for (const kind of actualOffers) {
          if (canonicalPeriod === null) {
            documentCode = "partial";
            continue;
          }
          const identity = `${canonicalPeriod}:${kind}`;
          if (capturedDocuments.has(identity)) continue;
          capturedDocuments.add(identity);
          if (budget.remainingBytes === 0) {
            documentResults.push({ period: canonicalPeriod, kind, code: "budget_exhausted" });
            continue;
          }
          try {
            monthArtifacts.push(
              await fetchCreditDocument(
                client,
                detailMonth,
                canonicalPeriod,
                kind,
                budget.remainingBytes,
              ),
            );
            const retained = monthArtifacts[monthArtifacts.length - 1]!.body;
            budget.remainingBytes -=
              typeof retained === "string"
                ? new TextEncoder().encode(retained).byteLength
                : retained.byteLength;
            documentResults.push({ period: canonicalPeriod, kind, code: "collected" });
          } catch (error) {
            documentResults.push({
              period: canonicalPeriod,
              kind,
              code:
                error instanceof Error &&
                error.message === "myjcb_statement_export_budget_exhausted"
                  ? "budget_exhausted"
                  : "unavailable",
            });
            const status = safeErrorDetails(error).httpStatus;
            if (
              status === 401 ||
              status === 403 ||
              status === 429 ||
              (status !== undefined && status >= 300 && status < 400)
            ) {
              // The valid statement artifacts survive a session-wide stop.
              artifacts.push(...monthArtifacts);
              throw Object.assign(
                new StopConditionError("MyJCB export session stopped", "collect-credit-export"),
                { httpStatus: status },
              );
            }
          }
        }
      }
    } catch (error) {
      const code = connectionStopCode(error);
      // A statement page that stopped the connection by its own shape (its
      // state, its month or its ledger) is kept, redacted like every page,
      // as `unknown` evidence with no ledger and no export, so the stop can
      // be diagnosed from the stored run (ADR 0005's second amendment). It is
      // not a captured month: `capturedMonthCount` stays the months before
      // it, and `stopPosition` names it. A page that could not be read as a
      // statement page at all (`month_parse`) is not kept.
      // Like every `unknown` page it states no period (amendment (h)), and it
      // is not kept when an earlier position kept the same bytes stating
      // something else.
      const stopBody =
        pageHtml !== undefined && STOP_PAGE_CODES.has(code)
          ? redactedStatementHtml(pageHtml)
          : undefined;
      const earlierStop = stopBody === undefined ? undefined : keptPages.get(stopBody);
      const keepStopPage =
        stopBody !== undefined && (earlierStop === undefined || earlierStop === UNKNOWN_STATED);
      if (keepStopPage && stopBody !== undefined) {
        artifacts.push({
          dataset: "credit-detail",
          filename: `credit-detail-${String(detailMonth).padStart(2, "0")}.html`,
          body: stopBody,
          mediaType: "text/html; charset=utf-8",
          statementState: "unknown",
        });
      }
      console.warn(
        JSON.stringify({
          event: "myjcb-credit-month-failed",
          detailMonth,
          code: error instanceof StopConditionError ? error.code : "collector-operation-failed",
          stopCode: code,
          capturedMonthCount,
          stopPageKept: keepStopPage,
        }),
      );
      // The connection stops at this month and keeps the months before it.
      return {
        periodCount: months(),
        artifacts,
        unreadMonths,
        exportOffers,
        documentResults,
        ...(documentCode === undefined ? {} : { documentCode }),
        schedulePages: monthSchedulePages,
        stop: { code, position: detailMonth, capturedMonthCount },
      };
    }
    artifacts.push(...monthArtifacts);
    if (keptPage !== undefined) keptPages.set(keptPage.body, keptPage.stated);
    if (unread !== undefined) {
      unreadMonths.push({ position: detailMonth, code: unread });
      if (unread === "scheduled_payments_page") {
        // Counts and codes only: the page's text never reaches the log.
        console.warn(
          JSON.stringify({
            event: "myjcb-credit-month-unread",
            detailMonth,
            code: unread,
          }),
        );
      }
    }
    if (offered.length > 0) exportOffers.push({ position: detailMonth, kinds: [...offered] });
    capturedMonthCount += 1;
  }
  const schedulePages: SchedulePage[] = [...monthSchedulePages];
  for (const position of schedulePositions) {
    try {
      const detail = await fetchCreditDetail(client, position);
      const html = decodeMyJcbHtml(detail.body, detail.contentType);
      // Kept whole: its rows are neither a month nor withheld from one. Only
      // the page whose h1 is the observed ショッピングスキップ払い heading is
      // named `credit-skip-payment-NN.html`, the one name registration gives
      // the parser dataset (ADR 0005 amendment e); every other schedule page
      // (the ボーナス払い page, recognised by its h1 since amendment (j) and
      // never observed with rows, and any page of another kind) stays
      // `credit-schedule-NN.html` and unread (ADR 0004).
      artifacts.push(schedulePageArtifact(html, position, schedulePageKind(html)));
      schedulePages.push({ position, code: "scheduled_payments_page" });
    } catch {
      // Counts and codes only: neither the error nor the page reaches the log.
      console.warn(
        JSON.stringify({
          event: "myjcb-credit-schedule-page-failed",
          detailMonth: position,
          code: "schedule_page_fetch",
        }),
      );
      schedulePages.push({ position, code: "schedule_page_fetch" });
    }
  }
  return {
    periodCount: months(),
    artifacts,
    unreadMonths,
    exportOffers,
    documentResults,
    ...(documentCode === undefined ? {} : { documentCode }),
    schedulePages: schedulePages.sort((left, right) => left.position - right.position),
  };
}

/** What a kept `unknown` page's manifest entry states (amendment (h)). */
const UNKNOWN_STATED = JSON.stringify(["unknown", null]);

/**
 * A schedule page as it is stored, whole and redacted, with state `unknown`
 * and its position's relative label, which `myjcb-skip-payment-schedule`
 * checks against the key: `credit-skip-payment-NN.html` when its h1 is the
 * observed ショッピングスキップ払い heading, which registration gives the
 * parser dataset (ADR 0005 amendment e), otherwise `credit-schedule-NN.html`,
 * which nothing reads: the ボーナス払い page (amendment j) and any page of
 * another kind.
 */
function schedulePageArtifact(
  html: string,
  position: number,
  kind: MyJcbSchedulePageKind,
): RawArtifact {
  return {
    dataset: "credit-schedule",
    filename: `${kind === "skip-payment" ? "credit-skip-payment" : "credit-schedule"}-${String(position).padStart(2, "0")}.html`,
    body: redactedStatementHtml(html),
    mediaType: "text/html; charset=utf-8",
    statementState: "unknown",
    period: `detailMonth-${position}`,
  };
}

async function fetchCreditDetail(
  client: CreditReadClient,
  detailMonth: number,
): Promise<ReadResponse> {
  return await client.get(
    "credit-detail",
    new URLSearchParams({ detailMonth: String(detailMonth), output: "web" }),
  );
}

/** Compatibility export; validation is shared with the evidence parser. */
export function validateCreditCsvText(csv: string): void {
  validateMyJcbCreditCsvText(csv);
}
