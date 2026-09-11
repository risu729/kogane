// Canonical JSON and digest helpers now live in the shared evidence-contract
// package so the ingest client and this server encode identical bytes. These
// re-exports keep the historical module path for the server and its tests.
export {
  binaryCompare,
  canonicalJsonV1 as canonicalJson,
  type JsonValue,
} from "../../../packages/evidence-contract/src/json";
export { sha256Hex } from "../../../packages/evidence-contract/src/digest";
// The hex decoder the object upload hands to the store moved with the upload
// itself (U05); one definition, so the checksum the store verifies and the
// digest the catalogue records cannot come from two different decoders.
export { hexBytes } from "../../../packages/application/src/ingest/index.ts";
