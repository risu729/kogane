// The audit envelope a test sends to the Processor's writing routes, as the
// App forwards it (ADR 0064): a `ui` path and a fresh correlation id. Synthetic.
import {
  AUDIT_HEADERS,
  type OperationCall,
  type OperationName,
  processorCall,
} from "../../../packages/application/src/index.ts";

export function envelopeHeaders(
  correlationId: string = crypto.randomUUID(),
): Record<string, string> {
  return { [AUDIT_HEADERS.correlationId]: correlationId, [AUDIT_HEADERS.path]: "ui" };
}

/** The audit call a writer receives when a test calls it directly, as the route builds it. */
export function testCall(
  operation: OperationName,
  principal = "operator@synthetic.test",
  correlationId: string = crypto.randomUUID(),
): OperationCall {
  return processorCall({ path: "ui", correlationId }, operation, principal, "human");
}
