// Every terminal a shared-R2 collector writes names the producer
// `collector-<collector id>`, where the collector id is the terminal's own
// `source`, and that (source, producer) pair is an active route of the
// Processor's ingest client (config/ingest-clients.json, COLLECTOR_SOURCE_IDS,
// docs/processor.md §3.1, ADR 0014).
//
// Until 2026-09-26 seven collectors named a producer of their own choosing
// (`vpass-json`, `myjcb-worker`, …); the Processor refused every one of their
// terminals as `inactive_ingest_route`, and each collector's own test pinned
// the wrong string, so nothing failed. This guard compares the collectors with
// the route table instead of with themselves:
//
//   * every `services/collector-*` workspace is listed below, so a new
//     collector joins the check by failing it until it is listed;
//   * each listed pair is imported from the module that writes the terminal
//     and must follow the naming rule and be a declared, active route;
//   * every `producer:` property under a collector's `src/` must be one of the
//     listed constants, directly after the listed source constant, so the
//     constants checked here are the ones the terminal actually carries.
//
// `scripts/config-bootstrap.test.ts` holds the other half: the declared routes
// are exactly the collector id mapping, one `collector-<collector id>` each.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coreSourceId } from "../packages/application/src/collection/descriptors.ts";
import { REPO_ROOT, loadIngestClientsConfig } from "../scripts/config-bootstrap.ts";
import * as globalpass from "../services/collector-globalpass/src/shared-collection.ts";
import * as mizuho from "../services/collector-mizuho/src/storage.ts";
import * as mobileSuica from "../services/collector-mobile-suica/src/shared-run.ts";
import * as moneyforward from "../services/collector-moneyforward/src/shared-collection.ts";
import * as myjcb from "../services/collector-myjcb/src/shared-collection.ts";
import * as sbiSecurities from "../services/collector-sbi-securities/src/shared-run.ts";
import * as sbiShinsei from "../services/collector-sbi-shinsei/src/shared-collection.ts";
import * as sbiVcTrade from "../services/collector-sbi-vc-trade/src/shared-collection.ts";
import * as smbcDirect from "../services/collector-smbc-direct/src/shared-collection.ts";
import * as sonyBank from "../services/collector-sony-bank/src/shared-collection.ts";
import * as stGeorge from "../services/collector-st-george/src/shared-collection.ts";
import * as vpass from "../services/collector-vpass/src/shared-collection.ts";
import * as vpoint from "../services/collector-vpoint/src/shared-run.ts";
import * as vpointPay from "../services/collector-vpoint-pay/src/shared-run.ts";

/** One terminal a collector writes: the module, its constants' names and values. */
interface TerminalIdentity {
  /** Relative to the collector's workspace. */
  readonly file: string;
  readonly sourceName: string;
  readonly source: string;
  readonly producerName: string;
  readonly producer: string;
}

const COLLECTORS: Readonly<Record<string, readonly TerminalIdentity[]>> = {
  "collector-globalpass": [
    {
      file: "src/shared-collection.ts",
      sourceName: "SHARED_SOURCE",
      source: globalpass.SHARED_SOURCE,
      producerName: "PRODUCER",
      producer: globalpass.PRODUCER,
    },
  ],
  "collector-mizuho": [
    {
      file: "src/storage.ts",
      sourceName: "MIZUHO_SOURCE",
      source: mizuho.MIZUHO_SOURCE,
      producerName: "MIZUHO_PRODUCER",
      producer: mizuho.MIZUHO_PRODUCER,
    },
  ],
  "collector-mobile-suica": [
    {
      file: "src/shared-run.ts",
      sourceName: "MOBILE_SUICA_SOURCE",
      source: mobileSuica.MOBILE_SUICA_SOURCE,
      producerName: "SHARED_PRODUCER",
      producer: mobileSuica.SHARED_PRODUCER,
    },
  ],
  "collector-moneyforward": [
    {
      file: "src/shared-collection.ts",
      sourceName: "SOURCE",
      source: moneyforward.SOURCE,
      producerName: "PRODUCER",
      producer: moneyforward.PRODUCER,
    },
  ],
  "collector-myjcb": [
    {
      file: "src/shared-collection.ts",
      sourceName: "SOURCE",
      source: myjcb.SOURCE,
      producerName: "PRODUCER",
      producer: myjcb.PRODUCER,
    },
  ],
  "collector-sbi-securities": [
    {
      file: "src/shared-run.ts",
      sourceName: "SBI_SECURITIES_SOURCE",
      source: sbiSecurities.SBI_SECURITIES_SOURCE,
      producerName: "SHARED_PRODUCER",
      producer: sbiSecurities.SHARED_PRODUCER,
    },
  ],
  "collector-sbi-shinsei": [
    {
      file: "src/shared-collection.ts",
      sourceName: "SHARED_SOURCE",
      source: sbiShinsei.SHARED_SOURCE,
      producerName: "PRODUCER",
      producer: sbiShinsei.PRODUCER,
    },
  ],
  "collector-sbi-vc-trade": [
    {
      file: "src/shared-collection.ts",
      sourceName: "SHARED_SOURCE",
      source: sbiVcTrade.SHARED_SOURCE,
      producerName: "PRODUCER",
      producer: sbiVcTrade.PRODUCER,
    },
  ],
  "collector-smbc-direct": [
    {
      file: "src/shared-collection.ts",
      sourceName: "SHARED_SOURCE",
      source: smbcDirect.SHARED_SOURCE,
      producerName: "PRODUCER",
      producer: smbcDirect.PRODUCER,
    },
  ],
  "collector-sony-bank": [
    {
      file: "src/shared-collection.ts",
      sourceName: "SOURCE",
      source: sonyBank.SOURCE,
      producerName: "PRODUCER",
      producer: sonyBank.PRODUCER,
    },
  ],
  "collector-st-george": [
    {
      file: "src/shared-collection.ts",
      sourceName: "ST_GEORGE_SOURCE",
      source: stGeorge.ST_GEORGE_SOURCE,
      producerName: "ST_GEORGE_PRODUCER",
      producer: stGeorge.ST_GEORGE_PRODUCER,
    },
  ],
  "collector-vpass": [
    {
      file: "src/shared-collection.ts",
      sourceName: "SOURCE",
      source: vpass.SOURCE,
      producerName: "PRODUCER",
      producer: vpass.PRODUCER,
    },
  ],
  "collector-vpoint": [
    {
      file: "src/shared-run.ts",
      sourceName: "VPOINT_SOURCE",
      source: vpoint.VPOINT_SOURCE,
      producerName: "VPOINT_PRODUCER",
      producer: vpoint.VPOINT_PRODUCER,
    },
    {
      file: "src/shared-run.ts",
      sourceName: "VPOINT_PAY_EMAIL_SOURCE",
      source: vpoint.VPOINT_PAY_EMAIL_SOURCE,
      producerName: "VPOINT_PAY_EMAIL_PRODUCER",
      producer: vpoint.VPOINT_PAY_EMAIL_PRODUCER,
    },
  ],
  "collector-vpoint-pay": [
    {
      file: "src/shared-run.ts",
      sourceName: "VPOINT_PAY_SOURCE",
      source: vpointPay.VPOINT_PAY_SOURCE,
      producerName: "SHARED_PRODUCER",
      producer: vpointPay.SHARED_PRODUCER,
    },
  ],
};

