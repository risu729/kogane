// The MyJCB 「カード情報」 reader, the `card_debit_account_statement` lane and
// the evidence the settlement sweep attaches to candidates (ADR 0032,
// 2026-09-27 amendment). Every page is synthetic: the table's shape mirrors
// the observed one (vertical th/td rows after an h3.hdg-H3 heading), and every
// bank, branch, digit and name string is made up.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import {
  CARD_INFORMATION_READER_VERSION,
  cardDebitAccountSweep,
  parseCardInformation,
} from "../src/card-debit-account-job.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import { smbcDirectTransactions } from "../../../packages/parsers/src/parsers/smbc-direct.ts";
import { cardSettlementEligible } from "../../../packages/domain/src/card-settlement.ts";
import { bankSourceIdForDisplayedName } from "../../../packages/domain/src/card-debit-account.ts";

let mf: Miniflare, env: Env, db: D1Database;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

/** A made-up holder name: it must never reach a reading or a row. */
const HOLDER = "*カク* ウ*";
const CARD_NAME = "架空カードプラス";
type Rows = [string, string][];
const ROWS: Rows = [
  ["カード名称", CARD_NAME],
  ["カード発行会社", "架空発行会社"],
  ["金融機関名", "みずほ銀行"],
  ["支店名", "架空支店"],
  ["科目・口座番号", "普通 1234***"],
  ["口座名義", HOLDER],
];
function page(rows: Rows = ROWS, options: { heading?: number; table?: string } = {}): string {
  const headings = Array.from(
    { length: options.heading ?? 1 },
    () => `<h3 class="hdg-H3">カード情報</h3>`,
  ).join("");
  const table =
    options.table ??
    `<table class="table-data"><tbody>${rows
      .map(([label, value]) => `<tr><th>${label}</th><td>\n  ${value}\n</td></tr>`)
      .join("")}</tbody></table>`;
  return `<!doctype html><html><body><h1>カードご利用代金明細(確定分)</h1>
<table class="table-data"><tbody><tr><th>ご利用日</th><td>架空</td></tr></tbody></table>
<div class="detail-list-01"><div class="head"><div class="cell">今回のお支払い金額</div></div></div>
<div class="detail-lyt-02 border-01">${headings}<div class="col-01">${table}</div></div>
<h3 class="hdg-H3">明細書をダウンロードできます</h3></body></html>`;
}
const replace = (label: string, value: string): Rows =>
  ROWS.map(([l, v]) => [l, l === label ? value : v]);

test("the reader reads bank, branch, 科目, leading digits and mask, and nothing else", () => {
  const reading = parseCardInformation(page());
  expect(reading).toEqual({
    outcome: "read",
    information: {
      bankName: "みずほ銀行",
      branchName: "架空支店",
      accountType: "普通",
      leadingDigits: "1234",
      maskedDigitCount: 3,
    },
  });
  // The holder name and the card name are never read.
  expect(JSON.stringify(reading)).not.toContain("カク");
  expect(JSON.stringify(reading)).not.toContain(CARD_NAME);
  expect(parseCardInformation(page(replace("科目・口座番号", "当座 9876*****")))).toMatchObject({
    information: { accountType: "当座", leadingDigits: "9876", maskedDigitCount: 5 },
  });
  // The unread rows may be absent; only the three read rows are required.
  expect(parseCardInformation(page(ROWS.filter(([label]) => label !== "口座名義"))).outcome).toBe(
    "read",
  );
});

