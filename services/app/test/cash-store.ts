// A synthetic store for the cash read (ADR 0123, amendment 2026-11-20): cash
// accounts of the shapes the registry names cash (direct yen deposits at
// three banks, an exchange's yen cash, a broker's foreign cash in three
// currencies), beside measurements that are not cash (a balance after a
// transaction, an available balance, a buying power, an unmapped metric),
// each account organized under a Japanese label and a 64-hex account entity
// as identity runs leave it, and the published balance snapshot built by the
// Processor's own job. Each source is one capture of its dataset, as its
// collector uploads it, so the snapshot policies keep every account of it
// current. Every label, amount, date and id is invented; only the shapes
// mirror what providers report.
import { env } from "cloudflare:test";
import { runBalanceProjection } from "../../processor/src/balance-projection-job";
import { publishParse, seedRun } from "./fixtures";

/**
 * One published measurement: provider metric, unit, and the amount as the
 * provider's decimal text (`－` does not parse) with, for the units whose
 * minor-unit exponent the parser contracts define, the same amount in minor
 * units (docs/normalized-decimals.md, input contract).
 */
interface Measurement {
  metric: string;
  unit: string;
  text: string;
  minor?: string;
}

export interface CashAccount {
  rawAccount: string;
  label: string;
  measurements: Measurement[];
  /** Map this reference onto the entity of another raw account instead of its own. */
  entityOf?: string;
}

/** One source's capture: the dataset and parser its snapshot policy names, and its accounts. */
export interface CashSource {
  source: string;
  dataset?: string;
  fetchUnitKey?: string;
  parser: string;
  accounts: CashAccount[];
}

