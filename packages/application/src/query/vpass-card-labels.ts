// The Vpass card label (#1357): `<cardName>（card-NNN）`, resolved at read
// time from the newest bound credit observation of the card, the way
// `connectionAccountLabel` names a MoneyForward connection. The organization
// read (balances, observations), the identity accounts page and the filter
// options apply it in one place each, so the screens and their MCP reads
// (ADR 0081) show the same label.
//
// Display only. The name never selects an account or changes a mapping: the
// identity rules and their stored labels (`Vpassカード明細`) are unchanged,
// a manual label wins, and a card with no named credit observation keeps its
// stored label.
import { vpassCardLabel } from "../../../domain/src/vpass-card-name.ts";
import type { IdentityOrigin } from "../../../observation-shared/src/identity-contract.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

/**
 * The newest credit observation of each requested bound Vpass card reference
 * (`["vpass:card", <durable token>]`, ADR 0023; a run-scoped ordinal reference
 * is not a card a name may label) whose current sealed identity organizes it
 * under that reference.
 * `?1` is a JSON array of reference ids. "Newest" is the newest credit fetch
 * run, then Authori before Revo (Revo names the card only when Authori has no
 * visible row, so no observation), then the lowest observation id. The rows
 * read are the requested references' own balance identity observations
 * (index `identity_observation_account`), never a catalogue scan.
 */
export const VPASS_CARD_LABELS_SQL = `WITH requested AS MATERIALIZED (
  SELECT DISTINCT s.id reference_id FROM json_each(?1) j
  CROSS JOIN source_accounts s ON s.id=j.value
  WHERE s.source_id='vpass' AND json_extract(s.reference_json,'$[0]')='vpass:card'
), credit AS MATERIALIZED (
  SELECT q.reference_id,o.observation_id,r.parse_run_id,f.started_at,f.id fetch_run_id
  FROM requested q
  CROSS JOIN identity_observations o ON o.source_account_id=q.reference_id AND o.kind='balance'
  CROSS JOIN eligible_identity_runs r ON r.id=o.identity_run_id
  CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
  CROSS JOIN published_parse_runs pub ON pub.parse_run_id=r.parse_run_id
  CROSS JOIN parse_runs p ON p.id=pub.parse_run_id
  CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
  CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
  WHERE p.parser_name='vpass-credit-snapshot' AND p.status='ok'
   AND f.status='success' AND f.failure_count=0
   AND NOT EXISTS(SELECT 1 FROM eligible_identity_runs n
    CROSS JOIN identity_run_seals ns ON ns.identity_run_id=n.id
    WHERE n.parse_run_id=r.parse_run_id AND n.policy_version>r.policy_version)
), ranked AS (
  SELECT c.reference_id,b.id observation_id,b.source_account,
   CASE WHEN json_type(b.extra_json,'$._kogane.cardName')='text'
    THEN json_extract(b.extra_json,'$._kogane.cardName') END card_name,
   row_number() OVER(PARTITION BY c.reference_id ORDER BY c.started_at DESC,c.fetch_run_id DESC,
    CASE WHEN instr(b.raw_locator,'.AuthoriShokaiDisplayServiceBean.')>0 THEN 0 ELSE 1 END,b.id) choice
  FROM credit c CROSS JOIN balance_observations b ON b.id=c.observation_id AND b.parse_run_id=c.parse_run_id
) SELECT reference_id referenceId,observation_id observationId,source_account sourceAccount,
  card_name cardName FROM ranked WHERE choice=1`;

/** A card's resolved label and the observation that named it. */
export interface VpassCardLabel {
  label: string;
  origin: IdentityOrigin & { kind: "balance" };
}

/** One set-oriented query per bounded page; references of other sources are ignored. */
export async function vpassCardLabels(
  sql: SqlExecutor,
  refs: readonly { referenceId: string; source: string }[],
): Promise<Map<string, VpassCardLabel>> {
  const ids = [
    ...new Set(refs.filter((ref) => ref.source === "vpass").map((ref) => ref.referenceId)),
  ];
  if (ids.length > 5501) throw new Error("vpass_card_label_reference_limit");
  const result = new Map<string, VpassCardLabel>();
  for (let start = 0; start < ids.length; start += 500) {
    const rows = await sql.all<{
      referenceId: string;
      observationId: number;
      sourceAccount: string;
      cardName: string | null;
    }>(VPASS_CARD_LABELS_SQL, [JSON.stringify(ids.slice(start, start + 500))]);
    for (const row of rows) {
      // The parser's own rule again: a name it would not keep is never shown.
      const label = vpassCardLabel(row.cardName, row.sourceAccount);
      if (label !== undefined)
        result.set(row.referenceId, { label, origin: { kind: "balance", id: row.observationId } });
    }
  }
  return result;
}

/** A card's name labels a rule-mapped Vpass reference; a manual label wins. */
export function vpassCardAccountLabel(
  currentLabel: string,
  method: "rule" | "manual",
  source: string,
  card: VpassCardLabel | undefined,
): string {
  return source === "vpass" && method !== "manual" && card ? card.label : currentLabel;
}
