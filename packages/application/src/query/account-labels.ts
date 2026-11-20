// The readable label of an account entity (ADR 0120): one label per account,
// whichever of its source references a row was read through. The identity
// pages, the observation and balance organization and the filter options all
// label accounts through `entityAccountLabels`, so `kogane.identity.read`,
// `kogane.balances.read` and the screens show the same name for one account.
//
// The label is display only. It never changes which account a row is
// attributed to, which mapping is current or what a mapping records; a
// mapping the owner wrote by hand (`manual`) keeps its own label.
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { connectionAccountLabel, readAccountConnections } from "./account-connections.ts";

/** Where an entity's label came from, for a reader that wants to say so. */
export type EntityLabelOrigin = "connection" | "card-name";
export interface EntityAccountLabel {
  label: string;
  origin: EntityLabelOrigin;
}

/** The bound on account entities one call labels (the organization step's own bound). */
export const ENTITY_LABEL_ACCOUNT_LIMIT = 5501;
/** The bound on the current source references of those entities. */
const REFERENCE_LIMIT = 5501;

/**
 * No index leads from an account to its mappings, so the ids are an `IN` list:
 * one pass over the mappings with a lookup in the list, where a join on
 * `json_each` scans the whole list once per mapping.
 */
const REFERENCES_SQL = `SELECT s.id referenceId,m.account_id targetId,s.source_id source,s.producer_id producer,
 json_extract(s.reference_json,'$[0]') sourceAccount,m.method
 FROM current_account_mappings m JOIN source_accounts s ON s.id=m.source_account_id
 WHERE m.account_id IN (SELECT value FROM json_each(?1))
 ORDER BY s.id LIMIT ${REFERENCE_LIMIT + 1}`;

/**
 * For each Vpass reference, the card name of its newest bound credit capture:
 * the published `vpass-credit-snapshot` parse of the highest fetch artifact
 * whose observations the current identity attributes to the reference, and
 * the name that parse recorded (reader 1.1.0 and later). The fetch artifact
 * orders captures; a re-parse of an older capture gets a higher observation id
 * but keeps its artifact id, so it never stands in for the newest capture.
 *
 * "Current" is `current_identity_observations` restricted to these
 * references: an eligible sealed run of the published parse with that parse's
 * highest sealed policy version, of a successful fetch run. A superseded run
 * (an older policy that keyed the card by its per-session ordinal) or a
 * capture every other read leaves out never names the card. The checks run
 * once per identity run of a reference, not once per observation.
 */
const CARD_NAMES_SQL = `WITH runs AS MATERIALIZED (
 SELECT DISTINCT io.source_account_id ref,io.identity_run_id run
 FROM json_each(?1) t CROSS JOIN identity_observations io ON io.source_account_id=t.value AND io.kind='balance'
), newest AS MATERIALIZED (
 SELECT x.ref,max(p.fetch_artifact_id) artifact
 FROM runs x CROSS JOIN identity_runs ir ON ir.id=x.run
 CROSS JOIN published_parse_runs pub ON pub.parse_run_id=ir.parse_run_id AND pub.parser_name='vpass-credit-snapshot'
 CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=ir.id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 CROSS JOIN eligible_identity_runs r ON r.id=ir.id
 WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
  AND r.policy_version=(SELECT max(newer.policy_version) FROM eligible_identity_runs newer
   JOIN identity_run_seals newer_seal ON newer_seal.identity_run_id=newer.id
   WHERE newer.parse_run_id=r.parse_run_id)
 GROUP BY x.ref
)
SELECT n.ref referenceId,min(b.source_account) sourceAccount,max(b.source_account) otherAccount,
 min(json_extract(b.extra_json,'$._kogane.cardName')) cardName,
 max(json_extract(b.extra_json,'$._kogane.cardName')) otherName
FROM newest n JOIN published_parse_runs pub ON pub.fetch_artifact_id=n.artifact
 AND pub.parser_name='vpass-credit-snapshot'
JOIN balance_observations b ON b.parse_run_id=pub.parse_run_id
GROUP BY n.ref`;

interface ReferenceRow {
  referenceId: string;
  targetId: string;
  source: string;
  producer: string;
  sourceAccount: string;
  method: "rule" | "manual";
}

/**
 * The card name is provider text: shown only when it is a plain name, as the
 * parser already keeps it (`vpassCardName`), and checked again here so a
 * stored value outside that shape never reaches a label.
 */
