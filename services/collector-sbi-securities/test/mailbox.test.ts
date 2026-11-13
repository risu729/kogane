import { expect, test } from "bun:test";
import { collectMailbox, type MailboxUnit } from "../src/mailbox";
import type { MailboxApi } from "../src/mailbox-http";
import type { Artifact } from "../src/types";
import { mailboxRow, mailboxList, mailboxSummary, mailboxDetailFixture } from "./mailbox-fixture";
import { mailboxDocumentIdentity } from "../src/mailbox-contract";
import { MailboxError } from "../src/mailbox-bootstrap";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const pdf = new TextEncoder().encode("%PDF-synthetic");
function capture(rows = [mailboxRow()], options: { broken?: string; bytes?: Uint8Array } = {}) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async open() {
        calls.push("open");
      },
      async api(kind: MailboxApi, fields: Readonly<Record<string, string>> = {}) {
        calls.push(`${kind}:${fields.sCdSeq ?? ""}`);
        if (kind === "summary") return encode(mailboxSummary(rows.length));
        if (kind === "list") return encode(mailboxList(rows));
        if (fields.sCdSeq === options.broken)
          throw new MailboxError("sbi_mailbox_document_unobserved");
        if (kind === "detail") return encode(mailboxDetailFixture());
        return options.bytes ?? pdf;
      },
    },
  };
}
async function run(
  input: ReturnType<typeof capture>,
  extra: {
    startIdentity?: string | null;
    byteBudget?: number;
    deadline?: number;
    signal?: AbortSignal;
  } = {},
) {
  const artifacts: Artifact[] = [];
  const units: MailboxUnit[] = [];
  const errors: MailboxError[] = [];
  let next: string | null | undefined;
  await collectMailbox({
    client: input.client,
    retain: (artifact) => artifacts.push(artifact),
    onUnit: (unit) => units.push(unit),
    onError: (error) => errors.push(error),
    deadline: extra.deadline ?? Date.now() + 100000,
    signal: extra.signal ?? new AbortController().signal,
    startIdentity: extra.startIdentity ?? null,
    onProgress: (pointer) => {
      next = pointer;
    },
    ...(extra.byteBudget === undefined ? {} : { byteBudget: extra.byteBudget }),
  });
  return { artifacts, units, errors, next };
}

test("retains valid sibling PDFs and unsupported row metadata without financial interpretations", async () => {
  const rows = [
    mailboxRow(),
    { ...mailboxRow("synthetic-unknown"), sCd: "UNKNOWN" },
    mailboxRow("synthetic-failed"),
  ];
  const source = capture(rows, { broken: "synthetic-failed" });
  const result = await run(source);
  expect(result.artifacts.filter((artifact) => artifact.role === "provider_document")).toHaveLength(
    1,
  );
  expect(result.units.filter((unit) => unit.coverageStatus === "partial")).toHaveLength(2);
  expect(result.artifacts[0]!.body).toEqual({
    schemaVersion: "sbi-mailbox-inventory-v1",
    total: 3,
    rows,
  });
  expect(source.calls).not.toContain("detail:synthetic-unknown");
  expect(result.next).toBeNull();
});

test("a bounded run resumes at its unretained document and reaches every row without starving a suffix", async () => {
  const rows = [mailboxRow("synthetic-a"), mailboxRow("synthetic-b"), mailboxRow("synthetic-c")];
  const seen = new Set<string>();
  let pointer: string | null = null;
  for (let pass = 0; pass < rows.length; pass++) {
    const source = capture(rows);
    const result = await run(source, { startIdentity: pointer, byteBudget: pdf.byteLength });
    const documents = result.artifacts.filter((artifact) => artifact.role === "provider_document");
    expect(documents).toHaveLength(1);
    seen.add(documents[0]!.unitKey!);
    expect(source.calls.filter((call) => call.startsWith("pdf:"))).toHaveLength(2);
    expect(result.next).not.toBeNull();
    pointer = result.next!;
  }
  expect(seen.size).toBe(rows.length);
});

test("identity and byte revisions stay distinct and identical documents share a content-addressed body", async () => {
  const rows = [mailboxRow(), mailboxRow("synthetic-other")];
  const first = await run(capture(rows));
  const documents = first.artifacts.filter((artifact) => artifact.role === "provider_document");
  expect(documents).toHaveLength(2);
  expect(documents[0]!.artifactKey).not.toBe(documents[1]!.artifactKey);
  expect(documents[0]!.bytes).toEqual(documents[1]!.bytes);
  const second = await run(
    capture([rows[0]!], { bytes: new TextEncoder().encode("%PDF-synthetic-corrected") }),
  );
  const identity = await mailboxDocumentIdentity(rows[0]!);
  const before = documents.find(
    (document) => document.unitKey === `mailbox-document-${identity.identity}`,
  )!;
  const after = second.artifacts.find((document) => document.role === "provider_document")!;
  expect(before.unitKey).toBe(after.unitKey);
  expect(before.artifactKey).not.toBe(after.artifactKey);
});

