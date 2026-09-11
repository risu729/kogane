// Canonical bytes and digest of a terminal manifest.
//
// The encoding is `canonicalJsonV1` from `packages/evidence-contract`: sorted
// keys at every depth, array order preserved, safe integers only. Reusing it
// means the terminal digest and the persisted descriptor digests are produced
// by one frozen encoder rather than two that drift.
//
// `terminalDigest` is taken over the *validated* manifest. The writer stores
// exactly `encodeTerminal(manifest)`, so for a terminal this package wrote the
// digest of the stored bytes and the digest of the manifest are one value; the
// reader checks that equality and blocks a terminal where it does not hold.
import { sha256Hex } from "../../evidence-contract/src/digest";
import {
  canonicalJsonV1,
  encodeCanonicalV1,
  type JsonValue,
} from "../../evidence-contract/src/json";
import { parseTerminalManifest, type TerminalManifest } from "./manifest";

export const TERMINAL_DIGEST_ALGORITHM = "sha256-canonical-json-v1";

export function canonicalTerminalJson(manifest: TerminalManifest): string {
  return canonicalJsonV1(parseTerminalManifest(manifest) as unknown as JsonValue);
}

/** UTF-8 bytes written to `runs/<source>/<runId>/terminal.json`. */
export function encodeTerminal(manifest: TerminalManifest): Uint8Array {
  return encodeCanonicalV1(parseTerminalManifest(manifest) as unknown as JsonValue);
}

/** Lower-case hex SHA-256 over {@link encodeTerminal}. */
export function terminalDigest(manifest: TerminalManifest): Promise<string> {
  return sha256Hex(encodeTerminal(manifest));
}

export { sha256Hex };
