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
- Waits for: the round-4 observation of the MyJCB statement page's
  transfer-account block (its labels, whether bank and branch names or codes
  appear, the mask pattern of the account number) and of whether any Vpass
  statement API carries a payment-account field.

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
