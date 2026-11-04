import { parse, type DefaultTreeAdapterMap } from "parse5";
import { extractGeneralJsonDiscriminator } from "./parsers";
import type { MyJcbReadClient } from "./client";
import type { JPointCollectionCode, RawArtifact } from "./types";

type Node = DefaultTreeAdapterMap["node"];
function className(node: Node, name: string): boolean {
  return (
    "attrs" in node &&
    (node.attrs.find((attr) => attr.name === "class")?.value ?? "").split(/\s+/u).includes(name)
  );
}
function text(node: Node): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}
/** Only the currently selected product marker observed on the logged-in mypage. */
export function isObservedJPointProduct(html: string): boolean {
  const products: string[] = [];
  function visit(node: Node): void {
    if (
      node.nodeName === "span" &&
      className(node, "txt") &&
      "parentNode" in node &&
      node.parentNode?.nodeName === "p" &&
      className(node.parentNode, "user-stage")
    ) {
      products.push(text(node).normalize("NFKC").trim());
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  }
  visit(parse(html));
  if (products.length !== 1) return false;
  const product = products[0]!;
  if (
    /(?:リクルートカード|JCB(?:カード|\s*CARD)?\s*(?:ゴールド|プラチナ|デビット|GOLD|PLATINUM|DEBIT))/iu.test(
      product,
    )
  )
    return false;
  if (/W\s*(?:(?:plus|プラス|\+)\s*L|L)/iu.test(product)) return false;
  return [...product.matchAll(/(?<![\p{L}\p{N}])JCBカードW(?![\p{L}\p{N}])/gu)].length === 1;
}

export async function collectJPoint(
  client: Pick<MyJcbReadClient, "postJPointJson">,
  html: string,
): Promise<{
  readonly code: JPointCollectionCode;
  readonly artifacts: readonly RawArtifact[];
}> {
  if (!isObservedJPointProduct(html)) return { code: "unsupported", artifacts: [] };
  try {
    const response = await client.postJPointJson(extractGeneralJsonDiscriminator(html));
    return {
      code: "collected",
      artifacts: [
        {
          dataset: "jpoint-balance",
          filename: "jpoint-balance.json",
          body: response.body,
          mediaType: "application/json",
        },
      ],
    };
  } catch {
    return { code: "unavailable", artifacts: [] };
  }
}
