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
  coreSourceId,
  createRunRequest,
  REGISTRATION_CONTRACT_VERSION,
  runRangeRequests,
  unitRequest,
} from "./descriptors.ts";
export {
  DIRECT_SEAL_ARTIFACTS,
  registerTerminal,
  RETRYABLE_RETRY_INTERVAL_MS,
  type RegisterTerminalOutcome,
} from "./register-terminal.ts";
