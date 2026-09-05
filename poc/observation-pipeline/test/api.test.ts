import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../src/api.ts";
import { validApiResponse } from "../shared/api-validation.ts";
import { latestBalances } from "../src/queries.ts";
import {
  supersedeOlderParseRuns,
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseRun,
  openStore,
  putRawObject,
  upsertSource,
} from "../src/store.ts";
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
  const value = await response.json();
  expect(validApiResponse(path, value)).toBe(true);
  return value;
}

describe("shared response validators", () => {
  test("detail identities must match the requested safe integer, including zero", async () => {
    const artifact = await json(`/api/artifacts/${fixture.artifactId}`);
    const observation = await json(
      `/api/observations/transaction/${fixture.retiredObservationId}`,
    );
    for (const id of [0, Number.MAX_SAFE_INTEGER]) {
      expect(
        validApiResponse(`/api/artifacts/${id}`, {
          ...artifact,
          artifact: { ...artifact.artifact, id },
        }),
      ).toBe(true);
      expect(
        validApiResponse(`/api/observations/transaction/${id}`, {
          ...observation,
          row: { ...observation.row, id },
        }),
      ).toBe(true);
    }
    for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", undefined]) {
      expect(
        validApiResponse("/api/artifacts/1", {
          ...artifact,
          artifact: { ...artifact.artifact, id },
        }),
      ).toBe(false);
      expect(
        validApiResponse("/api/observations/transaction/1", {
          ...observation,
          row: { ...observation.row, id },
        }),
      ).toBe(false);
    }
    expect(
      validApiResponse(`/api/artifacts/${fixture.artifactId + 1}`, artifact),
    ).toBe(false);
    expect(
      validApiResponse(
        `/api/observations/transaction/${fixture.retiredObservationId + 1}`,
        observation,
      ),
    ).toBe(false);
  });

  test("list and provenance identifiers and raw-byte hashes retain their exact identity", async () => {
    const transactions = await json("/api/transactions");
    const observationPath = `/api/observations/transaction/${fixture.retiredObservationId}`;
    const observation = await json(observationPath);
    for (const id of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        validApiResponse("/api/transactions", {
          transactions: [{ ...transactions.transactions[0], id }],
        }),
      ).toBe(false);
      expect(
        validApiResponse(observationPath, {
          ...observation,
          provenance: { ...observation.provenance, artifact_id: id },
        }),
      ).toBe(false);
    }
    for (const sha256 of [
      "",
      "../transactions",
      "a".repeat(63),
      "A".repeat(64),
    ]) {
      expect(
        validApiResponse(observationPath, {
          ...observation,
          provenance: { ...observation.provenance, sha256 },
        }),
      ).toBe(false);
    }
  });

  test("minor-unit fields accept only exact decimal integer strings or null", async () => {
    const transactions = await json("/api/transactions");
    const observationPath = `/api/observations/transaction/${fixture.retiredObservationId}`;
    const observation = await json(observationPath);
    for (const amount_minor of [
      "",
      " ",
      "0x10",
      "0b10",
      "+1",
      "1e3",
      "1.5",
      "1\n",
    ]) {
      expect(
        validApiResponse("/api/transactions", {
          transactions: [{ ...transactions.transactions[0], amount_minor }],
        }),
      ).toBe(false);
      expect(
        validApiResponse(observationPath, {
          ...observation,
          row: { ...observation.row, amount_minor },
        }),
      ).toBe(false);
    }
    for (const amount_minor of [null, "0", "-0", "0001", "-9007199254740993"]) {
      expect(
        validApiResponse("/api/transactions", {
          transactions: [{ ...transactions.transactions[0], amount_minor }],
        }),
      ).toBe(true);
    }
  });

  test("validate real query results and reject malformed nested details", async () => {
    const artifactPath = `/api/artifacts/${fixture.artifactId}`;
    const detail = await json(artifactPath);
    expect(validApiResponse(artifactPath, { ...detail, parseRuns: [{}] })).toBe(
      false,
    );
    const badWarnings = structuredClone(detail);
    badWarnings.parseRuns[0].warnings.list = [null];
    expect(validApiResponse(artifactPath, badWarnings)).toBe(false);
    const badReference = structuredClone(detail);
    badReference.parseRuns[0].observations = [
      { kind: "unknown", id: 1, summary: "sample" },
    ];
    expect(validApiResponse(artifactPath, badReference)).toBe(false);
    const observationPath = `/api/observations/transaction/${fixture.retiredObservationId}`;
    const observation = await json(observationPath);
    expect(
      validApiResponse(observationPath, { ...observation, provenance: {} }),
    ).toBe(false);
    const missingProvenance = { ...observation };
    delete missingProvenance.provenance;
    expect(validApiResponse(observationPath, missingProvenance)).toBe(true);
    expect(
      validApiResponse(observationPath, { ...observation, provenance: null }),
    ).toBe(false);
  });
});

