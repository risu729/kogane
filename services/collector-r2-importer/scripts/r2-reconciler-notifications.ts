import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const ACCOUNT_ID = "59ea63cc00914b30ca410b062ae2bb7f";
export const QUEUE_NAME = "kogane-r2-outbox-reconciler";
export const STATE_SCHEMA = "kogane-r2-notification-state-v1";
export const CONFIRMATION = "I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE";
const STATE_PATH = resolve(import.meta.dirname, ".r2-reconciler-notifications.state.json");
const WRANGLER_BIN = resolve(import.meta.dirname, "../node_modules/wrangler/bin/wrangler.js");
const CREATE_ACTIONS = ["CompleteMultipartUpload", "CopyObject", "PutObject"] as const;

export type ExpectedRule = {
  bucket: string;
  prefix: string;
  suffix: string;
  description: string;
};

export type StoredRule = ExpectedRule & { ruleId: string };

export type State = {
  schema: typeof STATE_SCHEMA;
  accountId: typeof ACCOUNT_ID;
  queueName: typeof QUEUE_NAME;
  rules: StoredRule[];
};

type ApiRule = {
  actions: string[];
  description: string;
  prefix: string;
  ruleId: string;
  suffix: string;
};

type ApiQueue = {
  queueId: string;
  queueName: string;
  rules: ApiRule[];
};

export type NotificationRuntime = {
  runWrangler(args: string[], capture?: boolean): string;
  fetch(url: string, init: RequestInit): Promise<Response>;
  stateExists(): boolean;
  readState(): string;
  writeState(state: State): void;
  removeState(): void;
  log(message: string): void;
};

const RULE_INPUTS = [
  ["kogane-sbi-collector-poc", "raw/sbi-securities/", "manifest.json", "sbi-securities-manifest"],
  ["kogane-sbi-vc-trade-poc", "raw/sbi-vc-trade/", "manifest.json", "sbi-vc-trade-manifest"],
  ["kogane-sony-bank-collector-poc", "raw/sony-bank/", "manifest.json", "sony-bank-manifest"],
  ["kogane-sbi-shinsei-collector-poc", "raw/sbi-shinsei/", "manifest.json", "sbi-shinsei-manifest"],
  [
    "kogane-mobile-suica-collector-poc",
    "raw/mobile-suica/",
    "manifest.json",
    "mobile-suica-manifest",
  ],
  [
    "kogane-globalpass-collector-poc",
    "raw/prestia-globalpass/",
    "manifest.json",
    "global-pass-manifest",
  ],
  ["kogane-myjcb-collector-poc", "raw/myjcb/", "manifest.json", "myjcb-manifest"],
  [
    "kogane-moneyforward-collector-poc",
    "raw/moneyforward/",
    "manifest.json",
    "moneyforward-manifest",
  ],
  ["kogane-vpoint-collector-poc", "raw/v-point/", "manifest.json", "v-point-manifest"],
  ["kogane-vpoint-pay-collector-poc", "raw/v-point-pay-email/", ".json", "v-point-pay-normalized"],
  ["kogane-vpass-collector-poc", "vpass/", "manifest.json", "vpass-manifest"],
  ["kogane-vpass-collector-poc", "vpass/", "error.json", "vpass-error"],
  ["kogane-smbc-direct-backfill-poc", "raw/smbc-direct/", "manifest.json", "smbc-direct-manifest"],
] as const;

export const RULES: readonly ExpectedRule[] = RULE_INPUTS.map(([bucket, prefix, suffix, name]) => ({
  bucket,
  prefix,
  suffix,
  description: `kogane-r2-reconciler-v1:${name}`,
}));

function fail(message: string): never {
  throw new Error(message);
}

function runProductionWrangler(args: string[], capture = false): string {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    fail(`wrangler command failed (${args.slice(0, 4).join(" ")})`);
  }
  return result.stdout ?? "";
}

