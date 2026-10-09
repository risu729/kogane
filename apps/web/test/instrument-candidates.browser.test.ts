// 銘柄の同一性の候補 in the production client against a server whose answers
// the application service itself produces from the synthetic resolution world
// (packages/application/test/instrument-resolution-world.ts). A decision is a
// plan of the payload the server named, sent to the change lifecycle; the
// page never builds one of its own and never approves.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import {
  reviewInstrumentCandidates,
  type InstrumentCandidateView,
  type ReviewCandidate,
} from "../../../packages/application/src/query/instrument-candidates-review.ts";
import {
  decide,
  ids,
  OPERATOR,
  world,
  type World,
} from "../../../packages/application/test/instrument-resolution-world.ts";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";

const client = join(import.meta.dir, "../dist-production");
const executablePath = process.env["CHROMIUM_PATH"] ?? chromium.executablePath();
const runnable = existsSync(join(client, "index.html")) && existsSync(executablePath);
if (!runnable && (!existsSync(join(client, "index.html")) || process.env["CI"] === "true"))
  process.exitCode = 1;
const PLAN = "e".repeat(64);
const GRANT = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
} as const;

describe.if(runnable)("instrument candidate review", () => {
  let browser: Browser;
  let server: ReturnType<typeof Bun.serve>;
  let origin: string;
  let store: World;
  let commands = true;
  let stale = false;
  const posted: { operation: string; body: Record<string, any> }[] = [];
  const read: URL[] = [];

  async function page(view: InstrumentCandidateView, offset: number) {
    const outcome = await reviewInstrumentCandidates({
      grant: GRANT,
      sql: store.sql,
      request: { view, offset, identifierId: null },
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    return outcome.review;
  }

  beforeEach(() => {
    commands = true;
    stale = false;
    posted.length = 0;
    read.length = 0;
  });
  beforeAll(async () => {
    store = await world();
    // One decided pair so the decided view has something to show.
    const id = ids(store);
    const open = await page("open", 0);
    const ric = (open.items as ReviewCandidate[]).find(
      (item) => item.anchorIdentifierId === id.ric,
    )!;
    await decide(
      store,
      OPERATOR,
      "relation.reject",
      { ...ric.commands!.keepApart.payload, reason: "synthetic: two listings" },
      "op-synthetic",
    );
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/meta")
          return Response.json({
            apiVersion: 1,
            source: { kind: "central-store", classification: "financial" },
            capabilities: { ...CENTRAL_STORE_CAPABILITIES, commands },
          });
        if (url.pathname === "/api/identity/instrument-candidates") {
          read.push(url);
          return Response.json(
            await page(
              (url.searchParams.get("view") ?? "open") as InstrumentCandidateView,
              Number(url.searchParams.get("offset") ?? "0"),
            ),
          );
        }
        if (url.pathname.startsWith("/api/command/v1/")) {
          const operation = url.pathname.split("/").at(-1)!;
          const body = (await request.json()) as Record<string, any>;
          posted.push({ operation, body });
          const kind = operation === "plan" ? body["kind"] : "identity.assign";
          const subject = posted.find((entry) => entry.operation === "plan")?.body["payload"]
            .referenceId as string | undefined;
          const revisions = subject
            ? { [`instrument_mapping:${subject}`]: stale ? 2 : 1 }
            : ({} as Record<string, number>);
          const simulation = {
            kind,
            targets: Object.keys(revisions).map((subjectRef) => ({
              subjectRef,
              currentRevision: 1,
              currentTargetRef: "instrument:synthetic-current",
              proposedTargetRef: "instrument:synthetic-anchor",
            })),
            before: { attributedObservations: 1, relations: 0 },
            after: { attributedObservations: 1, relations: 0 },
            invalidations: [],
            affectedScopes: ["sbi-securities"],
            affectedParseRuns: 1,
            outboxTargets: ["identity-projection"],
          };
          const plan = {
            planId: PLAN,
            planDigest: PLAN,
            kind,
            baseContextId: "synthetic",
            expectedRevisions: revisions,
            simulation,
            createdBy: "synthetic-reader",
            createdAt: "2099-01-01",
            expiresAt: "2099-01-02",
            status: "planned",
          };
          if (operation === "plan") return Response.json({ plan });
          return Response.json({
            report: { ...plan, currentRevisions: revisions, stale: false, resimulatedPlanId: PLAN },
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

  async function open(width = 1280) {
    const tab = await browser.newPage({ viewport: { width, height: 1000 } });
    await tab.goto(`${origin}/identities/instrument-candidates`);
    await tab.getByRole("heading", { name: "銘柄の同一性の候補", exact: true }).waitFor();
    await tab.locator(".identity-card").first().waitFor();
    return tab;
  }

  test("lists open candidates with the codes they rest on and plans nothing on its own", async () => {
    const tab = await open();
    const expected = await page("open", 0);
    expect(await tab.locator(".identity-card").count()).toBe(expected.items.length);
    const text = await tab.locator("main").innerText();
    expect(text).toContain("国と銘柄コードが一致");
    expect(text).toContain("市場を確認できない");
    expect(text).toContain("確認待ち");
    // Every request is a GET of the read: nothing was planned by opening the page.
    expect(posted).toEqual([]);
    expect(read.every((url) => url.searchParams.get("view") === "open")).toBe(true);
    await tab.close();
  });

  test("adopting plans exactly the payload the server named, with the reason, and opens the confirmation", async () => {
    const tab = await open();
    const expected = await page("open", 0);
    const id = ids(store);
    const candidate = (expected.items as ReviewCandidate[]).find(
      (item) => item.subjectIdentifierId === id.broker9001,
    )!;
    const card = tab.locator(".identity-card").nth(expected.items.indexOf(candidate));
    const adopt = card.getByRole("button", {
      name: "同じ銘柄として採用する内容を確認",
      exact: true,
    });
    expect(await adopt.isDisabled()).toBe(true);
    await card.getByLabel("判断の理由", { exact: true }).fill("synthetic: same code and country");
    await adopt.click();
    await tab.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(posted[0]).toEqual({
      operation: "plan",
      body: {
        kind: "identity.assign",
        payload: {
          ...candidate.commands!.adopt!.payload,
          reason: "synthetic: same code and country",
        },
        baseContextId: candidate.candidateId,
      },
    });
    expect(posted.some((entry) => ["approve", "commit"].includes(entry.operation))).toBe(false);
    await tab.close();
  });

  test("a plan pinned to another mapping revision than the one shown is not offered", async () => {
    stale = true;
    const tab = await open();
    const card = tab.locator(".identity-card").first();
    await card.getByLabel("判断の理由", { exact: true }).fill("synthetic");
    await card
      .getByRole("button", { name: "同じ銘柄として採用する内容を確認", exact: true })
      .click();
    await card.getByRole("alert").filter({ hasText: "候補が更新されています" }).waitFor();
    expect(tab.url()).toContain("/identities/instrument-candidates");
    await tab.close();
  });

  test("keeping apart plans the named rejection; decided and separated views say why", async () => {
    const tab = await open();
    const expected = await page("open", 0);
    const first = expected.items[0] as ReviewCandidate;
    const card = tab.locator(".identity-card").first();
    await card.getByLabel("判断の理由", { exact: true }).fill("synthetic: different products");
    await card.getByRole("button", { name: "別の銘柄として扱う内容を確認", exact: true }).click();
    await tab.getByRole("heading", { name: "変更の確認", exact: true }).waitFor();
    expect(posted[0]!.body).toEqual({
      kind: "relation.reject",
      payload: { ...first.commands!.keepApart.payload, reason: "synthetic: different products" },
      baseContextId: first.candidateId,
    });
    await tab.goto(`${origin}/identities/instrument-candidates`);
    await tab.getByRole("button", { name: "判断済み", exact: true }).click();
    await tab.getByText("別の銘柄と判断済み").first().waitFor();
    expect(await tab.getByRole("button", { name: /内容を確認$/u }).count()).toBe(0);
    await tab.getByRole("button", { name: "別の銘柄", exact: true }).click();
    await tab.getByText("市場（MIC）が異なる").first().waitFor();
    await tab.getByRole("button", { name: "名称のみ一致", exact: true }).click();
    await tab.getByText("名称が同じことは同じ銘柄の根拠になりません。").waitFor();
    await tab.close();
  });

  test("without the change lifecycle the actions stay disabled, and a phone width does not scroll sideways", async () => {
    commands = false;
    const tab = await open(390);
    const card = tab.locator(".identity-card").first();
    expect(
      await card
        .getByRole("button", { name: "同じ銘柄として採用する内容を確認", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(await card.getByLabel("判断の理由", { exact: true }).isDisabled()).toBe(true);
    expect(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    expect(posted).toEqual([]);
    await tab.close();
  });
});
