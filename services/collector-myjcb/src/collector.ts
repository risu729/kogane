import type { DocumentBudget } from "./documents";
import { collectCredit, collectionStage, type CreditStop } from "./credit";
export { collectCredit, connectionStopCode, validateCreditCsvText } from "./credit";
export type { CreditReadClient, CreditExportMode, CreditStop } from "./credit";
import { collectJPoint, isObservedJPointProduct } from "./jpoint";
import { collectJPointHistory } from "./jpoint-history";
import { collectDebit, collectDebitOther } from "./debit";
import { safeErrorDetails } from "../../../packages/collector-diagnostics/src/index";
import { decodeMyJcbHtml, MyJcbReadClient } from "./client";
import { CookieJar } from "./cookie-jar";
import { loginWithBitwardenPasskey, loginWithOfficialProtection } from "./login-protection";
import { extractCreditMenuLinkId, parseCardInventory } from "./parsers";
import { allowedUrl, MYJCB_ORIGIN } from "./policy";
import type {
  ConnectionSummary,
  ExportOffer,
  MyJcbCredential,
  RawArtifact,
  SchedulePage,
  SessionCredential,
  UnreadMonth,
} from "./types";
import { HumanRequiredError, StopConditionError } from "./types";

export interface ConnectionCollection {
  readonly summary: ConnectionSummary;
  readonly artifacts: readonly RawArtifact[];
}

export async function collectConnection(options: {
  diagnostic?: ReturnType<
    typeof import("../../../packages/collector-diagnostics/src/index").createDiagnostics
  >;
  browserBinding: BrowserRun;
  credential: MyJcbCredential;
  documentBudget?: DocumentBudget;
}): Promise<ConnectionCollection> {
  const login = await loginStage(async () =>
    options.credential.bootstrapMode === "password"
      ? await loginWithOfficialProtection(options.browserBinding, options.credential)
      : options.credential.bootstrapMode === "passkey"
        ? await loginWithBitwardenPasskey(options.browserBinding, options.credential)
        : await restoreSession(options.credential),
  );
  try {
    const cards = await collectionStage("collect-discovery", async () =>
      parseCardInventory(login.mypageHtml),
    );
    const client = new MyJcbReadClient(login.jar, login.userAgent);
    const artifacts: RawArtifact[] = [];
    let periodCount = 0;
    let unreadMonths: readonly UnreadMonth[] = [];
    let exportOffers: readonly ExportOffer[] = [];
    let documentResults: ConnectionSummary["documentResults"];
    let documentCode: ConnectionSummary["documentCode"];
    let schedulePages: readonly SchedulePage[] = [];
    let stop: CreditStop | undefined;
    let debitOtherCode: ConnectionSummary["debitOtherCode"];

    const creditLinkId = extractCreditMenuLinkId(login.mypageHtml);
    if (creditLinkId) {
      const credit = await collectionStage(
        "collect-credit",
        async () =>
          await collectCredit(client, creditLinkId, {
            exports: "fetch",
            ...(options.documentBudget === undefined
              ? {}
              : { documentBudget: options.documentBudget }),
          }),
      );
      artifacts.push(...credit.artifacts);
      periodCount += credit.periodCount;
      unreadMonths = credit.unreadMonths;
      exportOffers = credit.exportOffers;
      documentResults = credit.documentResults;
      documentCode = credit.documentCode;
      schedulePages = credit.schedulePages;
      stop = credit.stop;
    }
    // A connection stops where its credit months stopped: nothing further is
    // read (ADR 0005's amendment).
    if (
      stop === undefined &&
      login.mypageHtml.includes("/iss-pc/member/debit/details/debitDetailMenu.html")
    ) {
      const debit = await collectionStage("collect-debit", async () => await collectDebit(client));
      artifacts.push(...debit.artifacts);
      periodCount += debit.periodCount;
      unreadMonths = [...unreadMonths, ...debit.unreadMonths];
      stop = debit.stop;
      if (stop === undefined) {
        const other = await collectDebitOther(client);
        artifacts.push(...other.artifacts);
        debitOtherCode = other.code;
      }
    }
    if (artifacts.length === 0) {
      throw new StopConditionError(
        "MyJCB mypage exposed neither an allowlisted credit nor debit route",
        "collect-route",
      );
    }

    const point =
      stop === undefined
        ? await collectJPoint(client, login.mypageHtml)
        : {
            code: isObservedJPointProduct(login.mypageHtml)
              ? ("stopped" as const)
              : ("unsupported" as const),
            artifacts: [],
          };
    artifacts.push(...point.artifacts);
    const pointHistory =
      stop === undefined
        ? await collectJPointHistory(client, login.mypageHtml, point.artifacts)
        : {
            code: isObservedJPointProduct(login.mypageHtml)
              ? ("stopped" as const)
              : ("unsupported" as const),
            artifacts: [],
          };
    artifacts.push(...pointHistory.artifacts);

    const discovery = {
      schemaVersion: 1,
      bootstrapMode: options.credential.bootstrapMode,
      cards,
      periodCount,
      cookieCount: login.jar.count(),
      limitations: [
        "Root-card switching remains discovery-only until its relay responses and stable per-card identity are verified.",
        options.credential.bootstrapMode === "passkey"
          ? "Passkey bootstrap uses an imported Bitwarden credential with a zero signature counter."
          : "Passkey renewal remains human-operated; session bootstrap is short-lived.",
      ],
    };
    artifacts.push({
      dataset: "discovery",
      filename: "discovery.json",
      body: JSON.stringify(discovery),
      mediaType: "application/json",
    });
    return {
      summary: {
        ...(debitOtherCode === undefined ? {} : { debitOtherCode }),
        jpointCode: point.code,
        ...(pointHistory.code === "unsupported" ? {} : { jpointHistoryCode: pointHistory.code }),
        connectionId: options.credential.connectionId,
        bootstrapMode: options.credential.bootstrapMode,
        // A month whose rows are kept unread, or a stop that left months
        // unread, is missing from what this connection set out to collect,
        // so it is `partial`, never `success` (ADR 0026, INV05). Schedule
        // pages are not months: their outcome is recorded beside the months
        // and never decides the status (ADR 0005's amendment (c)).
        status: unreadMonths.length === 0 && stop === undefined ? "success" : "partial",
        cardCount: Math.max(cards.length, 1),
        periodCount,
        artifactCount: artifacts.length,
        ...(stop === undefined
          ? {}
          : {
              stopCode: stop.code,
              stopPosition: stop.position,
              capturedMonthCount: stop.capturedMonthCount,
            }),
        ...(unreadMonths.length === 0 ? {} : { unreadMonths }),
        ...(exportOffers.length === 0 ? {} : { exportOffers }),
        ...(documentResults === undefined || documentResults.length === 0
          ? {}
          : { documentResults }),
        ...(documentCode === undefined ? {} : { documentCode }),
        ...(schedulePages.length === 0
          ? {}
          : {
              schedulePages,
              schedulePageCount: schedulePages.filter(
                (page) => page.code === "scheduled_payments_page",
              ).length,
            }),
      },
      artifacts,
    };
  } finally {
    if (options.diagnostic) await options.diagnostic.step("browser-close", () => login.close());
    else await login.close();
  }
}