test("any other shape is a closed refusal, never a partial reading", () => {
  const code = (html: string) => {
    const reading = parseCardInformation(html);
    return reading.outcome === "refused" ? reading.code : "read";
  };
  expect(code(page(ROWS, { heading: 0 }))).toBe("card_information_absent");
  expect(code(page(ROWS, { heading: 2 }))).toBe("card_information_ambiguous");
  expect(code(page(ROWS, { table: "<p>架空</p>" }))).toBe("card_information_table_missing");
  // The first table after the heading is its table, whatever its class: a
  // table without the read labels is invalid, never another table's reading.
  expect(
    code(
      page(ROWS, { table: `<table class="other"><tr><th>金融機関名</th><td>x</td></tr></table>` }),
    ),
  ).toBe("card_information_table_invalid");
  expect(code(page([...ROWS, ["未知の項目", "架空"]]))).toBe("card_information_table_invalid");
  expect(code(page([...ROWS, ["支店名", "架空支店"]]))).toBe("card_information_table_invalid");
  expect(code(page(ROWS.filter(([label]) => label !== "支店名")))).toBe(
    "card_information_table_invalid",
  );
  expect(
    code(
      page(ROWS, {
        table: `<table class="table-data"><tr><td>金融機関名</td><td>x</td></tr></table>`,
      }),
    ),
  ).toBe("card_information_table_invalid");
  expect(code(page(replace("金融機関名", "")))).toBe("card_information_name_invalid");
  expect(code(page(replace("支店名", "架空123支店")))).toBe("card_information_name_invalid");
  for (const value of [
    "普通 123***", // three digits
    "普通 12345**", // five digits
    "普通 ***1234", // trailing digits, the mask direction ADR 0032 first assumed
    "普通 １２３４***", // full-width digits
    "普通 1234＊＊＊", // full-width mask
    "普通 1234", // no mask
    "貯蓄 1234***", // an account type nobody observed
    "普通1234***", // no space
  ])
    expect(code(page(replace("科目・口座番号", value)))).toBe("card_information_account_invalid");
});

test("the table is found by the heading text and th labels, not by class names", () => {
  const plain = `<!doctype html><html><body><nav><a href="#x">カード情報</a></nav>
<h2>カード情報</h2><table>${ROWS.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join("")}</table></body></html>`;
  expect(parseCardInformation(plain)).toMatchObject({
    outcome: "read",
    information: { bankName: "みずほ銀行", leadingDigits: "1234" },
  });
});

test("bank names are read with their whitespace collapsed and resolved after NFKC", () => {
  const bank = (value: string) => {
    const reading = parseCardInformation(page(replace("金融機関名", value)));
    if (reading.outcome !== "read") throw new Error(reading.code);
    return [
      reading.information.bankName,
      bankSourceIdForDisplayedName(reading.information.bankName),
    ];
  };
  // An ideographic space, a line break and a full-width rendering.
  expect(bank("みずほ\u3000銀行")).toEqual(["みずほ 銀行", "mizuho-bank"]);
  expect(bank("三井住友\n  銀行")).toEqual(["三井住友 銀行", "smbc-bank"]);
  expect(bank("ＳＢＩ新生銀行")).toEqual(["ＳＢＩ新生銀行", "sbi-shinsei-bank"]);
  // A bank Kogane does not model is read but resolves to no bank.
  expect(bank("架空銀行")).toEqual(["架空銀行", null]);
});

const resolver: IdentityResolver = (input) => ({
  account: {
    key: [input.sourceAccount],
    label: "synthetic",
    role: "deposit",
    status: "provider-local",
    reason: "test",
  },
  instruments: [],
  issues: [],
});
const bytes = (html: string) => new TextEncoder().encode(html);

/** A MyJCB page stored by run `id`, admitted by a published statement parse. */
async function seedPage(id: number, key: string, html: string, publish = true): Promise<void> {
  await seedArtifact(env, id, "myjcb", "credit-detail", key, bytes(html));
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'myjcb-credit-statement-total','1.1.0','2026-09-12','ok','[]')",
    )
    .bind(id, id)
    .run();
  if (publish) await publishParse(db, id);
}
const rows = () =>
  db
    .prepare("SELECT * FROM card_debit_account_statement ORDER BY id")
    .all<Record<string, unknown>>()
    .then((result) => result.results);

