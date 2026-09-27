import { parseCredential } from "../credential";
import { SbiShinseiLoginTransport } from "../login";
import { redactPersonNames } from "../name-redaction";
import { normalizeCoreResponses } from "../normalized";
import { noBodyRequest, YEN_DEPOSIT_SCREEN_GROUP_ID, yenDepositAccountRequest } from "../requests";
import { InMemorySessionState } from "../session";
import { getReadRoute } from "../read-allowlist";
import { SbiShinseiReadTransport } from "../transport";
import type {
  JscProvider,
  NormalizedSnapshot,
  RawArtifact,
  ReadOperationId,
  ReadTransportResult,
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
  const session = new InMemorySessionState(await login.login(credential, material));
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
  const exchangeRate = await transport.callWithRaw(noBodyRequest("common.exchange-rate"));
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
      providerCapture(
        "top-accounts-balance-and-activity",
        "raw-top-accounts-balance-and-activity.json",
        "top.accounts-balance-and-activity",
        topBalances,
      ),
      providerCapture(
        "balance-summary-and-stage",
        "raw-balance-summary-and-stage.json",
        "top.balance-summary-and-stage",
        balanceSummary,
      ),
      providerCapture(
        "exchange-rate",
        "raw-exchange-rate.json",
        "common.exchange-rate",
        exchangeRate,
      ),
      providerCapture(
        "yen-deposit-account",
        "raw-yen-deposit-account.json",
        "yen-deposit.account",
        yenDeposit,
      ),
      jsonArtifact("normalized", "normalized.json", `${JSON.stringify(normalized, null, 2)}\n`),
    ],
  };
}

function jsonArtifact(dataset: string, filename: string, body: string): RawArtifact {
  return { dataset, filename, mediaType: "application/json", body };
}

/** A provider response as it may be written: person names already removed. */
function providerCapture(
  dataset: string,
  filename: string,
  operation: ReadOperationId,
  result: ReadTransportResult,
): RawArtifact {
  const redacted = redactPersonNames(
    getReadRoute(operation).responseSchema,
    result.rawBody,
    result.data,
  );
  return {
    ...jsonArtifact(dataset, filename, redacted.body),
    redactedFieldCount: redacted.redactedFieldCount,
  };
}
