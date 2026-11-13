import { sha256Hex, type CoverageStatus } from "../../../packages/collection/src/index";
import { MailboxError, type MailboxFailureCode } from "./mailbox-bootstrap";
import {
  mailboxJson,
  mailboxInventory,
  mailboxDetail,
  mailboxDetailFields,
  mailboxPdfFields,
  assertSupportedMailboxRow,
  mailboxDocumentIdentity,
} from "./mailbox-contract";
import type { MailboxApi } from "./mailbox-http";
import type { Artifact } from "./types";

export interface MailboxUnit {
  readonly unitKey: string;
  readonly coverageStatus: CoverageStatus;
  readonly safeErrorCode?: MailboxFailureCode;
}
export const MAILBOX_INDEX_UNIT = "mailbox-index";
const PDF_LIMIT = 4 * 1024 * 1024;
const RUN_BYTES_LIMIT = 48 * 1024 * 1024;

export async function collectMailbox(options: {
  readonly client: {
    open(): Promise<void>;
    api(kind: MailboxApi, fields?: Readonly<Record<string, string>>): Promise<Uint8Array>;
  };
  readonly retain: (artifact: Artifact) => void;
  readonly onUnit: (unit: MailboxUnit) => void;
  readonly onError: (error: MailboxError) => void;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly startIdentity: string | null;
  readonly onProgress: (nextIdentity: string | null) => void;
  /** Synthetic tests can exercise continuation without allocating the production ceiling. */
  readonly byteBudget?: number;
}): Promise<void> {
  let retainedBytes = 0;
  let exhausted = false;
  const deadline = options.deadline;
  let nextIdentity: string | null = null;
  const failed = (unitKey: string, error: unknown) => {
    const safe = options.signal.aborted
      ? new MailboxError("sbi_mailbox_lease_lost")
      : error instanceof MailboxError
        ? error
        : new MailboxError("sbi_mailbox_transport_failed");
    options.onUnit({ unitKey, coverageStatus: "partial", safeErrorCode: safe.code });
    options.onError(safe);
  };
  try {
    if (options.signal.aborted) throw new MailboxError("sbi_mailbox_lease_lost");
    if (Date.now() >= deadline) throw new MailboxError("sbi_mailbox_response_bound");
    await options.client.open();
    const summary = mailboxJson(await options.client.api("summary"));
    const list = mailboxJson(await options.client.api("list"));
    const inventory = mailboxInventory(list, summary);
    // Keep private provider metadata, never the envelopes' free-text messages or session fields.
    options.retain({
      dataset: "mailbox-inventory",
      mediaType: "application/json",
      unitKey: MAILBOX_INDEX_UNIT,
      body: {
        schemaVersion: "sbi-mailbox-inventory-v1",
        total: inventory.total,
        rows: inventory.rows,
      },
    });
    options.onUnit({ unitKey: MAILBOX_INDEX_UNIT, coverageStatus: "complete" });
    const ordered = await Promise.all(
      inventory.rows.map(async (row) => ({ row, ...(await mailboxDocumentIdentity(row)) })),
    );
    ordered.sort((a, b) => a.identity.localeCompare(b.identity));
    const located =
      options.startIdentity === null
        ? 0
        : ordered.findIndex((entry) => entry.identity >= options.startIdentity!);
    const start = located < 0 ? 0 : located;
    const walk = [...ordered.slice(start), ...ordered.slice(0, start)];
    for (const { row, kind, identity } of walk) {
      const unitKey = `mailbox-document-${identity}`;
      try {
        if (options.signal.aborted) throw new MailboxError("sbi_mailbox_lease_lost");
        if (exhausted || Date.now() >= deadline) {
          nextIdentity ??= identity;
          exhausted = true;
          throw new MailboxError("sbi_mailbox_response_bound");
        }
        assertSupportedMailboxRow(row);
        const detail = mailboxDetail(
          mailboxJson(await options.client.api("detail", mailboxDetailFields(row))),
        );
        if (options.signal.aborted) throw new MailboxError("sbi_mailbox_lease_lost");
        const bytes = await options.client.api("pdf", mailboxPdfFields(row, detail));
        if (
          bytes.byteLength < 5 ||
          bytes.byteLength > PDF_LIMIT ||
          new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
        )
          throw new MailboxError("sbi_mailbox_document_unobserved");
        if (retainedBytes + bytes.byteLength > (options.byteBudget ?? RUN_BYTES_LIMIT)) {
          exhausted = true;
          nextIdentity ??= identity;
          throw new MailboxError("sbi_mailbox_response_bound");
        }
        retainedBytes += bytes.byteLength;
        const digest = await sha256Hex(bytes);
        const artifactKey = `document-${kind}-${row.sBaseDate}-${identity}-${digest}.pdf`;
        options.retain({
          artifactKey,
          dataset: "delivered-document-pdf",
          mediaType: "application/pdf",
          role: "provider_document",
          unitKey,
          bytes,
          body: null,
        });
        options.retain({
          artifactKey: `document-${identity}-${digest}-metadata.json`,
          dataset: "mailbox-document-metadata",
          mediaType: "application/json",
          unitKey,
          body: {
            schemaVersion: "sbi-mailbox-document-v1",
            kind: row.sCd,
            date: row.sBaseDate,
            identity,
            title: row.kofuInfoKtitle,
            filename: detail.kofuDetailList[0].sOriFileId,
            documentArtifactKey: artifactKey,
            sha256: digest,
            byteSize: bytes.byteLength,
          },
          inputArtifactKeys: ["mailbox-inventory.json", artifactKey],
        });
        options.onUnit({ unitKey, coverageStatus: "complete" });
      } catch (error) {
        if (Date.now() >= deadline) {
          exhausted = true;
          nextIdentity ??= identity;
        }
        failed(unitKey, error);
      }
    }
    if (!options.signal.aborted) options.onProgress(nextIdentity);
    // Only new-mailbox current-list completeness is claimed; legacy retention stays unknown.
  } catch (error) {
    failed(MAILBOX_INDEX_UNIT, error);
  }
}
