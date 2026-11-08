// Frozen copy of `cardSettlementsApi` as shipped before the route became an
// adapter over `readCardSettlementsForGrant` and `readCardOwnershipForGrant`
// (ADR 0081 point 2). Not served: `card-settlements-api-differential.test.ts`
// runs it beside the shipped handler and asserts they answer alike except
// where docs/card-settlements.md records the change. Do not edit it to follow
// the shipped handler.
import { storeHasFeature } from "../../../packages/application/src/query/store-schema.ts";
import { queryCardOwnership } from "../../../packages/application/src/query/card-ownership.ts";
import {
  queryCardSettlementStatements,
  queryCardSettlements,
  queryRelatedCardSettlements,
} from "../../../packages/application/src/query/card-settlements.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { principalFor } from "../src/grants";
import { HttpError, json } from "../src/http";

const CARD_SETTLEMENT_PATH = "/api/v2/reconciliation/card-settlements";
const CARD_OWNERSHIP_PATH = `${CARD_SETTLEMENT_PATH}/ownership`;
const CARD_SETTLEMENT_STATEMENTS_PATH = `${CARD_SETTLEMENT_PATH}/statements`;

async function cardSettlementsAvailable(env: Env): Promise<boolean> {
  return storeHasFeature(d1Executor(env.DB), "cardSettlements");
}

export async function frozenCardSettlementsApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  const ownership = url.pathname === CARD_OWNERSHIP_PATH;
  const grouped = url.pathname === CARD_SETTLEMENT_STATEMENTS_PATH;
  if (url.pathname !== CARD_SETTLEMENT_PATH && !ownership && !grouped) return null;
  if (request.method !== "GET" && request.method !== "HEAD")
    throw new HttpError(405, "method_not_allowed");
  if (!(await cardSettlementsAvailable(env))) throw new HttpError(404, "not_found");
  const principal = principalFor(env, subject);
  if (principal.kind !== "human" || !principal.capabilities.includes("interpretation.accept"))
    throw new HttpError(403, "operator_required");
  for (const [key, value] of url.searchParams) {
    if (
      !["offset", "proposalId", "statementKey", "relatedTo"].includes(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      !value
    )
      throw new HttpError(400, "invalid_query");
  }
  const text = url.searchParams.get("offset") ?? "0";
  const offset = Number(text);
  if (!/^(0|[1-9]\d*)$/u.test(text) || !Number.isSafeInteger(offset) || offset > 1_000_000)
    throw new HttpError(400, "invalid_offset");
  const proposalId = url.searchParams.get("proposalId");
  if (
    proposalId !== null &&
    (!/^[A-Za-z0-9_-]{1,128}$/u.test(proposalId) || url.searchParams.has("offset"))
  )
    throw new HttpError(400, "invalid_query");
  const statementKey = url.searchParams.get("statementKey");
  if (
    statementKey !== null &&
    (statementKey.length > 1024 || proposalId !== null || ownership || grouped)
  )
    throw new HttpError(400, "invalid_query");
  // The candidates `relatedTo` competes with: the list's own DTO and paging,
  // so it combines with `offset` only.
  const relatedTo = url.searchParams.get("relatedTo");
  if (
    relatedTo !== null &&
    (!/^[A-Za-z0-9_-]{1,128}$/u.test(relatedTo) ||
      proposalId !== null ||
      statementKey !== null ||
      ownership ||
      grouped)
  )
    throw new HttpError(400, "invalid_query");
  if (grouped) {
    if (proposalId !== null) throw new HttpError(400, "invalid_query");
    return json({
      apiVersion: 2,
      ...(await queryCardSettlementStatements(d1Executor(env.DB), { offset })),
    });
  }
  if (ownership) {
    if (proposalId === null || url.searchParams.has("offset"))
      throw new HttpError(400, "invalid_query");
    const review = await queryCardOwnership(d1Executor(env.DB), proposalId);
    if (!review) throw new HttpError(404, "not_found");
    return json({ apiVersion: 2, ...review });
  }
  if (relatedTo !== null) {
    const related = await queryRelatedCardSettlements(d1Executor(env.DB), relatedTo, { offset });
    if (!related) throw new HttpError(404, "not_found");
    return json({ apiVersion: 2, ...related });
  }
  const page = await queryCardSettlements(d1Executor(env.DB), {
    offset,
    ...(proposalId === null ? {} : { proposalId }),
    ...(statementKey === null ? {} : { statementKey }),
  });
  if (proposalId !== null && page.items.length === 0) throw new HttpError(404, "not_found");
  return json({ apiVersion: 2, ...page });
}