describe("API metadata", () => {
  test("describes the local read-only API without inferring provenance from demo-named rows", async () => {
    const response = await get("/api/meta");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      apiVersion: 1,
      source: { kind: "local-store", classification: "unknown" },
      capabilities: {
        readOnly: true,
        rawEvidence: true,
        liveCollectors: false,
      },
    });
  });
  test("accepts explicit synthetic provenance from the isolated fixture startup only", async () => {
    const demoApi = createApi(fixture.store, {
      dataClassification: "synthetic",
    });
    const response = await demoApi.fetch(
      new Request("http://api.test/api/meta"),
    );
    expect(
      ((await response.json()) as { source: { classification: string } }).source
        .classification,
    ).toBe("synthetic");
    const denied = await demoApi.fetch(
      new Request("http://api.test/api/meta", { method: "POST" }),
    );
    expect(denied.status).toBe(405);
  });
});

describe("amount formatting", () => {
  test("prototype-shaped unknown currencies never turn a nonzero amount into zero", () => {
    for (const currency of ["__proto__", "constructor", "toString"]) {
      expect(formatAmount("123456", currency)).toBe(
        `123,456 ${currency} (minor units)`,
      );
    }
  });
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
    expect(formatAmount("9007199254740993", "JPY")).toBe(
      "9,007,199,254,740,993 JPY",
    );
    expect(formatAmount(9007199254740993n, "JPY")).toBe(
      "9,007,199,254,740,993 JPY",
    );
  });

  test("an unknown instrument is labelled, never given an invented scale", () => {
    expect(formatAmount(12345, "XYZ")).toBe("12,345 XYZ (minor units)");
    expect(formatAmount(12345, "ANA_MILE")).toBe(
      "12,345 ANA_MILE (minor units)",
    );
  });

  test("a null amount falls back to the stored text verbatim", () => {
    expect(formatAmount(null, "USD", "1568.400")).toBe("1568.400 USD");
    expect(formatAmount(null, "USD", null)).toBe("");
    expect(formatAmount(undefined, null, "")).toBe("");
  });

  test("a malformed amount is shown as stored rather than coerced", () => {
    expect(formatAmount("not-a-number", "JPY")).toBe("not-a-number JPY");
    expect(formatAmount(1.5, "JPY")).toBe("1.5 JPY");
    for (const value of ["", " ", "0x10", "0b10", "+1", "1e3", "1\n"]) {
      expect(formatAmount(value, "JPY")).toBe(`${value} JPY`);
      expect(amountSign(value)).toBe("unknown");
    }
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
      body.counts.map((entry: { table: string; rows: number }) => [
        entry.table,
        entry.rows,
      ]),
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
    expect(current.warnings.list).toHaveLength(1);
    expect(current.warnings.parsed).toBe(true);
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
    const row = body.transactions.find(
      (entry: { external_id: string }) => entry.external_id === "T-2",
    );
    expect(row.amount_minor).toBe("102453");
    expect(row.currency).toBe("USD");
    expect(formatAmount(row.amount_minor, row.currency)).toBe("1,024.53 USD");
  });

  test("balances expose the latest per group and the full history", async () => {
    const body = await json("/api/balances");
    // Two observations of the same (source, account, metric, instrument);
    // only the later one is current.
    expect(body.latest).toHaveLength(1);
    expect(body.latest[0].as_of).toBe("2026-08-20");
    expect(body.latest[0].amount_minor).toBe("248820");
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
    const summaries = retired.observations.map(
      (o: { summary: string }) => o.summary,
    );
    expect(summaries.join(" ")).toContain(RETIRED_DESCRIPTION);
  });
});

