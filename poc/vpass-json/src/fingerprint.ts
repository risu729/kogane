import { Impit } from "impit";

const response = await new Impit({ browser: "chrome142" }).fetch(
  "https://tls.peet.ws/api/all",
);
if (!response.ok) throw new Error(`Fingerprint endpoint returned ${response.status}`);
const value: unknown = await response.json();

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

function recordAt(candidate: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(candidate)) return null;
  const nested = candidate[key];
  return isRecord(nested) ? nested : null;
}

const root = isRecord(value) ? value : {};
const tls = recordAt(root, "tls");
const http2 = recordAt(root, "http2");
const frames = Array.isArray(http2?.["sent_frames"]) ? http2["sent_frames"] : [];
const sentHeaderNames = frames
  .flatMap((frame) => {
    if (!isRecord(frame) || !Array.isArray(frame["headers"])) return [];
    return frame["headers"].filter((header): header is string => typeof header === "string");
  })
  .flatMap((header) => {
    const name = header.split(":")[0];
    return name ? [name] : [];
  });

console.log(
  JSON.stringify({
    httpVersion: root["http_version"],
    userAgent: root["user_agent"],
    tls: {
      ja3Hash: tls?.["ja3_hash"],
      ja4: tls?.["ja4"],
    },
    http2: {
      akamaiFingerprintHash: http2?.["akamai_fingerprint_hash"],
      akamaiFingerprint: http2?.["akamai_fingerprint"],
      sentHeaderNames,
    },
  }),
);
