// Identity read modes end to end (review D06, AT63): a correction changes
// what `latest` shows and never what `as-recorded` shows; every organized
// response says which interpretation it was computed under; the `latest`
// read equals the query the browser ran before read modes existed.
import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { identityApi } from "../src/identity-api";
import { observationApi } from "../src/observation-api";
import { observationOrganizations, ORGANIZATION_QUERY } from "../src/observation-organization";
import { validInterpretationContext } from "../../../packages/observation-shared/src/api-schema";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { validIdentityResponse } from "../../../packages/observation-shared/src/identity-contract";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

beforeAll(seedRegistry);

/** The organization query as it was before read modes, frozen for the comparison. */
const LEGACY_ORGANIZATION_QUERY = ORGANIZATION_QUERY.replace(
  " ctx.policy_release identity_release,\n",
  "",
).replace("\nJOIN identity_run_contexts ctx ON ctx.identity_run_id=o.identity_run_id", "");

async function call(path: string) {
  const request = new Request(`https://fixture.test${path}`);
  const url = new URL(request.url);
  const response =
    (await identityApi(request, env, url)) ?? (await observationApi(request, env, url));
  return response!;
}
async function body(path: string) {
  const response = await call(path);
  expect(response.status, path).toBe(200);
  return (await response.json()) as Record<string, any>;
}

/** One organized transaction with rule mappings at revision 1 for account and unit. */
async function seed(tag: string) {
  const run = await seedRun({ count: 1, source: "other-test" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'read-mode-fixture','1','2099','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  // Adoption is what makes a successful run current (docs/publication-gate.md).
  await publishParse(parse!.id);
  const account = `${tag}-account`;
  const observation = await env.DB.prepare(
    `INSERT INTO transaction_observations (parse_run_id,source_account,currency,raw_locator,extra_json) VALUES (?,?,'JPY','synthetic','{}') RETURNING id`,
  )
    .bind(parse!.id, account)
    .first<{ id: number }>();
  const id = (name: string) => `${tag}-${name}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO source_accounts VALUES (?,'other-test','evidence-test',?)`).bind(
      id("ref"),
      JSON.stringify([account]),
    ),
    env.DB.prepare(
      `INSERT INTO accounts VALUES (?,'規則口座','cash','provider-local'),(?,'手動口座','cash','identified')`,
    ).bind(id("rule-account"), id("manual-account")),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES (?,?,1,?,'rule','provider-scope',1,'2099','規則口座','provider-local')`,
    ).bind(id("am1"), id("ref"), id("rule-account")),
    env.DB.prepare(
      `INSERT INTO instruments VALUES (?,'money','JPY','identified'),(?,'money','手動通貨','identified')`,
    ).bind(id("rule-instrument"), id("manual-instrument")),
    env.DB.prepare(`INSERT INTO instrument_identifiers VALUES (?,'iso4217',?,'JPY','{}')`).bind(
      id("ident"),
      tag,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_mappings VALUES (?,?,1,?,'rule','iso',1,'2099','JPY','identified')`,
    ).bind(id("im1"), id("ident"), id("rule-instrument")),
    env.DB.prepare(`INSERT INTO identity_runs VALUES (?,?,1,'2099')`).bind(id("run"), parse!.id),
    env.DB.prepare(`INSERT INTO identity_observations VALUES (?,?,'transaction',?,?,?,'[]')`).bind(
      id("io"),
      id("run"),
      observation!.id,
      id("ref"),
      id("am1"),
    ),
    env.DB.prepare(`INSERT INTO identity_instrument_uses VALUES (?,'unit',?,?)`).bind(
      id("io"),
      id("ident"),
      id("im1"),
    ),
    env.DB.prepare(`INSERT INTO identity_run_seals VALUES (?,1,'2099')`).bind(id("run")),
  ]);
  const correct = () =>
    env.DB.batch([
      env.DB.prepare(
        `INSERT INTO account_mappings VALUES (?,?,2,?,'manual','reviewed',2,'2100','手動口座','identified')`,
      ).bind(id("am2"), id("ref"), id("manual-account")),
      env.DB.prepare(
        `INSERT INTO instrument_mappings VALUES (?,?,2,?,'manual','reviewed',2,'2100','手動通貨','identified')`,
      ).bind(id("im2"), id("ident"), id("manual-instrument")),
    ]);
  return { account, observationId: observation!.id, ref: id("ref"), correct };
}

