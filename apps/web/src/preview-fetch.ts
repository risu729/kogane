import { ApiError } from "./api.ts";

export const PREVIEW_LIMIT = 512 * 1024;

export function previewLanguage(
  mediaType: string | null,
  key: string,
): "json" | "xml" | "text" | null {
  const type = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  if (type === "application/json" || type?.endsWith("+json")) return "json";
  if (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type === "text/xml" ||
    type?.endsWith("+xml")
  )
    return "xml";
  if (type?.startsWith("text/")) return "text";
  if (type && type !== "application/octet-stream") return null;
  const extension = key.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase();
  if (extension === "json" || extension === "jsonl" || extension === "ndjson") return "json";
  if (["html", "htm", "xml", "svg"].includes(extension ?? "")) return "xml";
  return ["txt", "csv", "tsv", "log", "md"].includes(extension ?? "") ? "text" : null;
}

/** Read only an explicit, bounded original. Never interpret an authentication page as evidence. */
export async function fetchPreview(
  url: string,
  signal: AbortSignal,
  expectedSha256: string,
  expectedSize: number,
  mediaType?: string | null,
): Promise<string> {
  if (
    !/^\/api\/evidence\/v1\/runs\/r_[1-9][0-9]*\/artifacts\/a_[1-9][0-9]*\/raw$/.test(url) ||
    !/^[a-f0-9]{64}$/.test(expectedSha256) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 0
  )
    throw new ApiError(400, "ファイルの識別情報が正しくありません。");
  if (expectedSize > PREVIEW_LIMIT)
    throw new ApiError(413, "プレビューは512 KiBまでです。全文はダウンロードして確認できます。");
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    signal.throwIfAborted();
    throw new ApiError(0, "ファイルに接続できませんでした。再試行してください。");
  }
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400) ||
    response.status === 401 ||
    response.status === 403
  )
    throw new ApiError(401, "認証が必要です。ページを再読み込みしてログインしてください。");
  if (!response.ok)
    throw new ApiError(response.status, "ファイルを表示できませんでした。再試行してください。");
  if (!response.body) throw new ApiError(502, "ファイルの内容を受信できませんでした。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > PREVIEW_LIMIT)
        throw new ApiError(
          413,
          "プレビューは512 KiBまでです。全文はダウンロードして確認できます。",
        );
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, "ファイルの読み込みが中断されました。再試行してください。");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  signal.throwIfAborted();
  if (length !== expectedSize || digest !== expectedSha256)
    throw new ApiError(409, "保存情報とファイルが一致しないため表示できません。");
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(mediaType ?? "")?.[1] ?? "utf-8";
  try {
    const text = new TextDecoder(charset, { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("binary");
    return text;
  } catch {
    throw new ApiError(
      422,
      "このファイルの文字形式には対応していません。ダウンロードして確認してください。",
    );
  }
}
