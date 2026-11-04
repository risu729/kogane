import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledFailure,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import { createDiagnostics } from "../../../packages/collector-diagnostics/src/index";
import {
  AUTH_KEY_SHA256,
  CONFIG_KEY_SHA256,
  assertPublicKeyHash,
  buildConfigAuth,
  buildFirstLoginAuth,
} from "./mobile-auth";
import {
  persistCardRun,
  persistFailedRun,
  sharedBucket,
  sharedRunDiagnostic,
  sharedRunPersisted,
  type VpassMonthCapture,
} from "./shared-collection";
import { collectMonth } from "./statement-walk";
import { logVpassDiagnostic } from "./log-diagnostic";
const AUTH_URL = "https://spap.smbc-card.com/api/v3/Fauth";
const CONFIG_URL = "https://spap.smbc-card.com/api/v3/common/Config";
const MEMBER_BASE_URL = "https://www.smbc-card.com";
const CARD_LIST_PATH = "/memapi/jaxrs/multicard/dropdownlist_init/v1";
const CARD_SELECT_PATH = "/memapi/jaxrs/multicard/operation_card_update/v1";
const MEISAI_TOP_PATH = "/memapi/jaxrs/web_meisai/web_meisai_top/v1";
const APP_VERSION = "5.12.0";
const MOBILE_UA =
  `com.smbc_card.vpass.android_v${APP_VERSION} ` +
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241105.008; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36";
export interface Env {
  /** The central bucket; written only when COLLECTION_TARGET is `shared`. */
  DATA: R2Bucket;
  VPASS_ID: string;
  VPASS_PASSWORD: string;
  VPASS_DEVICE_ID: string;
  VPASS_AUTH_PUBLIC_KEY_B64: string;
  VPASS_CONFIG_PUBLIC_KEY_B64: string;
  SCHEDULE_DB?: D1Database;
}
type JsonObject = Record<string, unknown>;
interface RawJsonResponse {
  rawText: string;
  json: JsonObject;
}
interface RunSummary {
  runId: string;
  startedAt: string;
  completedAt: string;
  cardCount: number;
  selectedCardIndex: number;
  monthCount: number;
  pageCount: number;
  transactionCount: number;
  objectCount: number;
}
interface AllCardsRunSummary {
  runId: string;
  startedAt: string;
  completedAt: string;
  cardCount: number;
  successCount: number;
  failureCount: number;
  monthCount: number;
  pageCount: number;
  transactionCount: number;
  objectCount: number;
}
interface VpassSession {
  cookies: CookieBag;
  cardList: RawJsonResponse;
  cards: string[];
}
/** The captures a card collected, in the shape the shared plan reads. */
type SharedMonths = Record<string, VpassMonthCapture>;
class CookieBag {
  readonly #values = new Map<string, string>();
  absorb(headers: Headers): void {
    const extended = headers as Headers & {
      getSetCookie?: () => string[];
    };
    const sources = extended.getSetCookie?.() ?? splitSetCookie(headers.get("set-cookie"));
    for (const source of sources) {
      const pair = source.split(";", 1)[0]?.trim();
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) continue;
      this.#values.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  header(): string {
    return [...this.#values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  get size(): number {
    return this.#values.size;
  }
}
function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  // Expires contains a comma, while the next cookie begins after a comma followed
  // by a token and '='. Modern Workers exposes getSetCookie(); this is a fallback.
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}
function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function objectAt(value: unknown, ...path: string[]): JsonObject | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return isObject(current) ? current : null;
}
function pairMonths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const month = item["value"];
    return typeof month === "string" && /^\d{6}$/.test(month) ? [month] : [];
  });
}
function cardKeys(response: unknown): string[] {
  const list = objectAt(response, "body", "content", "DropdownListInitDisplayServiceBean")?.[
    "multiCardInfoList"
  ];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (!isObject(item)) return [];
    const value = item["value"];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
}
function availableMonths(response: unknown): string[] {
  const content = objectAt(response, "body", "content");
  if (!content) return [];
  const sources = [
    objectAt(content, "WebMeisaiTopDisplayServiceBean")?.["seikyuYMList"],
    objectAt(content, "WebMeisaiCommonDisplayServiceBean")?.["comSeikyuYMList"],
    objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean")?.["seikyuYMList"],
  ];
  return [...new Set(sources.flatMap(pairMonths))].sort().reverse();
}
function adler32(value: string): number {
  let a = 1;
  let b = 0;
  for (const byte of new TextEncoder().encode(value)) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function requestBody(path: string, content: JsonObject): string {
  return JSON.stringify({
    header: { requestHash: adler32(path), requestTimestamp: Date.now(), corpCode: "" },
    body: { content },
  });
}
function safeRunId(now = new Date()): string {
  return now.toISOString().replaceAll(":", "-").replace(".", "-");
}
function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}
async function jsonResponse(response: Response, label: string): Promise<RawJsonResponse> {
  const rawText = await response.text();
  if (!response.ok)
    throw Object.assign(new Error(`${label} failed with HTTP ${response.status}`), {
      httpStatus: response.status,
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!isObject(parsed)) throw new Error(`${label} returned non-object JSON`);
  return { rawText, json: parsed };
}
async function authenticate(env: Env, cookies: CookieBag): Promise<void> {
  const authKey = Buffer.from(
    requireSecret(env.VPASS_AUTH_PUBLIC_KEY_B64, "VPASS_AUTH_PUBLIC_KEY_B64"),
    "base64",
  );
  const configKey = Buffer.from(
    requireSecret(env.VPASS_CONFIG_PUBLIC_KEY_B64, "VPASS_CONFIG_PUBLIC_KEY_B64"),
    "base64",
  );
  assertPublicKeyHash(authKey, AUTH_KEY_SHA256, "auth public key");
  assertPublicKeyHash(configKey, CONFIG_KEY_SHA256, "Config public key");
  const deviceId = requireSecret(env.VPASS_DEVICE_ID, "VPASS_DEVICE_ID");
  const commonHeaders = {
    accept: "application/json",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "user-agent": MOBILE_UA,
    "x-app-version": APP_VERSION,
    "x-os-version": "15",
  };
  const configResponse = await fetch(CONFIG_URL, {
    method: "POST",
    redirect: "manual",
    headers: commonHeaders,
    body: JSON.stringify({
      auth: buildConfigAuth({ deviceId }, configKey),
      appVersion: APP_VERSION,
      osType: "Android",
      osVersion: "35",
    }),
  });
  cookies.absorb(configResponse.headers);
  const config = await jsonResponse(configResponse, "Config");
  const configStatus = typeof config.json["status"] === "number" ? config.json["status"] : null;
  const sessionTime = configResponse.headers.get("x-vappsessiontime");
  if (configStatus !== 200 || !sessionTime) {
    throw new Error(`Config rejected the session (application status ${String(configStatus)})`);
  }
  const loginId = requireSecret(env.VPASS_ID, "VPASS_ID");
  const password = requireSecret(env.VPASS_PASSWORD, "VPASS_PASSWORD");
  const authResponse = await fetch(AUTH_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...commonHeaders,
      cookie: cookies.header(),
      "x-vappsessiontime": sessionTime,
    },
    body: JSON.stringify({
      auth: buildFirstLoginAuth({ loginId, password, deviceId, deviceToken: "" }, authKey),
      is_first_login: 1,
      push: 0,
      auto_login: 0,
      os_type: 2,
      id_type: 2,
    }),
  });
  cookies.absorb(authResponse.headers);
  const auth = await jsonResponse(authResponse, "Fauth");
  const authStatus = typeof auth.json["status"] === "number" ? auth.json["status"] : null;
  const loginToken = objectAt(auth.json, "data")?.["login_token"];
  if (authStatus !== 200 || typeof loginToken !== "string" || cookies.size === 0) {
    throw new Error(`Fauth rejected the login (application status ${String(authStatus)})`);
  }
}
async function memberPost(
  cookies: CookieBag,
  path: string,
  content: JsonObject,
): Promise<RawJsonResponse> {
  const response = await fetch(MEMBER_BASE_URL + path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
      "content-type": "application/json",
      cookie: cookies.header(),
      "user-agent": MOBILE_UA,
    },
    body: requestBody(path, content),
  });
  cookies.absorb(response.headers);
  const result = await jsonResponse(response, path);
  const resultCode = objectAt(result.json, "header")?.["resultCode"];
  if (resultCode !== 0 && resultCode !== "0" && resultCode !== "0000") {
    throw new Error(`${path} returned resultCode ${String(resultCode)}`);
  }
  return result;
}
async function openSession(env: Env): Promise<VpassSession> {
  const cookies = new CookieBag();
  await authenticate(env, cookies);
  const cardList = await memberPost(cookies, CARD_LIST_PATH, {
    displayDropdownList: "enable",
  });
  const cards = cardKeys(cardList.json);
  if (cards.length === 0) throw new Error("Vpass returned no selectable cards");
  return { cookies, cardList, cards };
}
async function captureCard(
  env: Env,
  session: VpassSession,
  selectedCardZeroBased: number,
  started: Date,
  runId: string,
  onPersisted?: (runId: string) => void,
): Promise<RunSummary> {
  const cardLabel = `card-${String(selectedCardZeroBased + 1).padStart(3, "0")}`;

  const { cookies, cardList, cards } = session;
  const diagnostic = createDiagnostics("vpass", runId);
  let stage = "card-selection";
  try {
    const selectedCard = cards[selectedCardZeroBased];
    if (!selectedCard) {
      throw new Error(
        `Requested card ${selectedCardZeroBased + 1}, but Vpass returned ${cards.length} cards`,
      );
    }
    const selection = await memberPost(cookies, CARD_SELECT_PATH, {
      cardIdentifyKey: selectedCard,
    });
    stage = "statement-discovery";
    const top = await memberPost(cookies, MEISAI_TOP_PATH, {});
    const months = availableMonths(top.json);
    if (months.length === 0) throw new Error(`${cardLabel} returned no available statement months`);
    let pageCount = 0;
    let transactionCount = 0;
    const monthResults: Record<
      string,
      {
        pages: number;
        transactions: number;
      }
    > = {};
    const captures: SharedMonths = {};
    for (const month of months) {
      stage = "statement-collection";
      const result = await collectMonth(
        (path, content) => memberPost(cookies, path, content),
        month,
      );
      captures[month] = result;
      monthResults[month] = {
        pages: result.pages.length,
        transactions: result.transactionCount,
      };
      pageCount += result.pages.length;
      transactionCount += result.transactionCount;
    }
    const summary: RunSummary = {
      runId,
      startedAt: started.toISOString(),
      completedAt: new Date().toISOString(),
      cardCount: cards.length,
      selectedCardIndex: selectedCardZeroBased + 1,
      monthCount: months.length,
      pageCount,
      transactionCount,
      objectCount: 2,
    };
    {
      // The shared target stores the sanitized artifact set directly and
      // writes the terminal last; nothing goes to the per-source bucket and
      // the importer is never called (G1-15).
      stage = "shared-persist";
      const outcome = await persistCardRun(sharedBucket(env.DATA), {
        sessionRunId: runId,
        cardLabel,
        startedAt: started.toISOString(),
        completedAt: summary.completedAt,
        cardListRawJson: cardList.rawText,
        selectCardRawJson: selection.rawText,
        webMeisaiTopRawJson: top.rawText,
        months: captures,
      });
      logVpassDiagnostic(sharedRunDiagnostic(runId, cardLabel, outcome));
      // A run whose terminal was not written is not a finished run (G1-01).
      if (!sharedRunPersisted(outcome)) throw new Error("shared_persist_incomplete");
      onPersisted?.(`${runId}-${cardLabel}`);
      return summary;
    }
  } catch (error) {
    diagnostic.failure(stage, error);
    {
      // A card that collected nothing is a failed run with no artifact, never
      // an empty success (G1-09). A persist failure here is reported as the
      // original failure: the terminal is simply absent.
      if (stage !== "shared-persist") {
        const persisted = await persistFailedCard(env, runId, cardLabel, started).catch(
          () => false,
        );
        if (persisted) onPersisted?.(`${runId}-${cardLabel}`);
      }
      throw error;
    }
  }
}
/** The failed-run terminal for one card or, with `run`, for a session that
 * failed before a card was selected. */
