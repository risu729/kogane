import { UnverifiedReadRouteError } from "./errors";
import { liveReadsEnabled } from "./read-allowlist";
import type { RawArtifact } from "./types";

export interface CollectionWindow {
  from: string;
  to: string;
}

export interface CollectorOutput {
  artifacts: RawArtifact[];
}

export async function collectSbiShinsei(
  _options: { window: CollectionWindow },
): Promise<CollectorOutput> {
  if (!liveReadsEnabled()) {
    throw new UnverifiedReadRouteError(
      "SBI Shinsei live reads are disabled until authenticated request and response capture is complete",
    );
  }

  // This is intentionally unreachable in the first PoC. Authentication and
  // operation ordering are added only after the read schemas are verified.
  throw new UnverifiedReadRouteError(
    "SBI Shinsei authenticated collector flow is not implemented",
  );
}