/**
 * Login and session restore: a person being needed stays
 * `HumanRequiredError`, a passkey stage keeps its own condition, and anything
 * else becomes the `login` condition, so every error that leaves
 * `collectConnection` names its stage.
 */
async function loginStage<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HumanRequiredError) throw error;
    if (error instanceof StopConditionError && error.code !== "unknown-upstream-state") throw error;
    throw Object.assign(new StopConditionError("MyJCB login stopped", "login"), {
      httpStatus: safeErrorDetails(error).httpStatus,
    });
  }
}

export function parseCredentials(value: string): MyJcbCredential[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("MYJCB_CONNECTIONS_JSON must be a JSON array");
  }
  return parseCredentialItems(parsed);
}

export function parseCredentialSecrets(values: readonly string[]): MyJcbCredential[] {
  const items: unknown[] = [];
  for (const value of values) {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) items.push(...parsed);
    else items.push(parsed);
  }
  return parseCredentialItems(items);
}

function parseCredentialItems(parsed: readonly unknown[]): MyJcbCredential[] {
  if (parsed.length === 0 || parsed.length > 16) {
    throw new Error("MYJCB_CONNECTIONS_JSON must contain 1 to 16 connections");
  }
  const ids = new Set<string>();
  return parsed.map((item, index) => {
    if (!isRecord(item)) throw new Error(`MyJCB connection ${index + 1} is malformed`);
    const connectionId = item.connectionId;
    const bootstrapMode = item.bootstrapMode;
    if (typeof connectionId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(connectionId)) {
      throw new Error(`MyJCB connection ${index + 1} has an invalid connectionId`);
    }
    if (ids.has(connectionId)) throw new Error("MyJCB connection IDs must be unique");
    ids.add(connectionId);
    if (bootstrapMode === "password") {
      const userId = item.userId;
      const password = item.password;
      if (typeof userId !== "string" || userId.trim() === "") {
        throw new Error(`MyJCB connection ${index + 1} is missing userId`);
      }
      if (typeof password !== "string" || password === "") {
        throw new Error(`MyJCB connection ${index + 1} is missing password`);
      }
      return { connectionId, bootstrapMode, userId, password };
    }
    if (bootstrapMode === "session") {
      const userAgent = item.userAgent;
      const cookies = item.cookies;
      if (typeof userAgent !== "string" || userAgent.trim() === "") {
        throw new Error(`MyJCB connection ${index + 1} is missing userAgent`);
      }
      if (!Array.isArray(cookies) || cookies.length === 0 || cookies.length > 100) {
        throw new Error(`MyJCB connection ${index + 1} has invalid session cookies`);
      }
      const normalizedCookies = cookies.map((cookie, cookieIndex) => {
        if (
          !isRecord(cookie) ||
          typeof cookie.name !== "string" ||
          typeof cookie.value !== "string"
        ) {
          throw new Error(`MyJCB connection ${index + 1} cookie ${cookieIndex + 1} is malformed`);
        }
        if (cookie.domain !== undefined && typeof cookie.domain !== "string") {
          throw new Error(`MyJCB connection ${index + 1} cookie domain is malformed`);
        }
        if (cookie.path !== undefined && typeof cookie.path !== "string") {
          throw new Error(`MyJCB connection ${index + 1} cookie path is malformed`);
        }
        if (cookie.secure !== undefined && typeof cookie.secure !== "boolean") {
          throw new Error(`MyJCB connection ${index + 1} cookie secure flag is malformed`);
        }
        if (cookie.expires !== undefined && typeof cookie.expires !== "number") {
          throw new Error(`MyJCB connection ${index + 1} cookie expiry is malformed`);
        }
        return {
          name: cookie.name,
          value: cookie.value,
          ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
          ...(cookie.path === undefined ? {} : { path: cookie.path }),
          ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
          ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
        };
      });
      return { connectionId, bootstrapMode, userAgent, cookies: normalizedCookies };
    }
    if (bootstrapMode === "passkey") {
      const credentialId = item.credentialId;
      const privateKey = item.privateKey;
      const rpId = item.rpId;
      const userHandle = item.userHandle;
      const counter = item.counter;
      const discoverable = item.discoverable;
      const userName = item.userName;
      const userDisplayName = item.userDisplayName;
      if (typeof credentialId !== "string" || !isBitwardenCredentialId(credentialId)) {
        throw new Error(`MyJCB connection ${index + 1} has an invalid passkey credentialId`);
      }
      if (typeof privateKey !== "string" || !isBase64Url(privateKey)) {
        throw new Error(`MyJCB connection ${index + 1} has an invalid passkey privateKey`);
      }
      if (rpId !== "my.jcb.co.jp" && rpId !== "jcb.co.jp") {
        throw new Error(`MyJCB connection ${index + 1} has an unexpected passkey rpId`);
      }
      if (typeof userHandle !== "string" || !isBase64Url(userHandle)) {
        throw new Error(`MyJCB connection ${index + 1} has an invalid passkey userHandle`);
      }
      if (counter !== 0) {
        throw new Error(`MyJCB connection ${index + 1} has a stateful passkey counter`);
      }
      if (discoverable !== true) {
        throw new Error(`MyJCB connection ${index + 1} passkey is not discoverable`);
      }
      if (userName !== undefined && typeof userName !== "string") {
        throw new Error(`MyJCB connection ${index + 1} passkey userName is malformed`);
      }
      if (userDisplayName !== undefined && typeof userDisplayName !== "string") {
        throw new Error(`MyJCB connection ${index + 1} passkey userDisplayName is malformed`);
      }
      return {
        connectionId,
        bootstrapMode,
        credentialId,
        privateKey,
        rpId,
        userHandle,
        counter,
        discoverable,
        ...(userName === undefined ? {} : { userName }),
        ...(userDisplayName === undefined ? {} : { userDisplayName }),
      };
    }
    throw new Error(`MyJCB connection ${index + 1} has an unsupported bootstrapMode`);
  });
}

function isBitwardenCredentialId(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) ||
    (value.startsWith("b64.") && isBase64Url(value.slice(4)))
  );
}

function isBase64Url(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
    atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
    return true;
  } catch {
    return false;
  }
}

async function restoreSession(credential: SessionCredential): Promise<{
  readonly jar: CookieJar;
  readonly userAgent: string;
  readonly mypageHtml: string;
  readonly close: () => Promise<void>;
}> {
  const jar = new CookieJar();
  jar.importBrowserCookies(credential.cookies, new URL(MYJCB_ORIGIN));
  const client = new MyJcbReadClient(jar, credential.userAgent);
  const response = await client.get("mypage");
  const html = decodeMyJcbHtml(response.body, response.contentType);
  if (!/(?:ログアウト|toHeaderUserLogout)/u.test(html)) {
    throw new Error(`Restored MyJCB session did not reach ${allowedUrl("mypage").pathname}`);
  }
  return { jar, userAgent: credential.userAgent, mypageHtml: html, close: async () => {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
