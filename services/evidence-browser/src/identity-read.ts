import { HttpError } from "./http";
import {
  CENTRAL_STORE_CAPABILITIES,
  type IdentityReadMode,
  validIdentityReadMode,
} from "../../../poc/observation-pipeline/shared/api-schema";
import { DEFAULT_IDENTITY_READ_MODE } from "../../../packages/read-model/src/index";

/**
 * The identity read mode of a request. `snapshot` is a known mode of the
 * domain contract that this API does not serve yet, so it is refused as
 * unsupported semantics rather than as an unknown word. Kept apart from the
 * observation routes so the identity catalogue (and the pipeline's query-plan
 * tests, which import it) depend on nothing but the schema.
 */
export function identityReadMode(url: URL): IdentityReadMode {
  const value = url.searchParams.get("identityRead");
  if (value === null) return DEFAULT_IDENTITY_READ_MODE;
  if (value === "snapshot") throw new HttpError(400, "unsupported_semantics");
  if (!validIdentityReadMode(value, CENTRAL_STORE_CAPABILITIES))
    throw new HttpError(400, "invalid_query");
  return value;
}
