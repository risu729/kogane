import { useQuery } from "@tanstack/react-query";
import { getJson } from "./api.ts";
import type { AccountConnection } from "../../shared/account-connection-contract.ts";
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
} from "../../shared/identity-contract.ts";
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
function path(collection: string, source: string, offset: number): string {
  const search = new URLSearchParams({ offset: String(offset) });
  if (source) search.set("source", source);
  return `/api/identity/${collection}?${search}`;
}
