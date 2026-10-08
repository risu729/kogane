import { parse } from "parse5";
import type { ArtifactMeta, Parser, ParseResult } from "../types.ts";
import {
  scheduledPaymentsAsObservations,
  type ScheduledPaymentObservation,
} from "../scheduled-payment.ts";
import { unitScopeAdmitted } from "./util.ts";
import { stableFingerprint } from "./sbi-strict.ts";
import {
  readMyJcbSkipPaymentSchedule,
  SKIP_PAYMENT_SCHEDULE_REFUSALS,
} from "../../../../packages/domain/src/myjcb-skip-payment-schedule.ts";

/**
 * Every message this parser throws, a closed code each (the page refusals of
 * `readMyJcbSkipPaymentSchedule` and three of its own), so a stored parse
 * error names a code and never provider text:
 *
 * - `schedule_run_ineligible`: the fetch run was not a failure-free success
 *   and no unit-scope policy admitted the artifact;
 * - `schedule_artifact_metadata_invalid`: the key is not
 *   `<connection>/credit-skip-payment-NN.html`, or its state is not
 *   `unknown`, or its period is not the key's `detailMonth-N`;
 * - `schedule_html_boundary`: not UTF-8, not a complete document, or it
 *   crosses the redaction boundary the collector's pages keep (active content,
 *   links, a card-number shape, an unredacted form value).
 */
export const SKIP_PAYMENT_SCHEDULE_PARSER_CODES = [
  "schedule_run_ineligible",
  "schedule_artifact_metadata_invalid",
  "schedule_html_boundary",
  ...SKIP_PAYMENT_SCHEDULE_REFUSALS,
] as const;

const ARTIFACT_KEY = /^([a-z0-9][a-z0-9-]{0,63})\/credit-skip-payment-(0[0-9]|1[0-7])\.html$/u;

/**
 * The MyJCB ショッピングスキップ払い schedule page (ADR 0005 amendment e): each
 * row is a `scheduled_payment` observation, a payment still to come on the
 * date the row names. It is not a purchase, not a statement row and not a
 * balance: nothing that reads transactions or balances reads it, so it is
 * never recognised or counted twice (INV06). Only the shape the round-4 survey
 * observed is read; any other refuses the page with a closed code.
 */
export const myJcbSkipPaymentSchedule: Parser = {
  name: "myjcb-skip-payment-schedule",
  // 0.1.2: the empty row may also sit inside exactly one `div` that carries
  // none of the reader's classes, and in both shapes its row and `item-cell`
  // must be `div`s showing nothing but the label, with no element in the
  // cell, as observed (ADR 0005 amendment k); every other rule, and every
  // observation, is 0.1.1's.
  // 0.1.1: the empty row is zero rows only when it is the ledger's one
  // `content` row and shows exactly the observed label; beside other rows it
  // is refused (ADR 0005 amendment f). 0.1.0 is registered but parsed nothing.
  version: "0.1.2",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === "myjcb" &&
      artifact.dataset === "credit-schedule" &&
      (artifact.mime === "text/html" || artifact.mime === "text/html; charset=utf-8")
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    if (
      (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
      !unitScopeAdmitted(artifact)
    )
      throw new Error("schedule_run_ineligible");
    const key = artifact.artifactKey?.match(ARTIFACT_KEY);
    if (
      !key ||
      artifact.statementState !== "unknown" ||
      artifact.period !== `detailMonth-${Number(key[2])}`
    )
      throw new Error("schedule_artifact_metadata_invalid");
    const connectionId = key[1]!;
    const detailMonth = Number(key[2]);
    const html = boundedHtml(bytes);
    const reading = readMyJcbSkipPaymentSchedule(parse(html));
    if (!reading.ok) throw new Error(reading.code);
    const { asOf, paymentFromMonth, rows } = reading.schedule;

    const occurrences = new Map<string, number>();
    const observations: ScheduledPaymentObservation[] = rows.map((row) => {
      const fingerprint = stableFingerprint({ cells: row.cells });
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      return {
        kind: "scheduled_payment",
        sourceAccount: `myjcb:${connectionId}:root`,
        externalId: `myjcb-skip-payment:${fingerprint}:${occurrence}`,
        scheduleKind: "card-skip-payment",
        usageDate: row.usageDate,
        dueDate: row.paymentDate,
        amountText: row.amountText,
        amountScale: 0,
        currency: "JPY",
        counterparty: row.merchantText,
        // A page with rows always names its as-of date; the reader refuses it otherwise.
        asOf: asOf!,
        observedAt: artifact.fetchedAt,
        rawLocator: `html:div.detail-list-01>div.content[${row.index}]`,
        extra: {
          cells: [...row.cells],
          _kogane: {
            canonicalDataset: "credit-schedule",
            scheduleKind: "card-skip-payment",
            detailMonth,
            paymentFromMonth,
            sourceAccountScope: "root-statement-aggregate",
            amountBasis: "future-payment-amount",
            providerAmountSign: "credit-liability-positive-refund-negative",
            notA: ["purchase", "statement-row", "balance"],
            identityOrigin: "displayed-cells+occurrence",
          },
        },
      };
    });
    return { observations: scheduledPaymentsAsObservations(observations), warnings: [] };
  },
};

/** The page as text, inside the boundary the collector's redacted pages keep. */
function boundedHtml(bytes: Uint8Array): string {
  if (bytes.byteLength > 3_000_000) throw new Error("schedule_html_boundary");
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("schedule_html_boundary");
  }
  if (
    !/^\s*(?:<!doctype\s+html(?:\s+[^>]*)?>\s*)?<html\b/iu.test(html) ||
    !/<body\b/iu.test(html) ||
    !/<\/html\s*>\s*$/iu.test(html) ||
    /<(?:script|style|noscript|template|iframe|object|embed|meta|base|link|textarea)\b/iu.test(
      html,
    ) ||
    /\s(?:on[a-z0-9_-]+|style|srcdoc|srcset|integrity|nonce|data-[a-z0-9_-]+|href|src|action|formaction)\s*=/iu.test(
      html,
    ) ||
    /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/u.test(html) ||
    /\svalue\s*=\s*(?!["']\[redacted\]["'])/iu.test(html)
  )
    throw new Error("schedule_html_boundary");
  return html;
}
