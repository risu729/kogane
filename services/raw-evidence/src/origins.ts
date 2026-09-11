// Origin authorization split in U05: the decision is
// `packages/application/src/ingest/origins.ts`, the scope-rule and
// template-policy rows are `packages/storage-d1/src/core/origins.ts`.
// Historical import path only.
export {
  httpScopeAllowed,
  parseOrigins,
  validateOriginScope,
  type Origins,
} from "../../../packages/application/src/ingest/origins.ts";
export { originStatements } from "../../../packages/storage-d1/src/core/origins.ts";
