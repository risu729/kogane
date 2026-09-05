import { safeErrorDetails } from "../../collector-diagnostics/src/index";
import { decodeMyJcbHtml, MyJcbReadClient, type ReadResponse } from "./client";
import { CookieJar } from "./cookie-jar";
import { loginWithBitwardenPasskey, loginWithOfficialProtection } from "./login-protection";
import {
  discoverCreditExports,
  extractCreditMenuLinkId,
  extractGeneralJsonDiscriminator,
  parseCardInventory,
  parseCreditLedger,
  parseCreditMenuMonths,
  parsePastMonthAvailability,
  parseStatementPeriods,
  redactedStatementHtml,
} from "./parsers";
import { allowedUrl, MYJCB_ORIGIN } from "./policy";
import type {
  ConnectionSummary,
  MyJcbCredential,
  RawArtifact,
  SessionCredential,
} from "./types";
import { StopConditionError, type StopConditionCode } from "./types";

export interface ConnectionCollection {
  readonly summary: ConnectionSummary;
  readonly artifacts: readonly RawArtifact[];
}

export async function collectConnection(options: {
  diagnostic?: ReturnType<typeof import("../../collector-diagnostics/src/index").createDiagnostics>;
  browserBinding: BrowserRun;
  credential: MyJcbCredential;
}): Promise<ConnectionCollection> {
  const login = options.credential.bootstrapMode === "password"
    ? await loginWithOfficialProtection(options.browserBinding, options.credential)
    : options.credential.bootstrapMode === "passkey"
      ? await loginWithBitwardenPasskey(options.browserBinding, options.credential)
      : await restoreSession(options.credential);
  try {
    const cards = await collectionStage(
      "collect-discovery",
      async () => parseCardInventory(login.mypageHtml),
    );
    const client = new MyJcbReadClient(login.jar, login.userAgent);
    const artifacts: RawArtifact[] = [];
    let periodCount = 0;

    const creditLinkId = extractCreditMenuLinkId(login.mypageHtml);
    if (creditLinkId) {
      const credit = await collectionStage(
        "collect-credit",
        async () => await collectCredit(client, creditLinkId),
      );
      artifacts.push(...credit.artifacts);
      periodCount += credit.periodCount;
    }
    if (login.mypageHtml.includes("/iss-pc/member/debit/details/debitDetailMenu.html")) {
      const debit = await collectionStage(
        "collect-debit",
        async () => await collectDebit(client),
      );
      artifacts.push(...debit.artifacts);
      periodCount += debit.periodCount;
    }
    if (artifacts.length === 0) {
      throw new Error("MyJCB mypage exposed neither an allowlisted credit nor debit route");
    }

    const discovery = {
      schemaVersion: 1,
      bootstrapMode: options.credential.bootstrapMode,
      cards,
      periodCount,
      cookieCount: login.jar.count(),
      limitations: [
        "Root-card switching remains discovery-only until its current POST contract is observed.",
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
        connectionId: options.credential.connectionId,
        bootstrapMode: options.credential.bootstrapMode,
        status: "success",
        cardCount: Math.max(cards.length, 1),
        periodCount,
        artifactCount: artifacts.length,
      },
      artifacts,
    };
  } finally {
    if (options.diagnostic) await options.diagnostic.step("browser-close", () => login.close());
    else await login.close();
  }
}

async function collectionStage<T>(
  code: StopConditionCode,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof StopConditionError && error.code !== "unknown-upstream-state") throw error;
    throw Object.assign(new StopConditionError(`MyJCB collection stopped at ${code}`, code), { httpStatus: safeErrorDetails(error).httpStatus });
  }
}

