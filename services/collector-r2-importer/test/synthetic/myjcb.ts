import { expect } from "bun:test";
import { importMyJcbRun } from "../../src/myjcb";

export const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
export const PREFIX = `raw/myjcb/2026/09/05/${RUN_ID}/`;
export const MANIFEST_KEY = `${PREFIX}manifest.json`;
export const TOKEN = `collector-r2-myjcb.${"j".repeat(32)}`;
export const FINGERPRINT_KEY = "ab".repeat(32);

export interface StoredObject {
  body: Uint8Array;
  customMetadata: Record<string, string>;
  contentType: string;
  nativeSha256: string;
}

export class FakeBucket {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      key,
      size: value.body.byteLength,
      customMetadata: value.customMetadata,
      httpMetadata: { contentType: value.contentType },
      checksums: { sha256: ownedArrayBuffer(hexBytes(value.nativeSha256)) },
      arrayBuffer: async () => ownedArrayBuffer(value.body),
    } as unknown as R2ObjectBody;
  }

  async list(options: R2ListOptions = {}) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    return {
      objects: keys.map((key) => ({ key })),
      truncated: false,
    } as unknown as R2Objects;
  }
}

export class FakeCentral {
  readonly requests: Array<{ path: string; method: string; body: string }> = [];
  readonly uploaded = new Set<string>();
  readonly inventoryItems = new Set<string>();
  readonly seals: number[] = [];
  readonly uploadedBodies: string[] = [];
  readonly unitIds = new Map<string, number>();
  readonly reports = new Map<string, string>();
  failNextInventoryItems = false;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = request.body ? await request.clone().text() : "";
    this.requests.push({ path, method: request.method, body });
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    if (request.method === "PUT") {
      const reused = this.uploaded.has(path);
      this.uploaded.add(path);
      this.uploadedBodies.push(body);
      return Response.json({ reused }, { status: reused ? 200 : 201 });
    }
    if (path === "/v1/runs") return Response.json({ runId: 1 }, { status: 201 });
    if (path.endsWith("/units")) {
      const connection = (JSON.parse(body) as { unitKey: string }).unitKey;
      if (!this.unitIds.has(connection)) this.unitIds.set(connection, 10 + this.unitIds.size);
      return Response.json({ unitId: this.unitIds.get(connection)! }, { status: 201 });
    }
    if (path.endsWith("/inventories")) return Response.json({ inventoryId: 20 }, { status: 201 });
    if (path.endsWith("/items")) {
      if (this.failNextInventoryItems) {
        this.failNextInventoryItems = false;
        return Response.json({ error: "temporary" }, { status: 503 });
      }
      const items = (JSON.parse(body) as { items: Array<{ artifactKey: string }> }).items;
      for (const item of items) this.inventoryItems.add(item.artifactKey);
      return Response.json({ ok: true }, { status: 201 });
    }
    if (path.endsWith("/artifacts")) {
      return Response.json(
        {
          descriptorSha256: await normalizedDescriptorSha256(JSON.parse(body)),
        },
        { status: 201 },
      );
    }
    if (path.endsWith("/reports")) return immutableReport(this.reports, path, body);
    if (path.endsWith("/seal")) {
      this.seals.push(1);
      return Response.json({ sealed: true }, { status: 201 });
    }
    return Response.json({ ok: true }, { status: 201 });
  };
}

export async function runImport(
  bucket: FakeBucket,
  central: FakeCentral,
  continuation?: string,
  importerVersion = "collector-r2-importer-test",
) {
  return importMyJcbRun({
    bucket: bucket as unknown as R2Bucket,
    centralService: central as unknown as Fetcher,
    centralToken: TOKEN,
    fingerprintKey: FINGERPRINT_KEY,
    importerVersion,
    manifestKey: MANIFEST_KEY,
    ...(continuation ? { continuation } : {}),
  });
}

export function immutableReport(
  reports: Map<string, string>,
  path: string,
  body: string,
): Response {
  const previous = reports.get(path);
  if (previous !== undefined && previous !== body) {
    return Response.json({ error: "immutable report conflict" }, { status: 409 });
  }
  reports.set(path, body);
  return Response.json(
    { reused: previous !== undefined },
    {
      status: previous === undefined ? 201 : 200,
    },
  );
}