it("a correction changes latest and never as-recorded, and each response names its interpretation (AT63)", async () => {
  const fixture = await seed("at63");
  const list = (mode: string) =>
    body(`/api/transactions?source=other-test&account=${fixture.account}&identityRead=${mode}`);
  for (const mode of ["latest", "as-recorded"]) {
    const page = await list(mode);
    expect(validApiResponse("/api/transactions", page)).toBe(true);
    expect(page.transactions).toHaveLength(1);
    expect(page.transactions[0].organization).toMatchObject({
      state: "organized",
      account: { targetId: "at63-rule-account", revision: 1, method: "rule" },
      instruments: [{ targetId: "at63-rule-instrument", revision: 1 }],
      mappingRevision: 1,
      identityRelease: "identity-default-v1",
    });
    expect(validInterpretationContext(page.interpretationContext)).toBe(true);
    expect(page.interpretationContext).toMatchObject({
      mode,
      snapshotId: null,
      identityRelease: mode === "latest" ? "current-mappings-v1" : "identity-default-v1",
      measurePolicyRelease: "metric-registry-v1",
      decimalPolicyRelease: "decimal-v1",
    });
  }
  const recordedBefore = await list("as-recorded");
  await fixture.correct();
  const latest = await list("latest");
  expect(latest.transactions[0].organization).toMatchObject({
    account: { targetId: "at63-manual-account", revision: 2, method: "manual", label: "手動口座" },
    instruments: [{ targetId: "at63-manual-instrument", revision: 2 }],
    mappingRevision: 2,
  });
  const recordedAfter = await list("as-recorded");
  // Pinned attribution is unchanged. The preferred instrument name is a
  // display-only overlay that stays current in both modes and says so.
  const attribution = (page: Record<string, any>) => {
    const { instruments, ...organization } = page.transactions[0].organization;
    return {
      ...page,
      transactions: [
        {
          ...page.transactions[0],
          organization: {
            ...organization,
            instruments: instruments.map(
              ({ label: _label, nameEvidence: _nameEvidence, ...instrument }: any) => instrument,
            ),
          },
        },
      ],
    };
  };
  expect(attribution(recordedAfter)).toEqual(attribution(recordedBefore));
  expect(recordedAfter.transactions[0].organization).toMatchObject({
    account: { targetId: "at63-rule-account", revision: 1, method: "rule", label: "規則口座" },
    instruments: [
      {
        targetId: "at63-rule-instrument",
        revision: 1,
        method: "rule",
        label: "手動通貨",
        nameEvidence: { reason: "manual", origin: null },
      },
    ],
    mappingRevision: 1,
  });
  expect(recordedAfter.interpretationContext).toEqual(recordedBefore.interpretationContext);
  // Omitting the parameter is `latest`; detail routes read `latest` and say so.
  const implicit = await list("latest");
  const defaulted = await body(`/api/transactions?source=other-test&account=${fixture.account}`);
  expect(defaulted).toEqual(implicit);
  const detail = await body(`/api/observations/transaction/${fixture.observationId}`);
  expect(validApiResponse(`/api/observations/transaction/${fixture.observationId}`, detail)).toBe(
    true,
  );
  expect(detail.organization.mappingRevision).toBe(2);
  expect(detail.interpretationContext).toMatchObject({ mode: "latest" });
});

