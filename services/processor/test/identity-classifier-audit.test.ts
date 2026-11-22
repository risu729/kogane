// The classifier audit (`scripts/audit-identities.ts`) resolves each published
// parse the way the identity projection does: under the policy the parse's
// module selects, with the trusted Vpass binding, so its counts equal what
// `identifyParse` stores. Before, it resolved every row under the newest rules
// and without the binding, and reported every bound Vpass card row as an
// unresolved card ordinal.
//
// Everything is synthetic: the card, token, rows and amounts are placeholders
// in the observed shapes, on the real CORE schema in Miniflare.
import { afterEach, expect, test } from "bun:test";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { auditIdentityClassification } from "../src/identity-classifier-audit.ts";
import { identifyParse } from "../src/identity-store.ts";
import { disposeWorlds, PRODUCER, TOKEN_A, world, type World } from "./card-purchase-world.ts";
import { publishParse, seedArtifact } from "./harness.ts";

afterEach(disposeWorlds);

const FETCHED_AT = "2026-06-10T00:00:00.000Z";
const ROW = { date: "26/06/03", merchant: "架空店舗A", amount: "1,234", paymentType: "1" };

/** One published, identified parse of one transaction row, seeded without a parser. */
async function capture(
  w: World,
  id: number,
  source: string,
  dataset: string,
  row: { sourceAccount: string; currency: string; extra: Record<string, unknown> },
): Promise<void> {
  await seedArtifact(w.env, id, source, dataset, `${dataset}/synthetic.json`, { synthetic: id });
  await w.db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1','2026-09-01','pending','[]')",
    )
    .bind(id, id, `synthetic-${dataset}`)
    .run();
  await w.db
    .prepare(
      `INSERT INTO transaction_observations(parse_run_id,source_account,status,amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json)
       VALUES(?,?,'posted',100,'1.00',2,?,'2026-06-01','json:$.items[0]',?)`,
    )
    .bind(id, row.sourceAccount, row.currency, JSON.stringify(row.extra))
    .run();
  await w.db.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(id).run();
  await publishParse(w.db, id);
  await identifyParse(
    w.db,
    { id, artifact_id: id, source_id: source, producer_id: PRODUCER, fetch_run_id: id },
    resolveIdentity,
  );
}

type Counts = Record<string, number>;
function add(counts: Record<string, Counts>, source: string, key: string): void {
  const bucket = (counts[source] ??= {});
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/** What the projection stored, per source, in the audit's count shapes. */
async function stored(w: World) {
  const accountStatus: Record<string, Counts> = {};
  const issues: Record<string, Counts> = {};
  const policyReleases: Record<string, Counts> = {};
  for (const row of await w.all<{ source_id: string; status: string; issues_json: string }>(
    `SELECT a.source_id,m.status,o.issues_json FROM identity_observations o
     JOIN identity_runs r ON r.id=o.identity_run_id JOIN parse_runs p ON p.id=r.parse_run_id
     JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN account_mappings m ON m.id=o.account_mapping_id`,
  )) {
    add(accountStatus, row.source_id, row.status);
    for (const issue of JSON.parse(row.issues_json) as string[]) add(issues, row.source_id, issue);
  }
  for (const row of await w.all<{ source_id: string; release: string }>(
    `SELECT a.source_id,rp.policy_release release FROM identity_run_policies rp
     JOIN parse_runs p ON p.id=rp.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id`,
  ))
    add(policyReleases, row.source_id, row.release);
  return { accountStatus, issues, policyReleases };
}

test("the audit resolves each parse under its own policy and binding, as the projection stored it", async () => {
  const w = await world();
  // A card ordinal bound to a durable token by the trusted sidecar: policy 2.
  const bound = await w.vpass({ family: "web", fetchedAt: FETCHED_AT, rows: [ROW] });
  // The same ordinal of another run without a binding: baseline policy 1.
  const unbound = await w.vpass({
    family: "web",
    fetchedAt: FETCHED_AT,
    rows: [ROW],
    card: "card-002",
    token: null,
  });
  // SBI Securities' foreign cash history is not a discriminated foreign
  // capture, so it stays at base policy 1 while the newest SBI policy is 3.
  await capture(w, 11, "sbi-securities", "foreign-cash-history", {
    sourceAccount: "sbi-securities:foreign",
    currency: "USD",
    extra: {
      tradeType: "入金",
      description: "synthetic",
      cashType: "synthetic",
      _kogane: {
        direction: "credit",
        transactionType: "deposit",
        identityOrigin: "row-occurrence",
      },
    },
  });
  // A source with no policy module of its own.
  await capture(w, 12, "sony-bank", "synthetic-deposit-history", {
    sourceAccount: "sony-bank:deposit:JPY",
    currency: "JPY",
    extra: {},
  });

  const progress: string[] = [];
  const audit = await auditIdentityClassification(w.db, (kind) => progress.push(kind));
  expect(progress).toEqual(["transaction", "balance", "position", "valuation"]);
  expect(audit.policy).toBe("per-parse-required");
  const source = (id: string) => audit.sources.find((summary) => summary.source === id)!;

  const vpass = source("vpass");
  expect(vpass.observations).toBe(bound.observations.length + unbound.observations.length);
  expect(vpass.accountStatus).toEqual({
    "provider-local": bound.observations.length,
    unresolved: unbound.observations.length,
  });
  expect(vpass.issues).toEqual({
    "card-ordinal-needs-durable-provider-binding": unbound.observations.length,
  });
  expect(vpass.policyReleases).toEqual({ "vpass-card-binding-v2": 1, "identity-default-v1": 1 });
  expect(vpass.policyFallbacks).toEqual({ "vpass-card-binding:binding-missing": 1 });
  // One token-bound account and one run-scoped ordinal account.
  expect(vpass.canonicalKeys).toBe(2);
  expect(vpass.resolverErrors).toBe(0);

  const sbi = source("sbi-securities");
  expect(sbi.policyReleases).toEqual({ "identity-default-v1": 1 });
  expect(sbi.policyFallbacks).toEqual({
    "identity-default:not-a-discriminated-foreign-capture": 1,
  });
  expect(sbi.accountStatus).toEqual({ unresolved: 1 });
  // The cash history states no discriminator, trade currency or security by schema.
  expect(sbi.issues).toEqual({
    "missing-specificAccountCode": 1,
    "missing-trade-currency": 1,
    "missing-security-identifier": 1,
  });

  const sony = source("sony-bank");
  expect(sony.policyReleases).toEqual({ "identity-default-v1": 1 });
  expect(sony.policyFallbacks).toEqual({});
  expect(sony.accountStatus).toEqual({ "provider-local": 1 });

  // Parity with the projection, source by source.
  const projection = await stored(w);
  for (const summary of audit.sources) {
    expect(summary.accountStatus).toEqual(projection.accountStatus[summary.source] ?? {});
    expect(summary.issues).toEqual(projection.issues[summary.source] ?? {});
    expect(summary.policyReleases).toEqual(projection.policyReleases[summary.source] ?? {});
  }

  // Counts and closed codes only: no token, card ordinal, account reference or row text.
  const text = JSON.stringify(audit);
  for (const secret of [TOKEN_A.slice(-64), "vpass-card-v", "card-00", "架空", "sony-bank:deposit"])
    expect(text).not.toContain(secret);
}, 90_000);
