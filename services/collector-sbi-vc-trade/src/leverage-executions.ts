import { readGateway, type Fetcher } from "./collector";
import type {
  CollectionFailure,
  CollectionUnit,
  CollectorArtifact,
  SessionMaterial,
} from "./types";

const PAGE_SIZE = 20;

/** Only the four empty leverage views have an observed response contract. */
export async function collectSbiVcLeverageExecutions(options: {
  session: SessionMaterial;
  onSession: (session: SessionMaterial) => Promise<void>;
  onArtifact: (artifact: CollectorArtifact) => Promise<void>;
  diagnostic?: ReturnType<
    typeof import("../../../packages/collector-diagnostics/src/index").createDiagnostics
  >;
  fetcher?: Fetcher;
  sessionStopped?: boolean;
}): Promise<{ units: CollectionUnit[]; failures: CollectionFailure[] }> {
  let session = options.session;
  let stopped = options.sessionStopped === true;
  const units: CollectionUnit[] = [];
  const failures: CollectionFailure[] = [];
  for (const close of [false, true]) {
    for (const historical of [false, true]) {
      const unitKey =
        `executions-leverage-${close ? "close" : "open"}-${historical ? "historical" : "recent"}` as const;
      const unit: CollectionUnit = { unitKey, status: "partial" };
      units.push(unit);
      if (stopped) {
        unit.errorCode = "leverage_execution_session_stopped";
        failures.push({ operation: unitKey, errorCode: unit.errorCode });
        continue;
      }
      try {
        const action = () =>
          readGateway(options.fetcher ?? fetch, session, "executionList", {
            secureKey: session.secureKey,
            historical: String(historical),
            currencyPairs: [],
            fromDate: "",
            toDate: "",
            isActiveStatus: false,
            isTodayOrder: "false",
            isHistory: true,
            isTargetDate: true,
            isAuction: "false",
            sortKey: "executionDatetime",
            sortAsc: "false",
            pageNumber: "0",
            pageSize: String(PAGE_SIZE),
            isExOrder: "false",
            isCloseOrder: String(close),
          });
        const result = options.diagnostic
          ? await options.diagnostic.step(`gateway-${unitKey}`, action)
          : await action();
        session = result.session;
        await options.onSession(session);
        await options.onArtifact({ dataset: `${unitKey}-page-0001`, body: result.sanitizedBody });
        const body = result.body;
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          !("list" in body) ||
          !Array.isArray(body.list)
        ) {
          throw new Error("leverage_execution_invalid_pagination");
        }
        // A populated page stays evidence only, even if it resembles spot rows.
        if (body.list.length !== 0) throw new Error("leverage_execution_rows_unobserved");
        if (
          !("pageSize" in body) ||
          body.pageSize !== PAGE_SIZE ||
          !("pageNumber" in body) ||
          body.pageNumber !== 0 ||
          !("totalSize" in body) ||
          body.totalSize !== 0 ||
          !("totalNumOfPages" in body) ||
          body.totalNumOfPages !== 0
        ) {
          throw new Error("leverage_execution_invalid_pagination");
        }
        throw new Error("leverage_execution_transport_unverified");
      } catch (error) {
        const errorCode = safeError(error);
        unit.errorCode = errorCode;
        failures.push({ operation: unitKey, errorCode });
        stopped =
          errorCode !== "leverage_execution_invalid_pagination" &&
          errorCode !== "leverage_execution_rows_unobserved" &&
          errorCode !== "leverage_execution_transport_unverified";
      }
    }
  }
  return { units, failures };
}

const SAFE_ERRORS = new Set([
  "leverage_execution_transport_unverified",
  "leverage_execution_invalid_pagination",
  "leverage_execution_rows_unobserved",
  "collector_non_json_response",
  "collector_gateway_rejected",
  "collector_invalid_gateway_envelope",
  "collector_response_too_large",
  "collector_missing_response_body",
]);
function safeError(error: unknown): string {
  try {
    const message: unknown = error instanceof Error ? error.message : undefined;
    if (
      typeof message === "string" &&
      (SAFE_ERRORS.has(message) || /^collector_http_[1-5]\d{2}$/u.test(message))
    )
      return message;
  } catch {
    // Exception text and accessors never enter operational records.
  }
  return "leverage_execution_collection_failed";
}
