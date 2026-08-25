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
| MyJCB card family | P2 | MyJCB web/app | pending | — | — | queued |
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
