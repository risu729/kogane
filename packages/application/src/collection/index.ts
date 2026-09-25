// Shared-R2 collection use cases (unified plan 03 §4, U08).
//
// The Processor imports this barrel; the Queue consumer and the cron scan
// both call `registerTerminal`, so "a terminal was delivered" and "a terminal
// was found by the scan" run exactly the same registration.
export {
  ARTIFACT_STEP_BASE,
  AUDIT_RESERVE,
  DOCUMENTED_LIMITS,
  FINAL_STEP_RESERVE,
  inventoryChunkReserve,
  meterBucket,
  meterD1,
  OperationMeter,
  PREAMBLE_RESERVE,
  REGISTRATION_OPERATION_BUDGET,
  RegistrationBudget,
  STRUCTURE_STEP_RESERVE,
} from "./budget.ts";
export {
  artifactRequest,
  createRunRequest,
  EXTERNAL_ID_NAMESPACE,
  instantMs,
  REGISTRATION_CONTRACT_VERSION,
  runRangeRequests,
  runReportRequest,
  TerminalRegistrationError,
  unitReportRequest,
  unitRequest,
} from "./descriptors.ts";
export {
  artifactStepReserve,
  DEFAULT_ARTIFACT_BUDGET,
  DEFAULT_INVENTORY_CHUNK,
  DIRECT_SEAL_ARTIFACTS,
  registerTerminal,
  type RegisterTerminalInput,
  type RegisterTerminalOutcome,
  type RegistrationPhase,
} from "./register-terminal.ts";
