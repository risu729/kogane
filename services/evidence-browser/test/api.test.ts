import { env, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { seedRegistry, seedRun } from "./fixtures";

const prefix = "/api/evidence/v1";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://evidence-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
async function token(claims: Record<string, unknown> = {}, signingKey = keys.privateKey) {
  return new SignJWT({ type: "app", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
    .setAudience(typeof claims.aud === "string" ? claims.aud : "fixture-audience")
    .setSubject(typeof claims.sub === "string" ? claims.sub : "synthetic-user")
    .setIssuedAt()
    .setExpirationTime(claims.exp === undefined ? "5m" : (claims.exp as number))
    .sign(signingKey);
}
async function call(
  path: string,
  options: { jwt?: string | null; method?: string; environment?: Record<string, unknown> } = {},
) {
  const jwt = options.jwt === undefined ? await token() : options.jwt;
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: options.method ?? "GET",
      headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      ...options.environment,
    } as Env,
  );
}
async function catalogueSnapshot() {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  const contents = [];
  for (const { name } of tables.results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    contents.push([name, rows.results]);
  }
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(contents))),
    ),
  );
}

describe("authenticated read-only evidence", () => {
  it("protects API, raw, navigation, and assets without accepting a decoded or absent token", async () => {
    for (const path of [
      `${prefix}/meta`,
      `${prefix}/runs/r_1/artifacts/a_1/raw`,
      "/",
      "/assets/app.js",
    ]) {
      expect((await call(path, { jwt: null })).status).toBe(401);
      expect((await SELF.fetch(`https://fixture.test${path}`)).status).toBe(401);
    }
    expect(
      (await call(`${prefix}/meta`, { jwt: "eyJhbGciOiJub25lIn0.eyJ0eXBlIjoiYXBwIn0." })).status,
    ).toBe(401);
  });
  it("verifies signature, issuer, audience, expiration, subject and application token type", async () => {
    const other = await generateKeyPair("RS256");
    const invalid = [
      await token({}, other.privateKey),
      await token({ iss: "https://wrong.cloudflareaccess.com" }),
      await token({ aud: "wrong" }),
      await token({ exp: 1 }),
      await token({ sub: "" }),
      await token({ type: "org" }),
    ];
    for (const jwt of invalid) expect((await call(`${prefix}/meta`, { jwt })).status).toBe(401);
    const missingExpiry = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(issuer)
      .setAudience("fixture-audience")
      .setSubject("fixture")
      .setIssuedAt()
      .sign(keys.privateKey);
    expect((await call(`${prefix}/meta`, { jwt: missingExpiry })).status).toBe(401);
    expect((await call(`${prefix}/meta`)).status).toBe(200);
  });
  it("fails closed on missing configuration and distinguishes key provider outages", async () => {
    expect((await call("/", { environment: { ACCESS_ISSUER: "" } })).status).toBe(503);
    expect((await call("/", { environment: { EVIDENCE_SOURCE_ID: "other-test" } })).status).toBe(
      503,
    );
    issuer = "https://unavailable-fixture.cloudflareaccess.com";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("private upstream body", { status: 503 }),
    );
    const response = await call(`${prefix}/meta`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "identity_keys_unavailable" });
  });
  it("serves honest metadata and authenticated SPA with security headers", async () => {
    const meta = await call(`${prefix}/meta`);
    expect(await meta.json()).toMatchObject({
      source: { kind: "central-raw-store", classification: "financial" },
      capabilities: { parsedObservations: false, liveCollectors: false },
    });
    const response = await call("/evidence/sources/sony-bank");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("synthetic evidence shell");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call(`${prefix}/missing`)).status).toBe(404);
    expect((await call(`${prefix}/meta`, { method: "POST" })).status).toBe(405);
  });
  it("classifies malformed identity keys as a provider outage rather than invalid credentials", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("invalid private upstream JSON", { status: 200 }),
    );
    const response = await call(`${prefix}/meta`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "identity_keys_unavailable" });
  });
  it("preserves failed/partial outcomes, count, and timestamp provenance without exposing unsealed/excluded/other source runs", async () => {
    const partial = await seedRun({ outcome: "partial", count: 1 });
    const failed = await seedRun({ outcome: "failed" });
    const hidden = [
      await seedRun({ sealed: false, count: 1 }),
      await seedRun({ excluded: true, count: 1 }),
      await seedRun({ source: "other-test", count: 1 }),
      await seedRun({ source: "kogane-synthetic" }),
    ];
    const response = await call(`${prefix}/sources/sony-bank/runs`);
    const body = (await response.json()) as any;
    expect(body.items.find((r: any) => r.id === `r_${partial.id}`)).toMatchObject({
      outcome: "partial",
      artifactCount: 1,
      startedAt: null,
      startedAtBasis: null,
      completedAtBasis: "manifest",
    });
    expect(body.items.find((r: any) => r.id === `r_${failed.id}`)).toMatchObject({
      outcome: "failed",
      artifactCount: 0,
    });
    for (const run of hidden) {
      expect(body.items.some((r: any) => r.id === `r_${run.id}`)).toBe(false);
      expect((await call(`${prefix}/runs/r_${run.id}/artifacts`)).status).toBe(404);
      if (run.artifacts[0])
        for (const suffix of ["", "/raw"])
          expect(
            (await call(`${prefix}/runs/r_${run.id}/artifacts/a_${run.artifacts[0].id}${suffix}`))
              .status,
          ).toBe(404);
    }
    expect((await call(`${prefix}/sources/other-test/runs`)).status).toBe(404);
    expect(
      (await call(`${prefix}/runs/r_${failed.id}/artifacts/a_${partial.artifacts[0].id}`)).status,
    ).toBe(404);
  });
  it("keeps keyset pages stable when newer runs arrive and rejects invalid cursors", async () => {
    for (let i = 0; i < 51; i++) await seedRun();
    const first = (await (await call(`${prefix}/sources/sony-bank/runs`)).json()) as any;
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toMatch(/^c_/);
    const newest = await seedRun();
    const next = (await (
      await call(`${prefix}/sources/sony-bank/runs?cursor=${first.nextCursor}`)
    ).json()) as any;
    expect(next.items.some((r: any) => r.id === `r_${newest.id}`)).toBe(false);
    expect(next.items.every((r: any) => !first.items.some((f: any) => f.id === r.id))).toBe(true);
    for (const query of [
      "cursor=c_0",
      "cursor=c_01",
      "cursor=c_9007199254740992",
      "cursor=c_1&cursor=c_2",
      "foo=private",
    ])
      expect((await call(`${prefix}/sources/sony-bank/runs?${query}`)).status).toBe(400);
  });
  it("paginates inventory artifacts and returns their immutable descriptor", async () => {
    const run = await seedRun({ count: 51 });
    const first = (await (await call(`${prefix}/runs/r_${run.id}/artifacts`)).json()) as any;
    expect(first.items).toHaveLength(50);
    const second = (await (
      await call(`${prefix}/runs/r_${run.id}/artifacts?cursor=${first.nextCursor}`)
    ).json()) as any;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const detail = (await (
      await call(`${prefix}/runs/r_${run.id}/artifacts/${second.items[0].id}`)
    ).json()) as any;
    expect(detail.artifact).toMatchObject({
      containerKind: "single",
      lineageDisposition: "not_applicable",
      formatId: null,
      formatVersion: null,
      declaredMediaType: "application/json",
    });
    expect(detail.artifact.descriptorSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns original HTML as an attachment, HEAD without bytes, and no DB writes", async () => {
    const html = "<script>synthetic-private-body</script>";
    const run = await seedRun({ count: 1, body: html });
    const before = await catalogueSnapshot();
    let reads = 0;
    const readOnlyDb = {
      prepare(sql: string) {
        expect(sql.trimStart()).toMatch(/^SELECT\b/);
        reads++;
        return env.DB.prepare(sql);
      },
    };
    const environment = { DB: readOnlyDb };
    const path = `${prefix}/runs/r_${run.id}/artifacts/a_${run.artifacts[0].id}/raw`;
    const response = await call(path, { environment });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(html);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="evidence.bin"');
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const head = await call(path, { method: "HEAD", environment });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    await call(`${prefix}/sources/sony-bank/runs`, { environment });
    await call(`${prefix}/runs/r_${run.id}/artifacts`, { environment });
    await call(path.slice(0, -4), { environment });
    expect(reads).toBeGreaterThan(0);
    expect(await catalogueSnapshot()).toEqual(before);
  });
  it("refuses missing or altered R2 evidence on GET and HEAD", async () => {
    const run = await seedRun({ count: 1, body: "unique integrity fixture" });
    const item = run.artifacts[0];
    const key = `objects/${item.sha256.slice(0, 2)}/${item.sha256}`;
    const path = `${prefix}/runs/r_${run.id}/artifacts/a_${item.id}/raw`;
    await env.EVIDENCE.put(key, "tampered", {
      customMetadata: { sha256: item.sha256, byteSize: String(item.byte_size) },
    });
    for (const method of ["GET", "HEAD"]) expect((await call(path, { method })).status).toBe(409);
    await env.EVIDENCE.delete(key);
    expect((await call(path)).status).toBe(404);
  });
  it("requires native SHA-256 and matching metadata even when the object size matches", async () => {
    const original = "original";
    const run = await seedRun({ count: 1, body: original });
    const item = run.artifacts[0];
    const key = `objects/${item.sha256.slice(0, 2)}/${item.sha256}`;
    const path = `${prefix}/runs/r_${run.id}/artifacts/a_${item.id}/raw`;
    const metadata = { sha256: item.sha256, byteSize: String(item.byte_size) };
    const altered = new TextEncoder().encode("tampered");
    const alteredHash = await crypto.subtle.digest("SHA-256", altered);
    // A same-size payload with a valid checksum for different bytes cannot be
    // disguised using catalogue-matching, caller-controlled custom metadata.
    await env.EVIDENCE.put(key, altered, { sha256: alteredHash, customMetadata: metadata });
    for (const method of ["GET", "HEAD"]) expect((await call(path, { method })).status).toBe(409);
    // Matching bytes and metadata alone are insufficient without R2's checksum.
    await env.EVIDENCE.put(key, original, { customMetadata: metadata });
    for (const method of ["GET", "HEAD"]) expect((await call(path, { method })).status).toBe(409);
    await env.EVIDENCE.put(key, original, {
      sha256: item.sha256,
      customMetadata: { ...metadata, byteSize: "0" },
    });
    for (const method of ["GET", "HEAD"]) expect((await call(path, { method })).status).toBe(409);
    await env.EVIDENCE.put(key, original, { sha256: item.sha256, customMetadata: metadata });
    const response = await call(path);
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(original);
  });
  it("logs only bounded request summaries and survives a throwing logger", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(`${prefix}/sources/sony-bank/runs?private-secret=body-secret`);
    expect(response.status).toBe(400);
    const values = logs.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(values).toHaveLength(1);
    expect(Object.keys(values[0]).sort()).toEqual([
      "durationMs",
      "errorCode",
      "event",
      "requestId",
      "route",
      "status",
    ]);
    expect(JSON.stringify(values)).not.toMatch(/private-secret|body-secret|sony-bank|eyJ/);
    logs.mockImplementation(() => {
      throw new Error("private logger failure");
    });
    expect((await call(`${prefix}/meta`)).status).toBe(200);
  });
  it("distinguishes catalogue and object transport failures without leaking error contents", async () => {
    const run = await seedRun({ count: 1 });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const failedDb = {
      prepare() {
        throw new Error("private SQL account data");
      },
    };
    const database = await call(`${prefix}/sources/sony-bank/runs`, {
      environment: { DB: failedDb },
    });
    expect(database.status).toBe(503);
    expect(await database.json()).toMatchObject({ error: "catalogue_read_failed" });
    const failedBucket = {
      get() {
        throw new Error("private R2 object data");
      },
      head() {
        throw new Error("private R2 object data");
      },
    };
    for (const method of ["GET", "HEAD"]) {
      const response = await call(
        `${prefix}/runs/r_${run.id}/artifacts/a_${run.artifacts[0].id}/raw`,
        { method, environment: { EVIDENCE: failedBucket } },
      );
      expect(response.status).toBe(503);
    }
    expect(logs.mock.calls.map(([value]) => JSON.parse(String(value)).errorCode)).toEqual([
      "catalogue_read_failed",
      "raw_read_failed",
      "raw_read_failed",
    ]);
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private|SQL|R2 object|account/);
  });
});
