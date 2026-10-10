// Execution availability is not configuration validity. Adapters explicitly
// enumerate installed capabilities; no configuration value can install a writer.
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
  | "delegation_processor_unavailable"
  | "delegation_adapter_unavailable";

export type DelegationExecutionReason =
  | DelegationRefusal
  | "unsupported_semantics"
  | "delegation_capability_denied"
  | "delegation_execution_unavailable"
  | "ready";

export function delegationExecutionReadiness(
  resolution: DelegationResolution,
  capability: string,
  installed: readonly DelegationCapability[] = [],
): {
  available: boolean;
  reason: DelegationExecutionReason;
  blockedBy: readonly DelegationExecutionBlocker[];
} {
  if (!(DELEGATION_CAPABILITIES as readonly string[]).includes(capability))
    return { available: false, reason: "unsupported_semantics", blockedBy: [] };
  if (!resolution.ok) return { available: false, reason: resolution.code, blockedBy: [] };
  if (!resolution.principal.capabilities.includes(capability as DelegationCapability))
    return { available: false, reason: "delegation_capability_denied", blockedBy: [] };
  if (installed.includes(capability as DelegationCapability))
    return { available: true, reason: "ready", blockedBy: [] };
  if (
    installed.length > 0 &&
    (capability.startsWith("commands.decide.") ||
      capability === "operations.collection.request" ||
      capability === "operations.session.refresh")
  )
    return {
      available: false,
      reason: "delegation_execution_unavailable",
      blockedBy: ["delegation_adapter_unavailable"],
    };
  if (installed.length > 0)
    return {
      available: false,
      reason: "delegation_execution_unavailable",
      blockedBy: ["delegation_adapter_unavailable"],
    };
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
export function delegationCapabilities(
  resolution: DelegationResolution,
  installed: readonly DelegationCapability[] = [],
) {
  const available =
    resolution.ok && resolution.principal.capabilities.some((c) => installed.includes(c));
  return {
    schemaVersion: "kogane-delegation-capabilities-v1" as const,
    available,
    reason: resolution.ok
      ? available
        ? "ready"
        : "delegation_execution_unavailable"
      : resolution.code,
    configuration: resolution.ok ? ("valid" as const) : ("inactive" as const),
    capabilities: resolution.ok
      ? resolution.principal.capabilities.map((capability) => ({
          capability,
          ...delegationExecutionReadiness(resolution, capability, installed),
        }))
      : [],
  };
}
