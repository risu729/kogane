// Fails when the import adapter registry and the reconciler source table
// disagree. The same check runs under `bun test`; this entry point exists for
// operators and CI steps that want a standalone exit status.
import { IMPORT_ADAPTERS, checkImportAdapterRegistry } from "../src/adapters";

const problems = checkImportAdapterRegistry();
if (problems.length > 0) {
  for (const problem of problems) console.error(`import-adapter-registry: ${problem}`);
  process.exit(1);
}
console.log(`import-adapter-registry: ok sources=${Object.keys(IMPORT_ADAPTERS).length}`);