it("the latest read equals the query the browser ran before read modes, on the same fixture", async () => {
  const fixture = await seed("parity");
  await fixture.correct();
  const refs = JSON.stringify([{ kind: "transaction", id: fixture.observationId }]);
  const legacy = await env.DB.prepare(LEGACY_ORGANIZATION_QUERY).bind(refs).all();
  const current = await env.DB.prepare(ORGANIZATION_QUERY).bind(refs).all();
  expect(legacy.results).toHaveLength(1);
  expect(current.results.map(({ identity_release: _identityRelease, ...row }) => row)).toEqual(
    legacy.results,
  );
  expect(current.results[0]!.identity_release).toBe("identity-default-v1");
  const organized = await observationOrganizations(env.DB, [
    { kind: "transaction", id: fixture.observationId },
  ]);
  const { mappingRevision, identityRelease, ...rest } = organized.get(
    `transaction:${fixture.observationId}`,
  )!;
  expect(mappingRevision).toBe(2);
  expect(identityRelease).toBe("identity-default-v1");
  expect(rest).toMatchObject({ state: "organized", account: { revision: 2 } });
});

it("the identity catalogue and coverage follow the read mode", async () => {
  const fixture = await seed("catalogue");
  await fixture.correct();
  for (const collection of ["accounts", "instruments", "coverage"]) {
    for (const mode of ["latest", "as-recorded"]) {
      const path = `/api/identity/${collection}?source=other-test&identityRead=${mode}`;
      const page = await body(path);
      expect(validIdentityResponse(`/api/identity/${collection}`, page), path).toBe(true);
      expect(validInterpretationContext(page.interpretationContext), path).toBe(true);
      expect(page.interpretationContext.mode).toBe(mode);
      const row = page.rows.find(
        (r: Record<string, unknown>) =>
          r.referenceId === fixture.ref ||
          r.referenceId === "catalogue-ident" ||
          collection === "coverage",
      );
      expect(row, path).toBeDefined();
      if (collection === "coverage")
        expect(row, path).toMatchObject(
          mode === "latest"
            ? { identified: expect.any(Number), providerLocal: expect.any(Number) }
            : { providerLocal: expect.any(Number) },
        );
      else
        expect(row, path).toMatchObject(
          mode === "latest"
            ? { revision: 2, status: "identified" }
            : { revision: 1, status: collection === "accounts" ? "provider-local" : "identified" },
        );
    }
  }
  const recorded = await body("/api/identity/coverage?source=other-test&identityRead=as-recorded");
  const latest = await body("/api/identity/coverage?source=other-test&identityRead=latest");
  // Every fixture in this file was corrected: pinned rule mappings are
  // provider-local, the manual corrections are identified, the denominator is shared.
  expect(recorded.rows[0].organized).toBe(latest.rows[0].organized);
  expect(recorded.rows[0]).toMatchObject({
    identified: 0,
    providerLocal: latest.rows[0].identified,
  });
  expect(latest.rows[0]).toMatchObject({
    providerLocal: 0,
    identified: recorded.rows[0].organized,
  });
  expect(recorded.interpretationContext.identityRelease).toBe("identity-default-v1");
});

it("snapshot is refused as unsupported semantics and unknown modes as invalid queries", async () => {
  for (const path of [
    "/api/transactions",
    "/api/balances",
    "/api/positions",
    "/api/identity/accounts",
    "/api/identity/coverage",
  ]) {
    await expect(call(`${path}?identityRead=snapshot`), path).rejects.toMatchObject({
      status: 400,
      code: "unsupported_semantics",
    });
    for (const value of ["bogus", "LATEST", "", "latest&identityRead=latest"])
      await expect(call(`${path}?identityRead=${value}`), `${path} ${value}`).rejects.toMatchObject(
        {
          status: 400,
        },
      );
  }
  await expect(call("/api/artifacts?identityRead=latest")).rejects.toMatchObject({
    status: 400,
    code: "invalid_query",
  });
  await expect(call("/api/observations/transaction/1?identityRead=latest")).rejects.toMatchObject({
    status: 400,
  });
});
