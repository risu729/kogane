import { expect, test } from "bun:test";
import {
  mailboxJson,
  mailboxInventory,
  mailboxDetail,
  mailboxPdfFields,
  mailboxDocumentIdentity,
  assertSupportedMailboxRow,
  type MailboxRow,
} from "../src/mailbox-contract";
import { mailboxRow, mailboxList, mailboxSummary, mailboxDetailFixture } from "./mailbox-fixture";

test("corroborates the complete current list, preserving provider strings verbatim", () => {
  const rows = [mailboxRow(), mailboxRow("synthetic-sequence-2")];
  const inventory = mailboxInventory(mailboxList(rows), mailboxSummary(2));
  expect(inventory).toEqual({ rows, total: 2 });
  expect(inventory.rows[0]!.sTypeCd).toBe(" ");
  expect(mailboxInventory(mailboxList([]), mailboxSummary(0))).toEqual({ rows: [], total: 0 });
});

test("refuses incomplete totals, duplicate identity and unknown fields", () => {
  const badRows = [
    [mailboxRow(), mailboxRow()],
    [{ ...mailboxRow(), sBaseDate: "20990230" }],
    [{ ...mailboxRow(), sName: null }],
    [{ ...mailboxRow(), accessToken: "SYNTHETIC_SENTINEL" }],
  ];
  for (const rows of badRows)
    expect(() => mailboxInventory(mailboxList(rows), mailboxSummary(rows.length))).toThrow();
  expect(() => mailboxInventory({ ...mailboxList(), allCountKen: 2 }, mailboxSummary(2))).toThrow(
    "sbi_mailbox_inventory_incomplete",
  );
  expect(() => mailboxInventory(mailboxList([]), mailboxSummary(1))).toThrow(
    "sbi_mailbox_inventory_incomplete",
  );
  expect(() => mailboxInventory(mailboxList(), { ...mailboxSummary(), code: "OTHER" })).toThrow(
    "sbi_mailbox_response_unobserved",
  );
  expect(() => mailboxInventory(mailboxList(), { ...mailboxSummary(), summaryList: [] })).toThrow(
    "sbi_mailbox_inventory_incomplete",
  );
  expect(() =>
    mailboxInventory(mailboxList(), {
      ...mailboxSummary(),
      summaryList: [
        { busiSys: "other", userTokuteiId: "synthetic-user", kofuKensu: 1, mikaifuKensu: 0 },
      ],
    }),
  ).toThrow("sbi_mailbox_inventory_incomplete");
});

test("retains metadata for unknown kinds and makes support refusal local to that document", () => {
  const rows = [mailboxRow(), { ...mailboxRow("synthetic-other"), sCd: "UNOBSERVED_KIND" }];
  const inventory = mailboxInventory(mailboxList(rows), mailboxSummary(2));
  expect(inventory.rows).toEqual(rows);
  expect(() => assertSupportedMailboxRow(inventory.rows[0]!)).not.toThrow();
  expect(() => assertSupportedMailboxRow(inventory.rows[1]!)).toThrow(
    "sbi_mailbox_document_unobserved",
  );
  expect(() => assertSupportedMailboxRow({ ...inventory.rows[0]!, sTypeCd: "" })).toThrow(
    "sbi_mailbox_document_unobserved",
  );
});

test("audits original JSON before a duplicate private field or rounded count can disappear", () => {
  const original = JSON.stringify(mailboxList());
  const bytes = (value: string) => new TextEncoder().encode(value);
  expect(mailboxJson(bytes(original))).toEqual(mailboxList());
  for (const value of [
    '{"outlist":{"accessToken":"SYNTHETIC_SENTINEL"},' + original.slice(1),
    '{"outl\\u0069st":{"accessToken":"SYNTHETIC_SENTINEL"},' + original.slice(1),
    original.replace('"allCountKen":1', '"allCountKen":1.00000000000000000001'),
    original.replace('"allCountKen":1', '"allCountKen":9007199254740993'),
    original.replace('"allCountKen":1', '"allCountKen":1.0.0'),
    " ".repeat(2 * 1024 * 1024 + 1),
  ])
    expect(() => mailboxJson(bytes(value))).toThrow("sbi_mailbox_response_unobserved");
});

test("constructs the witnessed PDF form from the sole detail file without trimming type or splitting ids", () => {
  const row = mailboxInventory(mailboxList(), mailboxSummary()).rows[0]!;
  const detail = mailboxDetail(mailboxDetailFixture());
  expect(mailboxDetail({ ...mailboxDetailFixture(), torizanKbn: null })).toEqual(detail);
  expect(mailboxDetail({ ...mailboxDetailFixture(), tsuchiInfoKinfo: null })).toEqual(detail);
  expect(mailboxPdfFields(row, detail)).toEqual({
    userTokuteiId: "synthetic-user",
    sCd: "FR81011D02",
    sBaseDate: "20990101",
    sCdSeq: "synthetic-sequence-1",
    sTypeCd: " ",
    sIntFileIds: "synthetic-detail-file",
    xmlPreviewFlg: "0",
  });
  for (const files of [
    [],
    [detail.kofuDetailList[0], detail.kofuDetailList[0]],
    [{ sOriFileId: "synthetic.zip", sIntFileId: "synthetic" }],
  ])
    expect(() => mailboxDetail({ ...mailboxDetailFixture(), kofuDetailList: files })).toThrow(
      "sbi_mailbox_document_unobserved",
    );
  expect(() => mailboxDetail({ ...mailboxDetailFixture(), sTypeCd: "" })).toThrow(
    "sbi_mailbox_document_unobserved",
  );
  expect(() => mailboxDetail({ ...mailboxDetailFixture(), token: "SYNTHETIC_SENTINEL" })).toThrow(
    "sbi_mailbox_response_unobserved",
  );
});

test("same kind and date keep distinct stable document identities across mutable read-state changes", async () => {
  const first = mailboxRow() as MailboxRow;
  const next = mailboxRow("synthetic-sequence-2") as MailboxRow;
  const identity = await mailboxDocumentIdentity(first);
  const other = await mailboxDocumentIdentity(next);
  expect(other.kind).toBe(identity.kind);
  expect(other.identity).not.toBe(identity.identity);
  expect(
    await mailboxDocumentIdentity({ ...first, readSts: "changed", kofuInfoKtitle: "corrected" }),
  ).toEqual(identity);
  expect(JSON.stringify(identity)).not.toContain("synthetic");
  expect(JSON.stringify(identity)).not.toContain(first.sCd);
});