test("the lane writes one row per card and raw object, append-only, never twice", async () => {
  const html = page();
  await seedPage(801, "conn-a/credit-detail-01.html", html);
  // The same bytes stored by a later run: the same raw object, no new row.
  await seedPage(802, "conn-a/credit-detail-01.html", html);
  // A page whose statement parse is not published is not read.
  await seedPage(803, "conn-a/credit-detail-02.html", page(replace("支店名", "別架空支店")), false);
  // A refused shape is recorded with its code and no value.
  await seedPage(
    804,
    "conn-a/credit-detail-03.html",
    page(replace("科目・口座番号", "普通 ***1234")),
  );

  // Both copies of the same bytes are examined in one tick; the second
  // insert is a no-op on the unique key.
  expect(await cardDebitAccountSweep(env, { now: "2026-09-27T00:00:00.000Z" })).toEqual({
    scanned: 3,
    read: 2,
    refused: 1,
    written: 2,
  });
  const stored = await rows();
  expect(stored).toHaveLength(2);
  expect(stored[0]).toMatchObject({
    source_id: "myjcb",
    card_source_account: "myjcb:conn-a:root",
    fetch_artifact_id: 801,
    statement_parse_run_id: 801,
    reader_version: CARD_INFORMATION_READER_VERSION,
    outcome: "read",
    refusal_code: null,
    bank_name: "みずほ銀行",
    branch_name: "架空支店",
    account_type: "普通",
    leading_digits: "1234",
    masked_digit_count: 3,
  });
  expect(stored[1]).toMatchObject({
    fetch_artifact_id: 804,
    outcome: "refused",
    refusal_code: "card_information_account_invalid",
    bank_name: null,
    branch_name: null,
    account_type: null,
    leading_digits: null,
    masked_digit_count: null,
  });
  // Nothing of the holder or card name is stored anywhere in the table.
  expect(JSON.stringify(stored)).not.toContain("カク");
  expect(JSON.stringify(stored)).not.toContain(CARD_NAME);

  // Running again writes nothing; publishing the held-back page reads it.
  expect(await cardDebitAccountSweep(env)).toEqual({ scanned: 0, read: 0, refused: 0, written: 0 });
  await publishParse(db, 803);
  expect(await cardDebitAccountSweep(env)).toMatchObject({ scanned: 1, read: 1, written: 1 });

  // Rows are evidence: never updated or deleted.
  await expect(
    db.prepare("UPDATE card_debit_account_statement SET branch_name='x'").run(),
  ).rejects.toThrow();
  await expect(db.prepare("DELETE FROM card_debit_account_statement").run()).rejects.toThrow();
  // A reading without a value, or a refusal carrying one, is refused by the schema.
  await expect(
    db
      .prepare(
        `INSERT INTO card_debit_account_statement(source_id,card_source_account,fetch_artifact_id,statement_parse_run_id,raw_sha256,source_object_key,observed_at,reader_version,outcome,refusal_code,bank_name,branch_name,account_type,leading_digits,masked_digit_count,created_at)
         VALUES('myjcb','myjcb:conn-a:root',801,801,?,'k','t','myjcb-card-information-9.0.0','refused','card_information_absent','x',NULL,NULL,NULL,NULL,'t')`,
      )
      .bind("a".repeat(64))
      .run(),
  ).rejects.toThrow();
}, 60000);

