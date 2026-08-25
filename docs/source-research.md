# Source Research Board

This board tracks direct-source feasibility research. Scores and conclusions
are filled only by the source-specific PR; an account's mere presence in the
inventory is not a feasibility claim.

Automation levels:

- **A** — direct documented/export API suitable for scheduled headless use;
- **B** — stable read-only internal API with renewable or reusable session;
- **C** — browser/app bootstrap plus headless replay is plausible;
- **D** — full browser/device automation is probably required;
- **E** — manual capture remains the safe default.

Cost is 1 (small wrapper) through 5 (device-bound or adversarial automation).

| Research unit | Priority | Official route family | Source PR | Level | Cost | Status |
| --- | --- | --- | --- | --- | ---: | --- |
| Mobile Suica / JRE ID / JRE POINT | P0 | JR East web/app | [#8](https://github.com/risu729/kogane/pull/8) | C / D | 4 (Wallet spot-check: 2) | updated for JRE ID |
| SMBC bank / Olive bank account | P0 | SMBC Direct / Olive | [#7](https://github.com/risu729/kogane/pull/7) | C | 3-4 | draft complete |
| SBI Securities | P0 | SBI Securities web/app | [#6](https://github.com/risu729/kogane/pull/6) | B | 4 | draft complete |
| PayPay | P0 | PayPay app | [#9](https://github.com/risu729/kogane/pull/9) | D | 4 | draft complete (manual CSV: cost 2) |
| Sumishin SBI / DOCOMO SMTB Net Bank | P0 | bank app/web | [#10](https://github.com/risu729/kogane/pull/10) | D | 3-5 | draft complete |
| SMBC Trust PRESTIA / GLOBAL PASS | P1 | PRESTIA Online | [#11](https://github.com/risu729/kogane/pull/11) | D | 3-4 | draft complete |
| SBI Shinsei Bank | P1 | PowerDirect/app | [#12](https://github.com/risu729/kogane/pull/12) | D | 3-4 | draft complete |
| MUFG Bank | P1 | MUFG Direct/app | [#13](https://github.com/risu729/kogane/pull/13) | D | 4 | draft complete |
| Mizuho Bank | P1 | Mizuho Direct/app | [#14](https://github.com/risu729/kogane/pull/14) | D | 3-4 | draft complete |
| Japan Post Bank | P1 | Yucho Direct/app | [#15](https://github.com/risu729/kogane/pull/15) | D | 3 (manual CSV: 2) | draft complete |
| Sony Bank | P1 | Sony Bank web/app | [#17](https://github.com/risu729/kogane/pull/17) | C | 4 (manual CSV: 1) | draft complete |
| Minna Bank | P1 | mobile app | [#16](https://github.com/risu729/kogane/pull/16) | E | 1-2 (device UI: 5) | draft complete |
| Bank of Kyoto | P1 | Kyogin Direct/app | [#18](https://github.com/risu729/kogane/pull/18) | E (C candidate) | 1 (replay: 4) | draft complete |
| Westpac | P1 | web/app | [#19](https://github.com/risu729/kogane/pull/19) | E (CDR: A) | 1 (CDR: 5) | draft complete |
| St.George Bank | P1 | web/app | [#21](https://github.com/risu729/kogane/pull/21) | C | 4 (manual PDF: 1) | draft complete |
| Wise | P1 | first-party API/web/app | [#20](https://github.com/risu729/kogane/pull/20) | E | 1 (partner API: 3-5) | draft complete |
| SBI VC Trade | P1 | VCTRADE web/app | [#23](https://github.com/risu729/kogane/pull/23) | E (C candidate) | 1 (replay: 4) | draft complete |
| Mercari / Merpay / Mercoin | P1 | Mercari app/web | [#22](https://github.com/risu729/kogane/pull/22) | E | 1-2 (full automation: 5) | draft complete |
| MyJCB card family | P2 | MyJCB web/app | [#24](https://github.com/risu729/kogane/pull/24) | C | 4 (manual export: 1) | draft complete |
| MUFG card family | P2 | My Digital Connect | pending | — | — | queued |
| Epos / Epos Visa Prepaid | P2 | EposNet/app | pending | — | — | queued |
| JP BANK Card | P2 | JP BANK Card WEB | pending | — | — | queued |
| Rakuten Card / Point / Cash | P2 | e-NAVI / PointClub | pending | — | — | queued |
| Amazon card / gift balance / points | P2 | Amazon account | pending | — | — | queued |
| au PAY | P2 | au PAY app/web | pending | — | — | queued |
| J-Coin Pay | P2 | J-Coin Pay app | pending | — | — | queued |
| V Point / V Point Pay | P2 | V Point / Vpass / app | pending | — | — | queued |
| ANA Pay / ANA Mileage Club | P2 | ANA app/web | pending | — | — | queued |
| JAL Pay / JMB | P2 | JAL app/web | pending | — | — | queued |
| AirWallet | P2 | AirWallet app | pending | — | — | queued |
| WESTER / J-WEST / wesmo! | P2 | JR West app/web | pending | — | — | queued |
| Smart EX | P2 | Smart EX web/app | pending | — | — | queued |
| Opal | P2 | Transport for NSW web/app | pending | — | — | queued |

Long-tail reward-only services stay in `data/account-inventory.csv`. Add them
to this board when expiry risk or material value makes collection worthwhile.

## Reverse-engineering follow-up audit

An official export being usable does not close the implementation-feasibility
research. The following source PRs either made reverse engineering a non-goal,
deferred it without enough transport evidence, or left the private Web/app
protocol unknown. They require a source-isolated follow-up before their
automation rating is treated as final.

| Source PR | Audit finding | Required follow-up |
| --- | --- | --- |
| [#8 Mobile Suica](https://github.com/risu729/kogane/pull/8) | Detailed reverse engineering was incorrectly listed as a non-goal | Reconcile the existing decompilation artifacts and procedure with current JRE ID/app transports; identify read hosts, schemas, token renewal, integrity metadata, and Wallet boundary |
| [#13 MUFG Bank](https://github.com/risu729/kogane/pull/13) | Dynamic analysis was deferred because the Web route looked sufficient | Inspect the current Play-delivered app and compare app/Web read coverage and session issuance |
| [#14 Mizuho Bank](https://github.com/risu729/kogane/pull/14) | Detailed app analysis was deferred | Resolve app transport, long-history local storage, point route, and device/session binding |
| [#15 Japan Post Bank](https://github.com/risu729/kogane/pull/15) | Only an analysis plan was recorded | Execute the static inventory and identify the Direct/app read transport and FIDO boundary |
| [#17 Sony Bank](https://github.com/risu729/kogane/pull/17) | WALLET app analysis was postponed until a Web gap appeared | Analyze the app transport now so the gap decision is evidence-based |
| [#18 Bank of Kyoto](https://github.com/risu729/kogane/pull/18) | App reverse engineering was marked as not adopted | Replace the blanket rejection with a bounded static/dynamic transport study |
| [#19 Westpac](https://github.com/risu729/kogane/pull/19) | Private Web/app transport remains unknown | Inspect current Web JavaScript and app metadata/transport rather than stopping at CDR/export |
| [#20 Wise](https://github.com/risu729/kogane/pull/20) | Personal internal transport remains unknown | Trace current Web/app read requests, token/session renewal, and pending/posted models without assuming Business API equivalence |
| [#21 St.George](https://github.com/risu729/kogane/pull/21) | Current Web clients exist, but app transport was left unknown | Extend the current Web implementation evidence and inspect the app read transport |
| [#22 Mercari family](https://github.com/risu729/kogane/pull/22) | Financial app transports remain unknown | Analyze Mercari/Merpay/Mercoin packages separately and map common auth versus the three ledgers |
| [#23 SBI VC Trade](https://github.com/risu729/kogane/pull/23) | APK decompilation/instrumentation was explicitly excluded | Perform a bounded app/Web transport study and update the C/D evidence |
| [#24 MyJCB](https://github.com/risu729/kogane/pull/24) | Deobfuscation, runtime tracing, and traffic observation were rejected too broadly | Trace the protection JavaScript and current credit/debit read/export paths; keep write actions out of scope, not analysis |
