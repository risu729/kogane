/** Finite diagnostic labels; writable exception names are never inspected. */
const FAILURE_CLASSES = [
  [AggregateError, "AggregateError"],
  [EvalError, "EvalError"],
  [RangeError, "RangeError"],
  [ReferenceError, "ReferenceError"],
  [SyntaxError, "SyntaxError"],
  [TypeError, "TypeError"],
  [URIError, "URIError"],
  [Error, "Error"],
] as const;

/**
 * Classify built-in error types without reading name, constructor or message.
 * A custom Error remains generic Error; an unclassifiable throw is unknown.
 */
export function safeFailureCode(error: unknown): string {
  try {
    for (const [constructor, code] of FAILURE_CLASSES)
      if (error instanceof constructor) return code;
  } catch {
    // A hostile proxy may throw while instanceof walks its prototype chain.
  }
  return "unknown";
}
