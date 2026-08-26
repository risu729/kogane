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
| MUFG card family | P2 | My Digital Connect | [#26](https://github.com/risu729/kogane/pull/26) | D (C candidate) | 4 (manual export: 1-2) | draft complete |
| Epos / Epos Visa Prepaid | P2 | EposNet/app | [#25](https://github.com/risu729/kogane/pull/25) | E (C candidate) | 1-2 (analysis: 3-4) | draft complete |
| JP BANK Card | P2 | JP BANK Card WEB | [#27](https://github.com/risu729/kogane/pull/27) | D (C candidate) | 4 (manual CSV: 1) | draft complete |
| Rakuten Card / Point / Cash | P2 | e-NAVI / PointClub | [#29](https://github.com/risu729/kogane/pull/29) | E (C candidate) | 1-2 (replay: 4) | draft complete |
| Amazon card / gift balance / points | P2 | Amazon account | [#28](https://github.com/risu729/kogane/pull/28) | C candidate | 4 (manual artifacts: 1-2) | draft complete |
| au PAY | P2 | au PAY app/web | [#32](https://github.com/risu729/kogane/pull/32) | E (C candidate) | 1 (Web replay: 3) | draft complete |
| J-Coin Pay | P2 | J-Coin Pay app | [#30](https://github.com/risu729/kogane/pull/30) | D (C candidate) | 4 (manual view: 1) | draft complete |
| V Point / V Point Pay | P2 | V Point / Vpass / app | [#34](https://github.com/risu729/kogane/pull/34) | D (Web: C candidate) | 4-5 (manual: 1) | draft complete |
| ANA Pay / ANA Mileage Club | P2 | ANA app/web | [#31](https://github.com/risu729/kogane/pull/31) | C candidate | 4 (manual: 1-2) | draft complete |
| JAL Pay / JMB | P2 | JAL app/web | [#33](https://github.com/risu729/kogane/pull/33) | D | 5 (manual: 1-2) | draft complete |
| AirWallet | P2 | AirWallet app | [#36](https://github.com/risu729/kogane/pull/36) | E (C candidate) | 1-2 (automation: 4-5) | draft complete |
| WESTER / J-WEST / wesmo! | P2 | JR West app/web | [#35](https://github.com/risu729/kogane/pull/35) | D | 5 (manual: 1-2) | draft complete |
| Smart EX | P2 | Smart EX web/app | [#37](https://github.com/risu729/kogane/pull/37) | D (Web: C candidate) | 4 (manual: 1) | draft complete |
| Opal | P2 | Transport for NSW web/app | [#38](https://github.com/risu729/kogane/pull/38) | C candidate | 3 (manual: 1) | draft complete |

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
| [#8 Mobile Suica](https://github.com/risu729/kogane/pull/8) | **Resolved:** 6.6.0 splits/DEX/.NET assemblies were inspected; SF history path/schema, token retry, `sfLog`, pinning, and Wallet boundary are now recorded | Compare against owner-device Play splits and observe one sanitized history call to resolve `sfLog`, token lifetime, and runtime integrity metadata |
| [#13 MUFG Bank](https://github.com/risu729/kogane/pull/13) | **Resolved:** current login BFF, CSRF/screen headers, session extension, device print, Trusteer signal, and app provenance are recorded; runtime analysis is now in scope | Capture sanitized authenticated read BFF metadata and compare with owner-device Play splits/app coverage |
| [#14 Mizuho Bank](https://github.com/risu729/kogane/pull/14) | **Resolved:** current Play provenance, Web session/form transport, dynamic host routing, fingerprint fields, and concrete app static/runtime targets are recorded; reverse engineering is now in scope | Inspect owner-device Play splits and one sanitized authenticated read flow to resolve local history schema, point SSO, session/device binding, integrity, and pinning |
| [#15 Japan Post Bank](https://github.com/risu729/kogane/pull/15) | **Resolved:** current Play provenance, Struts login events, FIDO app-link boundary, public telemetry scripts, and concrete split/static/runtime procedures are recorded; reverse engineering is now in scope | Inspect owner-device splits and one sanitized authenticated read flow to resolve app schema/session issuance, FIDO profile, WebView boundary, integrity, and pinning |
| [#17 Sony Bank](https://github.com/risu729/kogane/pull/17) | **Resolved:** both official app packages, current Web CSRF/action/session boundary, Caulis integration, and parallel app static/runtime study are recorded; analysis no longer waits for a Web gap | Inspect owner-device splits and sanitized read flows to resolve app hosts/schema, app-to-Web SSO, WALLET ledger coverage, device binding, integrity, and pinning |
| [#18 Bank of Kyoto](https://github.com/risu729/kogane/pull/18) | **Resolved:** ParaSOL Web protection and fingerprint scripts were deobfuscated, official app provenance and bounded split/static/runtime analysis are recorded, and reverse engineering is no longer rejected | Inspect owner-device splits and sanitized authenticated read metadata to resolve export routes, session/risk-token renewal, app schema/local history, integrity, and pinning |
| [#19 Westpac](https://github.com/risu729/kogane/pull/19) | **Resolved:** current EAM/login JS, anonymous session, anti-forgery/LTPA, BioCatch/device telemetry, pending/posted UI model, app signer provenance, and split/static/runtime procedures are recorded independently of CDR | Observe sanitized authenticated Web/app reads and owner-device splits to resolve account/transaction routes, session renewal, pagination, pending-to-posted keys, device binding, integrity, and pinning |
| [#20 Wise](https://github.com/risu729/kogane/pull/20) | **Resolved:** current personal login JS, XSRF/OTT/passkey/device-challenge paths, Play provenance, ledger-specific read targets, and split/static/runtime procedures are recorded separately from Platform APIs | Observe one sanitized authenticated Home/Activity flow and owner-device splits to resolve personal read paths, pagination, session renewal, pending/posted schema, device binding, integrity, and pinning |
| [#21 St.George](https://github.com/risu729/kogane/pull/21) | **Resolved:** current login JS, dynamic credential/device fields, remote-access probe, BioCatch lifecycle, official app provenance, brand-family boundaries, and split/static/runtime procedures are recorded | Observe sanitized authenticated Web/app reads and owner-device splits to resolve portfolio/transaction schema, session renewal, pagination, pending/posted keys, Quick Logon binding, integrity, and pinning |
| [#22 Mercari family](https://github.com/risu729/kogane/pull/22) | **Resolved:** current Web OIDC/PKCE/DPoP transport, silent renewal, Mercari and Merpay ledger-specific read routes, app provenance, and split/static/runtime procedures are recorded separately from the still-unknown Mercoin app ledger | Validate the mapped Web reads in one sanitized session and inspect owner-device splits to resolve retention, merchant pending/settled/refund routes, Mercoin asset/order/execution/report schema, device binding, integrity, and pinning |
| [#23 SBI VC Trade](https://github.com/risu729/kogane/pull/23) | **Resolved:** public Nuxt source maps exposed the same-origin event gateway and read/write event split; APK analysis is now in scope | Pull owner-device Play splits and compare app transport/session metadata with the mapped Web events |
| [#24 MyJCB](https://github.com/risu729/kogane/pull/24) | **Resolved:** protection JS, Okura session reuse, historical export candidates, deobfuscation, APK analysis, and runtime tracing are now in scope | Observe current credit/export/o-matome requests and inspect owner-device Play splits for issuer feature flags and app transport |