async function collectDebit(client: MyJcbReadClient): Promise<{
  readonly periodCount: number;
  readonly artifacts: RawArtifact[];
}> {
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
    if (sequences.length === 0) {
      throw new Error("MyJCB debit menu did not enumerate statement sequences");
    }
    const artifacts: RawArtifact[] = [{
      dataset: "debit-menu",
      filename: "debit-menu.html",
      body: redactedStatementHtml(menuHtml),
      mediaType: "text/html; charset=utf-8",
      statementState: "debit",
    }];
    for (const sequence of sequences) {
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
    return { periodCount: sequences.length, artifacts };
}

async function collectCredit(
  client: MyJcbReadClient,
  linkId: string,
): Promise<{ readonly periodCount: number; readonly artifacts: RawArtifact[] }> {
  const { menuHtml, initialMonths } = await collectionStage("collect-credit-menu", async () => {
    const menu = await client.get(
      "credit-menu",
      new URLSearchParams({ link_id: linkId }),
    );
    const menuHtml = decodeMyJcbHtml(menu.body, menu.contentType);
    const initialMonths = parseCreditMenuMonths(menuHtml);
    if (initialMonths.length === 0) {
      throw new Error("MyJCB credit menu did not enumerate detailMonth values");
    }
    return { menuHtml, initialMonths };
  });
  const artifacts: RawArtifact[] = [{
    dataset: "credit-menu",
    filename: "credit-menu.html",
    body: redactedStatementHtml(menuHtml),
    mediaType: "text/html; charset=utf-8",
  }];

  const firstMonth = initialMonths[0];
  if (firstMonth === undefined) throw new Error("MyJCB credit menu was empty");
  const detailCache = new Map<number, ReadResponse>();
  const { firstDetail, discriminator } = await collectionStage(
    "collect-credit-first-detail",
    async () => {
      const firstDetail = await fetchCreditDetail(client, firstMonth);
      const firstHtml = decodeMyJcbHtml(firstDetail.body, firstDetail.contentType);
      return { firstDetail, discriminator: extractGeneralJsonDiscriminator(firstHtml) };
    },
  );
  detailCache.set(firstMonth, firstDetail);
  const { pastResponse, pastMonths } = await collectionStage("collect-credit-past-months", async () => {
    const pastResponse = await client.postCreditPastJson({
      generalJsonShikibetuId: discriminator,
      id: "030100601",
      detailMonth: firstMonth,
    });
    const pastJson = new TextDecoder("utf-8", { fatal: true }).decode(pastResponse.body);
    return { pastResponse, pastMonths: parsePastMonthAvailability(pastJson) };
  });
  artifacts.push({
    dataset: "credit-past-months",
    filename: "credit-past-months.json",
    body: pastResponse.body,
    mediaType: "application/json",
  });
  const availableMonths = [...new Set([
    ...initialMonths,
    ...pastMonths.filter((month) => month.available).map((month) => month.detailMonth),
  ])].sort((left, right) => left - right);

  for (const detailMonth of availableMonths) {
    try {
      const detail = await collectionStage(
        "collect-credit-month-fetch",
        async () => detailCache.get(detailMonth) ?? await fetchCreditDetail(client, detailMonth),
      );
      const { html, exports, ledger } = await collectionStage(
        "collect-credit-month-parse",
        async () => {
          const html = decodeMyJcbHtml(detail.body, detail.contentType);
          const exports = discoverCreditExports(html, detailMonth);
          const hasLedgerContainer = /\bdetail-list-01\b/u.test(html);
          const hasEmptyMarker = /(?:ご利用|明細)[^<>]{0,80}(?:ありません|ございません)/u
            .test(html);
          if (!hasLedgerContainer && hasEmptyMarker) {
            throw new Error("MyJCB credit detail exposed an inconsistent empty state");
          }
          const ledgerState = detailMonth <= 1 && exports.length === 0
            ? "unconfirmed"
            : "confirmed";
          const ledger = parseCreditLedger(
            html,
            ledgerState,
          );
          if (detailMonth === 0 && !ledger) {
            throw new Error("MyJCB unconfirmed detail page omitted .detail-list-01");
          }
          return { html, exports, ledger };
        },
      );
      const state = detailMonth === 0
        ? "unconfirmed"
        : ledger?.state === "unconfirmed"
          ? "unconfirmed"
          : ledger || exports.length > 0
          ? "confirmed"
          : "unknown";
      const period = pastMonths.find((month) => month.detailMonth === detailMonth)?.settlementYM ??
        `detailMonth-${detailMonth}`;
      artifacts.push({
        dataset: "credit-detail",
        filename: `credit-detail-${String(detailMonth).padStart(2, "0")}.html`,
        body: redactedStatementHtml(html),
        mediaType: "text/html; charset=utf-8",
        statementState: state,
        period,
      });
      if (ledger) {
        artifacts.push({
          dataset: "credit-ledger",
          filename: `credit-ledger-${String(detailMonth).padStart(2, "0")}.json`,
          body: JSON.stringify({ schemaVersion: 1, detailMonth, period, ...ledger }),
          mediaType: "application/json",
          statementState: state,
          period,
        });
      }
      for (const exportKind of exports) {
        artifacts.push(await collectionStage(
          "collect-credit-export",
          async () => await fetchCreditExport(client, detailMonth, period, exportKind),
        ));
      }
    } catch (error) {
      console.warn(JSON.stringify({
        event: "myjcb-credit-month-failed",
        detailMonth,
        code: error instanceof StopConditionError ? error.code : "collector-operation-failed",
      }));
      throw error;
    }
  }
  return { periodCount: availableMonths.length, artifacts };
}

async function fetchCreditDetail(
  client: MyJcbReadClient,
  detailMonth: number,
): Promise<ReadResponse> {
  return await client.get(
    "credit-detail",
    new URLSearchParams({ detailMonth: String(detailMonth), output: "web" }),
  );
}

async function fetchCreditExport(
  client: MyJcbReadClient,
  detailMonth: number,
  period: string,
  kind: "csv" | "pdf" | "ofx",
): Promise<RawArtifact> {
  const operation = kind === "csv" ? "credit-csv" : kind === "pdf" ? "credit-pdf" : "credit-ofx";
  const output = kind === "csv" ? "csv" : kind === "pdf" ? "pdf" : "money";
  const response = await client.get(
    operation,
    new URLSearchParams({ detailMonth: String(detailMonth), output }),
  );
  validateCreditExport(kind, response.body);
  const mediaType = kind === "csv"
    ? "text/csv; charset=windows-31j"
    : kind === "pdf"
      ? "application/pdf"
      : "application/x-ofx";
  return {
    dataset: `credit-${kind}`,
    filename: `credit-${String(detailMonth).padStart(2, "0")}.${kind}`,
    body: response.body,
    mediaType,
    statementState: "confirmed",
    period,
  };
}

function validateCreditExport(kind: "csv" | "pdf" | "ofx", body: ArrayBuffer): void {
  const bytes = new Uint8Array(body);
  if (kind === "pdf") {
    const header = new TextDecoder("ascii").decode(bytes.slice(0, 8));
    if (!header.startsWith("%PDF-")) throw new Error("MyJCB PDF export had an invalid signature");
    return;
  }
  if (kind === "ofx") {
    const header = new TextDecoder("ascii").decode(bytes.slice(0, 256));
    if (!/(?:OFXHEADER:|<OFX>)/u.test(header)) {
      throw new Error("MyJCB OFX export had an invalid header");
    }
    return;
  }
  const csv = new TextDecoder("shift_jis", { fatal: true }).decode(body);
  validateCreditCsvText(csv);
}

export function validateCreditCsvText(csv: string): void {
  const expectedHeaders = [
    "ご利用者",
    "カテゴリ",
    "ご利用日",
    "ご利用先など",
    "ご利用金額(￥)",
    "支払区分",
    "今回回数",
    "訂正サイン",
    "お支払い金額(￥)",
    "国内／海外",
    "摘要",
    "備考",
  ];
  const foundHeader = csv.split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .some((line) => csvColumns(line).join("\0") === expectedHeaders.join("\0"));
  if (!foundHeader) {
    throw new Error("MyJCB CSV export had an unknown 12-column schema");
  }
}

function csvColumns(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        value += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("MyJCB CSV export contained an unterminated quote");
  values.push(value);
  return values;
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
    .test(value) || (value.startsWith("b64.") && isBase64Url(value.slice(4)));
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
