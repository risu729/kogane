import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import worker, { alarmCollection } from "../src/worker";
import { readTerminal } from "../../../packages/collection/src/index";
import { VPOINT_EMAIL_SUBJECT } from "../src/email";

afterEach(() => vi.restoreAllMocks());

// A synthetic authentication mail: the subject the collector reads and one code.
function authenticationMail(): ReadableStream<Uint8Array> {
  const subject = Buffer.from(VPOINT_EMAIL_SUBJECT).toString("base64");
  return new Response(
    [
      `Subject: =?UTF-8?B?${subject}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "123456",
    ].join("\r\n"),
  ).body!;
}

function postAuthEnv(): Env {
  return {
    ...env,
    // No lease database, no network login: the challenge is pending and the
    // emailed code completes it.
    SCHEDULE_DB: undefined,
    VPOINT_EMAIL_RECIPIENT: "synthetic-otp@example.invalid",
    VPOINT_EMAIL_FORWARD_TO: "synthetic-forward@example.invalid",
    VPOINT_SESSION: {
      idFromName: () => "synthetic",
      get: () => ({
        completeEmailCode: async () => ({
          status: "authenticated",
          schemaVersion: 1,
          operationId: "a".repeat(64),
          requestSha256: "b".repeat(64),
        }),
        beginLegacyCollection: async () => true,
        finishLegacyCollection: async () => undefined,
        getSession: async () => "session=synthetic",
      }),
    },
  } as unknown as Env;
}

function syntheticProvider(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const results =
      path === "/api/tpoint_history" || path === "/api/tmoney_history"
        ? { total: 0, history: [], graph: {} }
        : {};
    return Response.json({ status: { code: "0000" }, results });
  });
}

test("a post-authentication run whose terminal was not written fails the mail", async () => {
  syntheticProvider();
  // Every object write is refused, so persistRun answers `incomplete` and no
  // terminal exists for the run that the mail started.
  vi.spyOn(env.DATA, "put").mockRejectedValue(new Error("synthetic_storage_refusal"));
  const message = {
    from: "sender@example.invalid",
    to: "synthetic-otp@example.invalid",
    raw: authenticationMail(),
    forward: async () => undefined,
  } as unknown as ForwardableEmailMessage;
  const logged: string[] = [];
  for (const level of ["log", "error"] as const)
    vi.spyOn(console, level).mockImplementation((value: unknown) => {
      logged.push(String(value));
    });
  await expect(
    worker.email!(message, postAuthEnv(), {} as unknown as ExecutionContext),
  ).rejects.toThrow("V Point email handling failed");
  // No success record, and the failure record carries only closed codes.
  const records = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(records.some((record) => record.event === "vpoint-email-handled")).toBe(false);
  expect(records).toContainEqual(
    expect.objectContaining({
      event: "collector-stage-failed",
      stage: "post-auth-collection",
      failureCode: "operation_failed",
    }),
  );
  const text = logged.join("\n");
  for (const forbidden of ["synthetic_storage_refusal", "terminal=", "synthetic-otp@"])
    expect(text).not.toContain(forbidden);
});

test("a post-authentication run that persisted its terminal completes the mail", async () => {
  syntheticProvider();
  const message = {
    from: "sender@example.invalid",
    to: "synthetic-otp@example.invalid",
    raw: authenticationMail(),
    forward: async () => undefined,
  } as unknown as ForwardableEmailMessage;
  await expect(
    worker.email!(message, postAuthEnv(), {} as unknown as ExecutionContext),
  ).resolves.toBeUndefined();
});

test("an expired scheduled session recovers through email as a separate persisted run", async () => {
  let cookie: string | null = "session=synthetic-expired";
  let pending = false;
  const invalidateSession = vi.fn(async () => {
    cookie = null;
  });
  const ensureEmailChallenge = vi.fn(async () => {
    pending = true;
    return { status: "created" };
  });
  const completeEmailCode = vi.fn(async () => {
    pending = false;
    cookie = "session=synthetic-refreshed";
    return { status: "authenticated" };
  });
  const configured = {
    ...postAuthEnv(),
    VPOINT_SESSION: {
      idFromName: () => "synthetic",
      get: () => ({
        getSession: async () => cookie,
        invalidateSession,
        ensureEmailChallenge,
        hasPendingChallenge: async () => pending,
        completeEmailCode,
      }),
    },
  } as unknown as Env;
  const lines: string[] = [];
  for (const level of ["log", "error"] as const)
    vi.spyOn(console, level).mockImplementation((value: unknown) => lines.push(String(value)));
  const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headers.get("cookie") === "session=synthetic-expired")
      return Response.json({ status: { code: "0010" } });
    expect(headers.get("cookie")).toBe("session=synthetic-refreshed");
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const results =
      path === "/api/tpoint_history" || path === "/api/tmoney_history"
        ? { total: 0, history: [], graph: {} }
        : {};
    return Response.json({ status: { code: "0000" }, results });
  });
  const original = await alarmCollection(configured, "15 21 * * *", 0);
  expect(original).toMatchObject({ status: "failed", failureCode: "reauthentication_pending" });
  expect(invalidateSession).toHaveBeenCalledOnce();
  expect(ensureEmailChallenge).toHaveBeenCalledOnce();
  expect(fetched).toHaveBeenCalledOnce();
  const failed = await readTerminal(env.DATA, "v-point", original.runIds[0]!);
  expect(failed.outcome).toBe("found");
  if (failed.outcome !== "found") throw new Error("synthetic_terminal_missing");
  expect(failed.manifest.providerOutcome).toBe("failed");
  expect(failed.manifest.safeErrorCode).toBe("authentication_required");
  await worker.email!(
    {
      from: "sender@example.invalid",
      to: "synthetic-otp@example.invalid",
      raw: authenticationMail(),
      forward: async () => undefined,
    } as unknown as ForwardableEmailMessage,
    configured,
    {} as unknown as ExecutionContext,
  );
  expect(completeEmailCode).toHaveBeenCalledOnce();
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const followup = records.find((record) => record.event === "vpoint-post-auth-collection")!;
  const persisted = records.find(
    (record) => record.event === "vpoint-collection-persisted" && record.status === "success",
  )!;
  expect(followup.runId).toBe(persisted.runId);
  expect(followup.runId).not.toBe(original.runIds[0]);
  expect(persisted.terminalOutcome).toBe("persisted");
  const success = await readTerminal(env.DATA, "v-point", String(followup.runId));
  expect(success.outcome).toBe("found");
  if (success.outcome !== "found") throw new Error("synthetic_followup_missing");
  expect(success.manifest.providerOutcome).toBe("success");
  // The successful email run never replaces the original failed evidence or its receipt.
  const unchanged = await readTerminal(env.DATA, "v-point", original.runIds[0]!);
  expect(unchanged).toEqual(failed);
  expect(original.status).toBe("failed");
});