function plainCardName(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !/[0-9０-９]{4}/u.test(value)
    ? value
    : null;
}

/** One label when every candidate agrees, else none: a disagreement is never resolved by a pick. */
function single(labels: Set<string>): string | null {
  return labels.size === 1 ? [...labels][0]! : null;
}

/**
 * The entity label of each of these accounts, where one exists:
 *
 * 1. An aggregator connection label (`<institution>（MoneyForward連携）（個別口座未確定）`)
 *    when any current reference of the entity has one through
 *    `connectionAccountLabel`, and all that do agree. A connection is never a
 *    leaf account, so the suffix stays; an entity that also holds a reference
 *    of another source is a leaf account and never gets one.
 * 2. Otherwise, for a Vpass card, `<card name>（card-00N）` from the newest
 *    bound credit capture of any of its references, when they agree.
 *
 * An account with neither, or with references that disagree, has no entry and
 * keeps its mapping label. References on manual mappings take part (their
 * evidence is the same), but `displayAccountLabel` never relabels such a row.
 */
export async function entityAccountLabels(
  sql: SqlExecutor,
  accountIds: Iterable<string>,
): Promise<Map<string, EntityAccountLabel>> {
  const ids = [...new Set(accountIds)];
  const result = new Map<string, EntityAccountLabel>();
  if (!ids.length) return result;
  if (ids.length > ENTITY_LABEL_ACCOUNT_LIMIT) throw new Error("account_label_limit");
  const references = await sql.all<ReferenceRow>(REFERENCES_SQL, [JSON.stringify(ids)]);
  if (references.length > REFERENCE_LIMIT) throw new Error("account_label_reference_limit");
  const connections = await readAccountConnections(sql, references);
  // A connection label names an aggregator mirror. An account that also holds
  // a direct source's reference (an owner's manual mapping can put one there)
  // is a leaf account, which the `（個別口座未確定）` label would misname.
  const leaves = new Set(
    references
      .filter((reference) => reference.source !== "moneyforward-me")
      .map((reference) => reference.targetId),
  );
  const connectionLabels = new Map<string, Set<string>>();
  for (const reference of references) {
    if (leaves.has(reference.targetId)) continue;
    const connection = connections.get(reference.referenceId);
    // A manual mapping is evaluated as a rule one here: the label describes
    // the connection the reference belongs to, not the owner's choice.
    const label = connectionAccountLabel("", "rule", reference.source, connection);
    if (!label) continue;
    const labels = connectionLabels.get(reference.targetId) ?? new Set<string>();
    labels.add(label);
    connectionLabels.set(reference.targetId, labels);
  }
  for (const [account, labels] of connectionLabels) {
    const label = single(labels);
    if (label !== null) result.set(account, { label, origin: "connection" });
  }
  const vpass = references.filter(
    (reference) => reference.source === "vpass" && !connectionLabels.has(reference.targetId),
  );
  if (!vpass.length) return result;
  const targetOf = new Map(vpass.map((reference) => [reference.referenceId, reference.targetId]));
  const names = await sql.all<{
    referenceId: string;
    sourceAccount: string | null;
    otherAccount: string | null;
    cardName: unknown;
    otherName: unknown;
  }>(CARD_NAMES_SQL, [JSON.stringify([...targetOf.keys()])]);
  const cardLabels = new Map<string, Set<string>>();
  for (const row of names) {
    const target = targetOf.get(row.referenceId);
    const name = plainCardName(row.cardName);
    const card = /^vpass:(card-\d{3})$/u.exec(row.sourceAccount ?? "")?.[1];
    // One capture names one card; two names or two cards in it are not a name.
    if (
      target === undefined ||
      name === null ||
      card === undefined ||
      row.otherName !== name ||
      row.otherAccount !== row.sourceAccount
    )
      continue;
    const labels = cardLabels.get(target) ?? new Set<string>();
    labels.add(`${name}（${card}）`);
    cardLabels.set(target, labels);
  }
  for (const [account, labels] of cardLabels) {
    const label = single(labels);
    if (label !== null) result.set(account, { label, origin: "card-name" });
  }
  return result;
}

/** The label a row shows: the owner's manual label stays, else the entity's label, else the row's. */
export function displayAccountLabel(
  rowLabel: string,
  method: "rule" | "manual",
  entity: EntityAccountLabel | undefined,
): string {
  return method === "manual" || entity === undefined ? rowLabel : entity.label;
}