describe("observation detail and provenance", () => {
  test("all four observation kinds expose their stored values and provenance", async () => {
    for (const kind of ["transaction", "balance", "position", "valuation"]) {
      const body = await json(`/api/observations/${kind}/1`);
      expect(body.kind).toBe(kind);
      expect(body.row.id).toBe(1);
      expect(body.provenance.artifact_id).toBe(fixture.artifactId);
      expect(body.provenance.sha256).toBe(fixture.sha256);
      if (kind === "position") {
        expect(body.row.quantity_text).toBe("10.5");
        expect(Object.hasOwn(body.row, "amount_minor")).toBe(false);
      } else {
        expect(typeof body.row.amount_minor).toBe("string");
      }
    }
  });

  test("walks observation to parse run to artifact to raw object to fetch run", async () => {
    const body = await json(
      `/api/observations/transaction/${fixture.retiredObservationId}`,
    );
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
    expect((await get("/api/observations/transaction/999999")).status).toBe(
      404,
    );
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
    expect((await get(`/api/raw/${fixture.sha256.toUpperCase()}`)).status).toBe(
      404,
    );
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
    const page = await served.fetch(
      new Request("http://api.test/transactions"),
    );
    expect(await page.text()).toBe("CLIENT");
    // the API still wins for /api paths
    const api = await served.fetch(new Request("http://api.test/api/nope"));
    expect(api.status).toBe(404);
    expect(await api.text()).toContain("no such endpoint");
  });
});