export async function storeSuccessRun(bucket: FakeBucket): Promise<void> {
  const artifacts = [
    await putArtifact(
      bucket,
      "primary",
      "credit-menu",
      "credit-menu.html",
      html("credit-menu", "<span>detailMonth generalJsonShikibetuId</span>"),
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-past-months",
      "credit-past-months.json",
      JSON.stringify({
        jsonrpc: "2.0",
        id: "030100601",
        result: {
          errId: "",
          errMessage: "",
          detailPastJsonInfo: [
            {
              detailAvailableFlag: true,
              detailMonth: "0",
              payAmount: "0",
              payAmountDispFlag: true,
              settlementYM: "2026年9月",
            },
            {
              detailAvailableFlag: true,
              detailMonth: "1",
              payAmount: "0",
              payAmountDispFlag: true,
              settlementYM: "2026年8月",
            },
          ],
        },
      }),
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-detail",
      "credit-detail-00.html",
      html("credit-detail", '<a href="/iss-pc/member/details_inquiry/current">detail</a>'),
      "unconfirmed",
      "detailMonth-0",
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-ledger",
      "credit-ledger-00.json",
      ledger(0, "detailMonth-0", "unconfirmed"),
      "unconfirmed",
      "detailMonth-0",
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-detail",
      "credit-detail-01.html",
      html("credit-detail", '<a href="/iss-pc/member/details_inquiry/previous">detail</a>'),
      "confirmed",
      "detailMonth-1",
    ),
    await putArtifact(
      bucket,
      "primary",
      "credit-ledger",
      "credit-ledger-01.json",
      ledger(1, "detailMonth-1", "confirmed"),
      "confirmed",
      "detailMonth-1",
    ),
    await putArtifact(
      bucket,
      "primary",
      "discovery",
      "discovery.json",
      JSON.stringify({
        schemaVersion: 1,
        bootstrapMode: "passkey",
        cards: [{ localId: "card-001", productHint: "JCB W", switchCandidate: false }],
        periodCount: 2,
        cookieCount: 3,
        limitations: [
          "Root-card switching remains discovery-only until its current POST contract is observed.",
          "Passkey bootstrap uses an imported Bitwarden credential with a zero signature counter.",
        ],
      }),
    ),
  ];
  await putManifest(bucket, {
    schemaVersion: "myjcb-worker-poc-v1",
    source: "myjcb",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: "success",
    trigger: "manual",
    connections: [
      {
        connectionId: "primary",
        bootstrapMode: "passkey",
        status: "success",
        cardCount: 1,
        periodCount: 2,
        artifactCount: artifacts.length,
      },
    ],
    artifacts,
    failures: [],
  });
}

export async function storeFailedRun(bucket: FakeBucket): Promise<void> {
  await putManifest(bucket, {
    schemaVersion: "myjcb-worker-poc-v1",
    source: "myjcb",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: "failed",
    trigger: "scheduled",
    connections: [
      {
        connectionId: "primary",
        bootstrapMode: "passkey",
        status: "failed",
        cardCount: 0,
        periodCount: 0,
        artifactCount: 0,
        blocker: "collect-credit",
      },
    ],
    artifacts: [],
    failures: [
      {
        connectionId: "primary",
        operation: "collect",
        errorType: "StopConditionError",
        message: "collect-credit",
      },
    ],
  });
}

export async function storeMaxConnectionsRun(bucket: FakeBucket): Promise<void> {
  const artifacts: Array<Record<string, unknown>> = [];
  const connections: Array<Record<string, unknown>> = [];
  for (let index = 1; index <= 16; index += 1) {
    const connectionId = `account-${String(index).padStart(2, "0")}`;
    const connectionArtifacts = [
      await putArtifact(
        bucket,
        connectionId,
        "credit-menu",
        "credit-menu.html",
        html("credit-menu", "<span>detailMonth generalJsonShikibetuId</span>"),
      ),
      await putArtifact(
        bucket,
        connectionId,
        "credit-past-months",
        "credit-past-months.json",
        JSON.stringify({
          jsonrpc: "2.0",
          id: "030100601",
          result: {
            errId: "",
            errMessage: "",
            detailPastJsonInfo: [
              {
                detailAvailableFlag: true,
                detailMonth: "0",
                payAmount: "0",
                payAmountDispFlag: true,
                settlementYM: "2026年9月",
              },
            ],
          },
        }),
      ),
      await putArtifact(
        bucket,
        connectionId,
        "credit-detail",
        "credit-detail-00.html",
        html("credit-detail", '<a href="/iss-pc/member/details_inquiry/current">detail</a>'),
        "unconfirmed",
        "detailMonth-0",
      ),
      await putArtifact(
        bucket,
        connectionId,
        "credit-ledger",
        "credit-ledger-00.json",
        ledger(0, "detailMonth-0", "unconfirmed"),
        "unconfirmed",
        "detailMonth-0",
      ),
      await putArtifact(
        bucket,
        connectionId,
        "discovery",
        "discovery.json",
        JSON.stringify({
          schemaVersion: 1,
          bootstrapMode: "passkey",
          cards: [{ localId: "card-001", productHint: "JCB W", switchCandidate: false }],
          periodCount: 1,
          cookieCount: 1,
          limitations: [
            "Root-card switching remains discovery-only until its current POST contract is observed.",
            "Passkey bootstrap uses an imported Bitwarden credential with a zero signature counter.",
          ],
        }),
      ),
    ];
    artifacts.push(...connectionArtifacts);
    connections.push({
      connectionId,
      bootstrapMode: "passkey",
      status: "success",
      cardCount: 1,
      periodCount: 1,
      artifactCount: connectionArtifacts.length,
    });
  }
  await putManifest(bucket, {
    schemaVersion: "myjcb-worker-poc-v1",
    source: "myjcb",
    runId: RUN_ID,
    startedAt: "2026-09-05T00:00:00.000Z",
    completedAt: "2026-09-05T00:01:00.000Z",
    status: "success",
    trigger: "manual",
    connections,
    artifacts,
    failures: [],
  });
}

