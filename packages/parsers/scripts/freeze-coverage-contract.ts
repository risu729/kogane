// Freeze the observations and warnings of every coverage-contract case.
//
// Written once with the parsers as they were before they emitted typed issues
// and coverage claims, and kept runnable so the frozen file stays
// regenerable: `mise run parsers:freeze-coverage-contract`.
// The output is `tests/fixtures/observation-pipeline/coverage-contract/expected.json`,
// which `test/coverage-contract.test.ts` compares against the converted
// parsers. Re-running it after a deliberate observation change is a reviewed
// fixture update, not a routine step. It moved here with the parsers it
// freezes (unified plan U04); it used to live in the PoC next to them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_ROOT } from "../test/fixture-root.ts";
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
const target = join(FIXTURES_ROOT, "coverage-contract", "expected.json");
writeFileSync(target, `${JSON.stringify(expected, null, 2)}\n`);
