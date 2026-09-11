// U09 sanitization parity for MyJCB: the bytes the collector persists in
// `COLLECTION_TARGET=shared` mode are the bytes the importer
// (`services/collector-r2-importer`) stores centrally for the same run today.
// The same synthetic legacy run — the collector's own redacted pages, as the
// legacy path writes them — is validated by the importer and mapped by the
// shared plan; the two must name the same digest for every artifact. The
// sibling cases for Vpass, Sony Bank and Money Forward are in
// `services/collector-r2-importer/test/shared-target-parity.test.ts`.
//
// Synthetic fixtures only: every value is invented and no provider is
// contacted.
import { describe, expect, test } from "bun:test";
import { objectKey, type PersistRunPlan } from "../../../packages/collection/src/index";
import { validateMyJcbRun } from "../../collector-r2-importer/src/myjcb";
import * as myjcb from "../../collector-r2-importer/test/synthetic/myjcb";
import { redactedStatementHtml } from "../src/parsers";
import { myJcbRunPlan, type SharedRunInput as MyJcbInput } from "../src/shared-collection";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

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

describe("MyJCB: the shared plan stores the collector's redacted pages unchanged", () => {
  test("the importer's central normalization is a no-op on collector output", async () => {
    // The legacy bucket holds what the collector wrote: `redactedStatementHtml`
    // over the page. The importer runs its own sanitizer over that again on
    // the way to central storage; shared mode stores the collector bytes
    // directly, so parity means that second pass changes nothing.
    const bucket = new myjcb.FakeBucket();
    const artifacts = [
      await myjcb.putArtifact(
        bucket,
        "primary",
        "credit-menu",
        "credit-menu.html",
        redactedStatementHtml(
          myjcb.html(
            "credit-menu",
            '<span>detailMonth generalJsonShikibetuId</span><input name="token" value="synthetic-secret"><script>alert(1)</script>',
          ),
        ),
      ),
      await myjcb.putArtifact(
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
            ],
          },
        }),
      ),
      await myjcb.putArtifact(
        bucket,
        "primary",
        "credit-detail",
        "credit-detail-00.html",
        redactedStatementHtml(
          myjcb.html(
            "credit-detail",
            '<div class="detail-list-01"><a href="/iss-pc/member/details_inquiry/current">ご利用 お支払い 明細</a><p>1234 5678 9012 3456</p><textarea name="csrf">synthetic</textarea></div>',
          ),
        ),
        "unconfirmed",
        "detailMonth-0",
      ),
      await myjcb.putArtifact(
        bucket,
        "primary",
        "credit-ledger",
        "credit-ledger-00.json",
        myjcb.ledger(0, "detailMonth-0", "unconfirmed"),
        "unconfirmed",
        "detailMonth-0",
      ),
      await myjcb.putArtifact(
        bucket,
        "primary",
        "discovery",
        "discovery.json",
        JSON.stringify({
          schemaVersion: 1,
          bootstrapMode: "passkey",
          cards: [{ localId: "card-001", productHint: "JCB W", switchCandidate: false }],
          periodCount: 1,
          cookieCount: 3,
          limitations: [
            "Root-card switching remains discovery-only until its current POST contract is observed.",
            "Passkey bootstrap uses an imported Bitwarden credential with a zero signature counter.",
          ],
        }),
      ),
    ];
    const connection = {
      connectionId: "primary",
      bootstrapMode: "passkey" as const,
      status: "success" as const,
      cardCount: 1,
      periodCount: 1,
      artifactCount: artifacts.length,
    };
    await myjcb.putManifest(bucket, {
      schemaVersion: "myjcb-worker-poc-v1",
      source: "myjcb",
      runId: myjcb.RUN_ID,
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:01:00.000Z",
      status: "success",
      trigger: "manual",
      connections: [connection],
      artifacts,
      failures: [],
    });
    const central = await validateMyJcbRun(bucket as unknown as R2Bucket, myjcb.MANIFEST_KEY);
    const legacy = myjcb.readManifest(bucket);

    const input: MyJcbInput = {
      schemaVersion: "myjcb-worker-poc-v1",
      runId: myjcb.RUN_ID,
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:01:00.000Z",
      status: "success",
      trigger: "manual",
      connections: [
        {
          summary: connection,
          artifacts: legacy.artifacts.map((artifact) => {
            const stored = artifacts.find((entry) => entry.key === artifact.key)!;
            return {
              dataset: artifact.dataset,
              filename: artifact.key.split("/").at(-1)!,
              mediaType: stored.mediaType as string,
              body: decode(bucket.objects.get(artifact.key)!.body),
              ...(stored.statementState
                ? { statementState: stored.statementState as "confirmed" | "unconfirmed" }
                : {}),
              ...(stored.period ? { period: stored.period as string } : {}),
            };
          }),
        },
      ],
      failures: [],
    };
    const plan = await myJcbRunPlan(input);

    const expected = Object.fromEntries(
      central.artifacts.map((entry) => [
        `${entry.artifact.connectionId}/${entry.artifact.filename}`,
        entry.centralSha256,
      ]),
    );
    expect(central.artifacts.length).toBe(5);
    const { "manifest.json": sharedManifestDigest, ...sharedPages } = digestsOf(plan);
    expect(sharedPages).toEqual(expected);
    expect(sharedManifestDigest).toBeDefined();
    // And the legacy bytes were already the central bytes: the importer's
    // pass over collector output is the identity on this run.
    for (const entry of central.artifacts) {
      expect(entry.centralSha256).toBe(entry.artifact.sha256);
    }
    for (const artifact of plan.artifacts) {
      const text = decode(planBytes(plan, artifact.artifactKey));
      expect(text).not.toContain("synthetic-secret");
      expect(text).not.toContain("1234 5678 9012 3456");
      expect(text).not.toContain("<script");
    }

    const centralManifest = JSON.parse(decode(central.centralManifestBytes)) as Record<
      string,
      unknown
    > & { artifacts: ManifestArtifact[]; connections: unknown[]; failures: unknown[] };
    const sharedManifest = JSON.parse(decode(planBytes(plan, "manifest.json"))) as Record<
      string,
      unknown
    > & { artifacts: ManifestArtifact[]; connections: unknown[]; failures: unknown[] };
    const fields = ["dataset", "mediaType", "sha256", "bytes", "statementState", "period"];
    expect(sharedManifest.artifacts.map((entry) => artifactFields(entry, fields))).toEqual(
      centralManifest.artifacts.map((entry) => artifactFields(entry, fields)),
    );
    expect(sharedManifest.artifacts.map((entry) => entry.key)).toEqual(
      centralManifest.artifacts.map((entry) => objectKey(entry.sha256)),
    );
    // The importer re-serializes its parsed view (`connectionId`, `filename`,
    // `ordinal` ride along centrally today); the shared manifest keeps the
    // collector's own artifact shape.
    expect(
      Object.keys(centralManifest.artifacts[0]!).filter(
        (key) => !Object.hasOwn(sharedManifest.artifacts[0]!, key),
      ),
    ).toEqual(["connectionId", "filename"]);
    expect(sharedManifest.connections).toEqual(centralManifest.connections);
    expect(sharedManifest.failures).toEqual(centralManifest.failures);
    const { artifacts: _c, ...centralRest } = centralManifest;
    const { artifacts: _s, ...sharedRest } = sharedManifest;
    expect(sharedRest).toEqual(centralRest);
    expect(Object.keys(sharedManifest)).toEqual(Object.keys(centralManifest));
  });
});
