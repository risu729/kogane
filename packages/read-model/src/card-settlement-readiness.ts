// `card_settlement_readiness` (migration 0044) for named candidates only.
//
// The view reads `card_statement_facts`, `card_bank_debit_facts` and
// `card_settlement_fact_ownership` whole: it ranks every captured statement
// total and every bank adapter row of the history, and resolves owners through
// `current_identity_observations`, which materializes the candidate identity
// runs of every published parse. On D1, which never runs `ANALYZE`, the first
// page of the review list took about 42 s on the two-year synthetic store and
// one candidate's readiness about 5 s (docs/card-settlements.md, Cost).
//
// These CTEs compute the same flags for the candidates a caller names. The
// caller defines `chosen(id)` before them; they add
//
//   ready_candidates     those candidates' rows;
//   statement_partitions the (source, period) of each candidate's statement;
//   ready_statements     `card_statement_facts`, for the statements of those (source, period);
//   debit_partitions     the (source account, provider id) of each candidate's debit;
//   ready_debits         `card_bank_debit_facts`, for the rows of those partitions:
//                        the union of its adapter branches (SMBC, SBI Shinsei;
//                        migration 0052), each with the view's own predicate;
//   statement_observed   the statements whose owner a flag reads;
//   statement_owned_runs ... statement_ownership
//                        card-settlement-ownership.ts, `balance`, over those;
//   debit_observed       the candidates' debits;
//   debit_owned_runs ... debit_ownership
//                        card-settlement-ownership.ts, `transaction`, over those;
//   readiness            the view's own select over them: id, statement_current,
//                        bank_current, ownership_current, allocation_available;
//                        and claim_available (ADR 0054, G1b), which the view
//                        does not have: no live holder of the candidate's
//                        bank_key, or of its debit's alias class, in book
//                        `cash-movement` other than the candidate's own
//                        accepted event.
//
// They are exact, not an approximation. Each fact view ranks captures within a
// partition (source, producer, namespace, source account and period or provider
// id), and both restrictions keep whole partitions: every row of a given
// source and period, and every row of a given source account and provider id.
// `statement_current` compares a candidate's statement only with statements of
// its own source and period, and `bank_current` looks up the candidate's own
// debit, so the partitions they can reach are all there. The owners are those
// of card-settlement-ownership.ts, which is exact for the observations named.
// The allocation check keeps the view's text, with the debit's own source
// account and provider id taken from the candidate's `bank_key` as well: a row
// whose key equals `bank_key` has exactly those, so the added terms only let
// the plan find the rows by index; the debit rows are reached by the account
// index too (`+t.external_id` keeps an unanalyzed planner from building an
// automatic index over every bank row instead). `readiness` is the view's select with the
// three views swapped for these CTEs; the review and allocation checks are the
// view's text. card-settlement-readiness.test.ts and every caller's
// differential test compare it with the view on the scale and random stores.
//
// `claim_available` reads the holders `live_consumption_claims` (CORE 0070)
// lists in book `cash-movement`, spelled out per source as the 0070 triggers
// spell them, each through its own index: SQLite does not push a correlated
// term into a UNION view. Its first term is the candidate's bank_key held by an
// `economic_claims` row of a live revision, its second the same key held by an
// accepted settlement decision of a live revision (a legacy holder, without an
// alias class), its third the alias class the registry's provider identity
// function computes for the candidate's debit row and resolved account
// (`providerAliasClassSql`) held by a live `economic_claims` row. A holder is
// the candidate's own when it is the event of the candidate's accepted review.
// The other four columns are the text they were before it (frozen in
// test/card-settlement-readiness-ctes-legacy-sql.ts and compared on the random
// stores).
import { PROVIDER_IDENTITY_FUNCTIONS } from "../../domain/src/event-families.ts";
import { cardSettlementOwnershipCtes } from "./card-settlement-ownership.ts";

const SQL_TEXT = /^[A-Za-z0-9$:._-]+$/u;
const quoted = (text: string): string => {
  // Registry constants only; a value outside this alphabet is a programming error.
  if (!SQL_TEXT.test(text)) throw new RangeError("registry text is not a plain SQL literal");
  return `'${text}'`;
};

/**
 * The alias class a declared provider identity function computes for one
 * stored transaction row (`declaredAliasClass` in
 * packages/domain/src/row-identity.ts), as an SQL expression that is NULL
 * where that function is null: no function for the row's source, parser and
 * source account, a component that is missing, empty, not text or longer than
 * 512 characters, an account that is not a text of 1 to 256 characters, or a
 * class longer than 2,048 characters. The arguments are SQL expressions for
 * the row's source id, parser name, source account and `extra_json`, and for
 * the resolved account id.
 */
