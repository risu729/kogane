// Read-only: proposes the one-time crosswalk between importer-era and
// collector-era account identities (ADR 0030) and prints counts only.
//
//   bun services/processor/scripts/identity-crosswalk-proposals.ts
//
// One D1 SELECT through `wrangler.diagnostic.jsonc`; nothing is written. For
// every collector-era identity value of Vpass and MoneyForward ME, each line
// names the importer-era values whose current observations share provider
// rows with it:
//
//   {"source","newKeyRef","oldKeyRef","sharedRows","newOnlyRows","oldOnlyRows","months","verdict"}
//
// The key refs are the identity values themselves (opaque hashes). No amount,
// merchant, date or provider id is selected: the SQL compares rows and returns
// counts. The last line counts the verdicts. A `unique` line is what the
// `identity.crosswalk.accept` command takes; the operator decides whether to
// record it (docs/identity-operations.md).
import {
  CROSSWALK_PROPOSALS_SQL,
  CROSSWALK_VERDICTS,
  type CrosswalkProposalRow,
  crosswalkProposals,
} from "../../../packages/storage-d1/src/core/identity-crosswalk.ts";

const cli = new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url).pathname;
const processorDir = new URL("..", import.meta.url).pathname;

async function select(sql: string): Promise<unknown> {
  const child = Bun.spawn(
    [
      "node",
      cli,
      "d1",
      "execute",
      "kogane-raw-evidence",
      "--remote",
      "--command",
      sql,
      "--json",
      "--config",
      "wrangler.diagnostic.jsonc",
    ],
    { cwd: processorDir, stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error("read-only command failed");
  return JSON.parse(output);
}

const result = (await select(CROSSWALK_PROPOSALS_SQL)) as { results: CrosswalkProposalRow[] }[];
const proposals = crosswalkProposals(result[0]!.results);
const summary = Object.fromEntries(CROSSWALK_VERDICTS.map((verdict) => [verdict, 0])) as Record<
  string,
  number
>;
for (const proposal of proposals) {
  summary[proposal.verdict]! += 1;
  console.log(JSON.stringify(proposal));
}
console.log(JSON.stringify({ summary }));