test("a shared expired deadline prevents further mailbox calls and leaves progress untouched", async () => {
  const source = capture();
  const result = await run(source, { deadline: Date.now() - 1 });
  expect(source.calls).toEqual([]);
  expect(result.errors[0]!.code).toBe("sbi_mailbox_response_bound");
  expect(result.next).toBeUndefined();
});

test("a deleted cursor target wraps once and a complete empty list clears progress", async () => {
  const source = capture([mailboxRow(), mailboxRow("synthetic-other")]);
  const result = await run(source, { startIdentity: "f".repeat(64) });
  expect(result.artifacts.filter((artifact) => artifact.role === "provider_document")).toHaveLength(
    2,
  );
  expect(source.calls.filter((call) => call.startsWith("pdf:"))).toHaveLength(2);
  expect(result.next).toBeNull();
  expect((await run(capture([]), { startIdentity: "a".repeat(64) })).next).toBeNull();
});

test("a deadline reached inside the final PDF request retries that same unretained identity", async () => {
  const originalNow = Date.now;
  let clock = 1000;
  const source = capture();
  const originalApi = source.client.api;
  source.client.api = async (kind, fields) => {
    if (kind === "pdf") {
      clock = 2001;
      throw new MailboxError("sbi_mailbox_response_bound");
    }
    return originalApi(kind, fields);
  };
  let result: Awaited<ReturnType<typeof run>>;
  Date.now = () => clock;
  try {
    result = await run(source, { deadline: 2000 });
  } finally {
    Date.now = originalNow;
  }
  const identity = await mailboxDocumentIdentity(mailboxRow());
  expect(result.next).toBe(identity.identity);
  expect(result.artifacts.filter((artifact) => artifact.role === "provider_document")).toEqual([]);
  const resumed = await run(capture(), { startIdentity: result.next! });
  expect(
    resumed.artifacts.filter((artifact) => artifact.role === "provider_document"),
  ).toHaveLength(1);
});

test("an oversized individual response never starves valid siblings in this or later runs", async () => {
  const rows = [mailboxRow("synthetic-oversized"), mailboxRow("synthetic-valid")];
  for (let pass = 0; pass < 2; pass++) {
    const source = capture(rows);
    const originalApi = source.client.api;
    source.client.api = async (kind, fields = {}) => {
      if (kind === "pdf" && fields.sCdSeq === "synthetic-oversized")
        throw new MailboxError("sbi_mailbox_response_bound");
      return originalApi(kind, fields);
    };
    const result = await run(source);
    expect(
      result.artifacts.filter((artifact) => artifact.role === "provider_document"),
    ).toHaveLength(1);
    expect(result.next).toBeNull();
    expect(result.units.filter((unit) => unit.coverageStatus === "partial")).toHaveLength(1);
  }
});

test("lease loss retains prior verified siblings but stops requests and never advances progress", async () => {
  const controller = new AbortController();
  const source = capture([
    mailboxRow("synthetic-a"),
    mailboxRow("synthetic-b"),
    mailboxRow("synthetic-c"),
  ]);
  const originalApi = source.client.api;
  let pdfs = 0;
  source.client.api = async (kind, fields) => {
    if (kind === "pdf" && ++pdfs === 2) {
      controller.abort();
      throw new Error("synthetic aborted transport");
    }
    return originalApi(kind, fields);
  };
  const result = await run(source, { signal: controller.signal });
  expect(result.artifacts.filter((artifact) => artifact.role === "provider_document")).toHaveLength(
    1,
  );
  expect(source.calls.filter((call) => call.startsWith("detail:"))).toHaveLength(2);
  expect(pdfs).toBe(2);
  expect(result.errors.every((error) => error.code === "sbi_mailbox_lease_lost")).toBe(true);
  expect(result.next).toBeUndefined();
  const blocked = capture();
  await run(blocked, { signal: controller.signal });
  expect(blocked.calls).toEqual([]);
});

test("provider envelope messages never enter retained artifacts or operational results", async () => {
  for (const refused of [false, true]) {
    const source = capture();
    const originalApi = source.client.api;
    source.client.api = async (kind, fields) => {
      const bytes = await originalApi(kind, fields);
      if (kind === "pdf") return bytes;
      const body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      return encode({
        ...body,
        message: "SYNTHETIC_PRIVATE_PROVIDER_MESSAGE",
        ...(refused ? { code: "UNOBSERVED" } : {}),
      });
    };
    const result = await run(source);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_PROVIDER_MESSAGE");
    if (refused) {
      expect(result.artifacts).toEqual([]);
      expect(result.errors[0]!.code).toBe("sbi_mailbox_response_unobserved");
    } else
      expect(
        result.artifacts.filter((artifact) => artifact.role === "provider_document"),
      ).toHaveLength(1);
  }
});
