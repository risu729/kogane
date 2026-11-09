<a id="金融データの意味の監査2026-09-08"></a>

# Audit of financial-data meanings (2026-09-08)

> Historical record: 2026-09-08. Scope, counts, resources and rollout
> instructions below describe that record, not a current production check.
> Use [current status](current-status.md), [rollout controls](rollout.md) and
> the [documentation index](README.md) for maintained references.

The display model follows what a record measures, not the name of the table storing it. A/B values are retained, with an evidenced C interpretation added. User totals and tax values are not created by adding observations with different meanings.

| Type                  | Examples                                                                              | Not equivalent to                                        |
| --------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Point-in-time balance | Deposits, points, electronic money, custody cash                                      | Earnings/usage during a period, buying power             |
| Event                 | Deposits/withdrawals, card usage, refunds, securities executions, usage notifications | Current balance, period total, P&L                       |
| Period activity       | Points earned last month                                                              | Current points, individual earning history               |
| Bill                  | Monthly bill, current payment details                                                 | Total usage, payment completed, outstanding debt balance |
| Valuation             | Market price, valuation, yen-converted value                                          | Held quantity, acquisition cost, realized P&L            |
| Capacity/limit        | Buying power, withdrawable amount                                                     | Additional cash holdings                                 |

<a id="確認した問題と表示上の修正"></a>

## Findings and presentation corrections

1. VPoint's SMFG display is last month's earned activity. Its mapping to official public code is recorded in [balance presentation policy](balance-presentation.md). It is separate from common and store-limited balances.
2. Confirmed MyJCB details use `_kogane.amountBasis=current-statement-payment`; unconfirmed details use `unconfirmed-usage`. The usage date does not become the amount's cash-withdrawal date. Monthly totals and detail rows are not counted twice.
3. Yen history from `SBI証券` (SBI Securities) retains original amounts and `_kogane.direction` separately. Withdrawals can be positive; sign alone must not label them as deposits.
4. Securities execution amounts include settlement amounts, and buys can be positive. Execution date, settlement date, quantity and unit price are separate concepts. `posted` establishes neither completed settlement nor P&L.
5. VPointPay notifications are not completed payments. Declines and unrecorded amounts are not replaced with zero. A balance in a notification is the quantity at the time that notification reports.
6. Bank withdrawals are not necessarily expenses, nor deposits income. Transfers, card debits, refunds and securities funding movements are not added, offset or merged without matching evidence.

The audit read `src/parsers/myjcb.ts`, `sbi-yen-detail-history.ts`, `sbi-foreign-trade-records.ts`, `sbi-vc-executions.ts`, `v-point.ts`, `v-point-pay.ts`, `mobile-suica-sf-history.ts` (now under `packages/parsers/src/parsers/`), together with existing designs and source references.

<a id="未証明の境界"></a>

## Unproven boundaries

`financial-measures-v2` separates point-in-time balances from period activity/bills on different pages. `activity-meaning-v1` independently interprets each detail row's kind, amount meaning, direction, date roles and state. The API reads only the necessary named fields from the same observation IDs it displays; it does not spread whole originals or authentication information into lists. Original amounts and timestamps are unchanged.

MyJCB shows usage dates alongside period labels, distinguishing current payment amounts from unconfirmed usage amounts. SBI yen history explicitly shows the withdrawal classification even for positive withdrawals. Securities distinguish execution from settlement and display only established quantities, unit prices and settlement dates. Card usage is a type of activity, but not equivalent to cash spending or a balance reduction. Transaction-list amounts use a neutral color; `posted` means `履歴に記録` ("recorded in history"), not paid.

This presentation change does not establish paid/outstanding amounts, income/expense classifications, economic identity across sources, point-to-currency conversions, or a non-overlapping total-asset scope across every account. Future reconciliation and calculations must also verify direction, reference time, target period, amount meaning, unit and state separately.