export async function putArtifact(
  bucket: FakeBucket,
  connectionId: string,
  dataset: string,
  filename: string,
  text: string,
  statementState?: string,
  period?: string,
): Promise<Record<string, unknown>> {
  const body = encode(text);
  const sha256 = await sha256Hex(body);
  const mediaType = filename.endsWith(".html") ? "text/html; charset=utf-8" : "application/json";
  const key = `${PREFIX}${connectionId}/${filename}`;
  bucket.objects.set(
    key,
    await stored(body, mediaType, {
      source: "myjcb",
      dataset,
      sha256,
      ...(statementState ? { statementState } : {}),
      ...(period ? { period } : {}),
    }),
  );
  return {
    dataset,
    key,
    mediaType,
    sha256,
    bytes: body.byteLength,
    ...(statementState ? { statementState } : {}),
    ...(period ? { period } : {}),
  };
}

export async function putManifest(
  bucket: FakeBucket,
  manifest: Record<string, unknown>,
): Promise<void> {
  const body = encode(JSON.stringify(manifest));
  bucket.objects.set(
    MANIFEST_KEY,
    await stored(body, "application/json", {
      source: "myjcb",
      status: String(manifest.status),
      runId: RUN_ID,
    }),
  );
}

export async function rewriteArtifactHash(
  bucket: FakeBucket,
  key: string,
  body: Uint8Array,
): Promise<void> {
  const manifestObject = bucket.objects.get(MANIFEST_KEY)!;
  const manifest = JSON.parse(new TextDecoder().decode(manifestObject.body)) as {
    artifacts: Array<{ key: string; sha256: string; bytes: number }>;
  } & Record<string, unknown>;
  const artifact = manifest.artifacts.find((entry) => entry.key === key)!;
  artifact.sha256 = await sha256Hex(body);
  artifact.bytes = body.byteLength;
  await putManifest(bucket, manifest);
}

export function readManifest(bucket: FakeBucket): {
  status: string;
  artifacts: Array<{ dataset: string; key: string; sha256: string; bytes: number }>;
  connections: Array<{ status: string; artifactCount: number; blocker?: string }>;
  failures: Array<{ connectionId: string; operation: string; errorType: string; message: string }>;
} & Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bucket.objects.get(MANIFEST_KEY)!.body));
}

export async function stored(
  body: Uint8Array,
  contentType: string,
  customMetadata: Record<string, string>,
): Promise<StoredObject> {
  return { body, contentType, customMetadata, nativeSha256: await sha256Hex(body) };
}

export function html(_dataset: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><html><body>MyJCB details_inquiry ${body}</body></html>`;
}

export function ledger(
  detailMonth: number,
  period: string,
  state: "confirmed" | "unconfirmed",
): string {
  return JSON.stringify({
    schemaVersion: 1,
    detailMonth,
    period,
    state,
    headers:
      state === "unconfirmed"
        ? ["ご利用日", "ご利用先など", "支払区分", "ご利用金額"]
        : ["ご利用日", "ご利用先など", "支払区分", "今回のお支払い金額"],
    rows: [],
  });
}

export async function normalizedDescriptorSha256(
  descriptor: Record<string, unknown>,
): Promise<string> {
  const { http, storage, file, email, ...fields } = descriptor;
  return sha256Hex(
    encode(
      canonicalJson({
        ...fields,
        origins: {
          http: http ?? null,
          storage: storage ?? null,
          file: file ?? null,
          email: email ?? null,
        },
      }),
    ),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

export function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