async function persistFailedCard(
  env: Env,
  runId: string,
  unitKey: string,
  started: Date,
): Promise<boolean> {
  const outcome = await persistFailedRun(sharedBucket(env.DATA), {
    sessionRunId: runId,
    unitKey,
    startedAt: started.toISOString(),
    failedAt: new Date().toISOString(),
  });
  logVpassDiagnostic(sharedRunDiagnostic(runId, unitKey, outcome));
  return sharedRunPersisted(outcome);
}
async function collectAllCards(
  env: Env,
  scheduledTime: number,
  onPersisted?: (runId: string) => void,
): Promise<AllCardsRunSummary> {
  return withCollectionLease(env, "vpass", async () => {
    const started = new Date(scheduledTime);
    const runId = safeRunId(started);

    const diagnostic = createDiagnostics("vpass", runId);
    let session: VpassSession;
    try {
      session = await diagnostic.step("session-open", () => openSession(env));
    } catch (error) {
      diagnostic.finish("failed");
      {
        const persisted = await persistFailedCard(env, runId, "run", started).catch(() => false);
        if (persisted) onPersisted?.(`${runId}-run`);
        throw error;
      }
    }
    const summaries: RunSummary[] = [];
    const failures: number[] = [];
    for (let index = 0; index < session.cards.length; index += 1) {
      try {
        summaries.push(
          await diagnostic.step("card-collection", () =>
            captureCard(env, session, index, started, runId, onPersisted),
          ),
        );
      } catch {
        failures.push(index + 1);
      }
    }
    const summary: AllCardsRunSummary = {
      runId,
      startedAt: started.toISOString(),
      completedAt: new Date().toISOString(),
      cardCount: session.cards.length,
      successCount: summaries.length,
      failureCount: failures.length,
      monthCount: summaries.reduce((total, item) => total + item.monthCount, 0),
      pageCount: summaries.reduce((total, item) => total + item.pageCount, 0),
      transactionCount: summaries.reduce((total, item) => total + item.transactionCount, 0),
      objectCount: summaries.reduce((total, item) => total + item.objectCount, 0) + failures.length,
    };
    logVpassDiagnostic({ event: "vpass-daily-collection-complete", ...summary });
    diagnostic.finish(
      failures.length === 0 ? "success" : summaries.length === 0 ? "failed" : "partial",
    );
    if (failures.length > 0) {
      throw new Error(`${failures.length} of ${session.cards.length} card collections failed`);
    }
    return summary;
  });
}
export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await collectAllCards(env, controller.scheduledTime);
  },
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "kogane-vpass-collector-poc" });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** Private service-binding collection; public HTTP cannot invoke collection. */
export async function alarmCollection(
  env: Env,
  _cron: string,
  scheduledTime: number,
): Promise<ScheduledResult> {
  const runIds: string[] = [];
  try {
    await collectAllCards(env, scheduledTime, (runId) => runIds.push(runId));
    return { status: "completed", runIds, failureCode: null };
  } catch (error) {
    return scheduledFailure(error, runIds);
  }
}
