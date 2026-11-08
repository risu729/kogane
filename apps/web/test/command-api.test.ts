// The change lifecycle's refusals as the web client shows them. Synthetic
// responses only: `fetch` is replaced for each request.
import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  COMMAND_ERROR_CODES,
  statusForCommandError,
} from "../../../packages/application/src/command/errors.ts";
import { CommandError, postCommand } from "../src/command-api.ts";
import { ErrorState } from "../src/ui.tsx";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** What `postCommand` throws for one refusal of the Processor. */
async function refusal(status: number, code: string): Promise<CommandError> {
  globalThis.fetch = (async () =>
    Response.json({ error: code }, { status })) as unknown as typeof fetch;
  try {
    await postCommand("plan", {}, new AbortController().signal);
  } catch (error) {
    if (error instanceof CommandError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

// The messages a code without its own entry falls back to: they name only the
// HTTP status, so a closed refusal must never read as one of them.
const FALLBACKS = [
  "操作を受け付けられませんでした。再試行しても結果は変わりません。表示を更新して、内容を確認し直してください。",
  "この操作を行う権限がありません。",
  "認証が必要です。ログイン状態を確認して、再読み込みしてください。",
];

test("every closed command refusal is named by its own fixed message", async () => {
  const messages = new Map<string, string>();
  for (const code of COMMAND_ERROR_CODES) {
    const error = await refusal(statusForCommandError(code), code);
    expect(error.code).toBe(code);
    expect(FALLBACKS).not.toContain(error.message);
    messages.set(code, error.message);
  }
  // One message per code: two refusals that ask for different next steps
  // never read the same.
  expect(new Set(messages.values()).size).toBe(messages.size);
});

test("an unknown refusal code falls back to its status, never to the server's text", async () => {
  expect((await refusal(400, "synthetic_unknown")).message).toBe(FALLBACKS[0]!);
  expect((await refusal(403, "synthetic_unknown")).message).toBe(FALLBACKS[1]!);
  expect((await refusal(401, "synthetic_unknown")).message).toBe(FALLBACKS[2]!);
});

test("only a refusal the same request would meet again says retrying will not help", async () => {
  // The App's own 400 (a body that is not a JSON object) is refused again.
  const invalid = await refusal(400, "invalid_request");
  expect(invalid.final).toBe(true);
  expect(invalid.message).toContain("再試行しても結果は変わりません");
  // A server fault, a timeout or a rate limit may pass later.
  for (const status of [500, 503, 408, 429]) {
    const transient = await refusal(status, "synthetic_unknown");
    expect(transient.final).toBe(false);
    expect(transient.message).toBe("操作を完了できませんでした。時間をおいて再試行してください。");
  }
  // The store-wide bound answers 429 and is not lifted by waiting.
  expect((await refusal(429, "budget_exceeded")).final).toBe(true);
  expect((await refusal(503, "command_executor_unavailable")).final).toBe(false);
});

test("a command refusal on a loading boundary shows its fixed message and status", () => {
  const markup = renderToStaticMarkup(
    createElement(ErrorState, {
      error: new CommandError(
        404,
        "plan_not_found",
        "計画が見つかりません。一覧から選び直してください。",
      ),
      label: "確認内容",
      onRetry: () => undefined,
    }),
  );
  expect(markup).toContain("計画が見つかりません。一覧から選び直してください。");
  expect(markup).toContain("(HTTP 404)");
  expect(markup).not.toContain("接続先の API が利用できるか確認し");
  // Asking again for a plan that does not exist meets the same refusal.
  expect(markup).not.toContain("再試行");
});

test("a command refusal that may pass later keeps its retry", () => {
  const markup = renderToStaticMarkup(
    createElement(ErrorState, {
      error: new CommandError(
        503,
        "command_executor_unavailable",
        "確定を実行する経路に接続できません。",
      ),
      label: "確認内容",
      onRetry: () => undefined,
    }),
  );
  expect(markup).toContain("再試行");
});
