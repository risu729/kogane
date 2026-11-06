import { describe, expect, test } from "bun:test";
import { readLedger, settledStatus } from "./ci/release-ledger.mjs";

const client = { apiUrl: "https://api.test", owner: "o", repo: "r", token: "t" };
const record = (sha: string) => ({ manifestVersion: "release-manifest-v2", sha });

type Status = { id: number; state: string; created_at: string };
type Deployment = { id: number; sha: string; created_at: string; payload: unknown };

function fakeFetch(deployments: Deployment[], statuses: Record<number, Status[]>, next = false) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const match = /\/deployments\/(\d+)\/statuses/u.exec(url);
    const body = match ? statuses[Number(match[1])] : deployments;
    const headers: Record<string, string> =
      !match && next ? { link: '<https://api.test/next>; rel="next"' } : {};
    return new Response(JSON.stringify(body), { status: 200, headers });
  }) as unknown as typeof fetch;
}

describe("settledStatus", () => {
  test("skips inactive, which GitHub adds after a newer deployment succeeds", () => {
    expect(
      settledStatus([
        { id: 3, state: "inactive", created_at: "2026-11-05T20:31:26Z" },
        { id: 2, state: "success", created_at: "2026-11-05T20:31:20Z" },
        { id: 1, state: "in_progress", created_at: "2026-11-05T20:21:11Z" },
      ])?.state,
    ).toBe("success");
  });

  test("keeps a failure or an unfinished run as it is", () => {
    expect(
      settledStatus([
        { id: 2, state: "failure", created_at: "2026-11-05T06:58:00Z" },
        { id: 1, state: "in_progress", created_at: "2026-11-05T06:56:17Z" },
      ])?.state,
    ).toBe("failure");
    expect(
      settledStatus([{ id: 1, state: "in_progress", created_at: "2026-11-05T06:56:17Z" }])?.state,
    ).toBe("in_progress");
    expect(settledStatus([])).toBeUndefined();
    expect(
      settledStatus([{ id: 1, state: "inactive", created_at: "2026-11-05T06:56:17Z" }]),
    ).toBeUndefined();
  });

  test("breaks a same-second tie by status id", () => {
    expect(
      settledStatus([
        { id: 1, state: "in_progress", created_at: "2026-11-05T20:31:20Z" },
        { id: 2, state: "success", created_at: "2026-11-05T20:31:20Z" },
      ])?.state,
    ).toBe("success");
  });
});

describe("readLedger", () => {
  // The shape production had from 2026-11-05 20:31 UTC: the last release
  // record went `inactive` six seconds after its `success`, when the job's
  // own empty-payload environment deployment closed, and every later run
  // failed before writing a record.
  const deployments: Deployment[] = [
    { id: 20, sha: "fcbf81a", created_at: "2026-11-06T17:31:02Z", payload: {} },
    { id: 11, sha: "9548ba6", created_at: "2026-11-05T20:21:11Z", payload: record("9548ba6") },
    { id: 10, sha: "9548ba6", created_at: "2026-11-05T20:02:24Z", payload: {} },
    { id: 7, sha: "ef33f58", created_at: "2026-11-05T06:56:17Z", payload: record("ef33f58") },
    { id: 5, sha: "1442de1", created_at: "2026-11-05T12:52:00Z", payload: record("1442de1") },
  ];
  const statuses: Record<number, Status[]> = {
    20: [
      { id: 202, state: "failure", created_at: "2026-11-06T17:31:43Z" },
      { id: 201, state: "in_progress", created_at: "2026-11-06T17:31:06Z" },
    ],
    11: [
      { id: 113, state: "inactive", created_at: "2026-11-05T20:31:26Z" },
      { id: 112, state: "success", created_at: "2026-11-05T20:31:20Z" },
      { id: 111, state: "in_progress", created_at: "2026-11-05T20:21:11Z" },
    ],
    10: [{ id: 101, state: "success", created_at: "2026-11-05T20:31:25Z" }],
    7: [{ id: 71, state: "failure", created_at: "2026-11-05T06:58:00Z" }],
    5: [
      { id: 52, state: "inactive", created_at: "2026-11-05T20:31:21Z" },
      { id: 51, state: "success", created_at: "2026-11-05T13:04:45Z" },
    ],
  };

  test("reads a release record that GitHub has since marked inactive as the state", async () => {
    const ledger = await readLedger(client, {
      fetchImpl: fakeFetch(deployments, statuses, true),
    });
    expect(ledger.release).toEqual({ sha: "9548ba6", id: 11, record: record("9548ba6") });
    expect(ledger.attempts).toEqual([]);
  });

  test("still never reads a failed release as the state", async () => {
    const ledger = await readLedger(client, {
      fetchImpl: fakeFetch(
        deployments,
        { ...statuses, 11: [{ id: 112, state: "failure", created_at: "2026-11-05T20:31:20Z" }] },
        true,
      ),
    });
    expect(ledger.release?.sha).toBe("1442de1");
    expect(ledger.attempts.map((attempt) => [attempt.sha, attempt.state])).toEqual([
      ["9548ba6", "failure"],
    ]);
  });

  test("still fails closed when no release on the page succeeded and the list goes on", async () => {
    const failed = Object.fromEntries(
      Object.keys(statuses).map((id) => [
        id,
        [{ id: 1, state: "failure", created_at: "2026-11-05T00:00:00Z" }],
      ]),
    );
    await expect(
      readLedger(client, { fetchImpl: fakeFetch(deployments, failed, true) }),
    ).rejects.toThrow("refusing to treat the ledger as empty");
  });
});
