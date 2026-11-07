// The actual Alarm reservations behind the collection quality summary: the
// App's relay to the Observation Pipeline (ADR 0045). The summary's
// application service overlays what this returns; the route and
// `kogane.collection-quality.summary` pass it the same way.

/**
 * The actual Alarm reservations, read from the Observation Pipeline's relay
 * while schedules are enabled; none otherwise. The deadline covers both
 * headers and JSON, even for a relay that does not honor cancellation; a
 * rejection is the service's to treat as unknown.
 */
export function collectionQualityAlarms(env: Env): (() => Promise<unknown>) | undefined {
  if (env.SCHEDULES_ENABLED !== "true") return undefined;
  return async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("alarm_read_unavailable"));
      }, 5000);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await env.PIPELINE.fetch(
            new Request(
              "https://observation-pipeline.internal/internal/collection-quality/alarms",
              {
                headers: { "x-kogane-internal-caller": "kogane-evidence-browser" },
                signal: controller.signal,
              },
            ),
          );
          return response.ok ? ((await response.json()) as unknown) : null;
        })(),
        deadline,
      ]);
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  };
}
