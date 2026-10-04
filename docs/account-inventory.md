# Account and Source Inventory

This inventory is the source-selection input for Kogane. It is derived from
the private Google Sheet `資産・残高チェックリスト` and is intentionally not
a balance report.

The machine-readable snapshot is [`data/account-inventory.csv`](../data/account-inventory.csv).
It retains provider, asset/reward type, unit, official surface, ownership,
holding evidence, and research priority. It deliberately omits:

- balances and valuations;
- account, member, and card numbers;
- email aliases and usernames;
- Bitwarden item names and all credential material;
- MoneyForward connection state.

The source spreadsheet remains private and authoritative for personal account
state. The checked-in CSV is a sanitized planning snapshot, not a replacement
for it.

## Current owner source selection

The owner confirmed these source-selection changes on 2026-10-05. They take
precedence over an older source-sheet snapshot; they do not confirm a current
balance or promote an unconfirmed product to a holding.

| Source                                    | Selection                                                                                       | Tracking                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GitHub Sponsors / Stripe Connect receipts | Excluded: no longer in use; its planning row was removed                                        | Re-add only after the owner confirms resumed use                  |
| APA Hotel points                          | Included for collector work; collection is not implemented                                      | [APA points #462](https://github.com/risu729/kogane/issues/462)   |
| d POINT CLUB                              | Included as a separate source from a bank's linked-point display; collection is not implemented | [d POINT CLUB #463](https://github.com/risu729/kogane/issues/463) |

The checked-in CSV remains a source-sheet snapshot. The two new selections
above are not fabricated as source-sheet rows. Other services discovered in
mail remain outside the selected scope until the owner chooses them. Do not
copy private mail bodies, balances, account labels or identifiers into this
inventory.

Work and acceptance progress live in the
[collector backlog #440](https://github.com/risu729/kogane/issues/440). Keep this
section limited to selected/excluded scope; update actual collector limits in
the relevant maintained documentation when implementation lands.

## Research units

A research unit is one institution or one demonstrably shared official API.
Different institutions are not combined merely because a third-party tool
supports both. This keeps authentication, anti-bot behavior, history limits,
and conclusions attributable to the correct source.

### P0 — investigate first

| Research unit                                | Direct official surfaces                                       | Why first                                                                                          |
| -------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Mobile Suica / JRE ID / JRE POINT            | Mobile Suica and JRE POINT; Google Wallet as an auxiliary view | SF history is time-limited; compare route coverage without treating Wallet as the source of record |
| SMBC bank                                    | SMBC Direct / Olive                                            | Bank settlement and balances complement the existing Vpass collector                               |
| SBI Securities                               | SBI Securities web/app                                         | Broker source needed; strong existing client prior art                                             |
| PayPay                                       | PayPay app                                                     | Stored value and points are separate observations                                                  |
| Sumishin SBI Net Bank / DOCOMO SMTB Net Bank | Official app/web                                               | Purpose accounts and hybrid deposit are separate balances                                          |

### P1 — direct banks, brokers, and multi-currency accounts

- SMBC Trust Bank PRESTIA / GLOBAL PASS
- SBI Shinsei Bank
- MUFG Bank
- Mizuho Bank
- Japan Post Bank
- Sony Bank
- Minna Bank
- Bank of Kyoto
- Westpac
- St.George Bank
- Wise
- SBI VC Trade
- Mercari / Merpay / Mercoin

### P2 — cards, stored value, and transport

- Vpass card statements (existing collector)
- MyJCB family where the official API is actually shared
- MUFG My Digital Connect cards
- Epos and Epos Visa Prepaid
- JP BANK Card WEB
- Rakuten Card / Rakuten Point / Rakuten Cash
- Amazon Mastercard / gift-card balance / Amazon Points
- au PAY
- J-Coin Pay
- V Point Pay and V Points
- ANA Pay / ANA Mileage Club
- JAL Pay / JMB
- AirWallet
- WESTER / J-WEST / wesmo!
- Smart EX
- Opal

Reward-only and long-tail services remain in the CSV. They are investigated
after sources that contain transaction, balance, or position evidence unless
their expiry window makes them urgent.

## Holding evidence

`holding_evidence` is deliberately conservative:

- `confirmed-in-source-sheet`: the private source sheet has direct evidence of
  the asset or reward;
- `account-confirmed-product-unconfirmed`: the account is confirmed, but that
  particular sub-account/product still needs verification;
- `account-indicated-product-unconfirmed`: an account entry exists, but the
  specific balance/product is not confirmed;
- `unconfirmed`: do not treat it as held without new evidence.

No research PR may silently promote an unconfirmed product to a holding. A
collector should enumerate the official account response instead of assuming
that every product offered by the institution is present.

## Updating the snapshot

1. Export the private sheet as XLSX.
2. Read the `残高インベントリ` tab.
3. Keep only personal rows (including family cards whose liability belongs to
   the personal account).
4. Map the nine public columns used by `data/account-inventory.csv`.
5. Drop all balance, identifier, credential, email-alias, and aggregator-state
   columns before committing.
6. Apply the current owner source selection above so an inactive source is
   not restored from an older sheet. Adding a selected source to the snapshot
   still requires its source-sheet provenance.
7. Review the diff for digit sequences, email addresses, card suffixes, and
   personal names before pushing.

The public snapshot must be regenerated, never hand-joined with credentials or
raw Bitwarden exports.
