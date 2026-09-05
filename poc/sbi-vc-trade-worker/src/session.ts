import type { GatewayMeta, SessionMaterial } from "./types";

const COOKIE_NAMES = [
  "vct_bff_sid",
  "JSESSIONID",
  "AWSALBAPP-0",
  "AWSALBAPP-1",
  "AWSALBAPP-2",
  "AWSALBAPP-3",
  "AWSALB",
  "AWSALBCORS",
] as const;

export function parseSession(value: unknown): SessionMaterial {
  if (!isRecord(value) || !isRecord(value.cookies) || typeof value.secureKey !== "string") {
    throw new Error("invalid_session_seed");
  }
  const cookies = value.cookies;
  const app = cookies.awsAlbApp;
  if (
    typeof cookies.vctBffSid !== "string" ||
    typeof cookies.jSessionId !== "string" ||
    typeof cookies.awsAlb !== "string" ||
    typeof cookies.awsAlbCors !== "string" ||
    !Array.isArray(app) ||
    app.length !== 4 ||
    !app.every((part) => typeof part === "string")
  ) {
    throw new Error("invalid_session_seed");
  }
  const parsed: SessionMaterial = {
    cookies: {
      vctBffSid: cookies.vctBffSid,
      jSessionId: cookies.jSessionId,
      awsAlbApp: [app[0]!, app[1]!, app[2]!, app[3]!],
      awsAlb: cookies.awsAlb,
      awsAlbCors: cookies.awsAlbCors,
    },
    secureKey: value.secureKey,
  };
  validateSession(parsed);
  return parsed;
}

export function cookieHeader(session: SessionMaterial): string {
  return [
    `vct_bff_sid=${session.cookies.vctBffSid}`,
    `JSESSIONID=${session.cookies.jSessionId}`,
    ...session.cookies.awsAlbApp.map((value, index) => `AWSALBAPP-${index}=${value}`),
    `AWSALB=${session.cookies.awsAlb}`,
    `AWSALBCORS=${session.cookies.awsAlbCors}`,
  ].join("; ");
}

export function applySessionUpdates(
  session: SessionMaterial,
  setCookieHeaders: readonly string[],
  meta: GatewayMeta,
): { session: SessionMaterial; updateCount: number } {
  const next = structuredClone(session);
  let updateCount = 0;
  for (const header of setCookieHeaders) {
    const firstPart = header.split(";", 1)[0];
    if (!firstPart) continue;
    const separator = firstPart.indexOf("=");
    if (separator <= 0) continue;
    const name = firstPart.slice(0, separator);
    const value = firstPart.slice(separator + 1);
    if (!value || !COOKIE_NAMES.some((candidate) => candidate === name)) continue;
    if (setCookie(next, name, value)) updateCount += 1;
  }
  if (typeof meta.secureKey === "string" && meta.secureKey && meta.secureKey !== next.secureKey) {
    next.secureKey = meta.secureKey;
    updateCount += 1;
  }
  validateSession(next);
  return { session: next, updateCount };
}

export function parseGatewayMeta(value: unknown): GatewayMeta {
  if (!isRecord(value) || !isRecord(value.meta) || typeof value.meta.status !== "string") {
    throw new Error("invalid_gateway_envelope");
  }
  return {
    status: value.meta.status,
    ...(typeof value.meta.secureKey === "string" ? { secureKey: value.meta.secureKey } : {}),
  };
}

function setCookie(session: SessionMaterial, name: string, value: string): boolean {
  switch (name) {
    case "vct_bff_sid":
      return replace(
        () => session.cookies.vctBffSid,
        (next) => {
          session.cookies.vctBffSid = next;
        },
        value,
      );
    case "JSESSIONID":
      return replace(
        () => session.cookies.jSessionId,
        (next) => {
          session.cookies.jSessionId = next;
        },
        value,
      );
    case "AWSALB":
      return replace(
        () => session.cookies.awsAlb,
        (next) => {
          session.cookies.awsAlb = next;
        },
        value,
      );
    case "AWSALBCORS":
      return replace(
        () => session.cookies.awsAlbCors,
        (next) => {
          session.cookies.awsAlbCors = next;
        },
        value,
      );
    default: {
      const match = /^AWSALBAPP-([0-3])$/u.exec(name);
      if (!match) return false;
      const index = Number(match[1]) as 0 | 1 | 2 | 3;
      if (session.cookies.awsAlbApp[index] === value) return false;
      session.cookies.awsAlbApp[index] = value;
      return true;
    }
  }
}

function replace(current: () => string, assign: (value: string) => void, value: string): boolean {
  if (current() === value) return false;
  assign(value);
  return true;
}

function validateSession(session: SessionMaterial): void {
  const values = [
    session.secureKey,
    session.cookies.vctBffSid,
    session.cookies.jSessionId,
    ...session.cookies.awsAlbApp,
    session.cookies.awsAlb,
    session.cookies.awsAlbCors,
  ];
  if (values.some((value) => !value || /[;\r\n]/u.test(value))) {
    throw new Error("invalid_session_seed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
