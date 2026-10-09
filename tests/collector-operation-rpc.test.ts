// The named collector RPC an accepted operation reaches (issue #544, ADR 0048)
// is the one the alarm reaches, and every piece of it agrees with the others:
//
//   * every connection's terminal source is the constant the collector really
//     writes into `runs/<source>/…`, and maps to exactly one CORE source per
//     action, so a request names one collector and its runs can be found;
//   * every connection's workspace is bound by the Processor under the name
//     both the alarm and the dispatch lane compute;
//   * every scheduled collector's `ScheduledCollection` entrypoint serves
//     `runOperation` for its own workspace, and reports a lease refusal as
//     `collection_busy` rather than as a failed collection.
//
// Static and synthetic: no Worker runs, no provider is contacted.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coreSourceId } from "../packages/application/src/collection/descriptors.ts";
import { OPERATION_CONNECTIONS } from "../packages/collection/src/operation-rpc.ts";
import { REPO_ROOT } from "../scripts/config-bootstrap.ts";
import { parseJsonc } from "../scripts/jsonc.ts";
import { collectorBindingName } from "../services/processor/src/collector-binding.ts";
import { connectionFor } from "../services/processor/src/operations/dispatch.ts";
import * as globalpass from "../services/collector-globalpass/src/shared-collection.ts";
import * as mizuho from "../services/collector-mizuho/src/storage.ts";
import * as mobileSuica from "../services/collector-mobile-suica/src/shared-run.ts";
import * as moneyforward from "../services/collector-moneyforward/src/shared-collection.ts";
import * as myjcb from "../services/collector-myjcb/src/shared-collection.ts";
import * as prestiaBank from "../services/collector-prestia-bank/src/storage.ts";
import * as sbiSecurities from "../services/collector-sbi-securities/src/shared-run.ts";
import * as sbiShinsei from "../services/collector-sbi-shinsei/src/shared-collection.ts";
import * as sbiVcTrade from "../services/collector-sbi-vc-trade/src/shared-collection.ts";
import * as sonyBank from "../services/collector-sony-bank/src/shared-collection.ts";
import * as stGeorge from "../services/collector-st-george/src/shared-collection.ts";
import * as vpass from "../services/collector-vpass/src/shared-collection.ts";
import * as vpoint from "../services/collector-vpoint/src/shared-run.ts";

/** The terminal source each scheduled collector writes, from its own module. */
const TERMINAL_SOURCES: Readonly<Record<string, string>> = {
  "collector-globalpass": globalpass.SHARED_SOURCE,
  "collector-mizuho": mizuho.MIZUHO_SOURCE,
  "collector-mobile-suica": mobileSuica.MOBILE_SUICA_SOURCE,
  "collector-moneyforward": moneyforward.SOURCE,
  "collector-myjcb": myjcb.SOURCE,
  "collector-prestia-bank": prestiaBank.PRESTIA_BANK_SOURCE,
  "collector-sbi-securities": sbiSecurities.SBI_SECURITIES_SOURCE,
  "collector-sbi-shinsei": sbiShinsei.SHARED_SOURCE,
  "collector-sbi-vc-trade": sbiVcTrade.SHARED_SOURCE,
  "collector-sony-bank": sonyBank.SOURCE,
  "collector-st-george": stGeorge.ST_GEORGE_SOURCE,
  "collector-vpass": vpass.SOURCE,
  "collector-vpoint": vpoint.VPOINT_SOURCE,
};

const workspaces = [...new Set(OPERATION_CONNECTIONS.map((entry) => entry.workspace))].sort();

describe("operation connections", () => {
  test("every connection's terminal source is the one its collector writes", () => {
    expect(workspaces).toEqual(Object.keys(TERMINAL_SOURCES).sort());
    for (const connection of OPERATION_CONNECTIONS)
      expect([connection.connectionId, connection.terminalSource]).toEqual([
        connection.connectionId,
        TERMINAL_SOURCES[connection.workspace]!,
      ]);
  });

  test("each CORE source has at most one connection per action, and every connection is reachable", () => {
    for (const connection of OPERATION_CONNECTIONS) {
      const core = coreSourceId(connection.terminalSource);
      expect(core).not.toBeNull();
      expect(connectionFor(OPERATION_CONNECTIONS, core, connection.action)).toBe(connection);
    }
    // Sources with no unattended collector are not guessed onto one.
    expect(connectionFor(OPERATION_CONNECTIONS, "smbc-bank", "collect")).toBeNull();
    expect(connectionFor(OPERATION_CONNECTIONS, "v-point-pay", "collect")).toBeNull();
    expect(connectionFor(OPERATION_CONNECTIONS, "sony-bank", "refresh-session")).toBeNull();
    expect(
      connectionFor(OPERATION_CONNECTIONS, "sbi-vc-trade", "refresh-session")?.connectionId,
    ).toBe("sbi-vc-keepalive");
    expect(connectionFor(OPERATION_CONNECTIONS, null, "collect")).toBeNull();
  });

  test("the Processor binds every connection's workspace under the name both callers compute", () => {
    const config = parseJsonc(
      readFileSync(join(REPO_ROOT, "services/processor/wrangler.jsonc"), "utf8"),
      "wrangler.jsonc",
    ) as { services: { binding: string; entrypoint: string }[] };
    for (const workspace of workspaces)
      expect(config.services).toContainEqual(
        expect.objectContaining({
          binding: collectorBindingName(workspace),
          entrypoint: "ScheduledCollection",
        }),
      );
    // The alarm uses the same helper rather than its own copy of the rule.
    expect(
      readFileSync(join(REPO_ROOT, "services/processor/src/schedule-alarm.ts"), "utf8"),
    ).toContain("collectorBindingName(pending.job.workspace!)");
  });
});

describe("collector entrypoints", () => {
  for (const workspace of workspaces)
    test(`${workspace} serves runOperation for its own workspace`, () => {
      const entrypoint = readFileSync(
        join(REPO_ROOT, "services", workspace, "src/schedule-entrypoint.ts"),
        "utf8",
      );
      expect(entrypoint).toContain("export class ScheduledCollection");
      expect(entrypoint).toContain(
        `return runCollectorOperation(request, "${workspace}", (cron, time) =>`,
      );
      expect(entrypoint).toContain("this.runScheduled(cron, time)");
      const worker = readFileSync(join(REPO_ROOT, "services", workspace, "src/worker.ts"), "utf8");
      const alarm = worker.slice(worker.indexOf("export async function alarmCollection("));
      expect(alarm.slice(0, alarm.indexOf("\n}\n"))).toContain("return scheduledFailure(error");
    });
});
