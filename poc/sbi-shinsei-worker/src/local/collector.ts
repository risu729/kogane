import { parseCredential } from "../credential";
import { SbiShinseiLoginTransport } from "../login";
import { normalizeCoreResponses } from "../normalized";
import {
  noBodyRequest,
  YEN_DEPOSIT_SCREEN_GROUP_ID,
  yenDepositAccountRequest,
} from "../requests";
import { InMemorySessionState } from "../session";
import { SbiShinseiReadTransport } from "../transport";
import type {
  JscProvider,
  NormalizedSnapshot,
  RawArtifact,
} from "../types";

export interface LocalCollectorResult {
  artifacts: RawArtifact[];
  normalized: NormalizedSnapshot;
}

/** Diagnostic only: moves CAFIS material from Chrome to a WSL fetch client. */
export async function collectHybridLocalSbiShinsei(options: {
  credentialJson: string;
  jscProvider: JscProvider;
  fetch: typeof fetch;
  now?: () => Date;
}): Promise<LocalCollectorResult> {
  const credential = parseCredential(options.credentialJson);
  const material = await options.jscProvider.acquire();
  const login = new SbiShinseiLoginTransport({ fetch: options.fetch });
  const session = new InMemorySessionState(
    await login.login(credential, material),
  );
  const transport = new SbiShinseiReadTransport({
    fetch: options.fetch,
    session,
    executionProfile: "local-captured-validation",
    userAgent: material.userAgent,
  });

  // Keep all calls sequential. A known response may rotate the CSRF token.
  await transport.call(noBodyRequest("common.security-connect"));
  await transport.call(noBodyRequest("common.validate-token"));
  const topBalances = await transport.callWithRaw(
    noBodyRequest("top.accounts-balance-and-activity"),
  );
  const balanceSummary = await transport.callWithRaw(
    noBodyRequest("top.balance-summary-and-stage"),
  );
  const exchangeRate = await transport.callWithRaw(
    noBodyRequest("common.exchange-rate"),
  );
  const yenDeposit = await transport.callWithRaw(
    yenDepositAccountRequest(YEN_DEPOSIT_SCREEN_GROUP_ID),
  );

  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const normalized = normalizeCoreResponses({
    capturedAt,
    topBalances: topBalances.data,
  });
  return {
    normalized,
    artifacts: [
      jsonArtifact(
        "top-accounts-balance-and-activity",
        "raw-top-accounts-balance-and-activity.json",
        topBalances.rawBody,
      ),
      jsonArtifact(
        "balance-summary-and-stage",
        "raw-balance-summary-and-stage.json",
        balanceSummary.rawBody,
      ),
      jsonArtifact(
        "exchange-rate",
        "raw-exchange-rate.json",
        exchangeRate.rawBody,
      ),
      jsonArtifact(
        "yen-deposit-account",
        "raw-yen-deposit-account.json",
        yenDeposit.rawBody,
      ),
      jsonArtifact(
        "normalized",
        "normalized.json",
        `${JSON.stringify(normalized, null, 2)}\n`,
      ),
    ],
  };
}

function jsonArtifact(
  dataset: string,
  filename: string,
  body: string,
): RawArtifact {
  return { dataset, filename, mediaType: "application/json", body };
}
