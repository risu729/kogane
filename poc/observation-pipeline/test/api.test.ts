import { describe, expect, test } from "bun:test";
import { createApi } from "../src/api.ts";
import { formatAmount, amountSign } from "../src/money.ts";
import {
  buildFixture,
  HOSTILE_DESCRIPTION,
  RETIRED_DESCRIPTION,
  type Fixture,
} from "./fixture.ts";

const fixture: Fixture = buildFixture();
const app = createApi(fixture.store);

async function get(path: string): Promise<Response> {
  return await app.fetch(new Request(`http://api.test${path}`));
}

async function json(path: string): Promise<any> {
  const response = await get(path);
  expect(response.status).toBe(200);
  return await response.json();
}

describe("amount formatting", () => {
  test("formats minor units without floating point", () => {
    expect(formatAmount(-1180, "JPY")).toBe("-1,180 JPY");
    expect(formatAmount(102453, "USD")).toBe("1,024.53 USD");
    expect(formatAmount(1234567890, "JPY")).toBe("1,234,567,890 JPY");
    expect(formatAmount(5, "USD")).toBe("0.05 USD");
    expect(formatAmount(0, "USD")).toBe("0.00 USD");
    expect(formatAmount(-5, "USD")).toBe("-0.05 USD");
  });

  test("an amount beyond the safe integer range keeps every digit", () => {
    // The API serialises large amounts as strings; formatting must not route
    // them through a double.
    expect(formatAmount("9007199254740993", "JPY")).toBe("9,007,199,254,740,993 JPY");
    expect(formatAmount(9007199254740993n, "JPY")).toBe("9,007,199,254,740,993 JPY");
  });

  test("an unknown instrument is labelled, never given an invented scale", () => {
    expect(formatAmount(12345, "XYZ")).toBe("12,345 XYZ (minor units)");
    expect(formatAmount(12345, "ANA_MILE")).toBe("12,345 ANA_MILE (minor units)");
  });

  test("a null amount falls back to the stored text verbatim", () => {
    expect(formatAmount(null, "USD", "1568.400")).toBe("1568.400 USD");
    expect(formatAmount(null, "USD", null)).toBe("");
    expect(formatAmount(undefined, null, "")).toBe("");
  });

  test("a malformed amount is shown as stored rather than coerced", () => {
    expect(formatAmount("not-a-number", "JPY")).toBe("not-a-number JPY");
    expect(formatAmount(1.5, "JPY")).toBe("1.5 JPY");
  });

  test("amountSign never does arithmetic on a bad value", () => {
    expect(amountSign(-1)).toBe("negative");
    expect(amountSign(0)).toBe("zero");
    expect(amountSign(1)).toBe("positive");
    expect(amountSign(null)).toBe("unknown");
    expect(amountSign("nonsense")).toBe("unknown");
  });
});

