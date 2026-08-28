import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseRun,
  openStore,
  putRawObject,
  supersedeOlderParseRuns,
  upsertSource,
  type Store,
} from "../src/store.ts";
import { createUiHandler, formatAmount } from "../src/ui.ts";

// Provider text is untrusted: a description shaped like markup must survive
// into the page as text and never as an element.
const HOSTILE_DESCRIPTION = 'Coffee & <script>alert("xss")</script>';
// Produced only by the retired parser version, so it must not appear in any
// current view, and must stay reachable through the artifact.
const RETIRED_DESCRIPTION = "row-from-the-retired-parser-version";

const RAW_BYTES = new TextEncoder().encode(
  JSON.stringify({
    account: "demo-bank:main",
    rows: [
      { id: "T-1", date: "2026-08-19", amount: "-1,180", label: HOSTILE_DESCRIPTION },
      { id: "T-2", date: "2026-08-20", amount: "1,024.53", label: "Inbound transfer" },
    ],
  }),
);

interface Fixture {
  handler: (request: Request) => Response;
  store: Store;
  artifactId: number;
  sha256: string;
  retiredObservationId: number;
}

/**
 * A two-parse-version dataset built through the store helpers, so the test
 * depends on the schema and the store API rather than on the fixtures.
 */
function buildFixture(): Fixture {
  const store = openStore(mkdtempSync(join(tmpdir(), "kogane-ui-")));
  upsertSource(store, {
    id: "demo-bank",
    provider: "Demo Bank",
    ingestion: "collector-r2",
  });
  const fetchRunId = insertFetchRun(store, {
    sourceId: "demo-bank",
    externalRunId: "run-20260820-210000-ui01",
    tool: "import-run",
    startedAt: "2026-08-20T21:00:00Z",
    completedAt: "2026-08-20T21:01:42Z",
    status: "success",
  });
  const stored = putRawObject(store, RAW_BYTES, "application/json");
  const artifactId = insertFetchArtifact(store, {
    fetchRunId,
    sourceId: "demo-bank",
    dataset: "statement",
    mime: "application/json",
    fetchedAt: "2026-08-20T21:01:42Z",
    sha256: stored.sha256,
  });

  const retiredRunId = insertParseRun(store, {
    artifactId,
    parserName: "demo-statement",
    parserVersion: "0.1.0",
    parsedAt: "2026-08-20T22:00:00Z",
    status: "ok",
    warnings: [],
  });
  insertObservation(store, retiredRunId, {
    kind: "transaction",
    sourceAccount: "demo-bank:main",
    description: RETIRED_DESCRIPTION,
    amountMinor: -1180,
    currency: "JPY",
    asOf: "2026-08-19",
    rawLocator: "json:$.rows[0]",
    extra: {},
  });

  const currentRunId = insertParseRun(store, {
    artifactId,
    parserName: "demo-statement",
    parserVersion: "0.2.0",
    parsedAt: "2026-08-21T09:00:00Z",
    status: "ok",
    warnings: ["json:$.rows[1]: currency inferred from the account, not stated"],
  });
  insertObservation(store, currentRunId, {
    kind: "transaction",
    sourceAccount: "demo-bank:main",
    externalId: "T-1",
    description: HOSTILE_DESCRIPTION,
    counterparty: "Kissaten <b>",
    amountMinor: -1180,
    currency: "JPY",
    asOf: "2026-08-19",
    rawLocator: "json:$.rows[0]",
    extra: { label: HOSTILE_DESCRIPTION },
  });
  insertObservation(store, currentRunId, {
    kind: "transaction",
    sourceAccount: "demo-bank:main",
    externalId: "T-2",
    description: "Inbound transfer",
    amountMinor: 102453,
    currency: "USD",
    asOf: "2026-08-20",
    rawLocator: "json:$.rows[1]",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "balance",
    sourceAccount: "demo-bank:main",
    metric: "ledger",
    amountMinor: 250000,
    instrument: "JPY",
    asOf: "2026-08-19",
    rawLocator: "json:$.balance",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "balance",
    sourceAccount: "demo-bank:main",
    metric: "ledger",
    amountMinor: 248820,
    instrument: "JPY",
    asOf: "2026-08-20",
    rawLocator: "json:$.balance",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "position",
    sourceAccount: "demo-bank:securities",
    securityCode: "1234",
    securityName: "Example <Fund>",
    market: "TSE",
    quantityText: "10.5",
    quantityScale: 1,
    currency: "JPY",
    asOf: "2026-08-20",
    rawLocator: "json:$.positions[0]",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "valuation",
    sourceAccount: "demo-bank:securities",
    subject: "1234",
    metric: "evaluation_amount",
    amountMinor: 123456,
    currency: "JPY",
    asOf: "2026-08-20",
    rawLocator: "json:$.positions[0]",
    extra: {},
  });
  insertObservation(store, currentRunId, {
    kind: "valuation",
    sourceAccount: "demo-bank:securities",
    subject: "1234",
    metric: "frn_evaluation_amount",
    amountMinor: 82000,
    currency: "USD",
    asOf: "2026-08-20",
    rawLocator: "json:$.positions[0]",
    extra: {},
  });

  const superseded = supersedeOlderParseRuns(
    store,
    artifactId,
    "demo-statement",
    currentRunId,
  );
  expect(superseded).toBe(1);

  const retiredObservation = store.db
    .query("SELECT id FROM transaction_observations WHERE description = ?1")
    .get(RETIRED_DESCRIPTION) as { id: number };

  return {
    handler: createUiHandler(store),
    store,
    artifactId,
    sha256: stored.sha256,
    retiredObservationId: retiredObservation.id,
  };
}