export function providerAliasClassSql(input: {
  sourceId: string;
  parserName: string;
  sourceAccount: string;
  extraJson: string;
  accountId: string;
}): string {
  const branches = PROVIDER_IDENTITY_FUNCTIONS.map((declared) => {
    const fields = declared.componentFields.map((field) => quoted(`$.${field}`));
    const scope =
      declared.sourceAccounts === "any"
        ? ""
        : ` AND ${input.sourceAccount} IN (${declared.sourceAccounts.map(quoted).join(",")})`;
    const components = fields
      .map(
        (path) =>
          ` AND json_type(${input.extraJson},${path})='text' AND length(json_extract(${input.extraJson},${path})) BETWEEN 1 AND 512`,
      )
      .join("");
    const value = `json_array(${input.sourceId},json_array(${fields
      .map((path) => `json_extract(${input.extraJson},${path})`)
      .join(",")}),${input.accountId},${quoted(declared.ruleVersion)})`;
    return `WHEN ${input.sourceId}=${quoted(declared.sourceId)} AND ${input.parserName}=${quoted(declared.parserName)}${scope}${components}
  AND typeof(${input.accountId})='text' AND length(${input.accountId}) BETWEEN 1 AND 256
  AND length(${value})<=2048 THEN ${value}`;
  });
  // The JSON functions raise on malformed text, so they run only under json_valid.
  return `CASE WHEN json_valid(${input.extraJson}) THEN CASE ${branches.join("\n  ")} END END`;
}

/** The event of the candidate's own accepted review, whose claims are not another holder. */
const OWN_EVENT = `(SELECT self.event_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id AND self.status='accepted')`;

/**
 * The key half of `claim_available`, over a candidate row named
 * `ready_candidate`: no live `economic_claims` row and no live accepted
 * settlement of another event holds its bank_key.
 */
const KEY_AVAILABLE = ` NOT EXISTS(SELECT 1 FROM economic_claims held
  JOIN economic_event_revisions held_revision ON held_revision.event_id=held.event_id AND held_revision.revision=held.revision
  WHERE held.book='cash-movement' AND held.consumption_key=ready_candidate.bank_key AND held_revision.superseded_by IS NULL
  AND held.event_id IS NOT ${OWN_EVENT})
 AND NOT EXISTS(SELECT 1 FROM card_settlement_candidates holder_candidate
  JOIN card_settlement_decisions holder ON holder.proposal_id=holder_candidate.id AND holder.status='accepted'
  JOIN economic_event_revisions holder_revision ON holder_revision.event_id=holder.event_id AND holder_revision.revision=holder.revision
  WHERE holder_candidate.bank_key=ready_candidate.bank_key AND holder_revision.superseded_by IS NULL
  AND holder.event_id IS NOT ${OWN_EVENT})`;

/**
 * Whether one candidate's bank_key is free (?1 the candidate id): the key half
 * of `claim_available`, the same text. A plan reads it to name why a claim is
 * unavailable (`economic_claim_held` when the key is held, else
 * `alias_conflict`).
 */
export const CARD_SETTLEMENT_KEY_AVAILABLE_SQL = `SELECT ${KEY_AVAILABLE} AS key_available
FROM card_settlement_candidates ready_candidate WHERE ready_candidate.id=?1`;

/** The 0044 period expression of a statement total, over `b.extra_json`. */
const PERIOD = `coalesce(json_extract(b.extra_json,'$._kogane.period'),
  substr(json_extract(b.extra_json,'$._kogane.statementMonth'),1,4)||'-'||substr(json_extract(b.extra_json,'$._kogane.statementMonth'),5,2))`;

/**
 * One adapter branch of `card_bank_debit_facts` (migration 0052), ranked on
 * its provider key, over the rows of the candidates' debit partitions only.
 * `admits` is the branch's own source (and parser) predicate, applied before
 * the ranking as the view applies it.
 */
function debitBranch(admits: string): string {
  return `
 SELECT t.id,t.parse_run_id,t.source_account,t.currency AS unit_ref,t.external_id,t.status,t.extra_json,d.coefficient,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id
  ORDER BY a.fetched_at DESC,t.id DESC) AS position
 FROM debit_partitions debit_partition
 CROSS JOIN transaction_observations t ON t.source_account=debit_partition.source_account AND +t.external_id=debit_partition.external_id
 JOIN published_parse_runs pub ON pub.parse_run_id=t.parse_run_id
 JOIN parse_runs p ON p.id=t.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='transaction' AND d.observation_id=t.id AND d.policy_version='decimal-v1'
 WHERE ${admits} AND t.external_id IS NOT NULL AND t.external_id<>''`;
}

