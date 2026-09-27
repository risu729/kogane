// The invariants central storage enforces on a stored MyJCB page, checked
// again on the bytes that are about to leave the Worker in shared mode
// (unified plan 12 §6, U09). `redactedStatementHtml` in `./parsers` is what
// makes them hold; this is the assertion that a regression in it fails the
// run instead of publishing the page. It lives apart from the parsers so the
// shared-target module depends on the check alone, not on the page parsers.

/**
 * Throws a stable code, never the offending text, when a page still carries
 * an executable or embedding element, an attribute that could hold a URL, a
 * session or a credential with its value, or a card number in its text.
 */
export function assertRedactedHtml(html: string): void {
  if (
    /<(?:script|style|noscript|template|iframe|object|embed|meta|base|link)\b/iu.test(html) ||
    /\s(?:on[a-z0-9_-]+|style|srcdoc|srcset|integrity|nonce|data-[a-z0-9_-]+|href|src|action|formaction)\s*=/iu.test(
      html,
    ) ||
    /\svalue\s*=\s*(?!["']\[redacted\]["'])/iu.test(html) ||
    /\s[a-z0-9:_-]*(?:token|csrf|session|auth|credential|secret|password|nonce|userid|user-id|user_id|cookie)[a-z0-9:_-]*\s*=\s*(?!["']\[redacted\]["'])/iu.test(
      html,
    ) ||
    /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/u.test(html)
  ) {
    throw new Error("artifact_html_redaction_invalid");
  }
}
