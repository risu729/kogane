import { useQuery } from "@tanstack/react-query";
import { getJson } from "./api.ts";
import type { AccountConnection } from "../../../packages/observation-shared/src/account-connection-contract.ts";
export function useIdentityConnections() {
  return useQuery({
    queryKey: ["identity-connections"],
    queryFn: ({ signal }) =>
      getJson<{ connections: AccountConnection[] }>("/api/identity/connections", signal),
  });
}
import type {
  IdentityAccountRow,
  IdentityCoverage,
  IdentityInstrumentRow,
  IdentityPage,
} from "../../../packages/observation-shared/src/identity-contract.ts";
import type { InstrumentCoverage } from "../../../packages/application/src/query/instrument-coverage.ts";
import { INSTRUMENT_COVERAGE_PATH } from "../../../packages/observation-shared/src/instrument-coverage-contract.ts";
export function useIdentityAccounts(source: string, offset: number) {
  return useQuery({
    queryKey: ["identity-accounts", source, offset],
    queryFn: ({ signal }) =>
      getJson<IdentityPage<IdentityAccountRow>>(path("accounts", source, offset), signal),
  });
}
export function useIdentityInstruments(source: string, offset: number) {
  return useQuery({
    queryKey: ["identity-instruments", source, offset],
    queryFn: ({ signal }) =>
      getJson<IdentityPage<IdentityInstrumentRow>>(path("instruments", source, offset), signal),
  });
}
export function useIdentityCoverage(source: string, offset = 0) {
  return useQuery({
    queryKey: ["identity-coverage", source, offset],
    queryFn: ({ signal }) => getJson<IdentityCoverage>(path("coverage", source, offset), signal),
  });
}
/**
 * Per-source counts of instrument identifiers by their candidate state
 * (ADR 0073). Its own request, so a refusal or a slow candidate read never
 * holds back the account coverage above it; a refusal is not retried.
 */
export function useInstrumentCoverage(source: string) {
  return useQuery({
    queryKey: ["identity-instrument-coverage", source],
    queryFn: ({ signal }) =>
      getJson<InstrumentCoverage>(
        source
          ? `${INSTRUMENT_COVERAGE_PATH}?${new URLSearchParams({ source })}`
          : INSTRUMENT_COVERAGE_PATH,
        signal,
      ),
    retry: false,
  });
}
function path(collection: string, source: string, offset: number): string {
  const search = new URLSearchParams({ offset: String(offset) });
  if (source) search.set("source", source);
  return `/api/identity/${collection}?${search}`;
}
