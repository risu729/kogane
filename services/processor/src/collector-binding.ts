// The private collector Service Binding of a workspace: `SCHEDULE_<WORKSPACE>`,
// bound to that collector's `ScheduledCollection` entrypoint
// (services/processor/wrangler.jsonc). One rule for the two callers — the
// alarm (`schedule-alarm.ts`) and the operations dispatch lane (ADR 0048) — so
// they always reach the same named RPC.
export function collectorBindingName(workspace: string): string {
  return `SCHEDULE_${workspace.replace("collector-", "").replaceAll("-", "_").toUpperCase()}`;
}

/** The binding itself, or null when this deployment declares none for the workspace. */
export function collectorBinding<T>(env: object, workspace: string): T | null {
  const value = (env as Record<string, unknown>)[collectorBindingName(workspace)];
  return value === undefined || value === null ? null : (value as T);
}
