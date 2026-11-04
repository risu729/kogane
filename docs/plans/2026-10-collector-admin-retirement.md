# Collector admin bearer retirement

- Status: implementation in progress; first slice covers 13 of 15 registrations
- Date: 2026-10-10
- Decision: [ADR 0069](../adr/0069-collector-admin-retirement.md)

## First slice: code and caller retirement

| Collector / deployed Worker                         | Retired public entrypoints                                        | Preserved execution                                        |
| --------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| GLOBAL PASS / `kogane-globalpass-collector-poc`     | trigger (daily/backfill), browser/container probe, container stop | fixed daily private RPC, health, existing egress and relay |
| Vpass / `kogane-vpass-collector-poc`                | collect-one-card, collect-all                                     | fixed all-card private RPC, health                         |
| MyJCB / `kogane-myjcb-collector-poc`                | trigger                                                           | private RPC, health                                        |
| SBI Securities / `kogane-sbi-collector-poc`         | trigger, scope/date override and backfill script                  | fixed all-scope private RPC, health                        |
| SBI Shinsei / `kogane-sbi-shinsei-collector-poc`    | trigger                                                           | private RPC, health, relay                                 |
| Sony Bank / `kogane-sony-bank-collector-poc`        | trigger, date override                                            | fixed current-window private RPC, health                   |
| Mobile Suica / `kogane-mobile-suica-collector-poc`  | trigger/as-of, credential and browser checks                      | fixed-current-day private RPC, health                      |
| Money Forward / `kogane-moneyforward-collector-poc` | trigger                                                           | private RPC, health                                        |
| V Point / `kogane-vpoint-collector-poc`             | trigger                                                           | private RPC, email auth/collection/forwarding, health      |
| Mizuho / `kogane-mizuho-collector`                  | trigger, supplied-session injection                               | configured-credential private RPC, health                  |
| PRESTIA Bank / `kogane-prestia-bank-collector`      | trigger                                                           | private RPC, health                                        |
| V Point Pay / `kogane-vpoint-pay-collector-poc`     | credential-status                                                 | disabled app routes stay 410; health; state retained       |
| SMBC Direct / `kogane-smbc-direct-backfill-poc`     | unused token declaration and sync only                            | existing Access-gated human UI unchanged                   |

All first-slice secrets are named `ADMIN_TRIGGER_TOKEN`. Worker names must be
rechecked against the deployed release inventory before deletion; this document
is not permission to delete a wildcard, a Worker, a DO or a credential file.

The tracked GLOBAL PASS/Money Forward/SBI trigger scripts, SBI backfill script,
and Shinsei admin-token sync script and its shell test are removed. Remaining
secret-sync scripts no longer create or upload admin tokens. Provider credential,
relay token and encryption-key synchronization remain. Native generated binding
types are regenerated; ignored outputs are not hand-edited.

## Deferred necessary recovery

| Worker                       | Secret still required | Unresolved operation                                 |
| ---------------------------- | --------------------- | ---------------------------------------------------- |
| `kogane-sbi-vc-session-poc`  | `ADMIN_TOKEN`         | forced human reauthentication, detailed state health |
| `kogane-st-george-collector` | `ADMIN_TRIGGER_TOKEN` | saved-run resume/republish                           |

Keep both tokens and existing checks until a separately reviewed replacement
lands and is deployed. Existing unattended refresh is not forced human reauth;
normal collection is not saved-run republish. Existing Access applications do
not protect either hostname (owner read-only audit of all 17 applications,
2026-10-10); do not invent a JWT audience or create a new Access application.
Propose the smallest App human-operator/audit adapter and fixed private recovery
RPC before editing the shared App/MCP files. No new agent grant or auth strategy.

## Release and exact-secret handoff

### St.George internal saved-only preparation

The internal `CollectionCoordinator.retryPending({ expectedRunId })` now separates
saved evidence persistence from generic trigger and authentication unblock.
It is intentionally unconnected: no HTTP, Durable Object RPC, schedule, App/MCP,
grant or secret change. Its strict pending-envelope and bounded-chunk comparison
preserves current evidence after stale/interleaved changes; transaction callbacks
perform storage operations only. See the [ADR amendment](../adr/0069-collector-admin-retirement.md#stgeorge-saved-only-preparation-amendment-2026-10-10)
for identity, failure-terminal and residual-key guarantees and limits.

This is synthetic preparation, not an available recovery command or a retired
fourteenth token. Existing `/resume` rejects pending state and can unblock
authentication; existing trigger may start a new login without pending state.
An audited human operator adapter and narrowly scoped private RPC, plus a
separate authentication-unblock replacement, remain prerequisites. No real DATA
read/write, bank request, deployed recovery proof or secret deletion is claimed.

1. Complete synthetic negative, persistence, relay, Access, type/config and root
   checks; obtain fresh independent review of the exact candidate tree.
2. Publish the normal PR; required CI must pass before normal merge.
3. Sole deploy owner verifies the merged release reached all first-slice Workers.
   Existing release identity and health checks are read-only; do not invoke a
   former trigger, log in to a provider or collect financial data as a smoke test.
4. Re-run the tracked caller/config/type inventory at that exact deployed SHA.
   Confirm the first-slice 13 admin names have zero runtime or tool dependency,
   while both deferred admin consumers, three relay tokens and two encryption
   keys remain.
5. Only then delete `ADMIN_TRIGGER_TOKEN` for the exact 13 listed Workers and
   verify its absence with name-only secret listings. Record counts and deployed
   identity, never values. Preserve `RELAY_TOKEN` (GLOBAL PASS/Shinsei/St.George),
   `SESSION_ENCRYPTION_KEY` (SBI VC/SMBC), and all provider credentials.
6. Local retired-token files are not removed by this PR. Any eventual cleanup
   requires exact owner-confirmed paths; no recursive cleanup or secret output.

Completion evidence must distinguish code merged, code deployed, thirteen
registrations deleted, and the two deferred recovery consumers. No production
or deletion claim follows from local CI.