export function cardSettlementReadinessCtes(): string {
  return `ready_candidates AS MATERIALIZED (
 SELECT c.* FROM (SELECT DISTINCT id FROM chosen) chosen_ids
 CROSS JOIN card_settlement_candidates c ON c.id=chosen_ids.id
), statement_partitions AS MATERIALIZED (
 SELECT DISTINCT a.source_id,${PERIOD} AS period
 FROM ready_candidates ready_candidate
 CROSS JOIN balance_observations b ON b.id=ready_candidate.statement_observation_id
 CROSS JOIN parse_runs p ON p.id=b.parse_run_id
 CROSS JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
 WHERE json_valid(b.extra_json)
), ready_statements AS MATERIALIZED (
 SELECT * FROM (
 SELECT b.id,b.parse_run_id,b.source_account,b.instrument AS unit_ref,a.source_id,a.fetched_at,
 d.status AS value_status,d.coefficient,d.scale,
 json_extract(b.extra_json,'$._kogane.paymentDate') AS payment_date,
 ${PERIOD} AS period,
 row_number() OVER(PARTITION BY a.source_id,fr.producer_id,ses.external_id_namespace,b.source_account,
  ${PERIOD}
  ORDER BY a.fetched_at DESC,json_extract(b.extra_json,'$._kogane.paymentDate') IS NOT NULL DESC,b.id DESC) AS position
 FROM balance_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=b.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN financial_fetch_runs fr ON fr.id=a.fetch_run_id
 JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
 LEFT JOIN observation_decimal_values d ON d.kind='balance' AND d.observation_id=b.id AND d.policy_version='decimal-v1'
 WHERE ((a.source_id='vpass' AND p.parser_name='vpass-statement-page') OR (a.source_id='myjcb' AND p.parser_name='myjcb-credit-statement-total'))
 AND b.metric='credit_statement_payment_amount' AND json_valid(b.extra_json)
 AND json_extract(b.extra_json,'$._kogane.snapshotSemantics')='provider-reported-monthly-payment-amount'
 AND EXISTS(SELECT 1 FROM statement_partitions statement_partition WHERE statement_partition.source_id IS a.source_id
  AND statement_partition.period IS CASE WHEN json_valid(b.extra_json) THEN ${PERIOD} END)
 ) WHERE position=1
), debit_partitions AS MATERIALIZED (
 SELECT DISTINCT t.source_account,t.external_id
 FROM ready_candidates ready_candidate
 CROSS JOIN transaction_observations t ON t.id=ready_candidate.bank_observation_id
 WHERE t.external_id IS NOT NULL AND t.external_id<>''
), ready_debits AS MATERIALIZED (
 SELECT * FROM (${debitBranch("a.source_id='smbc-bank'")}
 ) WHERE position=1 AND status='posted' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.direction')='outflow'
 AND json_extract(extra_json,'$._kogane.amountSignSource')='direction'
 AND coefficient LIKE '-%'
 UNION ALL
 SELECT * FROM (${debitBranch("a.source_id='sbi-shinsei-bank' AND p.parser_name='sbi-shinsei-top-balances-and-activity'")}
 ) WHERE position=1 AND status IS NULL AND unit_ref='JPY' AND json_valid(extra_json)
 AND json_extract(extra_json,'$._kogane.amountSignSource')='debit'
 AND coefficient LIKE '-%'
), statement_observed AS (
 SELECT id AS observation_id FROM ready_statements
 UNION ALL SELECT statement_observation_id FROM ready_candidates
), ${cardSettlementOwnershipCtes("balance", { prefix: "statement_", observed: "statement_observed" })},
debit_observed AS (SELECT bank_observation_id AS observation_id FROM ready_candidates),
${cardSettlementOwnershipCtes("transaction", { prefix: "debit_", observed: "debit_observed" })},
readiness AS (
SELECT ready_candidate.id,
 EXISTS(SELECT 1 FROM ready_statements current_statement
  WHERE current_statement.id=ready_candidate.statement_observation_id AND current_statement.parse_run_id=ready_candidate.statement_parse_run_id
  AND NOT EXISTS(SELECT 1 FROM ready_statements newer_statement
   JOIN statement_ownership newer_owner ON newer_owner.kind='balance' AND newer_owner.observation_id=newer_statement.id
   WHERE newer_statement.source_id=current_statement.source_id AND newer_statement.period=current_statement.period
    AND newer_owner.account_id=json_extract(ready_candidate.facts_json,'$.statement.accountId')
    AND (newer_statement.fetched_at>current_statement.fetched_at
     OR (newer_statement.fetched_at=current_statement.fetched_at AND newer_statement.id>current_statement.id)))
 ) AS statement_current,
 EXISTS(SELECT 1 FROM ready_debits current_debit WHERE current_debit.id=ready_candidate.bank_observation_id AND current_debit.parse_run_id=ready_candidate.bank_parse_run_id) AS bank_current,
 EXISTS(SELECT 1 FROM statement_ownership statement_owner JOIN debit_ownership debit_owner
  ON debit_owner.kind='transaction' AND debit_owner.observation_id=ready_candidate.bank_observation_id
  WHERE statement_owner.kind='balance' AND statement_owner.observation_id=ready_candidate.statement_observation_id
   AND statement_owner.owner_ref IS NOT NULL AND statement_owner.owner_ref=debit_owner.owner_ref
   AND statement_owner.account_id=json_extract(ready_candidate.facts_json,'$.statement.accountId')
   AND debit_owner.account_id=json_extract(ready_candidate.facts_json,'$.bankDebit.accountId')
   AND statement_owner.owner_ref=json_extract(ready_candidate.facts_json,'$.statement.ownerRef')
   AND debit_owner.owner_ref=json_extract(ready_candidate.facts_json,'$.bankDebit.ownerRef')
   AND NOT EXISTS(SELECT 1 FROM json_each(statement_owner.evidence_refs_json) e WHERE e.value NOT IN (SELECT value FROM json_each(ready_candidate.facts_json,'$.ownershipEvidenceRefs')))
   AND NOT EXISTS(SELECT 1 FROM json_each(debit_owner.evidence_refs_json) e WHERE e.value NOT IN (SELECT value FROM json_each(ready_candidate.facts_json,'$.ownershipEvidenceRefs')))
 ) AS ownership_current,
 NOT EXISTS(SELECT 1 FROM card_settlement_reviews used WHERE used.status='accepted' AND used.id<>ready_candidate.id
  AND (used.statement_key=ready_candidate.statement_key OR used.bank_key=ready_candidate.bank_key
   OR (json_extract(used.facts_json,'$.statement.sourceId')=json_extract(ready_candidate.facts_json,'$.statement.sourceId')
    AND json_extract(used.facts_json,'$.statement.accountId')=json_extract(ready_candidate.facts_json,'$.statement.accountId')
    AND json_extract(used.facts_json,'$.statement.period')=json_extract(ready_candidate.facts_json,'$.statement.period'))))
 AND NOT EXISTS(SELECT 1 FROM current_allocations a
  JOIN transaction_observations t ON a.source_component_ref='transaction:'||t.id
  JOIN parse_runs p ON p.id=t.parse_run_id
  JOIN observation_fetch_artifacts artifact ON artifact.id=p.fetch_artifact_id
  JOIN financial_fetch_runs fr ON fr.id=artifact.fetch_run_id
  JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
  WHERE json_array(artifact.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id)=ready_candidate.bank_key
  AND t.source_account=CASE WHEN json_valid(ready_candidate.bank_key) THEN json_extract(ready_candidate.bank_key,'$[3]') END
  AND t.external_id IS CASE WHEN json_valid(ready_candidate.bank_key) THEN json_extract(ready_candidate.bank_key,'$[4]') END
  AND a.id IS NOT (SELECT settlement_id FROM card_settlement_reviews self WHERE self.id=ready_candidate.id)) AS allocation_available,
${KEY_AVAILABLE}
 AND NOT EXISTS(SELECT 1 FROM transaction_observations debit
  JOIN parse_runs debit_run ON debit_run.id=debit.parse_run_id
  JOIN fetch_artifacts debit_artifact ON debit_artifact.id=debit_run.fetch_artifact_id
  JOIN economic_claims alias_held ON alias_held.book='cash-movement' AND alias_held.alias_class=${providerAliasClassSql(
    {
      sourceId: "debit_artifact.source_id",
      parserName: "debit_run.parser_name",
      sourceAccount: "debit.source_account",
      extraJson: "debit.extra_json",
      accountId: "json_extract(ready_candidate.facts_json,'$.bankDebit.accountId')",
    },
  )}
  JOIN economic_event_revisions alias_revision ON alias_revision.event_id=alias_held.event_id AND alias_revision.revision=alias_held.revision
  WHERE debit.id=ready_candidate.bank_observation_id AND alias_revision.superseded_by IS NULL
  AND alias_held.event_id IS NOT ${OWN_EVENT}) AS claim_available
FROM ready_candidates ready_candidate)`;
}
