// Freeze the observations and warnings of every coverage-contract case.
//
// Written once with the parsers as they were before they emitted typed issues
// and coverage claims, and kept runnable so the frozen file stays
// regenerable: `mise run parsers:freeze-coverage-contract`.
// The output is `tests/fixtures/observation-pipeline/coverage-contract/expected.json`
// and the per-source files beside it (`fileOf` below), which `test/coverage-contract.test.ts` compares against the converted
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
// Each case is written to the file that froze it first: the historical
// `expected.json` never grows, and a later source or release adds its own file.
const OBSERVED_SHAPES = new Set([
  "sbi-shinsei-top-balances-and-activity/window-end-not-stated",
  "sbi-shinsei-exchange-rate/observed-board",
  "sbi-shinsei-exchange-rate/jpy-only-not-a-board",
  "sbi-shinsei-exchange-rate/tier-duplicate",
]);
function fileOf(parser: string, name: string): string {
  if (OBSERVED_SHAPES.has(`${parser}/${name}`)) return "sbi-shinsei-observed-shapes-expected.json";
  if (parser === "st-george-balances") return "st-george-expected.json";
  if (parser === "sbi-shinsei-exchange-rate") return "sbi-shinsei-exchange-rate-expected.json";
  return "expected.json";
}
const files: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [parser, byCase] of Object.entries(expected))
  for (const [name, entry] of Object.entries(byCase))
    ((files[fileOf(parser, name)] ??= {})[parser] ??= {})[name] = entry;
for (const [file, content] of Object.entries(files))
  writeFileSync(
    join(FIXTURES_ROOT, "coverage-contract", file),
    `${JSON.stringify(content, null, 2)}\n`,
  );
