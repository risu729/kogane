// Freeze the observations and warnings of every coverage-contract case.
//
// Run once, from poc/observation-pipeline, with the parsers as they were
// before they emitted typed issues and coverage claims:
//   bun run scripts/freeze-coverage-contract.ts
// The output is fixtures/coverage-contract/expected.json, which
// test/coverage-contract.test.ts compares against the converted parsers.
// Re-running it after a deliberate observation change is a reviewed fixture
// update, not a routine step.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_PARSERS } from "../test/coverage-contract-cases.ts";

const expected: Record<string, Record<string, unknown>> = {};
for (const { parser, cases } of CONTRACT_PARSERS) {
  const byCase: Record<string, unknown> = {};
  for (const entry of cases) {
    try {
      const result = parser.parse(entry.bytes, entry.artifact);
      byCase[entry.name] = { observations: result.observations, warnings: result.warnings };
      console.log(
        `${parser.name}/${entry.name}: ${result.observations.length} observations, ${result.warnings.length} warnings`,
      );
    } catch {
      byCase[entry.name] = { error: true };
      console.log(`${parser.name}/${entry.name}: throws`);
    }
  }
  expected[parser.name] = byCase;
}
const target = join(import.meta.dir, "..", "fixtures", "coverage-contract", "expected.json");
writeFileSync(target, `${JSON.stringify(expected, null, 2)}\n`);
