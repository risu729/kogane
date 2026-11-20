// ADR 0120: one readable label per account entity. An aggregator connection
// label reached through one reference names every reference of the same
// account, and a Vpass card is named from its newest bound credit capture.
// Every value is invented.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import {
  displayAccountLabel,
  entityAccountLabels,
} from "../../../packages/application/src/query/account-labels.ts";
import { observationOrganizations } from "../../../packages/application/src/query/observation-organization.ts";
import { organizedFilterOptions } from "../../../packages/application/src/query/organized-filter-options.ts";
import { readIdentityPage } from "../../../packages/application/src/query/identity-pages.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { validIdentityResponse } from "../../../packages/observation-shared/src/identity-contract";
import { identifyParse } from "../../processor/src/identity-store";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const CONNECTION = "合成銀行（MoneyForward連携）";
const MF_ACCOUNT = "moneyforward-me:synthetic-connection";
const sql = () => d1Executor(env.DB);

async function parse(artifactId: number, parser = "fixture", version = "1") {
  const row = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,?,?,'2099','ok','[]') RETURNING id`,
  )
    .bind(artifactId, parser, version)
    .first<{ id: number }>();
  await publishParse(row!.id);
  return row!.id;
}

/** One MF transaction under `producer`, identified by the real rules. */
async function mfObservation(producer: string) {
  const run = await seedRun({ source: "moneyforward-me", count: 1, producer });
  const parseRunId = await parse(run.artifacts[0]!.id);
  const observation = await env.DB.prepare(
    `INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json)
     VALUES(?,?,'JPY','row','{}') RETURNING id`,
  )
    .bind(parseRunId, MF_ACCOUNT)
    .first<{ id: number }>();
  await identifyParse(
    env.DB,
    {
      id: parseRunId,
      artifact_id: run.artifacts[0]!.id,
      source_id: "moneyforward-me",
      producer_id: producer,
      fetch_run_id: run.id,
    },
    resolveIdentity,
  );
  const mapping = await env.DB.prepare(
    `SELECT s.id reference,m.account_id account FROM identity_observations o
     JOIN source_accounts s ON s.id=o.source_account_id
     JOIN current_account_mappings m ON m.source_account_id=s.id
     WHERE o.kind='transaction' AND o.observation_id=?`,
  )
    .bind(observation!.id)
    .first<{ reference: string; account: string }>();
  return { id: observation!.id, ...mapping! };
}

let direct: Awaited<ReturnType<typeof mfObservation>>;
let mirrored: Awaited<ReturnType<typeof mfObservation>>;

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producers (id,kind,display_name) VALUES ('label-test','collector','Synthetic fixture')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_producers (ingest_client_id,producer_id) VALUES ('evidence-test','label-test')",
    ),
    ...["evidence-test", "label-test"].flatMap((producer) =>
      ["moneyforward-me", "vpass"].flatMap((source) => [
        env.DB.prepare(
          "INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES(?,?)",
        ).bind(producer, source),
        env.DB.prepare(
          "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test',?,?)",
        ).bind(producer, source),
      ]),
    ),
  ]);
  const detail = await seedRun({
    source: "moneyforward-me",
    count: 1,
    dataset: "account-detail",
    fetchUnitKey: "synthetic-connection",
  });
  await env.DB.prepare(`INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,
    related_source_id,reason,verifier_version,detail_artifact_id,direct_reference_ids_json,created_at)
    VALUES('evidence-test','synthetic-connection',1,?,'unresolved','smbc-bank','synthetic reason','fixture',?,'[]','2099')`)
    .bind(CONNECTION, detail.artifacts[0]!.id)
    .run();
  direct = await mfObservation("evidence-test");
  mirrored = await mfObservation("label-test");
  // The second producer's reference is moved onto the first one's account by
  // a later rule revision, as production's `identity-value-rewrite` did; the
  // connection review names only the first producer.
  await env.DB.prepare(
    `INSERT INTO account_mappings VALUES ('am-rewrite',?,2,?,'rule','identity-value-rewrite',1,'2099','MoneyForward連携口座','provider-local')`,
  )
    .bind(mirrored.reference, direct.account)
    .run();
});

describe("aggregator connection labels", () => {
  it("name every reference of the account, not only the one the review covers", async () => {
    const organizations = await observationOrganizations(sql(), [
      { kind: "transaction", id: direct.id },
      { kind: "transaction", id: mirrored.id },
    ]);
    const label = `${CONNECTION}（個別口座未確定）`;
    expect(organizations.get(`transaction:${direct.id}`)!.account).toMatchObject({
      label,
      connection: { status: "unresolved" },
    });
    const other = organizations.get(`transaction:${mirrored.id}`)!.account!;
    expect(other).toMatchObject({ label, targetId: direct.account });
    // The connection itself is not claimed for a reference its review does not name.
    expect(other.connection).toBeUndefined();
    const options = await organizedFilterOptions(sql(), "transactions", {
      sources: ["moneyforward-me"],
      instruments: [],
      metrics: [],
      accounts: [{ source_id: "moneyforward-me", source_account: MF_ACCOUNT }],
    });
    expect(options.accounts[0]).toMatchObject({ display_name: label });
  });

  it("show the same label on the per-reference page and one line on the account list", async () => {
    const query = { source: "moneyforward-me", offset: 0, mode: "latest" as const };
    const accounts = await readIdentityPage(sql(), "accounts", query);
    expect(validIdentityResponse("/api/identity/accounts", accounts)).toBe(true);
    const label = `${CONNECTION}（個別口座未確定）`;
    expect((accounts.rows as { label: string }[]).map((row) => row.label)).toEqual([label, label]);
    const list = await readIdentityPage(sql(), "account-list", query);
    expect(validIdentityResponse("/api/identity/account-list", list)).toBe(true);
    expect(list.rows).toEqual([
      {
        account: direct.account,
        label,
        labelOrigin: "connection",
        role: expect.any(String),
        status: expect.any(String),
        sources: ["moneyforward-me"],
        references: 2,
        observedCount: 2,
        connection: "unresolved",
        lastFetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      },
    ]);
    expect(list.coverage).toEqual({ limit: 100, truncated: false, nextOffset: null });
  });

  it("never relabel the owner's manual mapping", () => {
    const entity = { label: "entity", origin: "connection" as const };
    expect(displayAccountLabel("owner", "manual", entity)).toBe("owner");
    expect(displayAccountLabel("rule", "rule", entity)).toBe("entity");
    expect(displayAccountLabel("rule", "rule", undefined)).toBe("rule");
  });
});

describe("Vpass card names", () => {
  /**
   * A Vpass reference with one sealed credit capture per entry, each parsed by
   * `vpass-credit-snapshot` with these extras, in capture order. The reference
   * is a per-run snapshot key: a `vpass:card` token key needs the collector's
   * card binding chain, which the label read never consults (it reads the
   * reference's sealed identity observations whatever their key).
   */
  async function card(
    key: string,
    captures: { names: (string | null)[]; card?: string }[],
    reparseFirst = false,
  ) {
    await env.DB.prepare(
      `INSERT INTO accounts VALUES (?,'Vpassカード明細','card-statement','provider-local')`,
    )
      .bind(`account-${key}`)
      .run();
    let reference: string | null = null;
    let index = 0;
    const capture = async (entry: (typeof captures)[number], version: string) => {
      const run = await seedRun({ source: "vpass", count: 1 });
      const parseRunId = await parse(run.artifacts[0]!.id, "vpass-credit-snapshot", version);
      return { run, parseRunId, entry };
    };
    const runs = [];
    for (const entry of captures) runs.push(await capture(entry, "1.1.0"));
    // A re-parse of the oldest capture made after the newest: a higher
    // observation id, the same (older) artifact.
    if (reparseFirst) {
      const first = runs[0]!;
      const parseRunId = await parse(first.run.artifacts[0]!.id, "vpass-credit-snapshot", "1.1.1");
      runs.push({ ...first, parseRunId });
    }
    for (const { run, parseRunId, entry } of runs) {
      if (reference === null) {
        reference = `sa-${key}`;
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO source_accounts VALUES (?,'vpass','evidence-test',?)`).bind(
            reference,
            JSON.stringify(["vpass:card-001", "fetch-run", key]),
          ),
          env.DB.prepare(
            `INSERT INTO account_mappings VALUES (?,?,1,?,'rule','card-ordinal-needs-durable-provider-binding',1,'2099','Vpassカード明細','provider-local')`,
          ).bind(`am-${key}`, reference, `account-${key}`),
        ]);
      }
      const identityRun = `ir-${key}-${index++}`;
      await env.DB.prepare(`INSERT INTO identity_runs VALUES (?,?,1,'2099')`)
        .bind(identityRun, parseRunId)
        .run();
      for (const name of entry.names) {
        const extra = {
          _kogane: { nonAdditive: true, ...(name === null ? {} : { cardName: name }) },
        };
        const observation = await env.DB.prepare(
          `INSERT INTO balance_observations (parse_run_id,source_account,metric,instrument,amount_minor,raw_locator,extra_json)
           VALUES (?,?,'reported_card_limit_thousand_yen','JPY',1000,'json:$',?) RETURNING id`,
        )
          .bind(parseRunId, `vpass:${entry.card ?? "card-001"}`, JSON.stringify(extra))
          .first<{ id: number }>();
        await env.DB.prepare(`INSERT INTO identity_observations VALUES (?,?,'balance',?,?,?,'[]')`)
          .bind(
            `io-${identityRun}-${observation!.id}`,
            identityRun,
            observation!.id,
            reference,
            `am-${key}`,
          )
          .run();
      }
      await env.DB.prepare(`INSERT INTO identity_run_seals VALUES (?,?,'2099')`)
        .bind(identityRun, entry.names.length)
        .run();
    }
    return `account-${key}`;
  }

  it("names the card from its newest capture, with the collector's card ordinal", async () => {
    const account = await card("newest", [
      { names: ["Old synthetic card"], card: "card-002" },
      { names: ["Synthetic card", "Synthetic card"], card: "card-003" },
    ]);
    expect((await entityAccountLabels(sql(), [account])).get(account)).toEqual({
      label: "Synthetic card（card-003）",
      origin: "card-name",
    });
  });

  it("orders captures by artifact, so a later re-parse of an old capture does not win", async () => {
    const account = await card(
      "reparse",
      [{ names: ["Old synthetic card"] }, { names: ["New synthetic card"] }],
      true,
    );
    expect((await entityAccountLabels(sql(), [account])).get(account)?.label).toBe(
      "New synthetic card（card-001）",
    );
  });

  it("gives no name when the newest capture has none, two, or one that could be a number", async () => {
    for (const [key, names] of [
      ["unnamed", [null]],
      ["two-names", ["Synthetic card A", "Synthetic card B"]],
      ["digits", ["Synthetic 1234"]],
    ] as const) {
      const account = await card(key, [{ names: ["Older synthetic card"] }, { names: [...names] }]);
      expect((await entityAccountLabels(sql(), [account])).has(account), key).toBe(false);
    }
  });
});
