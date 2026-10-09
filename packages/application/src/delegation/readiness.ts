// Execution availability is not configuration validity. There is deliberately
// no enabling flag: #619's common audited operation path, prepare/confirm and
// Processor delegation guards must be connected in a separately reviewed S3.
import {
  DELEGATION_CAPABILITIES,
  type DelegationCapability,
  type DelegationRefusal,
  type DelegationResolution,
} from "./contract.ts";

export type DelegationExecutionBlocker =
  | "delegation_audit_unavailable"
  | "delegation_operation_path_unavailable"
  | "delegation_confirmation_unavailable"
  | "delegation_processor_unavailable";

export type DelegationExecutionReason =
  | DelegationRefusal
  | "unsupported_semantics"
  | "delegation_capability_denied"
  | "delegation_execution_unavailable";

export function delegationExecutionReadiness(
  resolution: DelegationResolution,
  capability: string,
): {
  available: false;
  reason: DelegationExecutionReason;
  blockedBy: readonly DelegationExecutionBlocker[];
} {
  if (!(DELEGATION_CAPABILITIES as readonly string[]).includes(capability))
    return { available: false, reason: "unsupported_semantics", blockedBy: [] };
  if (!resolution.ok) return { available: false, reason: resolution.code, blockedBy: [] };
  if (!resolution.principal.capabilities.includes(capability as DelegationCapability))
    return { available: false, reason: "delegation_capability_denied", blockedBy: [] };
  const blockedBy: DelegationExecutionBlocker[] = [
    "delegation_audit_unavailable",
    "delegation_operation_path_unavailable",
  ];
  if (capability.startsWith("commands.") || capability.startsWith("schedules."))
    blockedBy.push("delegation_processor_unavailable");
  if (
    capability.startsWith("commands.decide.") ||
    capability === "schedules.job.update" ||
    capability === "schedules.survey.decide" ||
    capability === "operations.collection.request" ||
    capability === "operations.session.refresh"
  )
    blockedBy.push("delegation_confirmation_unavailable");
  return { available: false, reason: "delegation_execution_unavailable", blockedBy };
}

/** Safe public status: no delegator, scope, reference, expiry or other entry. */
export function delegationCapabilities(resolution: DelegationResolution) {
  return {
    schemaVersion: "kogane-delegation-capabilities-v1" as const,
    available: false as const,
    reason: resolution.ok ? "delegation_execution_unavailable" : resolution.code,
    configuration: resolution.ok ? ("valid" as const) : ("inactive" as const),
    capabilities: resolution.ok
      ? resolution.principal.capabilities.map((capability) => ({
          capability,
          ...delegationExecutionReadiness(resolution, capability),
        }))
      : [],
  };
}
