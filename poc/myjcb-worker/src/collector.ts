import { decodeMyJcbHtml, MyJcbReadClient } from "./client";
import { CookieJar } from "./cookie-jar";
import { loginWithOfficialProtection } from "./login-protection";
import { parseCardInventory, parseStatementPeriods, redactedStatementHtml } from "./parsers";
import { allowedUrl, MYJCB_ORIGIN } from "./policy";
import type {
  ConnectionSummary,
  MyJcbCredential,
  RawArtifact,
  SessionCredential,
} from "./types";

export interface ConnectionCollection {
  readonly summary: ConnectionSummary;
  readonly artifacts: readonly RawArtifact[];
}

export async function collectConnection(options: {
  browserBinding: BrowserRun;
  credential: MyJcbCredential;
}): Promise<ConnectionCollection> {
  const login = options.credential.bootstrapMode === "password"
    ? await loginWithOfficialProtection(options.browserBinding, options.credential)
    : await restoreSession(options.credential);
  try {
    const cards = parseCardInventory(login.mypageHtml);
    const client = new MyJcbReadClient(login.jar, login.userAgent);
    const menu = await client.get(
      "debit-menu",
      new URLSearchParams({ link_id: "myj_main_debitDetailMenu" }),
    );
    const menuHtml = decodeMyJcbHtml(menu.body, menu.contentType);
    const periods = parseStatementPeriods(menuHtml);
    const sequences = periods
      .flatMap((period) => period.sequence === undefined ? [] : [period.sequence])
      .filter((value, index, values) => values.indexOf(value) === index)
      .sort((left, right) => left - right);
    const effectiveSequences = sequences.length > 0
      ? sequences
      : Array.from({ length: 15 }, (_, index) => index);
    const artifacts: RawArtifact[] = [{
      dataset: "debit-menu",
      filename: "debit-menu.html",
      body: redactedStatementHtml(menuHtml),
      mediaType: "text/html; charset=utf-8",
      statementState: "debit",
    }];
    for (const sequence of effectiveSequences) {
      const detail = await client.get(
        "debit-detail",
        new URLSearchParams({ seq: String(sequence) }),
      );
      const detailHtml = decodeMyJcbHtml(detail.body, detail.contentType);
      artifacts.push({
        dataset: "debit-detail",
        filename: `debit-detail-${String(sequence).padStart(2, "0")}.html`,
        body: redactedStatementHtml(detailHtml),
        mediaType: "text/html; charset=utf-8",
        statementState: "debit",
        period: periods.find((period) => period.sequence === sequence)?.label ?? `seq-${sequence}`,
      });
    }
    const discovery = {
      schemaVersion: 1,
      cards,
      periods,
      cookieNames: login.jar.names(),
      limitations: [
        "Root-card switching is discovery-only until its current POST contract is observed.",
        "Credit confirmed/unconfirmed and CSV/PDF/OFX routes are disabled until live read-only observation.",
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
        connectionId: options.credential.connectionId,
        bootstrapMode: options.credential.bootstrapMode,
        status: "success",
        cardCount: Math.max(cards.length, 1),
        periodCount: effectiveSequences.length,
        artifactCount: artifacts.length,
      },
      artifacts,
    };
  } finally {
    await login.close();
  }
}

export function parseCredentials(value: string): MyJcbCredential[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 16) {
    throw new Error("MYJCB_CONNECTIONS_JSON must contain 1 to 16 connections");
  }
  const ids = new Set<string>();
  return parsed.map((item, index) => {
    if (!isRecord(item)) throw new Error(`MyJCB connection ${index + 1} is malformed`);
    const connectionId = item.connectionId;
    const bootstrapMode = item.bootstrapMode;
    if (
      typeof connectionId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(connectionId)
    ) {
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
        if (!isRecord(cookie) || typeof cookie.name !== "string" || typeof cookie.value !== "string") {
          throw new Error(
            `MyJCB connection ${index + 1} cookie ${cookieIndex + 1} is malformed`,
          );
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
    throw new Error(`MyJCB connection ${index + 1} has an unsupported bootstrapMode`);
  });
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
