# ADR 0032: The card provider's stated debit account is settlement evidence, proposed and never accepted by rule

- Status: proposed
- Date: 2026-09-27
- Carried by:
  `packages/domain/src/card-debit-account.ts`,
  `packages/domain/test/card-debit-account.test.ts`,
  [card settlements: provider-stated debit accounts](../card-settlements.md#provider-stated-debit-accounts)
- Related: [ADR 0018](0018-sbi-shinsei-bank-debit-adapter.md) (bank debit
  adapters), [ADR 0029](0029-data-classification-and-unkeyed-identity.md)
  (data classes b and c), [ADR 0004](0004-payment-type-shapes-from-evidence.md)
  (unobserved provider semantics stay unsupported),
  [ADR 0001](0001-domain-axes.md) (INV07: heuristics only propose)
- Amended: [2026-09-27](#amendment-2026-09-27-the-observed-shapes), with the
  round-4 observation this decision waited for: MyJCB shows a bank name, a
  branch name and the leading digits; Vpass shows no debit account.

## Context

[Card settlement review](../card-settlements.md) pairs a Vpass or MyJCB
statement payment total with a bank debit from an adapter (SMBC, SBI Shinsei)
when the amounts are equal and the debit date is within three days of the due
date. The code does not know which bank account a card debits, and no setting
names one. A candidate becomes a decision only when an operator accepts it and
the card account's `liable_party` and the bank account's `beneficial_owner`
are the same recorded party. No candidate has been accepted in production.

Amount and date are weak evidence. Two cards with the same total due on the
same day, or a bank debit of the same amount for another purpose, produce the
same candidate, and the operator has nothing on the review page that says
which account the card provider actually debits. The owner asked on
2026-09-27: the card side shows the debit account, why not use it.

What is known about the card side:

- **MyJCB.** That the MyJCB statement page (カードご利用代金明細照会) shows
  a transfer-account (お振替口座) block next to the payment date and total is
  reported by the owner and by a reading of JCB's public help; it is not
  verified in this repository, and the round-4 observation is pending. No
  fixture contains such a block (`services/collector-myjcb/test/fixtures/`
  and `tests/fixtures/observation-pipeline/myjcb/` hold the heading, the
  export links and the ledger; `debit-detail.html` is the JCB debit card's
  お振替日 ledger, a different page). The collector's `redactedStatementHtml`
  drops scripts, styles, frames, comments and similar elements, strips link,
  form-target, event and `data-` attributes, redacts `value` and token-like
  attributes and 16-digit card numbers in text, and keeps other text, so if
  the block exists the stored `credit-detail-NN.html` pages would likely
  contain it. Whether it exists, its labels, whether it shows bank and branch
  names or codes, and how the account number is masked are all unobserved.
- **Vpass.** The key allowlists in the statement parser
  (`packages/parsers/src/parsers/vpass.ts`) name no payment-account field.
  They do not prove its absence: nested objects such as the statement summary
  (`webMeisaiTopK3Vo`), `paramMap` and `linkHanteiVo` are read by name and are
  not key-allowlisted, and the meaning of the top-level
  `TkAccountExplanation` is unobserved. Whether any Vpass statement API
  carries a payment-account field is unknown until round 4.

What is known about the bank side, from the CORE source-account references
the identity rules accept (`packages/identity/src/other.ts`):

| Bank        | Reference                             | Account number in the reference                                                                     |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Mizuho      | `mizuho-bank:ordinary:<3>:<7 digits>` | Yes: the branch code and account number as the provider displays them. Not a debit adapter.         |
| SMBC        | `smbc-bank:ordinary-yen`              | No: the reference names the audited ordinary-yen scope, not an account.                             |
| SBI Shinsei | `sbi-shinsei:<accountNo>`             | The provider's `accountNo`; how it relates to the number a card page would display is not observed. |

## Options considered

1. **Keep amount and date only.** Nothing new to build or store. The operator
   keeps accepting on amount, date and a separately recorded ownership, with
   no evidence of which account the card debits. Rejected: the owner reports that
   the card side states the account, and if round 4 confirms it the evidence
   is on a page Kogane already stores.
2. **An owner-typed card → bank mapping.** The owner records which account
   each card debits. It works for every bank, including SMBC, but it is a
   human assertion with no source, it goes stale silently when the owner
   changes the debit account at the card issuer, and it adds a setting that
   nothing checks.
3. **The provider-stated link (chosen).** The card provider's own statement
   of the debit account is stored as an observation and matched against the
   bank side's account reference. The evidence is dated (it comes with each
   statement), it follows a change of debit account at the issuer, and it is
   provider content, not Kogane's guess.

## Decision

**Observation.** A card provider's description of the debit account, as the
statement page displays it (bank name, branch name or code, account type,
masked account number), becomes a new observation kind,
`card_debit_account_statement`, cited as a `typed-claim` source fact (the
closest existing kind; `SOURCE_FACT_KINDS` already has it and nothing uses
it). Every field is stored verbatim as displayed and is `null` when the page
does not show it. The masked account number is provider content under
ADR 0029: a masked or partial bank account number as the provider renders it
is allowed (classes b and c); a full card PAN never is. The reader also
records two resolved fields: the bank's CORE source id, through a table of
renderings actually observed (never guessed from a name), and the trailing
digits the provider shows unmasked. Each is `null` when the reader cannot
resolve it. Logs carry counts and closed codes only.

**Matching rule** (`proposeCardDebitAccount`, policy
`card-debit-account-statement-v1`). From one statement and the known bank
account references, the rule proposes a `card → bank account` relation when
exactly one comparable account at the stated bank has an account number that
ends in the visible digits, and, when both sides show a branch code, the codes
are equal. The proposal carries the statement as evidence and closed rationale
codes (`provider_stated_debit_account`, `bank_agrees`, `branch_code_agrees` or
`branch_not_compared`, `trailing_digits_agree`,
`unique_among_known_accounts`). Every other case is a closed reason and no
proposal: `statement_invalid` (the cited fact is not a valid `typed-claim`
reference), `bank_not_resolved`, `account_digits_not_shown`,
`no_comparable_bank_account`, `no_matching_account`, `ambiguous_accounts`, and
`uncomparable_account_at_bank` (another account at that bank whose number
Kogane cannot compare could be the real one). A reference is comparable only
when it carries the provider's displayed account number
(`bankAccountReference`): Mizuho's does; SMBC's carries none; SBI Shinsei's
layout is unverified and stays unsupported (ADR 0004).

**Use in settlement review.** A proposal that names both sides of a settlement
candidate (`debitAccountSupportsCandidate`) becomes that candidate's primary
evidence and is shown on the ownership review as "both providers state the
same account". Amount and date remain a consistency check. What does not
change: the proposal sets no `ownerRef` and adds no ownership evidence
reference, so it cannot make a candidate eligible. Ownership is still
recorded by the operator on the ownership review, and the settlement is still
accepted through the existing `card-settlement.accept` lifecycle (INV07). No
candidate is accepted automatically. Whether an accepted relation needs its
own command, or stays evidence cited by the settlement decision, is decided
when the reader lands.

**Scope of this change.** No fixture shows the MyJCB block or a Vpass field,
so nothing that reads a page lands: the domain types, the bank-reference
reading, the rule and its tests with synthetic inputs. The reader, the
observation table (the next free migration number when it lands), the sweep
wiring and the review-page display wait for the round-4 shapes.

## Consequences

- **Sources.** MyJCB can supply the statement only if round 4 confirms the
  owner-reported block. Vpass is unknown until round 4; if no Vpass API carries a
  payment-account field, Vpass candidates keep amount and date only.
- **Banks.** Of the two debit adapters, neither can be matched today: SMBC's
  reference has no account number, and SBI Shinsei's `accountNo` layout is
  unverified. Mizuho references are comparable but Mizuho is not an adapter
  (its row ids are fingerprints), so a Mizuho proposal supports no candidate
  until Mizuho becomes one. The rule is useful for adapter banks only after
  SMBC's reference carries the provider's account number (a separate identity
  change, which ADR 0029 class c permits) or SBI Shinsei's layout is observed.
- **Short masks.** Uniqueness is judged against the accounts Kogane knows at
  the stated bank. A mask that shows few digits can match more than one of
  them (`ambiguous_accounts`, no proposal), and the proposal records how many
  digits were compared (`visibleDigitCount`) so the reviewer sees how strong
  it is. No minimum digit count is set before the mask pattern is observed.
- **False matches.** An account at the same bank that Kogane does not collect
  can share the visible digits with one it does. The rule cannot see it, so a
  unique match among known accounts is still only a proposal, and the
  operator, who knows which accounts exist, accepts or rejects it. This is the
  reason acceptance stays with the operator even when both providers agree.
- **Change of debit account.** Each statement carries its own statement of
  the account, so a change at the card issuer produces a proposal for the new
  account from the next statement on; earlier statements keep their own.
- **Storage.** The new observation adds provider page text (bank and branch
  names, a masked number) to CORE. It is class b/c content and follows the
  raw-evidence rules; nothing is written to logs but counts and codes.

## Verification

- `packages/domain/test/card-debit-account.test.ts` (synthetic inputs only):
  bank-reference reading for the Mizuho, SMBC and SBI Shinsei shapes and for
  unrecognised references; a unique match is proposed with the listed
  rationale codes; a branch code shown on both sides must agree; the same
  mask without the branch code is `ambiguous_accounts`; missing bank, missing
  or non-ASCII digits and a mask longer than the account are closed reasons;
  SMBC and SBI Shinsei references yield `no_comparable_bank_account`; an
  uncomparable account at the same bank blocks uniqueness; a proposal
  supports a matching settlement candidate and the candidate stays
  ineligible.
- `mise run //packages/domain:ci`.
- Not verified: whether the MyJCB block exists at all (owner-reported and
  read from JCB's public help, not observed in any fixture), its labels,
  bank/branch rendering and mask; any
  Vpass payment-account field; the relation between SBI Shinsei `accountNo`
  and a displayed account number. These wait for the round-4 observations.

## Amendment 2026-09-27: the observed shapes

- Status: proposed; accepted when the amending PR merges
- Date: 2026-09-27
- Carried by:
  `packages/domain/src/myjcb-card-information.ts` (`readMyJcbCardInformation`),
  `packages/domain/src/card-debit-account.ts` (policy
  `card-debit-account-statement-v2`),
  `services/processor/src/card-debit-account-job.ts` (the
  `card_debit_account_sweep` lane),
  `services/processor/src/card-settlement-job.ts` (evidence on candidates),
  migration `0060_card_debit_account_statements.sql`,
  [card settlements: provider-stated debit accounts](../card-settlements.md#provider-stated-debit-accounts),
  [MyJCB source note](../sources/myjcb.md)
- Related: [ADR 0029](0029-data-classification-and-unkeyed-identity.md)
  (class d: the holder name)

### Context

The round-4 observation this ADR waited for was made on 2026-09-27
(structure and counts only, no value recorded):

- **MyJCB.** The statement page (`detail.html?detailMonth=N`, confirmed month)
  has no 「カード・お振替情報」 or お振替口座 block. The debit account is under an
  `h3.hdg-H3` heading 「カード情報」 after the ledger grid, in
  `div.detail-lyt-02.border-01 > div.col-01 > table.table-data`, a table of
  vertical th/td rows: カード名称 (product name), カード発行会社 (issuer),
  金融機関名 (bank name, text), 支店名 (branch **name**, text; no branch code),
  科目・口座番号 (「普通 ####\*\*\*」 in shape: 普通 or 当座, a space, the
  **first** four digits, the last three masked with `*`), and 口座名義 (the
  holder's name, partly masked). The same table is on the
  ショッピングスキップ払い page (menu position 8).
- **Stored evidence.** The same table, with the same value shapes, is in the
  stored redacted HTML (`credit-detail-01.html`; three captures of it have
  identical digests). The redaction keeps body text, so the bank name,
  branch name, masked number and partly masked holder name are already in
  stored evidence.
- **Vpass.** None of the statement APIs (`web_meisai_top/v1`,
  `dropdownlist_init/v1`, `meisai_ans/v1`, `xt_seikyu/v1`) carries a bank,
  branch or debit-account field, for any of the seven cards (two bean
  families). The only account-looking keys, `webMeisaiTopK3Vo.accountNo`
  (fully masked) and `webMeisaiTopK3Vo.accountOvly` (one letter and three
  digits), are card-side identifiers.

Two assumptions of the decision above are wrong for MyJCB: the visible
digits are the leading ones, not the trailing ones, and the branch is a name,
not a code. The bank side was checked for branch names: no bank reference
(`mizuho-bank:ordinary:<code>:<account>`, `smbc-bank:ordinary-yen`,
`sbi-shinsei:<accountNo>`) carries one. The Mizuho account-list parser keeps
the provider's branch name in its observation `extra`, but only a synthetic
fixture shows its rendering, so whether it can equal MyJCB's rendering is
unobserved.

### Options considered

1. **Keep ADR 0032's rule and map MyJCB onto it.** Treat the four digits as
   trailing digits. Rejected: it would propose the wrong account whenever an
   account ends in the digits another begins with.
2. **Compare branch names with Mizuho's `extra.branchName`.** It would
   separate two accounts with the same leading digits. Rejected for now: the
   renderings have never been compared (ADR 0004), and Mizuho is not a debit
   adapter, so it would change no candidate.
3. **Prefix rule, bank by name through an explicit table, account type
   compared, branch carried but not compared (chosen).**

### Decision

- **Reader.** `readMyJcbCardInformation` finds the 「カード情報」 table by text,
  not by the observed class names, which are layout: the one heading element
  (h1-h6) whose text is 「カード情報」, then the first table after it, read by
  its th labels: the bank name, the branch name, the 科目 (普通 or 当座), exactly four
  ASCII leading digits and the number of `*` after them. It checks the labels
  of カード名称, カード発行会社 and 口座名義 and never reads their values: the
  holder name is ADR 0029 class d, and its removal from stored pages is
  [#333](https://github.com/risu729/kogane/pull/333). Any other shape is a closed refusal code, never a partial
  reading (INV05). The reader lives in `packages/domain` beside
  `readMyJcbStatementPage` and takes a parse5 tree, so the processor can use
  it; the collector does not need it, because the redacted page already
  stores the table.
- **Observation.** A new processor lane, `card_debit_account_sweep`, under
  `RECONCILIATION_ENABLED` and right before `card_settlement_sweep`, reads
  pages whose `myjcb-credit-statement-total` parse is published and writes
  one append-only `card_debit_account_statement` row per card, raw object and
  reader version (migration 0060): `read` with the displayed values, or
  `refused` with the code and no value. It is a table of its own rather than
  a new observation kind, so no parser, parser digest or observation union
  changes. The fact reference is `typed-claim`
  `card_debit_account_statement:<id>` at revision
  `reader:<reader version>`.
- **Rule** (policy `card-debit-account-statement-v2`). The displayed bank name
  resolves to a source id only through a table in code of the banks Kogane
  models (みずほ銀行, 三井住友銀行, SBI新生銀行, ソニー銀行, compared after NFKC
  and whitespace removal); anything else is `bank_not_resolved`. 普通 is
  `ordinary`, 当座 is `current`, anything else `account_type_not_resolved`.
  A relation is proposed when exactly one known account at the bank has the
  same account type and an account number that **starts with** the leading
  digits, and every known account at the bank is comparable. The rationale
  codes are `provider_stated_debit_account`, `bank_agrees`,
  `account_type_agrees`, `branch_not_compared`, `leading_digits_agree`,
  `unique_among_known_accounts`; `branch_code_agrees` and
  `trailing_digits_agree` are retired with the v1 policy. The display type
  names the mask direction (`leadingDigits`, `maskedDigitCount`) and drops
  `branchCode` and `maskedAccountNumber`, which MyJCB does not show.
- **Settlement sweep.** For each MyJCB candidate the sweep reads the reading
  of the page its statement total was parsed from and appends what the rule
  says about the candidate to `card_settlement_debit_account_evidence`:
  `supports`, `names_other_account` or `not_proposed` with the reason, only
  when that differs from the candidate's latest row. The candidate's facts
  and digest do not include it, so no candidate is duplicated or changed and
  eligibility is exactly as before (INV07). This settles the question left
  open above: the relation stays evidence cited beside the candidate, with no
  command of its own.
- **Vpass** is recorded as observed absent: no reader and no statement.

### Consequences

- MyJCB candidates carry evidence rows. With the bank references Kogane has
  today, a page naming an adapter bank is `no_comparable_bank_account`, and a
  page naming Mizuho can at most be `names_other_account`: nothing
  `supports` a candidate until an adapter bank's reference carries the
  displayed account number.
- The evidence is not shown on the review page: that needs a field in the
  published review contract and the web page, a later change.
- Branch names are stored and never compared, so two known accounts at one
  bank with the same four leading digits are `ambiguous_accounts`.
- The stored table adds the bank name, branch name, 科目 and four digits to
  CORE (ADR 0029 classes b/c); the holder name is never stored. Logs and tick
  records carry counts only.

### Verification

- `packages/domain/test/card-debit-account.test.ts`: the bank-name table and
  account types; a unique prefix match is proposed with the listed codes; an
  account ending in the digits is not; two accounts sharing the prefix are
  ambiguous whatever their branch; the account type must agree; missing parts
  are closed reasons; the evidence outcomes and an unchanged candidate.
- `services/processor/test/card-debit-account.test.ts`: the reader on
  synthetic tables (values, every refusal, holder and card names never read);
  the table found by heading text and labels without class names; bank names
  with collapsed whitespace resolved after NFKC; the lane (one row per card
  and raw object, none for an unpublished page or on a re-run, refusals
  without values, bytes failing their digest refused as
  `raw_object_unreadable`, a key the table cannot hold never selected,
  append-only guards and the value check); the evidence trigger refusing a
  reading of another card; the sweep (a `names_other_account` row, no row appended for the same
  outcome, a new row for a changed one, the candidate's facts and eligibility
  unchanged, `no_comparable_bank_account` for a bank without comparable
  references).
- Not verified: the reader against a stored production page (the synthetic
  table mirrors the reported shape); whether Mizuho's branch-name rendering
  equals MyJCB's; the relation between the mask length and a bank's account
  number length.
