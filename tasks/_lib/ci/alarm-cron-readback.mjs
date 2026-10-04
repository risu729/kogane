/** Read public Worker trigger configuration before activating any new alarm. */
export async function verifyAlarmCronRemoval({ jobs, accountId, token, fetchImpl = fetch }) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !token)
    throw new Error("schedule_cron_readback_credentials_missing");
  const workers = [...new Set(jobs.filter((job) => job.enabled).map((job) => job.worker))];
  if (!workers.length || workers.some((worker) => !/^[a-z0-9-]{1,63}$/u.test(worker ?? "")))
    throw new Error("schedule_cron_readback_invalid_workers");
  for (const worker of workers) {
    let response;
    try {
      response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/schedules`,
        {
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${token}` },
        },
      );
    } catch {
      throw new Error("schedule_cron_readback_unavailable");
    }
    if (response.status !== 200) throw new Error(`schedule_cron_readback_http_${response.status}`);
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error("schedule_cron_readback_invalid_response");
    }
    if (result?.success !== true || !Array.isArray(result.result?.schedules))
      throw new Error("schedule_cron_readback_invalid_response");
    if (result.result.schedules.length !== 0) throw new Error("schedule_cron_readback_not_empty");
  }
  return workers.length;
}
