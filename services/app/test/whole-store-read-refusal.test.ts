// The App's two whole-store grant gates (the page reads' `refusedRefs` and
// `kogane.reported-state.read`) take the shared `narrowedScopeRefs` and
// `wholeStoreReadRefusal` (packages/application/src/grants.ts). Each refusal is
// compared, as status and JSON text, with what the hand-written gate answered
// before: `legacyRefs` below is that code, frozen, and each page read's
// capabilities are its definition's. The listing (`pageReadMcpTools`) uses
// the same gate and is compared too. This file imports no new name, so it
// runs unchanged against the code before the move. Synthetic grants only.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ERROR_STATUS, financialError } from "../../../packages/application/src/errors.ts";
import {
  type AgentCapability,
  fullGrant,
  type Grant,
  grantAllows,
} from "../../../packages/application/src/grants.ts";
import {
  callPageReadTool,
  PAGE_READ_ROUTES,
  type PageReadToolName,
  pageReadMcpTools,
} from "../src/page-read-tools";
import { callReadTool } from "../src/read-tools";

/** Each page read's capabilities, in the order its gate checks them, and whether it needs the schedule axis. */
const PAGE_READS: Record<PageReadToolName, [AgentCapability[], boolean]> = {
  "kogane.identity.read": [["records.read"], false],
  "kogane.store.read": [["records.read"], false],
  "kogane.observations.list": [["records.read"], false],
  "kogane.observations.get": [["records.read"], false],
  "kogane.balances.read": [["records.read"], false],
  "kogane.rewards.read": [["records.read"], false],
  "kogane.reported-holdings-change.read": [["records.read"], false],
  "kogane.events.read": [["records.read"], false],
  "kogane.reports.read": [["records.read"], false],
  "kogane.collection-quality.read": [["evidence.read"], false],
  "kogane.evidence.read": [["evidence.read"], false],
  "kogane.evidence.raw.read": [["evidence.read"], false],
  "kogane.schedules.read": [["schedules.read", "evidence.read"], true],
};

/** The page reads' gate before it took `narrowedScopeRefs`, frozen. */
function legacyRefs(grant: Grant, capabilities: AgentCapability[], scheduleScope: boolean) {
  const missing = capabilities.filter((capability) => !grantAllows(grant, capability));
  if (missing.length > 0) return missing.map((capability) => `capability:${capability}`);
  return [
    ...(scheduleScope && grant.scopes.scheduleSources !== "*" ? ["scope:scheduleSource"] : []),
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
}

const whole = fullGrant("synthetic");
const grant = (scopes: Partial<Grant["scopes"]>, capabilities = whole.capabilities): Grant => ({
  ...whole,
  scopes: { ...whole.scopes, ...scopes },
  capabilities,
});
const without = (dropped: AgentCapability) =>
  whole.capabilities.filter((capability) => capability !== dropped);

const GRANTS: Record<string, Grant> = {
  "whole store": whole,
  "no capability": grant({}, []),
  "no capability, every axis narrowed": grant(
    { sources: ["s"], accounts: ["a"], scheduleSources: [] },
    [],
  ),
  "without evidence.read": grant({}, without("evidence.read")),
  "without schedules.read, sources narrowed": grant({ sources: ["s"] }, without("schedules.read")),
  "sources narrowed": grant({ sources: ["s"] }),
  "accounts narrowed": grant({ accounts: ["a"] }),
  "both store axes narrowed": grant({ sources: ["s"], accounts: ["a"] }),
  "both store axes empty": grant({ sources: [], accounts: [] }),
  "schedule axis narrowed": grant({ scheduleSources: ["s"] }),
  "schedule axis absent": grant({ scheduleSources: undefined }),
  "every axis narrowed": grant({ sources: ["s"], accounts: ["a"], scheduleSources: [] }),
};

const expected = (operation: string, refs: string[]) => {
  const code = refs[0]!.startsWith("capability:") ? "unauthorized" : "evidence_restricted";
  return JSON.stringify({
    status: ERROR_STATUS[code],
    body: financialError(code, operation, refs),
  });
};

describe("the App's whole-store gates refuse byte for byte as before", () => {
  it("covers every page read", () => {
    expect(Object.keys(PAGE_READS).sort()).toEqual(Object.keys(PAGE_READ_ROUTES).sort());
  });

  for (const [name, [capabilities, scheduleScope]] of Object.entries(PAGE_READS))
    it(name, async () => {
      for (const [label, granted] of Object.entries(GRANTS)) {
        const refs = legacyRefs(granted, capabilities, scheduleScope);
        if (refs.length === 0) continue;
        // The grant is graded before the argument is read: `{}` is never checked.
        const answer = await callPageReadTool(name as PageReadToolName, {}, env, granted);
        expect(JSON.stringify(answer), label).toBe(expected(name.slice("kogane.".length), refs));
      }
    });

  it("lists to each grant exactly the page reads its gate lets it call", async () => {
    for (const [label, granted] of Object.entries(GRANTS)) {
      const listed = (await pageReadMcpTools(granted, async () => true)).map((tool) => tool.name);
      const callable = Object.entries(PAGE_READS)
        .filter(
          ([, [capabilities, scope]]) => legacyRefs(granted, capabilities, scope).length === 0,
        )
        .map(([name]) => name);
      expect(listed.sort(), label).toEqual(callable.sort());
    }
  });

  it("kogane.reported-state.read", async () => {
    for (const [label, granted] of Object.entries(GRANTS)) {
      const refs = legacyRefs(granted, ["records.read"], false);
      if (refs.length === 0) continue;
      const answer = await callReadTool("kogane.reported-state.read", {}, env, granted);
      expect(JSON.stringify(answer), label).toBe(expected("reported-state.read", refs));
    }
  });
});