/** The 64-hex account entity id of a raw account, as the identity store derives one. */
export async function entityOf(rawAccount: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawAccount));
  return `acc_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** One source's published capture, each account organized under its label. */
export async function seedCashSource(capture: CashSource): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES ('evidence-test',?)",
    ).bind(capture.source),
    env.DB.prepare(
      "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
    ).bind(capture.source),
  ]);
  const run = await seedRun({
    count: 1,
    source: capture.source,
    ...(capture.dataset === undefined ? {} : { dataset: capture.dataset }),
    ...(capture.fetchUnitKey === undefined ? {} : { fetchUnitKey: capture.fetchUnitKey }),
  });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,?,'1','2026-11-18T21:05:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id, capture.parser)
    .first<{ id: number }>();
  await publishParse(parse!.id, "2026-11-18T21:06:00Z");
  const prefix = `cash-${parse!.id}-`;
  const statements = [];
  let observed = 0;
  for (const [index, account] of capture.accounts.entries()) {
    const reference = `${prefix}ref-${index}`;
    const mapping = `${prefix}am-${index}`;
    const entity = await entityOf(account.entityOf ?? account.rawAccount);
    statements.push(
      // An entity a former capture or an earlier account already created is kept.
      env.DB.prepare(
        "INSERT INTO accounts SELECT ?1,?2,'cash','provider-local' WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id=?1)",
      ).bind(entity, account.label),
      env.DB.prepare("INSERT INTO source_accounts VALUES (?,?,'evidence-test',?)").bind(
        reference,
        capture.source,
        JSON.stringify([account.rawAccount, parse!.id]),
      ),
      env.DB.prepare(
        `INSERT INTO account_mappings VALUES (?,?,1,?,'rule','provider-scope',1,'2026-11-18T21:07:00Z',?,'provider-local')`,
      ).bind(mapping, reference, entity, account.label),
    );
    for (const [position, measurement] of account.measurements.entries()) {
      const inserted = await env.DB.prepare(
        `INSERT INTO balance_observations
           (parse_run_id,source_account,metric,instrument,amount_minor,amount_text,amount_scale,as_of,raw_locator,extra_json)
         VALUES (?,?,?,?,?,?,?,'2026-11-18',?,'{}') RETURNING id`,
      )
        .bind(
          parse!.id,
          account.rawAccount,
          measurement.metric,
          measurement.unit,
          measurement.minor ?? null,
          measurement.text,
          /^\d+\.(\d+)$/u.exec(measurement.text)?.[1]?.length ?? 0,
          `json:$.synthetic.accounts[${index}].balances[${position}]`,
        )
        .first<{ id: number }>();
      observed += 1;
      statements.push(
        env.DB.prepare("INSERT INTO identity_observations VALUES (?,?,'balance',?,?,?,'[]')").bind(
          `${prefix}io-${inserted!.id}`,
          `${prefix}ir`,
          inserted!.id,
          reference,
          mapping,
        ),
      );
    }
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO identity_runs VALUES (?,?,1,'2026-11-18T21:07:00Z')").bind(
      `${prefix}ir`,
      parse!.id,
    ),
    ...statements,
    env.DB.prepare("INSERT INTO identity_run_seals VALUES (?,?,'2026-11-18T21:07:00Z')").bind(
      `${prefix}ir`,
      observed,
    ),
  ]);
}

/** One build of the balance snapshot into the READ database, through the Processor's job. */
export async function buildSnapshot(): Promise<void> {
  await runBalanceProjection(
    { ...env, BALANCE_PROJECTION_ENABLED: "1", READ_PROJECTION_ENABLED: "true" } as never,
    { writeBudget: 20_000 },
  );
}

/** A yen amount, in the two representations a yen balance arrives in. */
const yen = (index: number, position = 0) => {
  const text = String(1_000_000 + index * 7_919 + position * 104_729);
  return { unit: "JPY", text, minor: text };
};

function deposits(source: string, metric: string, from: number, count: number): CashAccount[] {
  return Array.from({ length: count }, (_, position) => {
    const index = from + position;
    return {
      rawAccount: `${source}:synthetic-ordinary-${String(index).padStart(4, "0")}`,
      label: `合成銀行 普通預金 口座${String(index).padStart(2, "0")}`,
      measurements: [
        { metric, ...yen(index) },
        // Mizuho's account list also reports an available balance: a capacity, not cash.
        ...(source === "mizuho-bank" ? [{ metric: "available_balance", ...yen(index, 1) }] : []),
      ],
    };
  });
}

/** The SMBC capture: eight deposits and two whose value did not parse. */
export function smbcCapture(extra: CashAccount[] = []): CashSource {
  return {
    source: "smbc-bank",
    dataset: "balance-normalized",
    parser: "smbc-direct-balance",
    accounts: [
      ...deposits("smbc-bank", "account_balance", 12, 8),
      ...[0, 1].map((position) => ({
        rawAccount: `smbc-bank:synthetic-unparsed-${String(position)}`,
        label: `合成銀行 定期性預金 ${String(position)}`,
        measurements: [{ metric: "account_balance", unit: "JPY", text: "－" }],
      })),
      ...extra,
    ],
  };
}

/**
 * The cash store at the scale the owner's question meets: 30 cash accounts
 * (twelve yen deposits at one bank, ten at a second (two of whose values did
 * not parse), six at a third, an exchange's yen cash, a broker account with
 * three currencies) and non-cash measurements beside them.
 */
export function cashSources(): CashSource[] {
  return [
    {
      source: "sbi-shinsei-bank",
      dataset: "yen-deposit-account",
      parser: "sbi-shinsei-yen-deposit-account",
      accounts: deposits("sbi-shinsei-bank", "yen_deposit_account_balance", 0, 12),
    },
    smbcCapture(),
    {
      source: "mizuho-bank",
      parser: "mizuho-account-list",
      accounts: deposits("mizuho-bank", "account_balance", 20, 6),
    },
    {
      source: "sbi-vc-trade",
      dataset: "cash-balances",
      fetchUnitKey: "synthetic-classic",
      parser: "sbi-vc-cash-balances",
      accounts: [
        {
          rawAccount: "sbi-vc-trade:synthetic-cash",
          label: "合成暗号資産取引 円預り金",
          measurements: [{ metric: "cash_balance", ...yen(90) }],
        },
      ],
    },
    {
      source: "sbi-securities",
      dataset: "foreign-cash-balances",
      fetchUnitKey: "synthetic-foreign",
      parser: "sbi-foreign-cash-balances",
      accounts: [
        {
          rawAccount: "sbi-securities:synthetic-foreign",
          label: "合成証券 外貨預り金",
          measurements: [
            { metric: "keep_cash", unit: "USD", text: "1234.56", minor: "123456" },
            { metric: "keep_cash", unit: "AUD", text: "78.90", minor: "7890" },
            // No minor-unit exponent is defined for EUR: the text alone carries it.
            { metric: "keep_cash", unit: "EUR", text: "0.5" },
            { metric: "buy_possible_amount", unit: "USD", text: "9.99", minor: "999" },
          ],
        },
      ],
    },
    // Not cash: a balance after a transaction and an unmapped provider metric.
    {
      source: "sony-bank",
      parser: "sony-bank-history-json",
      accounts: [0, 1].map((position) => ({
        rawAccount: `sony-bank:synthetic-${String(position)}`,
        label: `合成銀行 円普通預金 ${String(position)}`,
        measurements: [{ metric: "available_after_transaction", ...yen(70 + position) }],
      })),
    },
    {
      source: "vpass",
      parser: "synthetic-balances",
      accounts: [
        {
          rawAccount: "vpass:synthetic-card",
          label: "合成カード口座",
          measurements: [{ metric: "ご利用残高", ...yen(80) }],
        },
      ],
    },
  ];
}
