/**
 * The byte bound on the JSON bodies of the Processor's internal routes: the
 * schedule operator and agent-read routes, the delegated schedule adapters
 * and the change-command API. The App bounds the same bodies before it
 * forwards them; this is the Processor's own bound behind it.
 */
export const INTERNAL_BODY_LIMIT = 16 * 1024;

/**
 * Reads a request body as UTF-8 text of at most `limit` bytes, counting bytes
 * as they arrive. Past the limit it stops at that chunk, cancels the stream
 * and answers null, so an oversized body — with or without a content-length —
 * is never read to its end. An absent body reads as empty text, and malformed
 * UTF-8 is replaced as `request.text()` replaces it unless `fatal` is set, in
 * which case decoding throws. A failing stream throws as `request.text()` does.
 */
export async function boundedText(
  request: Request,
  limit: number,
  options: { fatal?: boolean } = {},
): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: options.fatal ?? false });
  let size = 0,
    text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
