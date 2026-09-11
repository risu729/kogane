// Shared-R2 collection use cases (unified plan 03 §4, U08).
//
// The Processor imports this barrel; the Queue consumer and the cron scan
// both call `registerTerminal`, so "a terminal was delivered" and "a terminal
// was found by the scan" run exactly the same registration.
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
  DEFAULT_ARTIFACT_BUDGET,
  DEFAULT_INVENTORY_CHUNK,
  DIRECT_SEAL_ARTIFACTS,
  registerTerminal,
  type RegisterTerminalInput,
  type RegisterTerminalOutcome,
} from "./register-terminal.ts";