describe("read-only enforcement", () => {
  test("every write method is refused before routing", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await app.fetch(
        new Request("http://api.test/api/overview", { method }),
      );
      expect(response.status).toBe(405);
    }
  });

  test("HEAD is allowed", async () => {
    const response = await app.fetch(
      new Request("http://api.test/api/overview", { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
  });
});

describe("overview", () => {
  test("reports row counts, sources, and both parse runs", async () => {
    const body = await json("/api/overview");
    const counts = Object.fromEntries(
      body.counts.map((entry: { table: string; rows: number }) => [entry.table, entry.rows]),
    );
    expect(counts["sources"]).toBe(1);
    expect(counts["transaction_observations"]).toBe(3); // 1 retired + 2 current
    expect(body.sources[0].id).toBe("demo-bank");
    expect(body.sources[0].artifact_count).toBe(1);
    expect(body.parseRuns).toHaveLength(2);
    const retired = body.parseRuns.find(
      (run: { parser_version: string }) => run.parser_version === "0.1.0",
    );
    const current = body.parseRuns.find(
      (run: { parser_version: string }) => run.parser_version === "0.2.0",
    );
    expect(retired.superseded_by_parse_run_id).toBe(current.id);
    expect(current.superseded_by_parse_run_id).toBeNull();
    expect(current.warnings).toHaveLength(1);
  });
});

describe("current views", () => {
  test("transactions exclude superseded parse runs", async () => {
    const body = await json("/api/transactions");
    const descriptions = body.transactions.map(
      (row: { description: string }) => row.description,
    );
    expect(descriptions).toContain(HOSTILE_DESCRIPTION);
    expect(descriptions).not.toContain(RETIRED_DESCRIPTION);
  });

  test("transactions carry the amount as stored, not as a formatted string", async () => {
    const body = await json("/api/transactions");
    const row = body.transactions.find((entry: { external_id: string }) => entry.external_id === "T-2");
    expect(row.amount_minor).toBe(102453);
    expect(row.currency).toBe("USD");
    expect(formatAmount(row.amount_minor, row.currency)).toBe("1,024.53 USD");
  });

  test("balances expose the latest per group and the full history", async () => {
    const body = await json("/api/balances");
    // Two observations of the same (source, account, metric, instrument);
    // only the later one is current.
    expect(body.latest).toHaveLength(1);
    expect(body.latest[0].as_of).toBe("2026-08-20");
    expect(body.latest[0].amount_minor).toBe(248820);
    expect(body.history.length).toBeGreaterThanOrEqual(2);
    expect(body.history[0].as_of).toBe("2026-08-20");
  });

  test("positions keep each valuation in its own currency", async () => {
    const body = await json("/api/positions");
    expect(body.positions).toHaveLength(1);
    const entry = body.positions[0];
    expect(entry.position.security_code).toBe("1234");
    expect(entry.position.quantity_text).toBe("10.5");
    const currencies = entry.valuations
      .map((valuation: { currency: string }) => valuation.currency)
      .sort();
    // A JPY figure and a USD figure are two separate claims by the source and
    // are never combined.
    expect(currencies).toEqual(["JPY", "USD"]);
  });
});

describe("artifacts", () => {
  test("the index counts observations per kind", async () => {
    const body = await json("/api/artifacts");
    expect(body.artifacts).toHaveLength(1);
    const artifact = body.artifacts[0];
    expect(artifact.source_id).toBe("demo-bank");
    expect(artifact.dataset).toBe("statement");
    expect(artifact.parse_run_count).toBe(2);
    expect(artifact.transaction_count).toBe(3);
    expect(artifact.position_count).toBe(1);
    expect(artifact.valuation_count).toBe(2);
  });

  test("detail exposes superseded parse runs and their observations", async () => {
    const body = await json(`/api/artifacts/${fixture.artifactId}`);
    expect(body.artifact.sha256).toBe(fixture.sha256);
    expect(body.parseRuns).toHaveLength(2);
    const retired = body.parseRuns.find(
      (run: { parser_version: string }) => run.parser_version === "0.1.0",
    );
    expect(retired.superseded_by_parse_run_id).not.toBeNull();
    // The retired observation is unreachable from current views but stays
    // reachable here, which is what makes a re-parse auditable.
    const summaries = retired.observations.map((o: { summary: string }) => o.summary);
    expect(summaries.join(" ")).toContain(RETIRED_DESCRIPTION);
  });
});

describe("observation detail and provenance", () => {
  test("walks observation to parse run to artifact to raw object to fetch run", async () => {
    const body = await json(`/api/observations/transaction/${fixture.retiredObservationId}`);
    expect(body.kind).toBe("transaction");
    expect(body.row.raw_locator).toBe("json:$.rows[0]");
    const provenance = body.provenance;
    expect(provenance.parser_name).toBe("demo-statement");
    expect(provenance.parser_version).toBe("0.1.0");
    expect(provenance.superseded_by_parse_run_id).not.toBeNull();
    expect(provenance.artifact_id).toBe(fixture.artifactId);
    expect(provenance.sha256).toBe(fixture.sha256);
    expect(provenance.tool).toBe("import-run");
    expect(provenance.external_run_id).toBe("run-20260820-210000-ui01");
  });

  test("extra is returned parsed, with the raw text alongside it", async () => {
    const body = await json("/api/observations/transaction/2");
    expect(body.extraParsed).toBe(true);
    expect(typeof body.extraRaw).toBe("string");
  });

  test("an unknown kind or id is a 404, never a 500", async () => {
    expect((await get("/api/observations/nonsense/1")).status).toBe(404);
    expect((await get("/api/observations/transaction/999999")).status).toBe(404);
    expect((await get("/api/artifacts/999999")).status).toBe(404);
  });

  test("a non-integer id is rejected rather than coerced", async () => {
    for (const id of ["1e3", "0x10", "1.5", "-1", "%201", "abc"]) {
      const response = await get(`/api/observations/transaction/${id}`);
      expect(response.status).toBe(404);
    }
  });
});

describe("raw evidence", () => {
  test("serves the exact stored bytes", async () => {
    const response = await get(`/api/raw/${fixture.sha256}`);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(digest).toBe(fixture.sha256);
  });

  test("is never served as an active document", async () => {
    const response = await get(`/api/raw/${fixture.sha256}`);
    // Captured evidence can be attacker-authored HTML; rendered inline in this
    // origin it could read the whole dataset.
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe("inline");
  });

  test("a malformed or unknown digest is a 404", async () => {
    expect((await get("/api/raw/not-a-digest")).status).toBe(404);
    expect((await get(`/api/raw/${"f".repeat(64)}`)).status).toBe(404);
    // uppercase is not the stored form
    expect((await get(`/api/raw/${fixture.sha256.toUpperCase()}`)).status).toBe(404);
  });
});

describe("routing", () => {
  test("an unknown api endpoint is a 404 json error", async () => {
    const response = await get("/api/nope");
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBeString();
  });

  test("without a client handler, a non-api path is a 404", async () => {
    expect((await get("/anything")).status).toBe(404);
  });

  test("a client handler receives non-api paths only", async () => {
    const served = createApi(fixture.store, {
      serveClient: () => new Response("CLIENT", { status: 200 }),
    });
    const page = await served.fetch(new Request("http://api.test/transactions"));
    expect(await page.text()).toBe("CLIENT");
    // the API still wins for /api paths
    const api = await served.fetch(new Request("http://api.test/api/nope"));
    expect(api.status).toBe(404);
    expect(await api.text()).toContain("no such endpoint");
  });
});
