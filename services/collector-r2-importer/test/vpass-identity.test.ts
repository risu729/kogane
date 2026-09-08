import { describe, expect, test } from "bun:test";
import { deriveVpassCardBinding, importVpassCardBinding } from "../src/vpass-identity";
import { centralDescriptorSha256 } from "../src/central";
import worker from "../src/worker";

const RUN = "2026-09-05T00-00-00-000Z",
  PREFIX = `vpass/2026/09/05/${RUN}/card-001/`,
  KEY = `${PREFIX}manifest.json`;
const SECRET = "ab".repeat(32),
  TOKEN = `collector-r2-vpass.${"v".repeat(32)}`;
const descriptor = {
  externalId: "a".repeat(32),
  globalid: "b".repeat(32),
  cardCode: "1234567890123",
  cardName: "Synthetic product",
};
function envelope(content: unknown, header: Record<string, unknown> = {}) {
  return { header: { resultCode: 0, ...header }, body: { content } };
}
class Bucket {
  values = new Map<string, unknown>();
  mutateAfterRead: ((key: string) => void) | undefined;
  get = async (key: string) => {
    if (!this.values.has(key)) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(this.values.get(key)));
    this.mutateAfterRead?.(key);
    return {
      size: bytes.length,
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {},
      checksums: {},
      arrayBuffer: async () => bytes.buffer,
    };
  };
  list = async (options?: { prefix?: string }) => ({
    objects: Array.from(this.values.keys())
      .filter((k) => k.startsWith(options?.prefix ?? ""))
      .map((key) => ({ key })),
    truncated: false,
  });
  asR2() {
    return this as unknown as R2Bucket;
  }
  snapshot() {
    return this.values.get(`${PREFIX}snapshot.json`) as Record<string, unknown>;
  }
}
function fixture() {
  const bucket = new Bucket();
  const page = envelope({
    CustomizedMeisaiAnsDisplayServiceBean: {
      meisaiList: [],
      total: "0",
      pageSize: "100",
      pageFlg: "3",
    },
  });
  bucket.values.set(`${PREFIX}snapshot.json`, {
    format: "kogane-vpass-r2-snapshot/v1",
    runId: RUN,
    selectedCardIndex: 1,
    cardListRawJson: JSON.stringify(
      envelope({
        DropdownListInitDisplayServiceBean: {
          multiCardInfoList: [{ name: descriptor.cardName, value: "rotating-selector-one" }],
        },
      }),
    ),
    selectCardRawJson: JSON.stringify(envelope({ selected: true }, { vpSessionBean: descriptor })),
    webMeisaiTopRawJson: JSON.stringify(
      envelope(
        {
          WebMeisaiTopDisplayServiceBean: {
            seikyuYMList: [{ name: "2026年9月", value: "202609" }],
          },
        },
        { vpSessionBean: { cardCode: descriptor.cardCode, cardName: descriptor.cardName } },
      ),
    ),
    months: {
      "202609": {
        pages: [{ kind: "top", index: 0, rawJson: JSON.stringify(page) }],
        transactionCount: 0,
      },
    },
  });
  bucket.values.set(KEY, {
    runId: RUN,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    cardCount: 1,
    selectedCardIndex: 1,
    monthCount: 1,
    pageCount: 1,
    transactionCount: 0,
    objectCount: 2,
    status: "success",
    months: { "202609": { pages: 1, transactions: 0 } },
  });
  return bucket;
}
class Central {
  calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  objects = new Map<string, string>();
  failSeal = false;
  fetch = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "PUT") {
      this.objects.set(path, await request.text());
      this.calls.push({ path, body: {} });
      return Response.json({}, { status: 201 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    this.calls.push({ path, body });
    if (path === "/v1/runs") return Response.json({ runId: 10 });
    if (path.endsWith("/units")) return Response.json({ unitId: 20 });
    if (path.endsWith("/artifacts"))
      return Response.json({ descriptorSha256: await centralDescriptorSha256(body) });
    if (path.endsWith("/seal")) {
      if (this.failSeal) {
        this.failSeal = false;
        return Response.json({ error: "synthetic-transient" }, { status: 503 });
      }
      return Response.json({ sealed: true });
    }
    return Response.json({ ok: true });
  };
  asFetcher() {
    return this as unknown as Fetcher;
  }
}
function options(bucket: Bucket, central: Central) {
  return {
    bucket: bucket.asR2(),
    centralService: central.asFetcher(),
    centralToken: TOKEN,
    fingerprintKey: SECRET,
    recordKey: KEY,
  };
}

describe("Vpass durable identity sidecar", () => {
  test("rotating selector never changes provider-tuple HMAC and raw identifiers never leave derivation", async () => {
    const bucket = fixture();
    const first = await deriveVpassCardBinding(bucket.asR2(), KEY, SECRET);
    const list = JSON.parse(bucket.snapshot().cardListRawJson as string);
    list.body.content.DropdownListInitDisplayServiceBean.multiCardInfoList[0].value =
      "rotating-selector-two";
    bucket.snapshot().cardListRawJson = JSON.stringify(list);
    const second = await deriveVpassCardBinding(bucket.asR2(), KEY, SECRET);
    expect(first!.binding.accountIdentity).toBe(second!.binding.accountIdentity);
    expect(first!.binding.snapshotSha256).not.toBe(second!.binding.snapshotSha256);
    for (const raw of [...Object.values(descriptor), "rotating-selector-one", SECRET])
      expect(JSON.stringify(first)).not.toContain(raw);
    expect(first!.binding.accountIdentity).toMatch(/^vpass-card-v1-[0-9a-f]{64}$/u);
  });
  test("each provider principal/card discriminator independently prevents unsafe merging", async () => {
    const baseline = await deriveVpassCardBinding(fixture().asR2(), KEY, SECRET);
    for (const key of ["externalId", "globalid", "cardCode"]) {
      const bucket = fixture();
      const selection = JSON.parse(bucket.snapshot().selectCardRawJson as string);
      selection.header.vpSessionBean[key] = "z".repeat(key === "cardCode" ? 13 : 32);
      bucket.snapshot().selectCardRawJson = JSON.stringify(selection);
      if (key === "cardCode") {
        const top = JSON.parse(bucket.snapshot().webMeisaiTopRawJson as string);
        top.header.vpSessionBean.cardCode = selection.header.vpSessionBean.cardCode;
        bucket.snapshot().webMeisaiTopRawJson = JSON.stringify(top);
      }
      const changed = await deriveVpassCardBinding(bucket.asR2(), KEY, SECRET);
      expect(changed!.binding.accountIdentity).not.toBe(baseline!.binding.accountIdentity);
    }
  });
  test.each(["cardCode", "cardName"])("selection and discovery %s must agree", async (field) => {
    const bucket = fixture();
    const top = JSON.parse(bucket.snapshot().webMeisaiTopRawJson as string);
    top.header.vpSessionBean[field] = "different";
    bucket.snapshot().webMeisaiTopRawJson = JSON.stringify(top);
    await expect(deriveVpassCardBinding(bucket.asR2(), KEY, SECRET)).rejects.toThrow(
      "vpass_binding_selection_discovery_mismatch",
    );
  });
  test("missing identity stays unavailable and partial/malformed identity is rejected", async () => {
    const bucket = fixture();
    for (const field of ["selectCardRawJson", "webMeisaiTopRawJson"]) {
      const payload = JSON.parse(bucket.snapshot()[field] as string);
      delete payload.header.vpSessionBean;
      bucket.snapshot()[field] = JSON.stringify(payload);
    }
    expect(await deriveVpassCardBinding(bucket.asR2(), KEY, SECRET)).toBeNull();
    const bad = fixture();
    const selection = JSON.parse(bad.snapshot().selectCardRawJson as string);
    delete selection.header.vpSessionBean.globalid;
    bad.snapshot().selectCardRawJson = JSON.stringify(selection);
    await expect(deriveVpassCardBinding(bad.asR2(), KEY, SECRET)).rejects.toThrow(
      "vpass_binding_identifier_invalid",
    );
  });
  test("source change during validation is rejected before any central write", async () => {
    const bucket = fixture();
    let read = 0;
    bucket.mutateAfterRead = (key) => {
      if (key === `${PREFIX}snapshot.json` && ++read === 2) {
        const list = JSON.parse(bucket.snapshot().cardListRawJson as string);
        list.body.content.DropdownListInitDisplayServiceBean.multiCardInfoList[0].value = "changed";
        bucket.snapshot().cardListRawJson = JSON.stringify(list);
      }
    };
    const central = new Central();
    await expect(importVpassCardBinding(options(bucket, central))).rejects.toThrow(
      "vpass_binding_source_changed",
    );
    expect(central.calls).toEqual([]);
  });
  test("sidecar appends one derived artifact to same session and a distinct run, without monetary artifacts", async () => {
    const bucket = fixture(),
      central = new Central();
    expect(await importVpassCardBinding(options(bucket, central))).toEqual({
      status: "sealed",
      bindingRunId: 10,
      artifactCount: 1,
    });
    expect(central.calls).toHaveLength(7);
    expect(central.calls[0]!.body).toMatchObject({
      sourceId: "vpass",
      producerId: "collector-r2-importer",
      externalIdNamespace: "vpass-worker-card-v1",
      externalSessionId: RUN,
      sourceRunKey: "card-001-vpass-card-binding-v1",
    });
    const artifacts = central.calls.filter((c) => c.path.endsWith("/artifacts"));
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.body).toMatchObject({
      dataset: "card-identity-binding",
      artifactRole: "collector_derived",
      formatVersion: "1",
    });
    expect(central.calls.find((c) => c.path.endsWith("/units"))!.body.unitKey).toMatch(
      /^vpass-card-v1-[0-9a-f]{64}$/u,
    );
    const audit = JSON.stringify([...central.calls, ...central.objects.values()]);
    for (const raw of Object.values(descriptor)) expect(audit).not.toContain(raw);
  });
  test("seal failure retries same immutable sidecar identity and bytes", async () => {
    const bucket = fixture(),
      central = new Central();
    central.failSeal = true;
    await expect(importVpassCardBinding(options(bucket, central))).rejects.toThrow();
    const first = Array.from(central.objects.values());
    await importVpassCardBinding(options(bucket, central));
    expect(Array.from(central.objects.values())).toEqual(first);
    const runs = central.calls.filter((c) => c.path === "/v1/runs");
    expect(runs[0]!.body).toEqual(runs[1]!.body);
  });
  test("binding-only endpoint leaves financial importer untouched", async () => {
    const bucket = fixture(),
      central = new Central();
    const env = {
      VPASS_SNAPSHOTS: bucket.asR2(),
      RAW_EVIDENCE: central.asFetcher(),
      RAW_EVIDENCE_TOKEN_VPASS: TOKEN,
      ORIGIN_FINGERPRINT_KEY: SECRET,
    } as Env;
    const response = await worker.fetch(
      new Request("https://internal/v1/vpass/import-card-binding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recordKey: KEY }),
      }) as Request<unknown, IncomingRequestCfProperties>,
      env,
    );
    expect(response.status).toBe(200);
    expect(central.calls.filter((c) => c.path === "/v1/runs")).toHaveLength(1);
  });
});
