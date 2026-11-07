// Test transport only: Miniflare serializes native D1 objects to heap
// addresses but does not keep their proxies alive while an async CALL waits.
// Keep the receiver, method and argument references until settlement; never
// retry a call or alter its result/error. See workers-sdk issue 16230.
interface Retention {
  receiver: object;
  method: (...args: unknown[]) => unknown;
  args: unknown[];
  references: readonly object[];
}
const pending = new Set<Retention>();
const wrapped = new WeakMap<object, object>();
const NATIVE_RESULTS = new Set(["prepare", "bind", "withSession"]);

/**
 * Snapshot references in ordinary D1 argument arrays before a caller can
 * mutate them. Read only data descriptors: do not invoke accessors or walk
 * arbitrary objects. D1's statement arrays and bind values need no such walk.
 */
function referencesIn(args: unknown[]): object[] {
  const references: object[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
    if (seen.has(value)) return;
    seen.add(value);
    references.push(value);
    if (Array.isArray(value))
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
        if ("value" in descriptor) visit(descriptor.value);
  };
  visit(args);
  return references;
}

/** Test probes return copies; production code imports none of this module. */
export const pendingNativeD1Calls = (): number => pending.size;
export const retainedNativeD1References = (): readonly object[] =>
  [...pending].flatMap((entry) => [entry.receiver, entry.method, ...entry.references]);

function invoke(
  receiver: object,
  method: (...args: unknown[]) => unknown,
  args: unknown[],
): unknown {
  const retention = { receiver, method, args, references: referencesIn(args) };
  pending.add(retention);
  let asynchronous = false;
  try {
    const result = Reflect.apply(method, receiver, args);
    if (result instanceof Promise) {
      asynchronous = true;
      return result.finally(() => pending.delete(retention));
    }
    return result;
  } finally {
    if (!asynchronous) pending.delete(retention);
  }
}

/**
 * Preserve native metadata (including Miniflare's symbol/has traps), method
 * receivers and cached identity. Only synchronous D1 native results are
 * wrapped; async rows, arrays, buffers and errors are returned unchanged.
 */
export function retainNativeD1<T extends object>(native: T): T {
  const existing = wrapped.get(native);
  if (existing !== undefined) return existing as T;
  const methods = new Map<string, { method: unknown; call: (...args: unknown[]) => unknown }>();
  const proxy = new Proxy(native, {
    get(receiver, key) {
      const value: unknown = Reflect.get(receiver, key, receiver);
      if (typeof key !== "string" || typeof value !== "function") return value;
      const cached = methods.get(key);
      if (cached?.method === value) return cached.call;
      const method = value as (...args: unknown[]) => unknown;
      const call = (...args: unknown[]): unknown => {
        const result = invoke(receiver, method, args);
        return NATIVE_RESULTS.has(key) && typeof result === "object" && result !== null
          ? retainNativeD1(result)
          : result;
      };
      methods.set(key, { method, call });
      return call;
    },
  });
  wrapped.set(native, proxy);
  return proxy;
}
