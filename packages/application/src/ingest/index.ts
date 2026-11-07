// Registration use cases used in-process by the Processor.
// Contract validation, conflict detection and idempotency live here.
export { type RecordValue } from "./contract.ts";
export { addRunReport, createRun } from "./registration.ts";
export { addUnit, addUnitReport } from "./structure.ts";
export { addArtifact } from "./catalogue.ts";
export { sealRun } from "./seal.ts";
