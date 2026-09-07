import { parse, type DefaultTreeAdapterMap } from "parse5";
import { ImportError } from "./error";
import type { VerifiedMoneyForwardArtifact } from "./moneyforward-schema";

/** Derived only from verified provider bytes; no raw account context leaves this function. */
export async function moneyForwardAccountKeys(
  artifacts: readonly VerifiedMoneyForwardArtifact[],
  fingerprintKey: string,
): Promise<Map<number, string>> {
  if (!/^[0-9a-f]{64}$/u.test(fingerprintKey)) {
    throw new ImportError(500, "fingerprint_configuration_invalid");
  }
  const keyBytes = Uint8Array.from(fingerprintKey.match(/../gu)!, (value) =>
    Number.parseInt(value, 16),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const output = new Map<number, string>();
  const identities = new Set<string>();
  const index = artifacts.find((item) => item.artifact.kind === "accounts-index");
  const paths = new Set<string>();
  const collectLinks = (node: DefaultTreeAdapterMap["node"]): void => {
    if ("tagName" in node && node.tagName === "a") {
      const href = node.attrs.find((attr) => attr.name === "href")?.value ?? "";
      const match = /^\/accounts\/show\/([A-Za-z0-9_-]+)(?:[?#].*)?$/u.exec(href);
      if (match) paths.add(match[1]!);
    }
    if ("childNodes" in node) for (const child of node.childNodes) collectLinks(child);
  };
  if (index) collectLinks(parse(new TextDecoder("utf-8", { fatal: true }).decode(index.bytes)));
  const sortedPaths = [...paths].sort();
  for (const verified of artifacts) {
    if (verified.artifact.kind !== "account-detail") continue;
    const fields = new Map<string, string[]>();
    const visit = (node: DefaultTreeAdapterMap["node"]): void => {
      if ("tagName" in node && node.tagName === "input") {
        const name = node.attrs.find((attr) => attr.name === "name")?.value;
        if (name === "account[id_hash]" || name === "service[id]") {
          const value = node.attrs.find((attr) => attr.name === "value")?.value ?? "";
          fields.set(name, [...(fields.get(name) ?? []), value]);
        }
      }
      if ("childNodes" in node) for (const child of node.childNodes) visit(child);
      if ("content" in node) visit(node.content);
    };
    visit(parse(new TextDecoder("utf-8", { fatal: true }).decode(verified.bytes)));
    const values = ["account[id_hash]", "service[id]"].map((name) => {
      const entries = fields.get(name);
      if (entries?.length !== 1 || !/^[A-Za-z0-9_-]{1,4096}$/u.test(entries[0]!)) {
        throw new ImportError(409, "account_identity_invalid");
      }
      return entries[0]!;
    });
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(JSON.stringify(["moneyforward-account-v1", ...values])),
    );
    const identity = `moneyforward-account-v1-${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const ordinal = verified.artifact.accountOrdinal;
    if (
      ordinal === undefined ||
      ordinal < 1 ||
      ordinal > 64 ||
      output.has(ordinal) ||
      identities.has(identity)
    ) {
      throw new ImportError(409, "account_identity_duplicate");
    }
    // R2 write failures can remove the index; surviving partial evidence stays non-current.
    if (index && sortedPaths[ordinal - 1] !== values[0]) {
      throw new ImportError(409, "account_identity_index_mismatch");
    }
    output.set(ordinal, identity);
    identities.add(identity);
  }
  return output;
}
