// `ImportError` moved to the Processor with the rest of the reconcile logic
// (unified plan 02 §2, U08). This module keeps the historical import path for
// this Worker, which keeps running unchanged until U15; there is no second
// implementation.
export { ImportError } from "../../processor/src/legacy-import/error.ts";
