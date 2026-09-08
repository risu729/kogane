export interface PreferredInstrumentName {
  label: string;
  reason: "manual" | "provider-current" | "observed-japanese-script";
  origin: { kind: "transaction" | "position" | "valuation"; id: number } | null;
}

/** Names are display claims, never evidence that two identifiers are equivalent.
 * The current sealed C use supplies the exact identifier; B supplies its name.
 * SBI is a Japanese-language source, so Han-only names are eligible there too.
 * Names from unknown language contexts are not classified as Japanese.
 */
export const PREFERRED_INSTRUMENT_NAMES_SQL = `WITH requested AS MATERIALIZED (
  SELECT m.identifier_id,m.label,m.method FROM json_each(?1) requested
  JOIN current_instrument_mappings m ON m.identifier_id=requested.value
), eligible AS MATERIALIZED (
  SELECT o.id,o.kind,o.observation_id,o.parse_run_id,u.identifier_id
  FROM current_identity_observations o
  JOIN source_accounts s ON s.id=o.source_account_id AND s.source_id='sbi-securities'
  JOIN identity_instrument_uses u ON u.identity_observation_id=o.id AND u.role='security'
  JOIN requested r ON r.identifier_id=u.identifier_id AND r.method<>'manual'
), named AS (
  SELECT e.identifier_id,e.kind,e.observation_id,
    coalesce(nullif(trim(b.security_name),''),
      CASE WHEN json_type(b.extra_json,'$.securities.securitiesName')='text'
        THEN nullif(trim(json_extract(b.extra_json,'$.securities.securitiesName')),'') END,
      CASE WHEN json_type(b.extra_json,'$.issueName')='text'
        THEN nullif(trim(json_extract(b.extra_json,'$.issueName')),'') END) label
  FROM eligible e JOIN position_observations b
    ON e.kind='position' AND b.id=e.observation_id AND b.parse_run_id=e.parse_run_id
  UNION ALL
  SELECT e.identifier_id,e.kind,e.observation_id,
    coalesce(CASE WHEN json_type(b.extra_json,'$.securities.securitiesName')='text'
        THEN nullif(trim(json_extract(b.extra_json,'$.securities.securitiesName')),'') END,
      CASE WHEN json_type(b.extra_json,'$.issueName')='text'
        THEN nullif(trim(json_extract(b.extra_json,'$.issueName')),'') END) label
  FROM eligible e JOIN transaction_observations b
    ON e.kind='transaction' AND b.id=e.observation_id AND b.parse_run_id=e.parse_run_id
  UNION ALL
  SELECT e.identifier_id,e.kind,e.observation_id,
    coalesce(CASE WHEN json_type(b.extra_json,'$.securities.securitiesName')='text'
        THEN nullif(trim(json_extract(b.extra_json,'$.securities.securitiesName')),'') END,
      CASE WHEN json_type(b.extra_json,'$.issueName')='text'
        THEN nullif(trim(json_extract(b.extra_json,'$.issueName')),'') END) label
  FROM eligible e JOIN valuation_observations b
    ON e.kind='valuation' AND b.id=e.observation_id AND b.parse_run_id=e.parse_run_id
), ranked AS (
  SELECT *,row_number() OVER (PARTITION BY identifier_id ORDER BY
    CASE WHEN label GLOB '*[ぁ-ゖァ-ヺｦ-ﾟ]*' THEN 0 ELSE 1 END,
    label COLLATE BINARY,kind,observation_id) priority
  FROM named WHERE length(label) BETWEEN 1 AND 512
    AND (label GLOB '*[ぁ-ゖァ-ヺｦ-ﾟ]*' OR label GLOB '*[一-龯]*')
) SELECT r.identifier_id referenceId,coalesce(n.label,r.label) label,
  CASE WHEN r.method='manual' THEN 'manual' WHEN n.label IS NOT NULL
    THEN 'observed-japanese-script' ELSE 'provider-current' END reason,
  n.kind,n.observation_id observationId
  FROM requested r LEFT JOIN ranked n ON n.identifier_id=r.identifier_id AND n.priority=1`;

/** One set-oriented query per bounded response page; no process-global cache. */
export async function preferredInstrumentNames(
  db: D1Database,
  referenceIds: readonly string[],
): Promise<Map<string, PreferredInstrumentName>> {
  const ids = [...new Set(referenceIds)];
  if (ids.length > 500) throw new Error("preferred_instrument_name_budget_invalid");
  if (!ids.length) return new Map();
  const result = await db.prepare(PREFERRED_INSTRUMENT_NAMES_SQL).bind(JSON.stringify(ids)).all<{
    referenceId: string;
    label: string;
    reason: PreferredInstrumentName["reason"];
    kind: "transaction" | "position" | "valuation" | null;
    observationId: number | null;
  }>();
  return new Map(
    result.results.map((row) => [
      row.referenceId,
      {
        label: row.label,
        reason: row.reason,
        origin:
          row.kind !== null && row.observationId !== null
            ? { kind: row.kind, id: row.observationId }
            : null,
      },
    ]),
  );
}