const SERVICES = join(REPO_ROOT, "services");

function collectorWorkspaces(): string[] {
  return readdirSync(SERVICES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("collector-"))
    .map((entry) => entry.name)
    .sort();
}

/** Every TypeScript source under a collector's `src/`, relative to its workspace. */
function sourceFiles(workspace: string): string[] {
  return (readdirSync(join(SERVICES, workspace, "src"), { recursive: true }) as string[])
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"))
    .map((path) => `src/${path.replaceAll("\\", "/")}`)
    .sort();
}

/** `producer: <expression>` properties, with the property written just before each. */
function producerProperties(text: string): { producer: string; previous: string }[] {
  const lines = text.split("\n");
  const found: { producer: string; previous: string }[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*producer\s*:\s*(?<value>.*?),?\s*$/u.exec(line);
    if (match?.groups === undefined) return;
    found.push({ producer: match.groups["value"]!, previous: (lines[index - 1] ?? "").trim() });
  });
  return found;
}

const processorRoutes = (() => {
  const client = loadIngestClientsConfig(REPO_ROOT).clients.find(
    (candidate) => candidate.id === "processor-shared-r2",
  );
  if (client === undefined || !client.active) throw new Error("processor-shared-r2 missing");
  return client.routes.filter((route) => route.active);
})();

describe("shared-R2 collector producers (ADR 0014)", () => {
  test("every collector workspace is listed", () => {
    expect(Object.keys(COLLECTORS).sort()).toEqual(collectorWorkspaces());
  });

  for (const [workspace, identities] of Object.entries(COLLECTORS)) {
    describe(workspace, () => {
      for (const identity of identities) {
        test(`${identity.source}: producer is collector-<collector id> and an active route`, () => {
          expect(identity.producer).toBe(`collector-${identity.source}`);
          const core = coreSourceId(identity.source);
          expect(core).not.toBeNull();
          expect(processorRoutes).toContainEqual({
            source: core!,
            producer: identity.producer,
            active: true,
          });
        });
      }

      test("every terminal producer in src/ is a listed constant beside its source", () => {
        const listed = identities.map(
          (identity) =>
            `${identity.file}: source ${identity.sourceName}, producer ${identity.producerName}`,
        );
        const written: string[] = [];
        for (const file of sourceFiles(workspace)) {
          const text = readFileSync(join(SERVICES, workspace, file), "utf8");
          for (const property of producerProperties(text)) {
            const source =
              /^source\s*:\s*(?<name>[A-Za-z_$][\w$]*)\s*,$/u.exec(property.previous)?.groups?.[
                "name"
              ] ?? `<${property.previous}>`;
            written.push(`${file}: source ${source}, producer ${property.producer}`);
          }
        }
        // A literal, a computed value, or a producer written anywhere but the
        // listed module is how the unrouted producers got in; each shows up
        // here as an entry that is not listed.
        expect([...new Set(written)].sort()).toEqual([...new Set(listed)].sort());
      });
    });
  }
});
