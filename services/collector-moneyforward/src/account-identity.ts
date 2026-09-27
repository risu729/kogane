// The MoneyForward account identity, derived in the Worker (ADR 0027, ADR 0029).
//
// An account's position in the accounts index (`account-NN`) is not identity:
// adding or removing a linked service moves every later account. The parser
// (`moneyforward-monthly-transactions`, `moneyforward-canonical-evidence-boundary`)
// therefore requires a unit key `moneyforward-account-v1-<64 hex>` or
// `moneyforward-account-v2-<64 hex>`. This module derives
//
//   moneyforward-account-v2- + SHA-256(JSON(["moneyforward-account-v2", account[id_hash], service[id]]))
//
// from the two hidden inputs of each account-detail page: an unkeyed,
// domain-separated digest (ADR 0029). The retired importer
// (`services/collector-r2-importer/src/moneyforward-account-identity.ts`,
// removed in #206) derived `moneyforward-account-v1-` identities from the same
// tuple as an HMAC under a key that was retired with it. v1 identities stay
// readable as historical evidence, but nothing derives them any more, and the
// v1 and the v2 identity of one account are different values.
//
// The checks are the importer's, over the same page bytes the run stores:
// parse5 finds every `<input>` named
// `account[id_hash]` or `service[id]` (template contents included); each must
// occur exactly once with a value of 1-4096 characters from `[A-Za-z0-9_-]`;
// the account's ordinal comes from its `account-detail-NN.html` filename
// (1-64); no two details may share an ordinal or an identity; and, when the
// run holds the accounts index, the `NN`th of its sorted distinct
// `/accounts/show/<id>` links must be the detail's `account[id_hash]`.
//
// The identifiers never leave this module: the only output is the identity of
// each ordinal, or one closed code saying why there is none. It fails closed,
// for the whole run: any failed check returns `unavailable` and the run keeps
// its positional units, which the parser rejects. No secret is involved: ADR
// 0029 classifies `account[id_hash]` and `service[id]` as provider-local
// identifiers that central storage may hold, so the digest only fixes the
// identity's shape and separates it from every other derivation.
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { RawArtifact } from "./types";

/** The domain string hashed with the tuple, and the identity's prefix (ADR 0029). */
export const MONEYFORWARD_IDENTITY_CONTRACT = "moneyforward-account-v2";
const OPAQUE = /^[A-Za-z0-9_-]{1,4096}$/u;
const DETAIL = /^account-detail-(\d{2})\.html$/u;
const SHOW_PATH = /^\/accounts\/show\/([A-Za-z0-9_-]+)(?:[?#].*)?$/u;
const INPUTS = ["account[id_hash]", "service[id]"] as const;

/** Why a run carries no account identity. Closed codes; safe to log. */
export type MoneyForwardIdentityUnavailable =
  | "identity_tuple_absent"
  | "identity_tuple_invalid"
  | "identity_duplicate"
  | "identity_index_mismatch"
  | "identity_incomplete";

export type MoneyForwardAccountIdentities =
  | {
      readonly status: "derived";
      /** Identity by the two-digit ordinal of the collector's filenames (`"01"`). */
      readonly byOrdinal: ReadonlyMap<string, string>;
    }
  | { readonly status: "unavailable"; readonly code: MoneyForwardIdentityUnavailable };

type Node = DefaultTreeAdapterMap["node"];

class Unavailable extends Error {
  readonly code: MoneyForwardIdentityUnavailable;
  constructor(code: MoneyForwardIdentityUnavailable) {
    super(code);
    this.code = code;
  }
}

/** The page as the run stores it: the UTF-8 bytes of the body, decoded strictly. */
function document(body: string): Node {
  return parse(
    new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(body)),
  ) as Node;
}

function attribute(node: Node, name: string): string | undefined {
  return "attrs" in node ? node.attrs.find((attr) => attr.name === name)?.value : undefined;
}

/** The sorted distinct account ids the index links to, as the importer read them. */
function indexPaths(body: string): string[] {
  const paths = new Set<string>();
  const visit = (node: Node): void => {
    if ("tagName" in node && node.tagName === "a") {
      const match = SHOW_PATH.exec(attribute(node, "href") ?? "");
      if (match) paths.add(match[1]!);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(document(body));
  return [...paths].sort();
}

/** `[account[id_hash], service[id]]` of one account-detail page. */
function tuple(body: string): [string, string] {
  const fields = new Map<string, string[]>();
  const visit = (node: Node): void => {
    if ("tagName" in node && node.tagName === "input") {
      const name = attribute(node, "name");
      if (name === INPUTS[0] || name === INPUTS[1]) {
        fields.set(name, [...(fields.get(name) ?? []), attribute(node, "value") ?? ""]);
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
    if ("content" in node) visit(node.content as Node);
  };
  visit(document(body));
  const values = INPUTS.map((name) => {
    const entries = fields.get(name);
    if (entries === undefined) throw new Unavailable("identity_tuple_absent");
    if (entries.length !== 1 || !OPAQUE.test(entries[0]!)) {
      throw new Unavailable("identity_tuple_invalid");
    }
    return entries[0]!;
  });
  return [values[0]!, values[1]!];
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The identity of every account the run's pages name. `accountUnits` are the
 * two-digit ordinals the run's filenames name (details and monthly
 * fragments); every one of them must receive an identity. A successful run
 * passes its `accountDetailCount`, which the identities must number, as the
 * importer required.
 */
export async function moneyForwardAccountIdentities(
  artifacts: readonly RawArtifact[],
  accountUnits: ReadonlySet<string>,
  successfulAccountCount?: number,
): Promise<MoneyForwardAccountIdentities> {
  try {
    const index = artifacts.find(
      (artifact) => artifact.dataset === "accounts-index" && artifact.filename === "accounts.html",
    );
    const sortedPaths = index === undefined ? undefined : indexPaths(index.body);
    const byOrdinal = new Map<string, string>();
    const identities = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.dataset !== "account-detail") continue;
      const ordinalText = DETAIL.exec(artifact.filename)?.[1];
      const ordinal = ordinalText === undefined ? Number.NaN : Number(ordinalText);
      const values = tuple(artifact.body);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify([MONEYFORWARD_IDENTITY_CONTRACT, ...values])),
      );
      const identity = `${MONEYFORWARD_IDENTITY_CONTRACT}-${hex(digest)}`;
      if (
        ordinalText === undefined ||
        ordinal < 1 ||
        ordinal > 64 ||
        byOrdinal.has(ordinalText) ||
        identities.has(identity)
      ) {
        throw new Unavailable("identity_duplicate");
      }
      if (sortedPaths !== undefined && sortedPaths[ordinal - 1] !== values[0]) {
        throw new Unavailable("identity_index_mismatch");
      }
      byOrdinal.set(ordinalText, identity);
      identities.add(identity);
    }
    for (const unit of accountUnits) {
      if (!byOrdinal.has(unit)) throw new Unavailable("identity_incomplete");
    }
    if (successfulAccountCount !== undefined && byOrdinal.size !== successfulAccountCount) {
      throw new Unavailable("identity_incomplete");
    }
    return { status: "derived", byOrdinal };
  } catch (error) {
    if (error instanceof Unavailable) return { status: "unavailable", code: error.code };
    // A page that is not UTF-8 or not parseable carries no tuple either.
    return { status: "unavailable", code: "identity_tuple_invalid" };
  }
}
