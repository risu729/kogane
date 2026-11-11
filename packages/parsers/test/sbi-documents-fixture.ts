import { createHash } from "node:crypto";
import type { ArtifactMeta } from "../src/types.ts";

export function sbiDocumentFixture(
  identity = "a".repeat(64),
  text = "%PDF-1.7\nSynthetic evidence\n%%EOF",
) {
  const bytes = new TextEncoder().encode(text);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const meta: ArtifactMeta = {
    id: 1,
    sourceId: "sbi-securities",
    dataset: "delivered-document-pdf",
    artifactKey: `document-${"b".repeat(64)}-20990101-${identity}-${sha256}.pdf`,
    fetchUnitKey: `mailbox-document-${identity}`,
    runStatus: "success",
    runFailureCount: 0,
    url: null,
    mime: "application/pdf",
    fetchedAt: "2020-01-02T00:00:00Z",
    sha256,
  };
  return { bytes, meta };
}
