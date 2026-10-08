// Temporary read-only probe for the image created by reviewed run 37810724923.
// Remove this file and restore the CI invocation after the readback is captured.
const account = process.env.CONTAINER_VERIFICATION_ACCOUNT_ID;
const token = process.env.CONTAINER_VERIFICATION_API_TOKEN;
const repository = "kogane-container-api-verification-verificationcontainer";
const tag = "15ed82a7cb311a1a38001e21a60aa9a2edcb434f";
const emit = (result) => console.log(JSON.stringify(result));
try {
  if (account !== "59ea63cc00914b30ca410b062ae2bb7f" || !token) throw new Error();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`,
    {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ expiration_minutes: 1, permissions: ["pull"] }),
    },
  );
  emit({ code: "verification_registry_probe_credentials", status: response.status });
  if (!response.ok) throw new Error();
  const credentials = await response.json();
  if (
    credentials.success !== true ||
    credentials.result?.account_id !== account ||
    credentials.result?.registry_host !== "registry.cloudflare.com" ||
    credentials.result?.username !== "v1" ||
    typeof credentials.result?.password !== "string" ||
    !credentials.result.password
  )
    throw new Error();
  const authorization = `Basic ${Buffer.from(`v1:${credentials.result.password}`).toString("base64")}`;
  const url = `https://registry.cloudflare.com/v2/${account}/${repository}/manifests/${tag}`;
  for (const [operation, method, fresh] of [
    ["get", "GET", false],
    ["head", "HEAD", false],
    ["get_fresh", "GET", true],
  ]) {
    try {
      const result = await fetch(url, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: {
          authorization,
          accept:
            "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
          ...(fresh ? { "cache-control": "no-cache, no-store", pragma: "no-cache" } : {}),
        },
        ...(fresh ? { cache: "no-store" } : {}),
      });
      const cache = result.headers.get("cf-cache-status");
      const age = result.headers.get("age");
      emit({
        code: "verification_registry_probe_readback",
        operation,
        status: result.status,
        digestPresent: /^sha256:[a-f0-9]{64}$/.test(
          result.headers.get("docker-content-digest") ?? "",
        ),
        cache: [
          "HIT",
          "MISS",
          "EXPIRED",
          "DYNAMIC",
          "BYPASS",
          "REVALIDATED",
          "UPDATING",
          "STALE",
        ].includes(cache)
          ? cache
          : "unclassified",
        age: age !== null && /^[0-9]{1,10}$/.test(age) ? Number(age) : null,
      });
      await result.body?.cancel();
    } catch {
      emit({ code: "verification_registry_probe_transport", operation });
    }
  }
} catch {
  emit({ code: "verification_registry_probe_failed" });
}
// Deliberately stop this opt-in job; the full synthetic experiment must not run.
process.exitCode = 1;
