import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ArtifactDetail, ArtifactRow, ObservationDetail } from "../shared/api-contract.ts";
import { exportDemo, type DemoSnapshot } from "../src/export-demo.ts";
import { sha256Hex } from "../src/store.ts";
import { LOCAL_STORE_CAPABILITIES } from "../shared/api-schema.ts";

function decode<T>(snapshot: DemoSnapshot, path: string): T {
  const response = snapshot.responses[path];
  expect(response?.status).toBe(200);
  if (response === undefined) throw new Error(`Missing ${path}`);
  return JSON.parse(Buffer.from(response.bodyBase64, "base64").toString("utf8")) as T;
}

describe("synthetic deployment export", () => {
  test("fresh exports are deterministic and every evidence link resolves to exact bytes", async () => {
    const temporaryRoot = resolve(tmpdir());
    const directory = mkdtempSync(join(temporaryRoot, "kogane-export-test-"));
    const before = readdirSync(temporaryRoot).filter((name) =>
      name.startsWith("kogane-demo-export-"),
    );
    try {
      const firstPath = join(directory, "first.json");
      const secondPath = join(directory, "second.json");
      const snapshot = await exportDemo(firstPath);
      await exportDemo(secondPath);
      expect(readFileSync(firstPath).equals(readFileSync(secondPath))).toBe(true);
      expect(snapshot.classification).toBe("synthetic");
      expect(decode(snapshot, "/api/meta")).toMatchObject({
        source: { classification: "synthetic" },
        capabilities: LOCAL_STORE_CAPABILITIES,
      });
      expect(decode<unknown>(snapshot, "/api/meta")).toEqual({
        apiVersion: 1,
        source: { kind: "local-store", classification: "synthetic" },
        capabilities: LOCAL_STORE_CAPABILITIES,
      });
      const listing = decode<{ artifacts: ArtifactRow[] }>(snapshot, "/api/artifacts");
      expect(listing.artifacts.length).toBeGreaterThan(0);
      let observations = 0;
      for (const artifact of listing.artifacts) {
        const detail = decode<ArtifactDetail>(snapshot, `/api/artifacts/${artifact.id}`);
        const raw = snapshot.responses[`/api/raw/${artifact.sha256}`];
        expect(raw).toBeDefined();
        if (raw === undefined) throw new Error("Missing raw artifact");
        const bytes = Buffer.from(raw.bodyBase64, "base64");
        expect(sha256Hex(bytes)).toBe(artifact.sha256);
        expect(bytes.length).toBe(detail.artifact.size);
        expect(raw.contentType).toBe(detail.artifact.content_type);
        for (const parseRun of detail.parseRuns) {
          for (const ref of parseRun.observations) {
            observations += 1;
            const observation = decode<ObservationDetail>(
              snapshot,
              `/api/observations/${ref.kind}/${ref.id}`,
            );
            expect(observation.provenance?.artifact_id).toBe(artifact.id);
            expect(observation.provenance?.parse_run_id).toBe(parseRun.id);
            expect(snapshot.responses[`/api/raw/${observation.provenance?.sha256}`]).toBeDefined();
          }
        }
      }
      expect(observations).toBeGreaterThan(0);
      // Even an output failure must close and remove the temporary SQLite store.
      await expect(exportDemo(directory)).rejects.toThrow();
      expect(
        readdirSync(temporaryRoot).filter((name) => name.startsWith("kogane-demo-export-")),
      ).toEqual(before);
    } finally {
      const target = resolve(directory);
      if (dirname(target) === temporaryRoot && basename(target).startsWith("kogane-export-test-")) {
        rmSync(target, { recursive: true, force: true });
      }
    }
  });
});