const fixture = buildFixture();

function get(path: string): Response {
  return fixture.handler(new Request(`http://ui.test${path}`));
}

async function html(path: string): Promise<string> {
  const response = get(path);
  expect(response.status).toBe(200);
  return await response.text();
}

describe("amount formatting", () => {
  test("formats minor units without floating point", () => {
    expect(formatAmount(-1180, "JPY")).toBe("-1,180 JPY");
    expect(formatAmount(102453, "USD")).toBe("1,024.53 USD");
    expect(formatAmount(1234567890, "JPY")).toBe("1,234,567,890 JPY");
    expect(formatAmount(-5, "AUD")).toBe("-0.05 AUD");
    expect(formatAmount(0, "JPY")).toBe("0 JPY");
    // Every value above is exactly representable as a double, so none of them
    // can tell an exact implementation from a floating-point one. These can:
    // via double arithmetic the first renders ...345.69 and the second loses
    // its final digits entirely.
    expect(formatAmount(12345678901234567n, "USD")).toBe("123,456,789,012,345.67 USD");
    expect(formatAmount(9007199254740993n, "JPY")).toBe("9,007,199,254,740,993 JPY");
  });

  test("falls back to the stored decimal string when amount_minor is NULL", () => {
    expect(formatAmount(null, "BTC", "0.00000001")).toBe("0.00000001 BTC");
    expect(formatAmount(null, "JPY", null)).toBe("");
  });

  test("labels rather than guesses the scale of an unknown instrument", () => {
    expect(formatAmount(500, "XYZ")).toBe("500 XYZ (minor units)");
  });
});

