// Cross-package check for descriptor-v1 (PR A02 / finding D05): every golden
// vector is pushed through the importer's real CentralClient path (typed
// request → JSON body → server-side parse/normalize/encode/digest) and through
// centralDescriptorSha256, and both must reproduce the digests that the
// PRE-REFACTOR implementations recorded in the fixture.
import { describe, expect, test } from "bun:test";
import {
  ContractError,
  descriptorContractV1,
  type ArtifactRequest,
} from "../../../packages/evidence-contract/src/index";
import { CentralClient, centralDescriptorSha256 } from "../src/central";

interface VectorResult {
  normalized: unknown;
  canonical: string;
  sha256: string;
}
interface Vector {
  name: string;
  runId: number;
  sameClientDigestAs?: string;
  sameServerDigestAs?: string;
  input: Record<string, unknown>;
  client: VectorResult | { error: string };
  server: VectorResult | { error: string };
}
interface Fixture {
  contractVersion: string;
  vectors: Vector[];
}

const fixture = JSON.parse(
  await Bun.file(
    new URL("../../../packages/evidence-contract/fixtures/golden-vectors.json", import.meta.url),
  ).text(),
) as Fixture;
const TOKEN = "importer.synthetic-token-with-twenty-plus-characters";

/** Behaves like raw-evidence addArtifact: validate, normalize, encode, digest. */
class FakeIngest {
  readonly bodies: string[] = [];
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = await request.text();
    this.bodies.push(body);
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const match = /^\/v1\/runs\/(\d+)\/artifacts$/u.exec(path);
    if (!match) return Response.json({ error: "not_found" }, { status: 404 });
    try {
      const validated = descriptorContractV1.parseRequest(JSON.parse(body), {
        runId: Number(match[1]),
      });
      const bytes = descriptorContractV1.encode(descriptorContractV1.normalize(validated));
      return Response.json(
        { descriptorSha256: await descriptorContractV1.digest(bytes) },
        { status: 201 },
      );
    } catch (error) {
      if (error instanceof ContractError) {
        return Response.json({ error: error.code }, { status: 400 });
      }
      throw error;
    }
  };
}

describe("descriptor-v1 golden vectors through CentralClient", () => {
  const ingest = new FakeIngest();
  const central = new CentralClient(ingest as unknown as Fetcher, TOKEN, "importer");

  for (const vector of fixture.vectors) {
    test(vector.name, async () => {
      const input = structuredClone(vector.input) as unknown as ArtifactRequest;
      if ("error" in vector.client) {
        await expect(centralDescriptorSha256(input)).rejects.toThrow(vector.client.error);
      } else {
        expect(await centralDescriptorSha256(input)).toBe(vector.client.sha256);
      }
      if ("error" in vector.server) {
        await expect(central.addArtifact(vector.runId, input)).rejects.toThrow(
          `central_400_${vector.server.error}`,
        );
        return;
      }
      const accepted = await central.addArtifact(vector.runId, input);
      expect(accepted).toBe(vector.server.sha256);
      // The importers fail closed when the server's digest differs from the
      // locally computed one; the fixture records for which inputs that is.
      if (!("error" in vector.client)) {
        expect(accepted === vector.client.sha256).toBe(
          vector.client.sha256 === vector.server.sha256,
        );
      }
    });
  }

  test("the wire body is the request exactly as given, without client-side normalization", () => {
    const vector = fixture.vectors.find((entry) => entry.name === "canonical-storage-explicit")!;
    expect(ingest.bodies).toContain(JSON.stringify(vector.input));
  });
});
