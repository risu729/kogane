// U09 sanitization parity: the bytes a collector persists in
// `COLLECTION_TARGET=shared` mode are the bytes this importer stores centrally
// for the same run today.
//
// For three of the four group-1 sources the same synthetic legacy run is (a)
// validated by this importer, which yields the per-artifact bytes and digests
// it would upload, and (b) mapped by the collector's own shared-target plan
// from the same raw inputs. The two must name the same digest for every
// artifact key. The importer is the reference: it is what defines "what
// reaches central storage" while the legacy path is deployed.
//
// The one artifact that cannot be byte-identical is the collector manifest of
// the sources whose manifest names bucket keys (Sony Bank, Money Forward,
// MyJCB): the legacy manifest points at `raw/…` paths and the shared one at
// the content-addressed objects that were actually written. Those are compared
// field by field with the keys substituted. Vpass has no key in its central
// manifest, so it is compared byte for byte like every other artifact.
//
// Synthetic fixtures only: every value is invented and no provider is
// contacted.
//
// MyJCB's case lives with its collector
// (`services/collector-myjcb/test/shared-parity.test.ts`) because its fixture
// is built from the collector's own page redaction, whose module is compiled
// under that workspace's options; it imports this importer the same way.
import { describe, expect, test } from "bun:test";
import { objectKey } from "../../../packages/collection/src/index";
import {
  moneyForwardRunPlan,
  type SharedRunInput as MoneyForwardInput,
} from "../../collector-moneyforward/src/shared-collection";
import {
  sonyBankRunPlan,
  type SharedRunInput as SonyInput,
} from "../../collector-sony-bank/src/shared-collection";
import { vpassCardRunPlan } from "../../collector-vpass/src/shared-collection";
import { validateMoneyForwardRun } from "../src/moneyforward";
import { validateSonyRun } from "../src/sony";
import { validateVpassRun } from "../src/vpass";
import type { PersistRunPlan } from "../../../packages/collection/src/index";
import * as moneyforward from "./synthetic/moneyforward";
import * as vpass from "./synthetic/vpass";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function digestsOf(plan: PersistRunPlan): Record<string, string> {
  return Object.fromEntries(
    plan.artifacts.map((artifact) => [artifact.artifactKey, artifact.sha256]),
  );
}

function planBytes(plan: PersistRunPlan, artifactKey: string): Uint8Array {
  const artifact = plan.artifacts.find((entry) => entry.artifactKey === artifactKey);
  if (!artifact || artifact.body.kind !== "bytes") throw new Error(`missing ${artifactKey}`);
  return artifact.body.bytes;
}

type ManifestArtifact = Record<string, unknown> & { key: string; sha256: string };

/** The fields a collector manifest states about an artifact, key aside. */
function artifactFields(artifact: ManifestArtifact, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, artifact[key]]));
}

describe("Vpass: the shared plan stores the importer's sanitized bytes", () => {
  test("every artifact, the manifest included, has the digest the importer uploads", async () => {
    const bucket = vpass.cardSnapshotBucket();
    const central = await validateVpassRun(bucket as unknown as R2Bucket, vpass.CARD_RECORD);

    const snapshot = JSON.parse(
      decode(bucket.values.get(`${vpass.CARD_PREFIX}snapshot.json`)!.bytes),
    ) as {
      cardListRawJson: string;
      selectCardRawJson: string;
      webMeisaiTopRawJson: string;
      months: Record<
        string,
        {
          pages: { kind: "top" | "answer"; index: number; rawJson: string }[];
          transactionCount: number;
        }
      >;
    };
    const record = JSON.parse(decode(bucket.values.get(vpass.CARD_RECORD)!.bytes)) as {
      startedAt: string;
      completedAt: string;
    };
    const plan = await vpassCardRunPlan({
      sessionRunId: vpass.RUN_ID,
      cardLabel: "card-001",
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      cardListRawJson: snapshot.cardListRawJson,
      selectCardRawJson: snapshot.selectCardRawJson,
      webMeisaiTopRawJson: snapshot.webMeisaiTopRawJson,
      months: snapshot.months,
    });

    const expected = Object.fromEntries(
      central.artifacts.map((artifact) => [artifact.artifactKey, artifact.sha256]),
    );
    expect(central.artifacts.length).toBe(6);
    expect(digestsOf(plan)).toEqual(expected);
    // The stored bytes carry the sanitizer's markers and none of the session
    // material the raw envelopes held (G3-07/G3-08).
    for (const artifact of plan.artifacts) {
      const text = decode(planBytes(plan, artifact.artifactKey));
      expect(text).not.toContain("private-session-token");
      expect(text).not.toContain("private-card-key");
      expect(text).not.toContain("Card ending 1234");
    }
    expect(decode(planBytes(plan, "card-list.json"))).toContain("<redacted-card-reference>");
    expect(decode(planBytes(plan, "select-card.json"))).toContain("<redacted-vpass-sensitive>");
  });
});

