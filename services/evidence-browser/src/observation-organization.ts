import type { ObservationKind } from "../../../packages/observation-shared/src/api-contract";
import { resolveFinancialProduct } from "../../../packages/observation-shared/src/financial-products";
import {
  DEFAULT_IDENTITY_READ_MODE,
  type IdentityReadMode,
  type InterpretationContext,
  identityReleaseFor,
  interpretationContext,
  organizationSql,
} from "../../../packages/read-model/src/index";
import { readAccountConnections } from "./account-connections";
import { connectionAccountLabel } from "./account-connection-display";
import {
  preferredInstrumentNames,
  type PreferredInstrumentName,
} from "./preferred-instrument-names";
import type {
  ObservationOrganization,
  OrganizedAccount,
  OrganizedInstrument,
} from "../../../packages/observation-shared/src/organization-contract";

type Ref = { kind: ObservationKind; id: number };
interface OrganizationRow {
  parse_run_id: number;
  parser_name: string;
  artifact_id: number;
  dataset: string | null;
  raw_locator: string;
  product_currency: string | null;
  product_subject: string | null;
  product_extra: string;
  product_metadata_oversized: number;
  product_as_of: string | null;
  product_observed_at: string | null;
  source: string;
  producer: string;
  source_account: string;
  kind: ObservationKind;
  observation_id: number;
  historical: number;
  identity_release: string;
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

/** The `latest` read as SQL text, for the query-plan test and read-only audits. */
export const ORGANIZATION_QUERY = organizationSql("latest");

export const organizationKey = ({ kind, id }: Ref): string => `${kind}:${id}`;
const unavailable = (): ObservationOrganization => ({
  state: "unavailable",
  lineage: null,
  account: null,
  instruments: [],
});

/**
 * Organizes already-authorized observation references. `latest` decorates
 * with current mapping revisions; `as-recorded` with the revisions the sealed
 * identity run pinned. Display-only overlays (preferred instrument names,
 * connection labels) are current in both modes and carry their own evidence;
 * they never change which account or instrument a row is attributed to.
 */
export async function observationOrganizations(
  db: D1Database,
  references: readonly Ref[],
  mode: IdentityReadMode = DEFAULT_IDENTITY_READ_MODE,
): Promise<Map<string, ObservationOrganization>> {
  const unique = new Map(references.map((r) => [organizationKey(r), r]));
  // A position page can contain 501 position IDs plus up to 5,000 valuation
  // pairs already bounded by the read-model reader. Do not shrink that API budget.
  if (unique.size > 5501) throw new Error("organization_reference_limit");
  const output = new Map([...unique.keys()].map((key) => [key, unavailable()]));
  const refs = [...unique.values()];
  const accountRefs = new Map<
    string,
    { referenceId: string; source: string; producer: string; sourceAccount: string }
  >();
  const sql = organizationSql(mode);
  for (let start = 0; start < refs.length; start += 500) {
    const rows = await db
      .prepare(sql)
      .bind(JSON.stringify(refs.slice(start, start + 500)))
      .all<OrganizationRow>();
    for (const row of rows.results) {
      accountRefs.set(row.account_reference, {
        referenceId: row.account_reference,
        source: row.source,
        producer: row.producer,
        sourceAccount: row.source_account,
      });
      const key = organizationKey({ kind: row.kind, id: row.observation_id });
      let organization = output.get(key);
      if (!organization) throw new Error("organization_unrequested_result");
      if (organization.state === "unavailable") {
        organization = {
          state: "organized",
          lineage: row.historical ? "historical" : "current",
          product: resolveFinancialProduct({
            kind: row.kind,
            id: row.observation_id,
            parseRunId: row.parse_run_id,
            parserName: row.parser_name,
            artifactId: row.artifact_id,
            rawLocator: row.raw_locator,
            sourceId: row.source,
            dataset: row.dataset ?? "",
            sourceAccount: row.source_account,
            currency: row.product_currency,
            subject: row.product_subject,
            asOf: row.product_as_of,
            observedAt: row.product_observed_at,
            extra: JSON.parse(row.product_extra),
          }),
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
          mappingRevision: row.account_revision,
          identityRelease: row.identity_release,
        };
        if (row.product_metadata_oversized && organization.product) {
          organization.product = {
            ...organization.product,
            status: "unresolved",
            reason:
              "商品判定用の追加情報が読み取り上限を超えたため未特定です。保存原本は変更していません。",
          };
        }
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
  const connections = accountRefs.size
    ? await readAccountConnections(db, [...accountRefs.values()])
    : new Map();
  for (const organization of output.values()) {
    if (organization.account) {
      const account = organization.account;
      const connection = connections.get(account.referenceId);
      if (connection) {
        account.connection = connection;
        account.label = connectionAccountLabel(
          account.label,
          account.method,
          accountRefs.get(account.referenceId)!.source,
          connection,
        );
      }
    }
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
  mode: IdentityReadMode = DEFAULT_IDENTITY_READ_MODE,
): Promise<(T & { organization: ObservationOrganization })[]> {
  const organizations = await observationOrganizations(
    db,
    rows.map(({ id }) => ({ kind, id })),
    mode,
  );
  return rows.map((row) => ({
    ...row,
    organization: organizations.get(organizationKey({ kind, id: row.id }))!,
  }));
}

/** The context a response carries: the mode and the releases its organized rows were read under. */
export function organizationContext(
  mode: IdentityReadMode,
  organizations: Iterable<ObservationOrganization | undefined>,
): InterpretationContext {
  return interpretationContext(
    mode,
    identityReleaseFor(
      mode,
      [...organizations].map((organization) => organization?.identityRelease),
    ),
  );
}