function authHeaders(runtime: NotificationRuntime): Record<string, string> {
  let input: unknown;
  try {
    input = JSON.parse(runtime.runWrangler(["auth", "token", "--json"], true));
  } catch {
    fail("could not parse Wrangler authentication output");
  }
  if (!input || typeof input !== "object") fail("invalid Wrangler authentication output");
  const value = input as Record<string, unknown>;
  if (
    (value.type === "oauth" || value.type === "api_token") &&
    typeof value.token === "string" &&
    value.token.length > 0
  ) {
    return { Authorization: `Bearer ${value.token}` };
  }
  if (
    value.type === "api_key" &&
    typeof value.key === "string" &&
    value.key.length > 0 &&
    typeof value.email === "string" &&
    value.email.length > 0
  ) {
    return { "X-Auth-Key": value.key, "X-Auth-Email": value.email };
  }
  return fail("unsupported Wrangler authentication output");
}

function parseApiRule(input: unknown): ApiRule {
  if (!input || typeof input !== "object") fail("invalid notification rule response");
  const value = input as Record<string, unknown>;
  if (
    !Array.isArray(value.actions) ||
    !value.actions.every((action) => typeof action === "string") ||
    typeof value.description !== "string" ||
    typeof value.prefix !== "string" ||
    typeof value.suffix !== "string" ||
    typeof value.ruleId !== "string" ||
    value.ruleId.length < 1 ||
    value.ruleId.length > 128 ||
    !/^[A-Za-z0-9-]+$/.test(value.ruleId)
  ) {
    fail("invalid notification rule response");
  }
  return {
    actions: [...value.actions],
    description: value.description,
    prefix: value.prefix,
    suffix: value.suffix,
    ruleId: value.ruleId,
  };
}

function parseApiQueue(input: unknown): ApiQueue {
  if (!input || typeof input !== "object") fail("invalid notification queue response");
  const value = input as Record<string, unknown>;
  if (
    typeof value.queueId !== "string" ||
    value.queueId.length < 1 ||
    typeof value.queueName !== "string" ||
    !Array.isArray(value.rules)
  ) {
    fail("invalid notification queue response");
  }
  return {
    queueId: value.queueId,
    queueName: value.queueName,
    rules: value.rules.map(parseApiRule),
  };
}

