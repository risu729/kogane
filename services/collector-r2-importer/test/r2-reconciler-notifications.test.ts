import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_ID,
  CONFIRMATION,
  QUEUE_NAME,
  RULES,
  STATE_SCHEMA,
  runNotificationCommand,
  writeStateFile,
  type ExpectedRule,
  type NotificationRuntime,
  type State,
  type StoredRule,
} from "../scripts/r2-reconciler-notifications";

const ACTIONS = ["PutObject", "CopyObject", "CompleteMultipartUpload"];
const temporaryDirectories: string[] = [];

type LiveRule = ExpectedRule & { ruleId: string; actions: string[]; queueName: string };

function stored(rule: ExpectedRule, ruleId = "rule-0001"): StoredRule {
  return { ...rule, ruleId };
}

function state(rules: StoredRule[]): State {
  return { schema: STATE_SCHEMA, accountId: ACCOUNT_ID, queueName: QUEUE_NAME, rules };
}

function live(rule: ExpectedRule, ruleId = "rule-0001"): LiveRule {
  return { ...rule, ruleId, actions: [...ACTIONS], queueName: QUEUE_NAME };
}

function mockRuntime(
  options: {
    liveRules?: LiveRule[];
    state?: unknown;
    tokenFailure?: boolean;
    networkFailure?: boolean;
    deleteFailure?: boolean;
    retainAfterDelete?: boolean;
  } = {},
): {
  runtime: NotificationRuntime;
  commands: string[][];
  logs: string[];
  stateText: () => string | undefined;
  liveRules: LiveRule[];
} {
  const liveRules = structuredClone(options.liveRules ?? []);
  let stateText = options.state === undefined ? undefined : JSON.stringify(options.state);
  const commands: string[][] = [];
  const logs: string[] = [];
  let nextRuleId = 100;

  const runtime: NotificationRuntime = {
    runWrangler(args) {
      commands.push([...args]);
      if (args[0] === "auth") {
        if (options.tokenFailure) throw new Error("raw-auth-output-must-not-escape");
        return JSON.stringify({ type: "oauth", token: "test-token" });
      }
      if (args[3] === "create") {
        const expected = RULES.find(
          (rule) =>
            rule.bucket === args[4] &&
            rule.prefix === flag(args, "--prefix") &&
            rule.suffix === flag(args, "--suffix"),
        );
        if (!expected) throw new Error("unexpected mock create");
        liveRules.push(live(expected, `rule-${nextRuleId++}`));
        return "";
      }
      if (args[3] === "delete") {
        if (options.deleteFailure) throw new Error("wrangler command failed (delete)");
        if (!options.retainAfterDelete) {
          const index = liveRules.findIndex((rule) => rule.ruleId === flag(args, "--rule"));
          if (index >= 0) liveRules.splice(index, 1);
        }
        return "";
      }
      throw new Error("unexpected mock Wrangler command");
    },
    async fetch(url) {
      if (options.networkFailure) throw new Error("network unavailable");
      const segments = new URL(url).pathname.split("/");
      const bucket = decodeURIComponent(segments.at(-2) ?? "");
      const matching = liveRules.filter((rule) => rule.bucket === bucket);
      if (matching.length === 0) {
        return Response.json(
          { success: false, result: null, errors: [{ code: 11015 }] },
          { status: 404 },
        );
      }
      const queues = new Map<string, LiveRule[]>();
      for (const rule of matching) {
        const rules = queues.get(rule.queueName) ?? [];
        rules.push(rule);
        queues.set(rule.queueName, rules);
      }
      return Response.json({
        success: true,
        result: {
          bucketName: bucket,
          queues: [...queues].map(([queueName, rules], index) => ({
            queueId: `queue-${index}`,
            queueName,
            rules: rules.map((rule) => ({
              actions: rule.actions,
              description: rule.description,
              prefix: rule.prefix,
              suffix: rule.suffix,
              ruleId: rule.ruleId,
            })),
          })),
        },
      });
    },
    stateExists: () => stateText !== undefined,
    readState: () => {
      if (stateText === undefined) throw new Error("missing mock state");
      return stateText;
    },
    writeState: (value) => {
      stateText = JSON.stringify(value);
    },
    removeState: () => {
      stateText = undefined;
    },
    log: (message) => logs.push(message),
  };
  return { runtime, commands, logs, stateText: () => stateText, liveRules };
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function deleteCommands(commands: string[][]): string[][] {
  return commands.filter((args) => args[3] === "delete");
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true });
});