describe("Money Forward: the shared plan stores the pages the importer forwards", () => {
  test("page digests are identical and the manifest differs only in its keys", async () => {
    const bucket = new moneyforward.FakeBucket();
    await moneyforward.storeSuccessRun(bucket, 2);
    const central = await validateMoneyForwardRun(
      bucket as unknown as R2Bucket,
      moneyforward.MANIFEST_KEY,
    );
    const legacy = moneyforward.readManifest(bucket) as unknown as Record<string, unknown> & {
      artifacts: (ManifestArtifact & { dataset: string; mediaType: string })[];
    };

    const input: MoneyForwardInput = {
      schemaVersion: legacy.schemaVersion as string,
      runId: legacy.runId as string,
      startedAt: legacy.startedAt as string,
      completedAt: legacy.completedAt as string,
      status: "success",
      accountDetailCount: legacy.accountDetailCount as number,
      monthlyFragmentCount: legacy.monthlyFragmentCount as number,
      artifacts: legacy.artifacts.map((artifact) => ({
        dataset: artifact.dataset,
        filename: artifact.key.slice(moneyforward.PREFIX.length),
        mediaType: artifact.mediaType,
        body: decode(bucket.objects.get(artifact.key)!.body),
      })),
      failures: [],
    };
    const plan = await moneyForwardRunPlan(input);

    const expected = Object.fromEntries(
      central.artifacts.map((entry) => [entry.artifact.filename, entry.artifact.sha256]),
    );
    expect(central.artifacts.length).toBe(1 + 2 + 2 * 12);
    const { "manifest.json": sharedManifestDigest, ...sharedPages } = digestsOf(plan);
    expect(sharedPages).toEqual(expected);
    expect(sharedManifestDigest).toBeDefined();

    // The manifest: the same run, the same artifacts in the same order, the
    // same normalization (failure message → code). The legacy manifest names
    // `raw/…` keys the shared run never wrote; the shared one names the
    // content-addressed object of each artifact. The importer additionally
    // re-serializes its parsed view — `filename`, `kind`, `accountOrdinal`,
    // `month` ride along in the central bytes today — which the shared
    // manifest, the collector's own record, does not carry.
    const centralManifest = JSON.parse(decode(central.centralManifestBytes)) as Record<
      string,
      unknown
    > & { artifacts: ManifestArtifact[]; failures: unknown[] };
    const sharedManifest = JSON.parse(decode(planBytes(plan, "manifest.json"))) as Record<
      string,
      unknown
    > & { artifacts: ManifestArtifact[]; failures: unknown[] };
    const fields = ["dataset", "mediaType", "sha256", "bytes"];
    expect(sharedManifest.artifacts.map((entry) => artifactFields(entry, fields))).toEqual(
      centralManifest.artifacts.map((entry) => artifactFields(entry, fields)),
    );
    expect(sharedManifest.artifacts.map((entry) => entry.key)).toEqual(
      centralManifest.artifacts.map((entry) => objectKey(entry.sha256)),
    );
    expect(sharedManifest.artifacts.map((entry) => Object.keys(entry))).toEqual(
      legacy.artifacts.map((entry) => Object.keys(entry)),
    );
    expect(
      [
        ...new Set(
          centralManifest.artifacts.flatMap((entry) =>
            Object.keys(entry).filter((key) => !Object.hasOwn(sharedManifest.artifacts[0]!, key)),
          ),
        ),
      ].sort(),
    ).toEqual(["accountOrdinal", "filename", "kind", "month"]);
    const { artifacts: _c, failures: _cf, ...centralRest } = centralManifest;
    const { artifacts: _s, failures: _sf, ...sharedRest } = sharedManifest;
    expect(sharedRest).toEqual(centralRest);
    expect(sharedManifest.failures).toEqual(centralManifest.failures);
    expect(Object.keys(sharedManifest)).toEqual(Object.keys(centralManifest));
  });
});

