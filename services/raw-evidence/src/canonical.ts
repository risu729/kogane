// Canonical JSON and digest helpers now live in the shared evidence-contract
// package so the ingest client and this server encode identical bytes. These
// re-exports keep the historical module path for the server and its tests.
export {
  binaryCompare,
  canonicalJsonV1 as canonicalJson,
  type JsonValue,
} from "../../../packages/evidence-contract/src/json";
export { sha256Hex } from "../../../packages/evidence-contract/src/digest";

export function hexBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError("invalid sha256");
  }
  return Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}