describe("R2 reconciler notification lifecycle helper", () => {
  test("removes only an exactly verified recorded rule ID", async () => {
    const expected = RULES[0]!;
    const mock = mockRuntime({ liveRules: [live(expected)], state: state([stored(expected)]) });
    await runNotificationCommand(["remove", CONFIRMATION], mock.runtime);
    expect(deleteCommands(mock.commands)).toEqual([
      expect.arrayContaining(["--queue", QUEUE_NAME, "--rule", "rule-0001"]),
    ]);
    expect(mock.stateText()).toBeUndefined();
  });

  test.each([
    ["missing", []],
    ["duplicate", [live(RULES[0]!), live(RULES[0]!, "rule-0002")]],
    ["description", [{ ...live(RULES[0]!), description: "not-managed" }]],
    ["queue", [{ ...live(RULES[0]!), queueName: "other-queue" }]],
    ["prefix", [{ ...live(RULES[0]!), prefix: "other/" }]],
    ["suffix", [{ ...live(RULES[0]!), suffix: "other.json" }]],
    ["action", [{ ...live(RULES[0]!), actions: ["PutObject"] }]],
    ["rule ID", [live(RULES[0]!, "rule-9999")]],
  ])("fails closed before deletion on a %s live rule", async (_name, liveRules) => {
    const expected = RULES[0]!;
    const mock = mockRuntime({ liveRules, state: state([stored(expected)]) });
    await expect(runNotificationCommand(["remove", CONFIRMATION], mock.runtime)).rejects.toThrow(
      "live notification rule does not exactly match local state",
    );
    expect(deleteCommands(mock.commands)).toHaveLength(0);
    expect(mock.stateText()).toBeDefined();
  });

  test("sanitizes a token command failure before any API request", async () => {
    const mock = mockRuntime({ tokenFailure: true });
    const failure = runNotificationCommand(["capture"], mock.runtime);
    await expect(failure).rejects.toThrow("could not parse Wrangler authentication output");
    await expect(failure).rejects.not.toThrow("raw-auth-output-must-not-escape");
  });

  test("fails closed on a notification API network failure", async () => {
    const mock = mockRuntime({ networkFailure: true });
    await expect(runNotificationCommand(["capture"], mock.runtime)).rejects.toThrow(
      "network unavailable",
    );
    expect(deleteCommands(mock.commands)).toHaveLength(0);
  });

  test("keeps state on a Wrangler delete failure", async () => {
    const expected = RULES[0]!;
    const mock = mockRuntime({
      liveRules: [live(expected)],
      state: state([stored(expected)]),
      deleteFailure: true,
    });
    await expect(runNotificationCommand(["remove", CONFIRMATION], mock.runtime)).rejects.toThrow(
      "wrangler command failed",
    );
    expect(mock.stateText()).toBeDefined();
  });

  test("keeps state when the rule remains after a nominal delete", async () => {
    const expected = RULES[0]!;
    const mock = mockRuntime({
      liveRules: [live(expected)],
      state: state([stored(expected)]),
      retainAfterDelete: true,
    });
    await expect(runNotificationCommand(["remove", CONFIRMATION], mock.runtime)).rejects.toThrow(
      "deleted notification rule is still present",
    );
    expect(mock.stateText()).toBeDefined();
  });

  test.each([
    { ...state([]), schema: "other" },
    { ...state([]), accountId: "0".repeat(32) },
    { ...state([]), queueName: "other" },
    { ...state([stored(RULES[0]!)]), rules: [stored(RULES[0]!), stored(RULES[0]!)] },
  ])("rejects invalid state identity or duplicate ownership", async (invalidState) => {
    const mock = mockRuntime({ state: invalidState });
    await expect(runNotificationCommand(["remove", CONFIRMATION], mock.runtime)).rejects.toThrow();
    expect(deleteCommands(mock.commands)).toHaveLength(0);
  });

  test("resumes a partial apply without recreating its recorded rule", async () => {
    const first = RULES[0]!;
    const mock = mockRuntime({ liveRules: [live(first)], state: state([stored(first)]) });
    await runNotificationCommand(["apply", CONFIRMATION], mock.runtime);
    const creates = mock.commands.filter((args) => args[3] === "create");
    expect(creates).toHaveLength(RULES.length - 1);
    expect(creates.some((args) => args[4] === first.bucket)).toBeFalse();
    expect(JSON.parse(mock.stateText() ?? "null").rules).toHaveLength(RULES.length);
  });

  test("writes the production state atomically with owner-only mode", () => {
    const directory = mkdtempSync(join(tmpdir(), "kogane-r2-notification-state-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.json");
    const value = state([stored(RULES[0]!)]);
    writeStateFile(path, value);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(value);
  });
});
