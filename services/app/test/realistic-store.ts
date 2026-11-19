// A synthetic store at the scale #1414 describes (2026-11-19), for measuring
// what each MCP read answers: balances on 12 accounts of four sources, each
// account organized (account label, unit instrument) as identity runs leave
// it, the published balance snapshot built by the Processor's own job, and
// ten days of schedule occurrences for every collection job the migrations
// configure. Every label, amount, date and id is invented; nothing mirrors a
// production value, only the shapes (a Japanese account label, a Japanese
// provider metric, a decimal amount, a JPY unit).
import { env } from "cloudflare:test";
import { runBalanceProjection } from "../../processor/src/balance-projection-job";
import { publishParse, seedRun } from "./fixtures";

/** The sources the balances are spread over; each gets an ingest route for the fixture producer. */
const SOURCES = ["vpass", "moneyforward-me", "sony-bank", "sbi-securities"] as const;
/** Ten provider metrics per account, in the two shapes providers name them: Japanese text and long snake case. */
const METRICS = [
  "利用可能額",
  "ご利用残高",
  "お支払い予定額",
  "synthetic_revolving_balance_amount",
  "synthetic_installment_balance_amount",
  "synthetic_cash_advance_balance",
  "synthetic_shopping_credit_limit",
  "synthetic_available_credit_amount",
  "前回お支払い額",
  "今回ご請求額",
] as const;
const REALISTIC_ACCOUNTS = 12;
export const REALISTIC_BALANCES = REALISTIC_ACCOUNTS * METRICS.length;

async function route(source: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES ('evidence-test',?)",
    ).bind(source),
    env.DB.prepare(
      "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
    ).bind(source),
  ]);
}

/** One account's published parse with ten balances, organized under a synthetic label. */
async function seedAccount(index: number): Promise<void> {
  const source = SOURCES[index % SOURCES.length]!;
  const run = await seedRun({ count: 1, source });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,'synthetic-balances','1','2026-11-18T21:05:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id, "2026-11-18T21:06:00Z");
  const rawAccount = `synthetic-account-${String(index).padStart(3, "0")}`;
  const ids: number[] = [];
  for (const [position, metric] of METRICS.entries()) {
    // Every eleventh value is unparsed: a non-exact value keeps its reason.
    const unparsed = (index * METRICS.length + position) % 11 === 0;
    const minor = String(100_000 + index * 7_919 + position * 104_729);
    const row = await env.DB.prepare(
      `INSERT INTO balance_observations
         (parse_run_id,source_account,metric,instrument,amount_minor,amount_text,as_of,raw_locator,extra_json)
       VALUES (?,?,?,'JPY',?,?,'2026-11-18',?,'{}') RETURNING id`,
    )
      .bind(
        parse!.id,
        rawAccount,
        metric,
        unparsed ? null : minor,
        unparsed ? "－" : `${Number(minor).toLocaleString("en-US")}円`,
        `json:$.synthetic.accounts[${index}].balances[${position}].amount`,
      )
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  const prefix = `realistic-${parse!.id}-`;
  const unit = `${prefix}unit`;
  // Account entity ids are a prefix and a SHA-256, as the identity store derives them.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prefix));
  const entity = `acc_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO source_accounts VALUES (?,?,'evidence-test',?)").bind(
      `${prefix}ref`,
      source,
      JSON.stringify([rawAccount, parse!.id]),
    ),
    env.DB.prepare("INSERT INTO accounts VALUES (?,?,'cash','provider-local')").bind(
      entity,
      `合成カード口座 ${index}`,
    ),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES (?,?,1,?,'rule','provider-scope',1,'2026-11-18T21:07:00Z',?,'provider-local')`,
    ).bind(`${prefix}am`, `${prefix}ref`, entity, `合成カード口座（カード${index}）`),
    env.DB.prepare("INSERT INTO instruments VALUES (?,'money','日本円','identified')").bind(unit),
    env.DB.prepare("INSERT INTO instrument_identifiers VALUES (?,'iso-4217',?,'JPY','{}')").bind(
      `${prefix}identifier`,
      `${prefix}scope`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_mappings VALUES (?,?,1,?,'rule','currency-code',1,'2026-11-18T21:07:00Z','日本円','identified')`,
    ).bind(`${prefix}im`, `${prefix}identifier`, unit),
    env.DB.prepare("INSERT INTO identity_runs VALUES (?,?,1,'2026-11-18T21:07:00Z')").bind(
      `${prefix}ir`,
      parse!.id,
    ),
    ...ids.flatMap((id) => [
      env.DB.prepare("INSERT INTO identity_observations VALUES (?,?,'balance',?,?,?,'[]')").bind(
        `${prefix}io-${id}`,
        `${prefix}ir`,
        id,
        `${prefix}ref`,
        `${prefix}am`,
      ),
      env.DB.prepare("INSERT INTO identity_instrument_uses VALUES (?,'unit',?,?)").bind(
        `${prefix}io-${id}`,
        `${prefix}identifier`,
        `${prefix}im`,
      ),
    ]),
    env.DB.prepare("INSERT INTO identity_run_seals VALUES (?,?,'2026-11-18T21:07:00Z')").bind(
      `${prefix}ir`,
      ids.length,
    ),
  ]);
}

/** Ten days of occurrences per collection job; some failed with a closed code, each with run ids. */
async function seedOccurrences(): Promise<void> {
  const jobs = await env.DB.prepare(
    "SELECT id FROM collection_schedules WHERE kind='collection' ORDER BY id",
  ).all<{ id: string }>();
  const statements = [];
  for (const [jobIndex, { id }] of jobs.results.entries())
    for (let day = 0; day < 10; day++) {
      const date = `2026-11-${String(9 + day).padStart(2, "0")}`;
      const failed = (jobIndex + day) % 4 === 0;
      const runs = Array.from(
        { length: 1 + ((jobIndex + day) % 7) },
        (_, run) => `${id}-2026111${day}-${run}`,
      );
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO collection_schedule_occurrences
             (id,schedule_id,nominal_at,started_at,finished_at,status,run_ids_json,failure_code)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).bind(
          `${id}-occurrence-${day}`,
          id,
          `${date}T21:00:00.000Z`,
          `${date}T21:00:01.000Z`,
          `${date}T21:04:30.000Z`,
          failed ? "failed" : "completed",
          JSON.stringify(runs),
          failed ? "collection_failed" : null,
        ),
      );
    }
  await env.DB.batch(statements);
}

/** Seed the store once; `seedRegistry` must have run. */
export async function seedRealisticStore(): Promise<void> {
  for (const source of SOURCES) await route(source);
  for (let index = 0; index < REALISTIC_ACCOUNTS; index++) await seedAccount(index);
  await runBalanceProjection(
    { ...env, BALANCE_PROJECTION_ENABLED: "1", READ_PROJECTION_ENABLED: "true" } as never,
    { writeBudget: 20_000 },
  );
  await seedOccurrences();
}
