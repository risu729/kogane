import { parse } from "parse5";
import {
  readMyJcbDebitPage,
  readMyJcbDebitMenu,
  myJcbDebitOtherIsEmpty,
  myJcbDebitSelectedSequence,
} from "../../../packages/domain/src/myjcb-debit-page";
import { decodeMyJcbHtml, type MyJcbReadClient } from "./client";
import { redactedStatementHtml } from "./parsers";
import type { RawArtifact, UnreadMonth } from "./types";

export async function collectDebit(client: Pick<MyJcbReadClient, "get">): Promise<{
  readonly periodCount: number;
  readonly artifacts: RawArtifact[];
  readonly unreadMonths: readonly UnreadMonth[];
  readonly stop?: {
    readonly code: "debit";
    readonly position: number;
    readonly capturedMonthCount: number;
  };
}> {
  const menu = await client.get(
    "debit-menu",
    new URLSearchParams({ link_id: "myj_main_debitDetailMenu" }),
  );
  const menuHtml = decodeMyJcbHtml(menu.body, menu.contentType);
  const sequences = readMyJcbDebitMenu(parse(menuHtml), "ordinary");
  const artifacts: RawArtifact[] = [
    {
      dataset: "debit-menu",
      filename: "debit-menu.html",
      body: redactedStatementHtml(menuHtml),
      mediaType: "text/html; charset=utf-8",
      statementState: "debit",
    },
  ];
  const unreadMonths: UnreadMonth[] = [];
  for (const sequence of sequences) {
    let detailHtml: string;
    try {
      const detail = await client.get(
        "debit-detail",
        new URLSearchParams({ seq: String(sequence) }),
      );
      detailHtml = decodeMyJcbHtml(detail.body, detail.contentType);
    } catch {
      const captured = artifacts.length - 1;
      return {
        artifacts,
        unreadMonths,
        periodCount: captured,
        stop: { code: "debit", position: sequence, capturedMonthCount: captured },
      };
    }
    try {
      const page = parse(detailHtml);
      if (myJcbDebitSelectedSequence(page) !== sequence)
        throw new Error("myjcb_debit_selected_sequence_mismatch");
      readMyJcbDebitPage(page);
    } catch {
      unreadMonths.push({ position: sequence, code: "rows_unstated" });
    }
    artifacts.push({
      dataset: "debit-detail",
      filename: `debit-detail-${String(sequence).padStart(2, "0")}.html`,
      body: redactedStatementHtml(detailHtml),
      mediaType: "text/html; charset=utf-8",
      statementState: "debit",
    });
  }
  return { periodCount: sequences.length, artifacts, unreadMonths };
}

/** The separately offered other-statement periods never replace ordinary differences. */
export async function collectDebitOther(client: Pick<MyJcbReadClient, "get">): Promise<{
  readonly artifacts: RawArtifact[];
  readonly code: "complete" | "partial";
}> {
  const artifacts: RawArtifact[] = [];
  let code: "complete" | "partial" = "complete";
  try {
    const menu = await client.get("debit-other-menu");
    const html = decodeMyJcbHtml(menu.body, menu.contentType);
    artifacts.push({
      dataset: "debit-other-menu",
      filename: "debit-other-menu.html",
      body: redactedStatementHtml(html),
      mediaType: "text/html; charset=utf-8",
    });
    const sequences = readMyJcbDebitMenu(parse(html), "other");
    for (const sequence of sequences) {
      try {
        const response = await client.get(
          "debit-other-detail",
          new URLSearchParams({ seq: String(sequence), inquiry: "照会" }),
        );
        const page = decodeMyJcbHtml(response.body, response.contentType);
        artifacts.push({
          dataset: "debit-other-detail",
          filename: `debit-other-detail-${String(sequence).padStart(2, "0")}.html`,
          body: redactedStatementHtml(page),
          mediaType: "text/html; charset=utf-8",
        });
        if (!myJcbDebitOtherIsEmpty(parse(page))) code = "partial";
      } catch {
        return { artifacts, code: "partial" };
      }
    }
  } catch {
    code = "partial";
  }
  return { artifacts, code };
}
