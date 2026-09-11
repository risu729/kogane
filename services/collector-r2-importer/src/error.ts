// `ImportError` moved to the Processor with the rest of the reconcile logic
// (unified plan 02 §2, U08). This module keeps the historical import path for
// this Worker, which keeps running unchanged until U15; there is no second
// implementation.
export { ImportError } from "../../observation-pipeline/src/legacy-import/error.ts";
