import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../src/worker";
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
        hasPendingChallenge: async () => true,
        completeEmailCode: async () => ({ status: "authenticated" }),
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