describe("Sony Bank: the shared plan stores the bytes the importer forwards verbatim", () => {
  const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
  const PREFIX = `raw/sony-bank/2026/09/03/${RUN_ID}/`;
  const MANIFEST_KEY = `${PREFIX}manifest.json`;
  const WINDOW = { from: "2025-09-04", to: "2026-09-03" };
  const WALLET_MONTHS = ["202608", "202607"];
  const CURRENCIES = ["usd", "eur", "gbp", "aud", "nzd", "cad", "chf", "hkd", "zar", "sek"];

  interface Stored {
    body: Uint8Array;
    customMetadata: Record<string, string>;
    contentType: string;
  }

  class FakeBucket {
    readonly objects = new Map<string, Stored>();
    async get(key: string) {
      const value = this.objects.get(key);
      if (!value) return null;
      return {
        key,
        size: value.body.byteLength,
        customMetadata: value.customMetadata,
        httpMetadata: { contentType: value.contentType },
        checksums: {},
        arrayBuffer: async () => {
          const copy = new Uint8Array(value.body.byteLength);
          copy.set(value.body);
          return copy.buffer;
        },
      } as unknown as R2ObjectBody;
    }
    async list(options: R2ListOptions = {}) {
      const keys = [...this.objects.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .sort();
      return { objects: keys.map((key) => ({ key })), truncated: false } as unknown as R2Objects;
    }
  }

  const jsonBody = (value: unknown) => encode(`${JSON.stringify(value)}\n`);
  const pageBody = (rowCount: number, countCnt: number) =>
    jsonBody({
      transactionHistInfo: Array.from({ length: rowCount }, (_, index) => ({ fixture: index })),
      countCnt,
    });
  const walletHtml = (months: string[], selectedMonth: string) =>
    `<html><input type="hidden" name="cc" value=""><select name="W131301.referenceDate">${months
      .map(
        (month) =>
          `<option value="${month}01"${month === selectedMonth ? " selected" : ""}>${month}</option>`,
      )
      .join("")}</select></html>`;
  const filenameFor = (dataset: string) => {
    if (dataset === "yen-history-csv") return "yen-history.csv";
    const foreignCsv = /^foreign-history-([a-z]{3})-csv$/u.exec(dataset);
    if (foreignCsv) return `foreign-history-${foreignCsv[1]}.csv`;
    const wallet = /^wallet-history-(\d{4})(\d{2})$/u.exec(dataset);
    if (wallet) return `wallet-history-${wallet[1]}-${wallet[2]}.html`;
    return `${dataset}.json`;
  };

  test("artifact digests are identical and the manifest differs only in its keys", async () => {
    const entries: { dataset: string; body: Uint8Array; mediaType: string }[] = [
      {
        dataset: "gross-balance",
        body: jsonBody({ balance: "fixture" }),
        mediaType: "application/json",
      },
      { dataset: "yen-history-page-0001", body: pageBody(3, 4), mediaType: "application/json" },
      { dataset: "yen-history-page-0002", body: pageBody(1, 4), mediaType: "application/json" },
      {
        dataset: "yen-history-csv",
        body: encode("date,amount\n2026-09-03,1\n"),
        mediaType: "text/csv",
      },
    ];
    for (const currency of CURRENCIES) {
      const count = currency === "usd" ? 2 : 0;
      entries.push({
        dataset: `foreign-history-${currency}-page-0001`,
        body: pageBody(count, count),
        mediaType: "application/json",
      });
      if (count > 0) {
        entries.push({
          dataset: `foreign-history-${currency}-csv`,
          body: encode("date,amount\n2026-09-03,1\n"),
          mediaType: "application/octet-stream",
        });
      }
    }
    for (const month of WALLET_MONTHS) {
      entries.push({
        dataset: `wallet-history-${month}`,
        body: encode(walletHtml(WALLET_MONTHS, month)),
        mediaType: "text/html; charset=UTF-8",
      });
    }
    entries.push({
      dataset: "collection-summary",
      body: jsonBody({
        schemaVersion: "sony-bank-collection-summary-v2",
        window: { ...WINDOW },
        transactionCount: 4,
        pageCount: 2,
        foreignCurrencyCount: 10,
        foreignTransactionCount: 2,
        foreignPageCount: 10,
        walletMonthCount: 2,
        cookieNames: ["SESSION"],
      }),
      mediaType: "application/json",
    });

    const bucket = new FakeBucket();
    const manifestArtifacts = [];
    for (const entry of entries) {
      const sha256 = await sha256Hex(entry.body);
      const key = `${PREFIX}${filenameFor(entry.dataset)}`;
      bucket.objects.set(key, {
        body: entry.body,
        customMetadata: { dataset: entry.dataset, sha256 },
        contentType: entry.mediaType,
      });
      manifestArtifacts.push({
        dataset: entry.dataset,
        key,
        mediaType: entry.mediaType,
        sha256,
        bytes: entry.body.byteLength,
      });
    }
    const legacyManifest = {
      schemaVersion: "sony-bank-worker-poc-v2",
      source: "sony-bank" as const,
      runId: RUN_ID,
      startedAt: "2026-09-03T00:00:00.000Z",
      completedAt: "2026-09-03T00:01:00.000Z",
      status: "success" as const,
      window: { ...WINDOW },
      transactionCount: 4,
      artifacts: manifestArtifacts,
      failures: [],
    };
    const legacyBytes = encode(JSON.stringify(legacyManifest));
    bucket.objects.set(MANIFEST_KEY, {
      body: legacyBytes,
      customMetadata: {
        source: "sony-bank",
        status: "success",
        runId: RUN_ID,
        sha256: await sha256Hex(legacyBytes),
      },
      contentType: "application/json",
    });

    const central = await validateSonyRun(bucket as unknown as R2Bucket, MANIFEST_KEY);
    const input: SonyInput = {
      schemaVersion: legacyManifest.schemaVersion,
      runId: RUN_ID,
      startedAt: legacyManifest.startedAt,
      completedAt: legacyManifest.completedAt,
      status: "success",
      window: WINDOW,
      transactionCount: 4,
      artifacts: entries.map((entry) => ({
        dataset: entry.dataset,
        filename: filenameFor(entry.dataset),
        mediaType: entry.mediaType,
        body: decode(entry.body),
      })),
      failures: [],
    };
    const plan = await sonyBankRunPlan(input);

    // The importer uploads every legacy object as it is; the shared plan
    // must name the same digest under the same artifact key.
    const expected = Object.fromEntries(
      central.artifacts.map((entry) => [entry.filename, entry.artifact.sha256]),
    );
    expect(central.artifacts.length).toBe(entries.length);
    const { "manifest.json": sharedManifestDigest, ...sharedArtifacts } = digestsOf(plan);
    expect(sharedArtifacts).toEqual(expected);
    expect(sharedManifestDigest).toBeDefined();

    // The importer forwards the legacy manifest bytes verbatim, so the shared
    // manifest is those bytes with each `raw/…` key replaced by the
    // content-addressed key of the same artifact — nothing else moves.
    let expectedManifest = decode(central.manifestBytes);
    for (const artifact of manifestArtifacts) {
      expectedManifest = expectedManifest.replace(
        JSON.stringify(artifact.key),
        JSON.stringify(objectKey(artifact.sha256)),
      );
    }
    expect(decode(planBytes(plan, "manifest.json"))).toBe(expectedManifest);
  });
});
