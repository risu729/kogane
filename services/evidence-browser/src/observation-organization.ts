import type { ObservationKind } from "../../../poc/observation-pipeline/shared/api-contract";
import {
  preferredInstrumentNames,
  type PreferredInstrumentName,
} from "./preferred-instrument-names";
import type {
  ObservationOrganization,
  OrganizedAccount,
  OrganizedInstrument,
} from "../../../poc/observation-pipeline/shared/organization-contract";

type Ref = { kind: ObservationKind; id: number };
interface OrganizationRow {
  kind: ObservationKind;
  observation_id: number;
  historical: number;
  account_reference: string;
  account_target: string;
  account_label: string;
  account_status: OrganizedAccount["status"];
  account_revision: number;
  account_method: OrganizedAccount["method"];
  account_reason: string;
  role: OrganizedInstrument["role"] | null;
  instrument_reference: string | null;
  instrument_target: string;
  instrument_label: string;
  instrument_status: OrganizedInstrument["status"];
  instrument_revision: number;
  instrument_method: OrganizedInstrument["method"];
  instrument_reason: string;
  namespace: string;
  scope: string;
  value: string;
}

// Start with the already-authorized bounded page. Keyed observation lookup avoids
// rescanning the current catalogue per row. Historical B rows can display their
// latest eligible sealed interpretation, explicitly marked historical.
export const ORGANIZATION_QUERY = `WITH wanted AS MATERIALIZED (
 SELECT json_extract(value,'$.kind') kind,json_extract(value,'$.id') id FROM json_each(?1)
), ranked AS MATERIALIZED (
 SELECT o.*,p.superseded_by_parse_run_id IS NOT NULL historical,
 row_number() OVER(PARTITION BY o.kind,o.observation_id ORDER BY r.policy_version DESC) choice
 FROM wanted w
 CROSS JOIN identity_observations o ON o.kind=w.kind AND o.observation_id=w.id
 CROSS JOIN eligible_identity_runs r ON r.id=o.identity_run_id
 CROSS JOIN identity_run_seals seal ON seal.identity_run_id=r.id
 CROSS JOIN parse_runs p ON p.id=r.parse_run_id
 CROSS JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 CROSS JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE p.status='ok' AND f.status='success' AND f.failure_count=0
)
SELECT o.kind,o.observation_id,o.historical,
 am.source_account_id account_reference,am.account_id account_target,
 am.label account_label,am.status account_status,am.revision account_revision,
 am.method account_method,am.reason account_reason,
 u.role,d.id instrument_reference,im.instrument_id instrument_target,
 im.label instrument_label,im.status instrument_status,im.revision instrument_revision,
 im.method instrument_method,im.reason instrument_reason,d.namespace,d.scope,d.value
FROM ranked o JOIN current_account_mappings am ON am.source_account_id=o.source_account_id
LEFT JOIN identity_instrument_uses u ON u.identity_observation_id=o.id
LEFT JOIN instrument_identifiers d ON d.id=u.identifier_id
LEFT JOIN current_instrument_mappings im ON im.identifier_id=d.id
WHERE o.choice=1 ORDER BY o.kind,o.observation_id,u.role`;

export const organizationKey = ({ kind, id }: Ref): string => `${kind}:${id}`;
const unavailable = (): ObservationOrganization => ({
  state: "unavailable",
  lineage: null,
  account: null,
  instruments: [],
});

export async function observationOrganizations(
  db: D1Database,
  references: readonly Ref[],
): Promise<Map<string, ObservationOrganization>> {
  const unique = new Map(references.map((r) => [organizationKey(r), r]));
  // A position page can contain 501 position IDs plus up to 5,000 valuation
  // pairs already bounded by observationStore. Do not shrink that API budget.
  if (unique.size > 5501) throw new Error("organization_reference_limit");
  const output = new Map([...unique.keys()].map((key) => [key, unavailable()]));
  const refs = [...unique.values()];
  for (let start = 0; start < refs.length; start += 500) {
    const rows = await db
      .prepare(ORGANIZATION_QUERY)
      .bind(JSON.stringify(refs.slice(start, start + 500)))
      .all<OrganizationRow>();
    for (const row of rows.results) {
      const key = organizationKey({ kind: row.kind, id: row.observation_id });
      let organization = output.get(key);
      if (!organization) throw new Error("organization_unrequested_result");
      if (organization.state === "unavailable") {
        organization = {
          state: "organized",
          lineage: row.historical ? "historical" : "current",
          account: {
            referenceId: row.account_reference,
            targetId: row.account_target,
            label: row.account_label,
            status: row.account_status,
            revision: row.account_revision,
            method: row.account_method,
            reason: row.account_reason,
          },
          instruments: [],
        };
        output.set(key, organization);
      }
      if (row.role && row.instrument_reference)
        organization.instruments.push({
          referenceId: row.instrument_reference,
          targetId: row.instrument_target,
          label: row.instrument_label,
          status: row.instrument_status,
          revision: row.instrument_revision,
          method: row.instrument_method,
          reason: row.instrument_reason,
          role: row.role,
          namespace: row.namespace,
          scope: row.scope,
          value: row.value,
        });
    }
  }
  // Many observations reuse the same instrument. Select each identifier once
  // for the whole response, then distribute its name without modifying B rows.
  const identifiers = [
    ...new Set(
      [...output.values()].flatMap((organization) =>
        organization.instruments.map((instrument) => instrument.referenceId),
      ),
    ),
  ];
  const names = new Map<string, PreferredInstrumentName>();
  for (let start = 0; start < identifiers.length; start += 500) {
    for (const [id, name] of await preferredInstrumentNames(
      db,
      identifiers.slice(start, start + 500),
    )) {
      names.set(id, name);
    }
  }
  for (const organization of output.values()) {
    for (const instrument of organization.instruments) {
      const name = names.get(instrument.referenceId);
      if (name) {
        instrument.label = name.label;
        instrument.nameEvidence = { reason: name.reason, origin: name.origin };
      }
    }
  }
  return output;
}

export async function organizeRows<T extends { id: number }>(
  db: D1Database,
  kind: ObservationKind,
  rows: readonly T[],
): Promise<(T & { organization: ObservationOrganization })[]> {
  const organizations = await observationOrganizations(
    db,
    rows.map(({ id }) => ({ kind, id })),
  );
  return rows.map((row) => ({
    ...row,
    organization: organizations.get(organizationKey({ kind, id: row.id }))!,
  }));
}