describe("pages", () => {
  test("overview names the source and counts the tables", async () => {
    const body = await html("/");
    expect(body).toContain("demo-bank");
    expect(body).toContain("Demo Bank");
    expect(body).toContain("transaction_observations");
    expect(body).toContain("demo-statement@0.2.0");
    expect(body).toContain("Read-only evidence browser.");
  });

  test("transactions show formatted amounts", async () => {
    const body = await html("/transactions");
    expect(body).toContain("-1,180 JPY");
    expect(body).toContain("1,024.53 USD");
  });

  test("balances derive a latest row per (account, metric, instrument)", async () => {
    const body = await html("/balances");
    expect(body).toContain("Latest per (source, source_account, metric, instrument)");
    const [latest = "", history = ""] = body.split("<h2>Full history</h2>");
    // Two ledger observations of the same account: only the later one is
    // "latest", and that section is computed by this request, not stored.
    expect(latest).toContain("248,820 JPY");
    expect(latest).not.toContain("250,000 JPY");
    expect(history).toContain("248,820 JPY");
    expect(history).toContain("250,000 JPY");
  });

  test("positions list each valuation metric in its own currency", async () => {
    const body = await html("/positions");
    expect(body).toContain("Example &lt;Fund&gt;");
    expect(body).toContain("10.5"); // quantity as a decimal string, not a float
    expect(body).toContain("123,456 JPY"); // JPY minor unit is the yen
    expect(body).toContain("820.00 USD"); // its own currency, never converted
  });

  test("provider text is escaped, never emitted as markup", async () => {
    const body = await html("/transactions");
    expect(body).toContain("Coffee &amp; &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("Kissaten &lt;b&gt;");
  });

  test("an observation detail page walks provenance to the raw bytes", async () => {
    const body = await html(`/observations/transaction/${fixture.retiredObservationId}`);
    expect(body).toContain("Provenance");
    expect(body).toContain("demo-statement@0.1.0");
    expect(body).toContain(fixture.sha256);
    expect(body).toContain(`/raw/${fixture.sha256}`);
    expect(body).toContain("import-run");
  });
});

describe("supersession", () => {
  test("a superseded parse run's observations are hidden from current views", async () => {
    const body = await html("/transactions");
    expect(body).not.toContain(RETIRED_DESCRIPTION);
  });

  test("they stay readable through the artifact that produced them", async () => {
    const body = await html(`/artifacts/${fixture.artifactId}`);
    expect(body).toContain(RETIRED_DESCRIPTION);
    expect(body).toContain("superseded by run");
    expect(body).toContain(`/observations/transaction/${fixture.retiredObservationId}`);
    // both parse runs over the same bytes are listed
    expect(body).toContain("demo-statement@0.1.0");
    expect(body).toContain("demo-statement@0.2.0");
  });

  test("the artifact index lists the artifact and links to its bytes", async () => {
    const body = await html("/artifacts");
    expect(body).toContain("demo-bank");
    expect(body).toContain("statement");
    expect(body).toContain(`/artifacts/${fixture.artifactId}`);
    expect(body).toContain(fixture.sha256.slice(0, 12));
  });
});

describe("raw evidence", () => {
  test("serves the stored bytes verbatim", async () => {
    const response = get(`/raw/${fixture.sha256}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-disposition")).toBe("inline");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(RAW_BYTES);
  });

  test("rejects a digest it does not hold", () => {
    expect(get(`/raw/${"a".repeat(64)}`).status).toBe(404);
    expect(get("/raw/not-a-digest").status).toBe(404);
  });
});

describe("routing", () => {
  test("an unknown path is 404", async () => {
    const response = get("/does-not-exist");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("404 not found");
    expect(get("/observations/nonsense/1").status).toBe(404);
    expect(get("/artifacts/999999").status).toBe(404);
  });

  test("the browser refuses anything but reads", () => {
    const response = fixture.handler(
      new Request("http://ui.test/transactions", { method: "POST" }),
    );
    expect(response.status).toBe(405);
  });
});

// Two institutions that both label an account "main" and both report a
// security code "1234". source_account carries no institution identity and
// security codes are not globally unique (numeric TSE codes are shared across
// every Japanese broker), so anything keyed without the source cross-wires
// them.
describe("two sources that use the same labels", () => {
  function twoSourceHandler(): (request: Request) => Response {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-ui-two-")));
    for (const source of ["bank-a", "bank-b"]) {
      upsertSource(store, { id: source, provider: source, ingestion: "file-export" });
      const runId = insertFetchRun(store, {
        sourceId: source,
        externalRunId: `${source}-run`,
        tool: "ingest-file",
        startedAt: "2026-08-20T00:00:00Z",
        status: "success",
      });
      const stored = putRawObject(
        store,
        new TextEncoder().encode(`{"source":"${source}"}`),
        "application/json",
      );
      const artifactId = insertFetchArtifact(store, {
        fetchRunId: runId,
        sourceId: source,
        dataset: "d",
        mime: "application/json",
        fetchedAt: "2026-08-20T00:00:00Z",
        sha256: stored.sha256,
      });
      const parseRunId = insertParseRun(store, {
        artifactId,
        parserName: `${source}-parser`,
        parserVersion: "1.0.0",
        parsedAt: "2026-08-20T00:00:00Z",
        status: "ok",
        warnings: [],
      });
      insertObservation(store, parseRunId, {
        kind: "balance",
        sourceAccount: "main",
        metric: "ledger",
        amountMinor: source === "bank-a" ? 111 : 222,
        instrument: "JPY",
        asOf: "2026-08-20",
        rawLocator: "json:$",
        extra: {},
      });
      insertObservation(store, parseRunId, {
        kind: "position",
        sourceAccount: "main",
        securityCode: "1234",
        securityName: `${source} fund`,
        quantityText: "1",
        quantityScale: 0,
        rawLocator: "json:$",
        extra: {},
      });
      insertObservation(store, parseRunId, {
        kind: "valuation",
        sourceAccount: "main",
        subject: "1234",
        metric: "evaluation_amount",
        amountMinor: source === "bank-a" ? 1010 : 2020,
        currency: "JPY",
        rawLocator: "json:$",
        extra: {},
      });
    }
    return createUiHandler(store);
  }

  test("neither institution's latest balance hides the other", async () => {
    const handler = twoSourceHandler();
    const body = await (await handler(new Request("http://ui.test/balances"))).text();
    expect(body).toContain("111 JPY");
    expect(body).toContain("222 JPY");
    expect(body).toContain("bank-a");
    expect(body).toContain("bank-b");
  });

  test("a valuation never attaches to the other institution's position", async () => {
    const handler = twoSourceHandler();
    const body = await (await handler(new Request("http://ui.test/positions"))).text();
    // Each position section shows only its own institution's valuation.
    const sections = body.split("<h3>").slice(1);
    expect(sections).toHaveLength(2);
    const sectionA = sections.find((part) => part.includes("bank-a"))!;
    const sectionB = sections.find((part) => part.includes("bank-b"))!;
    expect(sectionA).toContain("1,010 JPY");
    expect(sectionA).not.toContain("2,020 JPY");
    expect(sectionB).toContain("2,020 JPY");
    expect(sectionB).not.toContain("1,010 JPY");
  });
});

describe("raw evidence is served inert", () => {
  test("html evidence cannot execute in the browser's origin", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-ui-raw-")));
    upsertSource(store, { id: "s", provider: "s", ingestion: "file-export" });
    const runId = insertFetchRun(store, {
      sourceId: "s",
      externalRunId: "r",
      tool: "ingest-file",
      startedAt: "2026-08-20T00:00:00Z",
      status: "success",
    });
    const evil = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const stored = putRawObject(store, evil, "text/html");
    insertFetchArtifact(store, {
      fetchRunId: runId,
      sourceId: "s",
      mime: "text/html",
      fetchedAt: "2026-08-20T00:00:00Z",
      sha256: stored.sha256,
    });
    const handler = createUiHandler(store);
    const response = handler(new Request(`http://ui.test/raw/${stored.sha256}`));
    expect(response.status).toBe(200);
    // The bytes stay verbatim — they are the evidence — but the page is
    // denied an origin and scripting.
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a stored content type containing CRLF cannot break the response", () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-ui-crlf-")));
    upsertSource(store, { id: "s", provider: "s", ingestion: "file-export" });
    const runId = insertFetchRun(store, {
      sourceId: "s",
      externalRunId: "r",
      tool: "ingest-file",
      startedAt: "2026-08-20T00:00:00Z",
      status: "success",
    });
    const stored = putRawObject(
      store,
      new TextEncoder().encode("{}"),
      "text/plain\r\nX-Injected: 1",
    );
    insertFetchArtifact(store, {
      fetchRunId: runId,
      sourceId: "s",
      mime: "application/json",
      fetchedAt: "2026-08-20T00:00:00Z",
      sha256: stored.sha256,
    });
    const handler = createUiHandler(store);
    const response = handler(new Request(`http://ui.test/raw/${stored.sha256}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-injected")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
  });
});