/** A MyJCB statement total from page `id` and an SMBC debit of the same amount. */
async function seedCandidate(statementId: number, bankId: number, connection = "conn-a") {
  await db
    .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
 VALUES(?,?,'credit_statement_payment_amount',3000,'3000',0,'JPY','2026-09-10','synthetic-total',?)`)
    .bind(
      statementId,
      `myjcb:${connection}:root`,
      JSON.stringify({
        _kogane: {
          period: "2026-09",
          paymentDate: "2026-09-10",
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  await seedArtifact(env, bankId, "smbc-bank", "synthetic", "synthetic-" + bankId, {});
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'smbc-direct-transactions','1','2026-09-12','ok','[]')",
    )
    .bind(bankId, bankId)
    .run();
  const parsed = await smbcDirectTransactions.parse(
    bytes(
      JSON.stringify({
        range: { start: "2026-09-01", end: "2026-09-30" },
        depositsTotal: 0,
        withdrawalsTotal: 3000,
        transactions: [
          {
            id: "synthetic-provider-debit-" + bankId,
            date: "2026-09-10T00:00:00+09:00",
            amount: 3000,
            balanceAfter: 7000,
            description: "synthetic",
            direction: "debit",
          },
        ],
      }),
    ),
    {
      id: bankId,
      sourceId: "smbc-bank",
      runStatus: "success",
      runFailureCount: 0,
      dataset: "transactions-normalized",
      artifactKey: "transactions/20260901-20260930.normalized.json",
      url: null,
      mime: "application/json",
      fetchedAt: "2026-09-12T00:00:00.000Z",
      sha256: "0".repeat(64),
    },
  );
  for (const row of parsed.observations) {
    if (row.kind !== "transaction") continue;
    await db
      .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        bankId,
        row.sourceAccount,
        row.externalId ?? null,
        row.status ?? null,
        row.amountMinor ?? null,
        row.amountText ?? null,
        row.amountScale ?? null,
        row.currency ?? null,
        row.counterparty ?? null,
        row.asOf ?? null,
        row.rawLocator,
        JSON.stringify(row.extra),
      )
      .run();
  }
  await publishParse(db, bankId);
  for (const [id, source] of [
    [statementId, "myjcb"],
    [bankId, "smbc-bank"],
  ] as const)
    await identifyParse(
      db,
      {
        id,
        artifact_id: id,
        source_id: source,
        producer_id: "collector-r2-importer",
        fetch_run_id: id,
      },
      resolver,
    );
}
const evidence = () =>
  db
    .prepare(
      "SELECT candidate_id,statement_id,policy,outcome,reason,proposal_json FROM card_settlement_debit_account_evidence ORDER BY id",
    )
    .all<{
      candidate_id: string;
      statement_id: number;
      policy: string;
      outcome: string;
      reason: string | null;
      proposal_json: string | null;
    }>()
    .then((result) => result.results);

test("the sweep attaches the statement's debit account as evidence and changes nothing else", async () => {
  // A Mizuho account Kogane knows, with the prefix the page shows.
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO sources VALUES('mizuho-bank','mizuho-bank')"),
    db.prepare(
      `INSERT INTO source_accounts VALUES('sa-synthetic-mizuho','mizuho-bank','collector-r2-importer','["mizuho-bank:ordinary:001:1234567"]')`,
    ),
  ]);
  await seedCandidate(801, 901);
  const first = await cardSettlementSweep(db);
  expect(first).toMatchObject({ proposed: 1, written: 1, debitAccountEvidence: 1 });
  const candidate = (await db
    .prepare("SELECT id,facts_json FROM card_settlement_candidates")
    .first<{ id: string; facts_json: string }>())!;
  const [row] = await evidence();
  // The page names a Mizuho account; the candidate's debit is SMBC's: the
  // provider states another account, recorded as evidence against the pair.
  expect(row).toMatchObject({
    candidate_id: candidate.id,
    policy: "card-debit-account-statement-v2",
    outcome: "names_other_account",
    reason: null,
  });
  expect(JSON.parse(row!.proposal_json!)).toMatchObject({
    status: "proposed",
    cardSourceAccount: "myjcb:conn-a:root",
    bankSourceId: "mizuho-bank",
    bankSourceAccount: "mizuho-bank:ordinary:001:1234567",
    visibleDigitCount: 4,
  });
  // The candidate is exactly what it would be without the evidence, and
  // still not eligible: ownership is the operator's decision.
  const facts = JSON.parse(candidate.facts_json);
  expect(facts.ownership).toBe("unknown");
  expect(cardSettlementEligible(facts)).toBe(false);
  expect(JSON.stringify(facts)).not.toContain("mizuho-bank");
  expect(JSON.stringify(facts)).not.toContain("card_debit_account_statement");

  // A second sweep over the same facts appends nothing.
  await db.prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=0").run();
  expect(await cardSettlementSweep(db)).toMatchObject({ written: 0, debitAccountEvidence: 0 });
  expect(await evidence()).toHaveLength(1);

  // A second Mizuho account with the same prefix makes the proposal
  // ambiguous: a changed outcome is a new row, the old one stays.
  await db
    .prepare(
      `INSERT INTO source_accounts VALUES('sa-synthetic-mizuho-2','mizuho-bank','collector-r2-importer','["mizuho-bank:ordinary:002:1234999"]')`,
    )
    .run();
  await db.prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=0").run();
  expect(await cardSettlementSweep(db)).toMatchObject({ written: 0, debitAccountEvidence: 1 });
  expect((await evidence()).map((e) => [e.outcome, e.reason])).toEqual([
    ["names_other_account", null],
    ["not_proposed", "ambiguous_accounts"],
  ]);
  expect(
    await db.prepare("SELECT count(*) AS n FROM card_settlement_candidates").first<number>("n"),
  ).toBe(1);
  await expect(
    db.prepare("DELETE FROM card_settlement_debit_account_evidence").run(),
  ).rejects.toThrow();
}, 60000);

test("a page naming a bank without comparable references is a closed reason", async () => {
  await seedPage(805, "conn-b/credit-detail-01.html", page(replace("金融機関名", "三井住友銀行")));
  expect(await cardDebitAccountSweep(env)).toMatchObject({ read: 1, written: 1 });
  await seedCandidate(805, 902, "conn-b");
  await db.prepare("UPDATE card_settlement_scan_cursor SET last_statement_id=0").run();
  await cardSettlementSweep(db);
  const statementId = (await db
    .prepare("SELECT id FROM card_debit_account_statement WHERE fetch_artifact_id=805")
    .first<number>("id"))!;
  const rows = (await evidence()).filter((row) => row.statement_id === statementId);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows)
    expect(row).toMatchObject({
      outcome: "not_proposed",
      reason: "no_comparable_bank_account",
      proposal_json: null,
    });
}, 60000);

test("bytes that fail their digest are refused without values, and unwritable keys are never selected", async () => {
  const html = page();
  await seedPage(806, "conn-c/credit-detail-01.html", html);
  const sha = (await db
    .prepare("SELECT sha256 FROM fetch_artifacts WHERE id=806")
    .first<string>("sha256"))!;
  // Same length, other bytes: only the digest check can tell.
  await env.EVIDENCE.put(sha, bytes(html.replace("1234***", "5678***")));
  // A connection segment the table's CHECK refuses: never selected, so the
  // lane cannot fail on it tick after tick.
  await seedPage(807, "conn_x/credit-detail-01.html", page(replace("支店名", "別架空支店")));
  expect(await cardDebitAccountSweep(env)).toEqual({ scanned: 1, read: 0, refused: 1, written: 1 });
  expect(
    await db
      .prepare(
        "SELECT fetch_artifact_id,outcome,refusal_code,bank_name,leading_digits FROM card_debit_account_statement WHERE fetch_artifact_id IN (806,807)",
      )
      .all(),
  ).toMatchObject({
    results: [
      {
        fetch_artifact_id: 806,
        outcome: "refused",
        refusal_code: "raw_object_unreadable",
        bank_name: null,
        leading_digits: null,
      },
    ],
  });
  expect(await cardDebitAccountSweep(env)).toEqual({ scanned: 0, read: 0, refused: 0, written: 0 });
}, 60000);

test("evidence must cite a reading of the candidate's own card", async () => {
  const candidate = (await db
    .prepare(
      "SELECT id FROM card_settlement_candidates WHERE json_extract(facts_json,'$.statement.sourceAccount')='myjcb:conn-a:root'",
    )
    .first<string>("id"))!;
  const otherCard = (await db
    .prepare("SELECT id FROM card_debit_account_statement WHERE fetch_artifact_id=805")
    .first<number>("id"))!;
  await expect(
    db
      .prepare(
        `INSERT INTO card_settlement_debit_account_evidence(candidate_id,statement_id,policy,outcome,reason,proposal_json,evidence_digest,created_at)
         VALUES(?,?,'card-debit-account-statement-v2','not_proposed','bank_not_resolved',NULL,?,'t')`,
      )
      .bind(candidate, otherCard, "b".repeat(64))
      .run(),
  ).rejects.toThrow();
}, 60000);
