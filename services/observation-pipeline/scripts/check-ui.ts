// Read-only smoke check. Run from an already authorized WARP environment.
// No raw response or financial values are printed or saved.
export {};
const base = "https://kogane-evidence-browser.takuanimal.workers.dev";
for (const route of ["meta", "overview", "transactions", "balances", "positions", "artifacts"]) {
  const response = await fetch(`${base}/api/${route}`, { redirect: "manual" });
  if (response.status !== 200) throw new Error(`${route}: HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  const arrays = Object.entries(body).filter(([, value]) => Array.isArray(value));
  console.log(
    JSON.stringify({
      route,
      status: response.status,
      counts: Object.fromEntries(arrays.map(([key, value]) => [key, (value as unknown[]).length])),
      ...(route === "meta" ? { parsingHealth: body.parsingHealth } : {}),
    }),
  );
}
