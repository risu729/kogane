# Plan: collect what existing collectors' sites already offer

- Status: **accepted** by the owner on 2026-11-09. The goal is from 19:06 UTC, the answers on method are from 19:51–19:52 UTC and the order is from 20:21 UTC; all of them are in [section 4](#4-owner-decisions-2026-11-09). Each item is its own issue and pull request.
- Roadmap: ["New sources"](../roadmap.md#new-sources). This work comes before any new collector. Per-source issues: #441–#454 under [#440](https://github.com/risu729/kogane/issues/440).
- Source of truth for what is collected: the provider data-type catalogue `provider-data-types-v1` ([ADR 0087](../adr/0087-provider-data-type-catalogue.md), `packages/application/src/collection/provider-data-types.ts`). Each item below moves one or more `partial` or `not_collected` entries.

## 1. How the gaps were found

For every source, the gap list compares three things: the catalogue; the collector's own requests (routes, parameters, date window, pages, filters); and the source research in `docs/sources/*.md` (what the site offers, how far back it goes, and its limits). Production was read through `kogane.collection-quality.read`, closed codes and counts only.

| Kind                             | Meaning                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| A. Stored, not parsed            | The collector already saves the page; no parser reads it.                                     |
| B. Known request, narrow         | The route and its request values are observed; the collector asks for less than the site has. |
| B/C. Known route, values unknown | The route is called, but wider parameter values (filters, dates) were never observed.         |
| C. Route not observed            | The site shows the data; no request shape is in the repository.                               |

## 2. Order

The order follows the roadmap. Phase 4 (transfers between own accounts, securities executions, balances on a date) needs complete cash and execution history. Phases 5–7 need income, realised gains and holdings by product.

### P0: data the collectors request but lose

| Item | Source                                        | Issue or PR                                                                                                  |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 0a   | SBI証券 foreign trades and foreign cash parse | [#1220](https://github.com/risu729/kogane/issues/1220)                                                       |
| 0b   | SBI新生 partial daily runs                    | [#1215](https://github.com/risu729/kogane/issues/1215)                                                       |
| 0c   | Vpass stated-total mismatch                   | [#445](https://github.com/risu729/kogane/issues/445), [#1142](https://github.com/risu729/kogane/issues/1142) |
| 0d   | みずほ history page refused                   | [#1217](https://github.com/risu729/kogane/pull/1217) (merged)                                                |

### P1: history the reconstruction needs

| Item | Source         | What                                                              | Kind | Issue                                                  |
| ---- | -------------- | ----------------------------------------------------------------- | ---- | ------------------------------------------------------ |
| 1    | SBI証券        | Executions for the site's two years                               | B    | [#1225](https://github.com/risu729/kogane/issues/1225) |
| 2    | SBI証券        | Yen cash pages beyond the first; USD cash movements               | B/C  | [#1226](https://github.com/risu729/kogane/issues/1226) |
| 3    | SBI VC         | Crypto transfers, staking and lending rewards, non-JPY cash flows | B/C  | [#1227](https://github.com/risu729/kogane/issues/1227) |
| 4    | SBI VC         | Executions outside the current filter                             | B/C  | [#1228](https://github.com/risu729/kogane/issues/1228) |
| 5    | みずほ         | Ordinary history beyond the default view                          | B/C  | [#1229](https://github.com/risu729/kogane/issues/1229) |
| 6    | SBI新生        | Dated history                                                     | C    | [#1230](https://github.com/risu729/kogane/issues/1230) |
| 7    | ソニー銀行     | History before the current month                                  | B    | [#1231](https://github.com/risu729/kogane/issues/1231) |
| 8    | PRESTIA (bank) | First production collection (balances)                            | ops  | ADR 0048 amendment 2026-11-09                          |
| 8b   | PRESTIA (bank) | Deposit-account activity                                          | C    | [#1235](https://github.com/risu729/kogane/issues/1235) |

### P2: products and income

| Item | Source           | What                                                      | Kind | Issue                                                  |
| ---- | ---------------- | --------------------------------------------------------- | ---- | ------------------------------------------------------ |
| 9    | SBI証券          | Dividends, distributions, interest; realised gains        | C    | [#1236](https://github.com/risu729/kogane/issues/1236) |
| 10   | SBI証券          | Fund, MMF, bond and margin positions                      | C    | [#1237](https://github.com/risu729/kogane/issues/1237) |
| 10b  | SBI証券          | Weekly asset history                                      | C    | [#1238](https://github.com/risu729/kogane/issues/1238) |
| 11   | MyJCB            | Other JCB cards; JCB debit statements and difference rows | C    | [#1239](https://github.com/risu729/kogane/issues/1239) |
| 12   | Money Forward ME | Balances and holdings from the stored detail pages        | A    | [#1240](https://github.com/risu729/kogane/issues/1240) |
| 13a  | みずほ           | Time, installment and foreign time deposits               | C    | [#1241](https://github.com/risu729/kogane/issues/1241) |
| 13b  | SBI新生          | Time and foreign-currency deposit contracts               | C    | [#1242](https://github.com/risu729/kogane/issues/1242) |
| 13c  | ソニー銀行       | Time and foreign time deposit contracts                   | C    | [#1243](https://github.com/risu729/kogane/issues/1243) |
| 13d  | St.George        | Term deposits                                             | C    | [#1244](https://github.com/risu729/kogane/issues/1244) |
| 14   | SMBC             | AUD foreign-currency ordinary deposit (manual runs)       | C    | [#1245](https://github.com/risu729/kogane/issues/1245) |
| 15   | St.George        | History beyond the default view                           | B/C  | [#1246](https://github.com/risu729/kogane/issues/1246) |

### P3: documents, points and extras

| Item | Source         | What                                                        | Kind | Issue                                                  |
| ---- | -------------- | ----------------------------------------------------------- | ---- | ------------------------------------------------------ |
| 16   | SBI新生        | Monthly PDF reports                                         | C    | [#1247](https://github.com/risu729/kogane/issues/1247) |
| 17   | SBI証券        | Electronically delivered reports                            | C    | [#1248](https://github.com/risu729/kogane/issues/1248) |
| 18   | SBI VC         | Balance history, reports, P&L data                          | C    | [#1249](https://github.com/risu729/kogane/issues/1249) |
| 19   | ソニー銀行     | Realised FX gains; delivered documents                      | C    | [#1250](https://github.com/risu729/kogane/issues/1250) |
| 20   | MyJCB          | J-POINT history and expiry buckets; statement files         | C    | [#1251](https://github.com/risu729/kogane/issues/1251) |
| 21   | みずほ         | Mizuho points                                               | C    | [#1252](https://github.com/risu729/kogane/issues/1252) |
| 22a  | PRESTIA (bank) | Statement PDFs                                              | C    | [#1253](https://github.com/risu729/kogane/issues/1253) |
| 22b  | St.George      | eStatements                                                 | C    | [#1254](https://github.com/risu729/kogane/issues/1254) |
| 23   | Mobile Suica   | Rows beyond one 100-row page                                | B/C  | [#1255](https://github.com/risu729/kogane/issues/1255) |
| 24   | MyJCB          | Bonus-payment schedule pages (stored, never seen with rows) | A    | none: waits until a page with rows is stored           |
| 25   | Vpass          | Available credit, revolving and installment balances        | C    | [#1256](https://github.com/risu729/kogane/issues/1256) |

Not listed: V Point (every offered type is collected), GLOBAL PASS (backfill done; the daily run keeps two months) and V Point Pay (#453 unchanged).

## 3. Rules every item follows

Every issue carries these rules.

- **Observe first.** The implementer observes the routes and request values the issue needs, with the owner's login on the owner's machine, and calls read routes only. Only request shapes go into the repository (method, path, parameter names and the values used, response keys and types), under a dated heading in `docs/sources/<source>.md`.
- **Past data comes from the scheduled run.** Collection requests have no window parameter, and none is added. The scheduled run collects everything the site keeps at once. A collector keeps how far it got only when that cannot finish inside one run (the holder stops itself at 13 minutes, [ADR 0085](../adr/0085-collection-lease-heartbeat.md)), so the next run continues.
- **Fail closed.** A stated total that does not match the rows, an unknown code or a missing next page makes the unit `partial` with a closed code. Missing data is never zero.
- **No double publication.** A row seen in two windows or two runs is published once.
- **Finish the loop.** Parser version and digests, the catalogue entry, the collector docs, synthetic fixtures, and the workspace and root CI tasks.

## 4. Owner decisions (2026-11-09)

- **19:06 UTC: goal.** Before any new collector, fix the places where an existing collector's site offers data that Kogane does not collect. Recorded in the roadmap by [#1218](https://github.com/risu729/kogane/pull/1218).
- **19:51 UTC: unobserved routes and values.** The implementer observes them as part of each issue, including the provider login that takes. No separate capture-only step is built into deployed collectors, and the owner is not asked to record requests.
- **19:52 UTC: past data.** No window parameter on collection requests ("指定できるようにしなくていい。対応するためのコードが増えるので", "no need to make it selectable; it adds code"). Past data is collected all at once ("まとめて", "all together") by the scheduled run, and continued only when a run hits its time limit.
- **19:52 UTC: PRESTIA.** An agent may request PRESTIA bank's first production collection. Done through the [ADR 0048 amendment](../adr/0048-operation-collector-dispatch.md) ([#1232](https://github.com/risu729/kogane/pull/1232)).
- **20:21 UTC: order.** P0 → P1 → P2 → P3 as above.