describe("invariants that a shared label could break", () => {
  test("two institutions using the same account label do not hide each other", () => {
    // `source_account` is only the provider's own name for an account. Two
    // sources both calling one "main" must stay two rows in the latest-balance
    // view, or one institution's balance silently replaces the other's.
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-collide-")));
    for (const sourceId of ["bank-a", "bank-b"]) {
      upsertSource(store, {
        id: sourceId,
        provider: sourceId,
        ingestion: "collector-r2",
      });
      const fetchRunId = insertFetchRun(store, {
        sourceId,
        externalRunId: `${sourceId}-run`,
        tool: "import-run",
        startedAt: "2026-08-20T00:00:00Z",
        status: "success",
      });
      const stored = putRawObject(
        store,
        new TextEncoder().encode(`{"source":"${sourceId}"}`),
        "application/json",
      );
      const artifactId = insertFetchArtifact(store, {
        fetchRunId,
        sourceId,
        dataset: "balances",
        mime: "application/json",
        fetchedAt: "2026-08-20T00:00:00Z",
        sha256: stored.sha256,
      });
      const parseRunId = insertParseRun(store, {
        artifactId,
        parserName: "p",
        parserVersion: "1.0.0",
        parsedAt: "2026-08-20T01:00:00Z",
        status: "ok",
        warnings: [],
      });
      insertObservation(store, parseRunId, {
        kind: "balance",
        sourceAccount: "main", // the colliding label
        metric: "ledger",
        instrument: "JPY",
        amountMinor: sourceId === "bank-a" ? 111 : 222,
        asOf: "2026-08-20",
        rawLocator: "json:$",
        extra: {},
      });
    }
    const latest = latestBalances(store);
    expect(latest).toHaveLength(2);
    expect(latest.map((row) => row.source_id).sort()).toEqual([
      "bank-a",
      "bank-b",
    ]);
    expect(latest.map((row) => row.amount_minor).sort()).toEqual([
      "111",
      "222",
    ]);
  });

  test("a content type carrying CRLF cannot reach the response header", async () => {
    // The stored content type is provider-derived. A CR or LF in it would
    // otherwise split the response or throw out of the handler.
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-crlf-")));
    upsertSource(store, { id: "s", provider: "S", ingestion: "file-export" });
    const fetchRunId = insertFetchRun(store, {
      sourceId: "s",
      externalRunId: "r",
      tool: "ingest-file",
      startedAt: "2026-08-20T00:00:00Z",
      status: "success",
    });
    const bytes = new TextEncoder().encode("evidence");
    const stored = putRawObject(store, bytes, "text/plain\r\nX-Injected: yes");
    insertFetchArtifact(store, {
      fetchRunId,
      sourceId: "s",
      mime: "text/plain",
      fetchedAt: "2026-08-20T00:00:00Z",
      sha256: stored.sha256,
    });
    const api = createApi(store);
    const response = await api.fetch(
      new Request(`http://api.test/api/raw/${stored.sha256}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-injected")).toBeNull();
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    // the bytes themselves are still exact
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});

describe("rule: only a successful, unsuperseded parse run is current", () => {
  // Mutation testing showed the earlier suite could not detect a violation of
  // this rule for positions, valuations, or an error run: the fixture had one
  // source and its only superseded run produced a transaction. These build the
  // missing cases.
  function storeWithRetiredAndFailed(): {
    store: ReturnType<typeof openStore>;
    artifactId: number;
  } {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-current-")));
    upsertSource(store, { id: "s", provider: "S", ingestion: "collector-r2" });
    const fetchRunId = insertFetchRun(store, {
      sourceId: "s",
      externalRunId: "r",
      tool: "import-run",
      startedAt: "2026-08-20T00:00:00Z",
      status: "success",
    });
    const stored = putRawObject(
      store,
      new TextEncoder().encode('{"holdings":[]}'),
      "application/json",
    );
    const artifactId = insertFetchArtifact(store, {
      fetchRunId,
      sourceId: "s",
      dataset: "holdings",
      mime: "application/json",
      fetchedAt: "2026-08-20T00:00:00Z",
      sha256: stored.sha256,
    });

    const retired = insertParseRun(store, {
      artifactId,
      parserName: "p",
      parserVersion: "0.1.0",
      parsedAt: "2026-08-20T01:00:00Z",
      status: "ok",
      warnings: [],
    });
    insertObservation(store, retired, {
      kind: "position",
      sourceAccount: "s:acct",
      securityCode: "RETIRED_POS",
      quantityText: "1",
      quantityScale: 0,
      rawLocator: "json:$",
      extra: {},
    });
    insertObservation(store, retired, {
      kind: "valuation",
      sourceAccount: "s:acct",
      subject: "RETIRED_POS",
      metric: "evaluation_amount",
      amountMinor: 1,
      currency: "JPY",
      rawLocator: "json:$",
      extra: {},
    });

    const current = insertParseRun(store, {
      artifactId,
      parserName: "p",
      parserVersion: "0.2.0",
      parsedAt: "2026-08-20T02:00:00Z",
      status: "ok",
      warnings: [],
    });
    insertObservation(store, current, {
      kind: "position",
      sourceAccount: "s:acct",
      securityCode: "CURRENT_POS",
      quantityText: "2",
      quantityScale: 0,
      rawLocator: "json:$",
      extra: {},
    });
    supersedeOlderParseRuns(store, artifactId, "p", current);

    // A different parser that failed, but whose observations exist. Nothing
    // stops a row being written under a run later marked error, so the view
    // must exclude it by status, not merely by supersession.
    const failed = insertParseRun(store, {
      artifactId,
      parserName: "q",
      parserVersion: "1.0.0",
      parsedAt: "2026-08-20T03:00:00Z",
      status: "error",
      error: "boom",
      warnings: [],
    });
    insertObservation(store, failed, {
      kind: "position",
      sourceAccount: "s:acct",
      securityCode: "FAILED_POS",
      quantityText: "3",
      quantityScale: 0,
      rawLocator: "json:$",
      extra: {},
    });
    insertObservation(store, failed, {
      kind: "valuation",
      sourceAccount: "s:acct",
      subject: "FAILED_POS",
      metric: "evaluation_amount",
      amountMinor: 3,
      currency: "JPY",
      rawLocator: "json:$",
      extra: {},
    });
    return { store, artifactId };
  }

  test("a superseded position and valuation are absent from current views", async () => {
    const { store, artifactId } = storeWithRetiredAndFailed();
    const api = createApi(store);
    const positions = await (
      await api.fetch(new Request("http://t/api/positions"))
    ).json();
    const codes = positions.positions.map(
      (entry: { position: { security_code: string } }) =>
        entry.position.security_code,
    );
    expect(codes).toContain("CURRENT_POS");
    expect(codes).not.toContain("RETIRED_POS");

    // ...but they remain reachable through the artifact that produced them.
    const detail = await (
      await api.fetch(new Request(`http://t/api/artifacts/${artifactId}`))
    ).json();
    const summaries = detail.parseRuns
      .flatMap(
        (run: { observations: { summary: string }[] }) => run.observations,
      )
      .map((observation: { summary: string }) => observation.summary)
      .join(" ");
    expect(summaries).toContain("RETIRED_POS");
  });

  test("an error parse run's observations never reach a current view", async () => {
    const { store } = storeWithRetiredAndFailed();
    const api = createApi(store);
    const positions = await (
      await api.fetch(new Request("http://t/api/positions"))
    ).json();
    const blob = JSON.stringify(positions);
    expect(blob).not.toContain("FAILED_POS");
  });

  test("an amount past the safe integer range survives the API intact", async () => {
    // bun:sqlite returns an INTEGER column as a JS number, which would round
    // this silently. The queries cast amounts to text for that reason.
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-big-")));
    upsertSource(store, { id: "s", provider: "S", ingestion: "file-export" });
    const fetchRunId = insertFetchRun(store, {
      sourceId: "s",
      externalRunId: "r",
      tool: "ingest-file",
      startedAt: "2026-08-20T00:00:00Z",
      status: "success",
    });
    const stored = putRawObject(
      store,
      new TextEncoder().encode("{}"),
      "application/json",
    );
    const artifactId = insertFetchArtifact(store, {
      fetchRunId,
      sourceId: "s",
      mime: "application/json",
      fetchedAt: "2026-08-20T00:00:00Z",
      sha256: stored.sha256,
    });
    const parseRunId = insertParseRun(store, {
      artifactId,
      parserName: "p",
      parserVersion: "1.0.0",
      parsedAt: "2026-08-20T01:00:00Z",
      status: "ok",
      warnings: [],
    });
    // Written through SQL so the value never passes through a JS number.
    store.db
      .query(
        `INSERT INTO transaction_observations
           (parse_run_id, source_account, amount_minor, currency, raw_locator, extra_json)
         VALUES (?1, 's:acct', 9223372036854775807, 'JPY', 'json:$', '{}')`,
      )
      .run(parseRunId);

    const api = createApi(store);
    const body = await (
      await api.fetch(new Request("http://t/api/transactions"))
    ).json();
    expect(body.transactions[0].amount_minor).toBe("9223372036854775807");
    expect(formatAmount(body.transactions[0].amount_minor, "JPY")).toBe(
      "9,223,372,036,854,775,807 JPY",
    );
  });

  test("an unreadable warnings value is reported, not silently empty", async () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-warn-")));
    upsertSource(store, { id: "s", provider: "S", ingestion: "file-export" });
    const fetchRunId = insertFetchRun(store, {
      sourceId: "s",
      externalRunId: "r",
      tool: "ingest-file",
      startedAt: "2026-08-20T00:00:00Z",
      status: "success",
    });
    const stored = putRawObject(
      store,
      new TextEncoder().encode("{}"),
      "application/json",
    );
    const artifactId = insertFetchArtifact(store, {
      fetchRunId,
      sourceId: "s",
      mime: "application/json",
      fetchedAt: "2026-08-20T00:00:00Z",
      sha256: stored.sha256,
    });
    const parseRunId = insertParseRun(store, {
      artifactId,
      parserName: "p",
      parserVersion: "1.0.0",
      parsedAt: "2026-08-20T01:00:00Z",
      status: "ok",
      warnings: [],
    });
    store.db
      .query("UPDATE parse_runs SET warnings_json = ?1 WHERE id = ?2")
      .run("{ truncated", parseRunId);

    const api = createApi(store);
    const body = await (
      await api.fetch(new Request("http://t/api/overview"))
    ).json();
    const run = body.parseRuns[0];
    expect(run.warnings.parsed).toBe(false);
    expect(run.warnings.raw).toBe("{ truncated");
  });

  test("raw bytes that no longer match their digest are refused", async () => {
    const store = openStore(mkdtempSync(join(tmpdir(), "kogane-tamper-")));
    const stored = putRawObject(
      store,
      new TextEncoder().encode("original evidence"),
      "text/plain",
    );
    // Replace the blob on disk, leaving the row claiming the original digest.
    const row = store.db
      .query("SELECT blob_key FROM raw_objects WHERE sha256 = ?1")
      .get(stored.sha256) as { blob_key: string };
    writeFileSync(join(store.blobDir, ...row.blob_key.split("/")), "tampered");

    const api = createApi(store);
    const response = await api.fetch(
      new Request(`http://t/api/raw/${stored.sha256}`),
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("does not match");
  });
});