async function listRules(
  bucket: string,
  headers: Record<string, string>,
  runtime: NotificationRuntime,
): Promise<ApiQueue[]> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/event_notifications/r2/` +
    `${encodeURIComponent(bucket)}/configuration`;
  const response = await runtime.fetch(url, { headers });
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    fail(`notification list returned non-JSON (${response.status})`);
  }
  if (!envelope || typeof envelope !== "object") fail("invalid notification list response");
  const value = envelope as Record<string, unknown>;
  if (
    response.status === 404 &&
    value.success === false &&
    value.result === null &&
    Array.isArray(value.errors) &&
    value.errors.length === 1 &&
    value.errors[0] &&
    typeof value.errors[0] === "object" &&
    (value.errors[0] as Record<string, unknown>).code === 11015
  ) {
    return [];
  }
  if (!response.ok || value.success !== true || !value.result || typeof value.result !== "object") {
    fail(`notification list failed (${response.status})`);
  }
  const result = value.result as Record<string, unknown>;
  if (result.bucketName !== bucket || !Array.isArray(result.queues)) {
    fail("notification list identity mismatch");
  }
  return result.queues.map(parseApiQueue);
}

function sameActions(actual: string[]): boolean {
  return (
    actual.length === CREATE_ACTIONS.length &&
    [...actual].sort().every((action, index) => action === CREATE_ACTIONS[index])
  );
}

function exactMatches(queues: ApiQueue[], expected: ExpectedRule): StoredRule[] {
  return queues.flatMap((queue) =>
    queue.queueName === QUEUE_NAME
      ? queue.rules
          .filter(
            (rule) =>
              rule.description === expected.description &&
              rule.prefix === expected.prefix &&
              rule.suffix === expected.suffix &&
              sameActions(rule.actions),
          )
          .map((rule) => ({ ...expected, ruleId: rule.ruleId }))
      : [],
  );
}

function hasCollision(queues: ApiQueue[], expected: ExpectedRule): boolean {
  return queues.some((queue) =>
    queue.rules.some(
      (rule) =>
        rule.description === expected.description ||
        (queue.queueName === QUEUE_NAME &&
          rule.prefix === expected.prefix &&
          rule.suffix === expected.suffix &&
          sameActions(rule.actions)),
    ),
  );
}

function assertKnownStoredRule(input: unknown): StoredRule {
  if (!input || typeof input !== "object") fail("invalid local rule state");
  const value = input as Record<string, unknown>;
  const expected = RULES.find(
    (rule) =>
      value.bucket === rule.bucket &&
      value.prefix === rule.prefix &&
      value.suffix === rule.suffix &&
      value.description === rule.description,
  );
  if (
    !expected ||
    typeof value.ruleId !== "string" ||
    value.ruleId.length < 1 ||
    value.ruleId.length > 128 ||
    !/^[A-Za-z0-9-]+$/.test(value.ruleId)
  ) {
    fail("invalid local rule state");
  }
  return { ...expected, ruleId: value.ruleId };
}

function readState(runtime: NotificationRuntime): State {
  let input: unknown;
  try {
    input = JSON.parse(runtime.readState());
  } catch {
    fail("notification state is missing or invalid");
  }
  if (!input || typeof input !== "object") fail("invalid notification state");
  const value = input as Record<string, unknown>;
  if (
    value.schema !== STATE_SCHEMA ||
    value.accountId !== ACCOUNT_ID ||
    value.queueName !== QUEUE_NAME ||
    !Array.isArray(value.rules)
  ) {
    fail("notification state identity mismatch");
  }
  const rules = value.rules.map(assertKnownStoredRule);
  if (new Set(rules.map((rule) => rule.description)).size !== rules.length) {
    fail("duplicate local notification state");
  }
  return { schema: STATE_SCHEMA, accountId: ACCOUNT_ID, queueName: QUEUE_NAME, rules };
}

function emptyState(): State {
  return { schema: STATE_SCHEMA, accountId: ACCOUNT_ID, queueName: QUEUE_NAME, rules: [] };
}

export function writeStateFile(path: string, state: State): void {
  const temporaryDirectory = mkdtempSync(join(dirname(path), ".r2-reconciler-state-"));
  const temporary = join(temporaryDirectory, "state.json");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`);
    fchmodSync(descriptor, 0o600);
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      fail("notification state temporary file invariant failed");
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function readStateFile(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o600
    ) {
      fail("notification state file invariant failed");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function requireConfirmation(value: string | undefined): void {
  if (value !== CONFIRMATION) {
    fail(`refusing: pass ${CONFIRMATION} as the second argument`);
  }
}

async function verifyStoredRule(
  stored: StoredRule,
  headers: Record<string, string>,
  runtime: NotificationRuntime,
): Promise<void> {
  const queues = await listRules(stored.bucket, headers, runtime);
  const matches = exactMatches(queues, stored);
  if (matches.length !== 1 || matches[0]?.ruleId !== stored.ruleId) {
    fail("live notification rule does not exactly match local state");
  }
}

async function apply(runtime: NotificationRuntime): Promise<void> {
  const headers = authHeaders(runtime);
  const state = runtime.stateExists() ? readState(runtime) : emptyState();

  for (const stored of state.rules) await verifyStoredRule(stored, headers, runtime);
  for (const expected of RULES) {
    if (state.rules.some((rule) => rule.description === expected.description)) continue;
    const before = await listRules(expected.bucket, headers, runtime);
    if (hasCollision(before, expected)) fail("unmanaged or ambiguous notification rule collision");
  }
  runtime.writeState(state);

  for (const expected of RULES) {
    if (state.rules.some((rule) => rule.description === expected.description)) continue;
    runtime.runWrangler([
      "r2",
      "bucket",
      "notification",
      "create",
      expected.bucket,
      "--event-type",
      "object-create",
      "--queue",
      QUEUE_NAME,
      "--prefix",
      expected.prefix,
      "--suffix",
      expected.suffix,
      "--description",
      expected.description,
    ]);
    const matches = exactMatches(await listRules(expected.bucket, headers, runtime), expected);
    if (matches.length !== 1) fail("created notification rule could not be uniquely verified");
    state.rules.push(matches[0]!);
    runtime.writeState(state);
  }
  runtime.log(`queue=${QUEUE_NAME} rules-created-or-verified=${state.rules.length}`);
}

async function capture(runtime: NotificationRuntime): Promise<void> {
  if (runtime.stateExists()) fail("notification state already exists");
  const headers = authHeaders(runtime);
  const state = emptyState();
  for (const expected of RULES) {
    const matches = exactMatches(await listRules(expected.bucket, headers, runtime), expected);
    if (matches.length > 1) fail("ambiguous live notification rules");
    if (matches[0]) state.rules.push(matches[0]);
  }
  if (state.rules.length === 0) fail("no managed notification rules found");
  runtime.writeState(state);
  runtime.log(`queue=${QUEUE_NAME} rules-captured=${state.rules.length}`);
}

async function remove(runtime: NotificationRuntime): Promise<void> {
  const headers = authHeaders(runtime);
  const state = readState(runtime);
  if (state.rules.length === 0) fail("notification state contains no rules");

  // Complete preflight before the first destructive call.
  for (const stored of state.rules) await verifyStoredRule(stored, headers, runtime);

  while (state.rules.length > 0) {
    const stored = state.rules[0]!;
    runtime.runWrangler([
      "r2",
      "bucket",
      "notification",
      "delete",
      stored.bucket,
      "--queue",
      QUEUE_NAME,
      "--rule",
      stored.ruleId,
    ]);
    const stillPresent = (await listRules(stored.bucket, headers, runtime)).some((queue) =>
      queue.rules.some((rule) => rule.ruleId === stored.ruleId),
    );
    if (stillPresent) fail("deleted notification rule is still present");
    state.rules.shift();
    runtime.writeState(state);
  }
  runtime.removeState();
  runtime.log(`queue=${QUEUE_NAME} rules-removed=${RULES.length}`);
}

export async function runNotificationCommand(
  args: readonly string[],
  runtime: NotificationRuntime,
): Promise<void> {
  const mode = args[0] ?? "plan";
  if (mode === "plan") {
    runtime.log(`queue=${QUEUE_NAME} rules=${RULES.length} mode=read-only-plan`);
    for (const rule of RULES) {
      runtime.log(
        `bucket=${rule.bucket} prefix=${rule.prefix} suffix=${rule.suffix} description=${rule.description}`,
      );
    }
    return;
  }
  if (mode === "capture") return capture(runtime);
  if (mode === "apply") {
    requireConfirmation(args[1]);
    return apply(runtime);
  }
  if (mode === "remove") {
    requireConfirmation(args[1]);
    return remove(runtime);
  }
  fail(`usage: r2-reconciler-notifications.ts plan|capture|apply|remove [${CONFIRMATION}]`);
}

const productionRuntime: NotificationRuntime = {
  runWrangler: runProductionWrangler,
  fetch: (url, init) => fetch(url, init),
  stateExists: () => existsSync(STATE_PATH),
  readState: () => readStateFile(STATE_PATH),
  writeState: (state) => writeStateFile(STATE_PATH, state),
  removeState: () => rmSync(STATE_PATH),
  log: (message) => console.log(message),
};

if (import.meta.main) {
  runNotificationCommand(process.argv.slice(2), productionRuntime).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "notification helper failed");
    process.exitCode = 1;
  });
}
