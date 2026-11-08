// 口座の対応候補 in the production client against a server whose answers the
// application service itself produces from the synthetic account candidate
// world (packages/application/test/account-candidates-world.ts). A decision
// is a plan of the payload the server named, sent to the change lifecycle;
// the page never builds one of its own and never approves.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  reviewAccountCandidates,
  type AccountCandidate,
  type AccountCandidateView,
} from "../../../packages/application/src/query/account-candidates.ts";
import { world, type Store } from "../../../packages/application/test/account-candidates-world.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { auditView } from "./a11y-audit.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
const PLAN = "f".repeat(64);
const GRANT = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
} as const;

describe.if(runnable)("account candidate review", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let store: Store;
  const posted: { operation: string; body: Record<string, any> }[] = [];
  const read: URL[] = [];

  async function page(view: AccountCandidateView, offset: number, sourceAccountId: string | null) {
    const outcome = await reviewAccountCandidates({
      grant: GRANT,
      sql: store.sql,
      request: { view, offset, sourceAccountId },
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    return outcome.review;
  }

  beforeEach(() => {
    store = world();
    posted.length = 0;
    read.length = 0;
  });
  beforeAll(async () => {
    store = world();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, commands: true },
          });
        if (url.pathname === "/api/identity/account-candidates") {
          read.push(url);
          return Response.json(
            await page(
              (url.searchParams.get("view") ?? "open") as AccountCandidateView,
              Number(url.searchParams.get("offset") ?? "0"),
              url.searchParams.get("sourceAccountId"),
            ),
          );
        }
        if (url.pathname.startsWith("/api/command/v1/")) {
          const operation = url.pathname.split("/").at(-1)!;
          const body = (await request.json()) as Record<string, any>;
          posted.push({ operation, body });
          const plan = {
            planId: PLAN,
            planDigest: PLAN,
            kind: posted[0]!.body["kind"],
            baseContextId: "synthetic",
            expectedRevisions: { "relation:synthetic": 0 },
            simulation: {
              kind: posted[0]!.body["kind"],
              targets: [
                {
                  subjectRef: "relation:synthetic",
                  currentRevision: 0,
                  currentTargetRef: null,
                  proposedTargetRef: "accepted",
                },
              ],
              before: { attributedObservations: 0, relations: 0 },
              after: { attributedObservations: 0, relations: 1 },
              invalidations: ["read-model:relations"],
              affectedScopes: [],
              affectedParseRuns: 0,
              outboxTargets: ["identity-projection"],
            },
            createdBy: "synthetic-reader",
            createdAt: "2099-01-01",
            expiresAt: "2099-01-02",
            status: "planned",
          };
          if (operation === "plan") return Response.json({ plan });
          return Response.json({
            report: {
              ...plan,
              currentRevisions: plan.expectedRevisions,
              stale: false,
              resimulatedPlanId: PLAN,
            },
          });
        }
        if (url.pathname.startsWith("/api/"))
          return Response.json({ error: "not_found" }, { status: 404 });
        const file = Bun.file(join(client, url.pathname === "/" ? "/index.html" : url.pathname));
        return (await file.exists())
          ? new Response(file)
          : new Response(Bun.file(join(client, "index.html")));
      },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    server?.stop(true);
  });

  async function open() {
    const tab = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await tab.goto(`${origin}/identities/account-candidates`);
    await tab.getByRole("heading", { name: "口座の対応候補", exact: true }).waitFor();
    await tab.locator(".identity-card").first().waitFor();
    return tab;
  }

  test("lists the open candidate with its evidence and why no same account is proposed, planning nothing", async () => {
    const tab = await open();
    const expected = await page("open", 0, null);
    expect(await tab.locator(".identity-card").count()).toBe(expected.items.length);
    const text = await tab.locator("main").innerText();
    expect(text).toContain("Synthetic time deposit");
    expect(text).toContain("連携の確認記録");
    expect(text).toContain("aggregator-account-connection-scoped");
    expect(text).toContain("several-direct-accounts");
    expect(posted).toEqual([]);
    await tab.close();
  });

  test("accepting plans exactly the payload the server named, with the reason, and opens the confirmation", async () => {
    const tab = await open();
    const [candidate] = (await page("open", 0, null)).items as AccountCandidate[];
    const card = tab.locator(".identity-card").first();
    const accept = card.getByRole("button", {
      name: "この連携に含まれる口座として採用する内容を確認",
      exact: true,
    });
    expect(await accept.isDisabled()).toBe(true);
    await card.getByLabel("判断の理由", { exact: true }).fill("synthetic: reviewed connection");
    await accept.click();
    await tab.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(posted[0]).toEqual({
      operation: "plan",
      body: {
        kind: "relation.accept",
        payload: {
          ...candidate!.commands.accept!.payload,
          reason: "synthetic: reviewed connection",
        },
        baseContextId: candidate!.candidateId,
      },
    });
    expect(posted.some((entry) => ["approve", "commit"].includes(entry.operation))).toBe(false);
    await tab.close();
  });

  test("a held candidate offers keeping apart only", async () => {
    const tab = await open();
    await tab.getByRole("button", { name: "採用を保留", exact: true }).click();
    await tab
      .getByText("複数の連携の確認記録に含まれているため", { exact: false })
      .first()
      .waitFor();
    const card = tab.locator(".identity-card").first();
    expect(
      await card
        .getByRole("button", { name: "この連携に含まれる口座として採用する内容を確認" })
        .count(),
    ).toBe(0);
    expect(
      await card.getByRole("button", { name: "含まれないものとして扱う内容を確認" }).count(),
    ).toBe(1);
    expect(posted).toEqual([]);
    await tab.close();
  });

  test("a candidate that changed after the list was shown is read again and nothing is planned", async () => {
    const tab = await open();
    const [candidate] = (await page("open", 0, null)).items as AccountCandidate[];
    // After the page was shown, a decision recorded elsewhere rejects the pair.
    const decision = "dr-synthetic-elsewhere";
    store.db.run(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?,'relation','rel-synthetic-elsewhere',1,'reject','manual','synthetic',NULL,'synthetic','[]',NULL,NULL,'2099-01-03')`,
      [decision],
    );
    store.db.run(
      `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
       VALUES('rel-synthetic-elsewhere','connection_contains',?,?,NULL,NULL,'rejected',?,'[]','2099-01-03')`,
      [candidate!.connectionRef, `source_account:${candidate!.directSourceAccountId}`, decision],
    );
    const card = tab.locator(".identity-card").first();
    await card.getByLabel("判断の理由", { exact: true }).fill("synthetic");
    await card
      .getByRole("button", { name: "この連携に含まれる口座として採用する内容を確認", exact: true })
      .click();
    await card.getByRole("alert").filter({ hasText: "候補が更新されています" }).waitFor();
    expect(
      read.some(
        (url) => url.searchParams.get("sourceAccountId") === candidate!.directSourceAccountId,
      ),
    ).toBe(true);
    expect(posted).toEqual([]);
    await tab.close();
  });

  test("the open and held views and the confirmation pass the accessibility audit", async () => {
    const tab = await open();
    expect(await auditView(tab)).toEqual([]);
    await tab.getByRole("button", { name: "採用を保留", exact: true }).click();
    await tab
      .getByText("複数の連携の確認記録に含まれているため", { exact: false })
      .first()
      .waitFor();
    expect(await auditView(tab)).toEqual([]);
    await tab.close();
    const confirm = await open();
    const card = confirm.locator(".identity-card").first();
    await card.getByLabel("判断の理由", { exact: true }).fill("synthetic: reviewed connection");
    await card
      .getByRole("button", { name: "この連携に含まれる口座として採用する内容を確認", exact: true })
      .click();
    await confirm.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    await confirm.locator(".skeleton-bar").first().waitFor({ state: "detached" });
    expect(await auditView(confirm)).toEqual([]);
    await confirm.close();
  }, 60_000);
});
