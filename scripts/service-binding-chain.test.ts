// How many Worker invocations one request can reach through Service Bindings.
//
// Cloudflare documents that "a single request has a maximum of 32 Worker
// invocations, and each call to a Service binding counts towards this limit"
// (https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
// The retired Vpass importer spent that limit on every central call of a
// registration (issue #87). Its successor registers in process: the Processor
// holds the whole registration and calls no other Worker, and no collector
// calls any Worker at all. This guard reads the service-binding graph from the
// resource ledger — which `resource-ledger.test.ts` keeps equal to the
// Wrangler configs on disk — and fails when that stops being true, so a new
// binding is a decision that has to revisit the invocation arithmetic rather
// than a line nobody counted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { LEDGER_JSON_PATH, REPO_ROOT } from "./resource-ledger.ts";

interface LedgerWorker {
  config: string;
  name: string;
  serviceBindings: { binding: string; service: string }[];
}

const ledger = JSON.parse(readFileSync(join(REPO_ROOT, LEDGER_JSON_PATH), "utf8")) as {
  directories: { directory: string; workers?: LedgerWorker[] }[];
};
const workers = ledger.directories.flatMap((directory) => directory.workers ?? []);

/** The Workers each Worker name can call, over every config that names it. */
const edges = new Map<string, Set<string>>();
for (const worker of workers) {
  const targets = edges.get(worker.name) ?? new Set<string>();
  for (const binding of worker.serviceBindings) targets.add(binding.service);
  edges.set(worker.name, targets);
}

/** The most Worker invocations a request entering at `name` can chain. */
function longestChain(name: string, seen: readonly string[] = []): number {
  if (seen.includes(name)) throw new Error(`service binding cycle through ${name}`);
  let longest = 0;
  for (const target of edges.get(name) ?? [])
    longest = Math.max(longest, longestChain(target, [...seen, name]));
  return 1 + longest;
}

test("the registration path makes no Service Binding call", () => {
  const processor = workers.filter(
    (worker) => worker.config === "services/processor/wrangler.jsonc",
  );
  expect(processor).toHaveLength(1);
  expect(processor[0]!.name).toBe("kogane-observation-pipeline");
  expect(processor[0]!.serviceBindings).toEqual([]);
});

test("no collector calls another Worker", () => {
  const collectors = workers.filter((worker) => worker.config.startsWith("services/collector-"));
  expect(collectors.length).toBeGreaterThan(10);
  for (const collector of collectors)
    expect([collector.config, collector.serviceBindings]).toEqual([collector.config, []]);
});

test("no request can chain more than two Worker invocations, far below the documented 32", () => {
  const chains = [...edges.keys()].map((name) => [name, longestChain(name)] as const);
  const longest = Math.max(...chains.map(([, length]) => length));
  expect(longest).toBe(2);
  expect(longest).toBeLessThan(32);
  // The only chains of two end at the Processor: the App's `PIPELINE`
  // binding and the local operations configuration's.
  for (const [name, length] of chains)
    if (length === 2) expect([...(edges.get(name) ?? [])]).toEqual(["kogane-observation-pipeline"]);
});
