import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  logFailure,
  MoneyForwardHttpError,
  MoneyForwardProtocolError,
  safeFailure,
} from "../src/diagnostics";
import { collectMoneyForward } from "../src/moneyforward";
import { persistSharedRun } from "../src/shared-collection";
import { runSharedCollection } from "../src/worker";
import type { MoneyForwardCredential } from "../src/types";

afterEach(() => mock.restore());
const PRIVATE = "private-body-token-cookie-email-account-id";
const credential: MoneyForwardCredential = {
  rpId: "id.moneyforward.com",
  origin: "https://id.moneyforward.com",
  credentialId: "00112233-4455-6677-8899-aabbccddeeff",
  keyValue: "test-only",
  counter: 0,
};
function captureLogs() {
  const lines: string[] = [];
  spyOn(console, "log").mockImplementation((line) => {
    lines.push(String(line));
  });
  spyOn(console, "error").mockImplementation((line) => {
    lines.push(String(line));
  });
  return lines;
}
function fixture(secret: string, data: FakeR2Bucket) {
  return Object.assign({} as Env, {
    MONEYFORWARD_CREDENTIAL_JSON: secret,
    COLLECTOR_SCHEMA_VERSION: "test",
    DATA: data,
  });
}

describe("Money Forward safe stage diagnostics", () => {
  test("unknown or hostile errors cannot disclose data or break diagnostics", () => {
    const error = Object.assign(new Error(PRIVATE), { name: PRIVATE, status: 503 });
    expect(safeFailure(error)).toEqual({
      errorType: "UnknownError",
      failureCode: "operation_failed",
    });
    const hostile = new MoneyForwardHttpError(503);
    Object.defineProperty(hostile, "status", {
      get() {
        throw new Error(PRIVATE);
      },
    });
    expect(safeFailure(hostile)).toEqual({
      errorType: "UnknownError",
      failureCode: "operation_failed",
    });
    spyOn(console, "error").mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    expect(logFailure("test-run", "passkey-options", error).errorType).toBe("UnknownError");
  });

  test("passkey options HTTP failure preserves stage and status but never body or token", async () => {
    const stages: string[] = [];
    try {
      await collectMoneyForward({
        credential,
        onStage: (stage) => {
          stages.push(stage);
        },
        fetcher: async (input) =>
          String(input).endsWith("/sign_in")
            ? new Response(`<meta name="csrf-token" content="${PRIVATE}">`)
            : new Response(PRIVATE, { status: 503 }),
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(stages).toEqual(["login-entry", "passkey-options"]);
      expect(safeFailure(error)).toEqual({
        errorType: "MoneyForwardHttpError",
        failureCode: "provider_http_failed",
        httpStatus: 503,
      });
      expect(JSON.stringify(safeFailure(error))).not.toContain(PRIVATE);
    }
  });

  test("redirect limit failure omits response-controlled paths and cookie names", async () => {
    try {
      await collectMoneyForward({
        credential,
        fetcher: async () =>
          new Response(null, {
            status: 302,
            headers: {
              location: `https://id.moneyforward.com/${PRIVATE}`,
              "set-cookie": `${PRIVATE}=value; Secure; Path=/`,
            },
          }),
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(safeFailure(error)).toMatchObject({
        failureCode: "provider_protocol_failed",
        reasonCode: "redirect-limit",
      });
      expect(String(error)).not.toContain(PRIVATE);
    }
  });

  test("broken stage callback does not prevent provider requests", async () => {
    let calls = 0;
    await expect(
      collectMoneyForward({
        credential,
        onStage: () => {
          throw new Error("logger failed");
        },
        fetcher: async () => {
          calls++;
          return new Response(PRIVATE, { status: 503 });
        },
      }),
    ).rejects.toThrow("Money Forward");
    expect(calls).toBe(1);
  });

  test("configuration failure still records a failed shared terminal when logging fails", async () => {
    const data = new FakeR2Bucket();
    spyOn(console, "log").mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    spyOn(console, "error").mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    const response = await runSharedCollection(fixture(PRIVATE, data));
    expect(response.status).not.toBe("success");
    const result = response as { terminalKey: string; persistence: string };
    expect(result.persistence).toBe("persisted");
    const terminal = data.entries.get(result.terminalKey);
    expect(JSON.parse(new TextDecoder().decode(terminal!.bytes)).providerOutcome).toBe("failed");
    const contents = [...data.entries.values()]
      .map((e) => new TextDecoder().decode(e.bytes))
      .join("\n");
    expect(contents).toContain("collector_failed");
    expect(contents).not.toContain(PRIVATE);
  });

  test("failed shared upload publishes no terminal and keeps diagnostics safe", async () => {
    const logs = captureLogs();
    const data = new FakeR2Bucket({
      beforePut: () => {
        throw new Error(PRIVATE);
      },
    });
    const response = await runSharedCollection(fixture(PRIVATE, data));
    expect(response.status).not.toBe("success");
    const result = response as { persistence: string };
    expect(result.persistence).toBe("incomplete");
    expect([...data.entries.keys()].some((key) => key.endsWith("/terminal.json"))).toBe(false);
    expect(logs.join()).not.toContain(PRIVATE);
  });
});

describe("diagnostics snapshot error properties once", () => {
  test("stateful allowed-first name, status and reason getters never leak later values", () => {
    let nameReads = 0;
    const generic = new Error(PRIVATE);
    Object.defineProperty(generic, "name", { get: () => (++nameReads === 1 ? "Error" : PRIVATE) });
    expect(safeFailure(generic)).toEqual({ errorType: "Error", failureCode: "operation_failed" });
    expect(nameReads).toBe(1);

    let statusReads = 0;
    let reasonReads = 0;
    const protocol = new MoneyForwardProtocolError("invalid-response", 503);
    Object.defineProperty(protocol, "status", { get: () => (++statusReads === 1 ? 503 : PRIVATE) });
    Object.defineProperty(protocol, "reasonCode", {
      get: () => (++reasonReads === 1 ? "invalid-response" : PRIVATE),
    });
    const detail = safeFailure(protocol);
    expect(detail).toEqual({
      errorType: "MoneyForwardProtocolError",
      failureCode: "provider_protocol_failed",
      httpStatus: 503,
      reasonCode: "invalid-response",
    });
    expect(statusReads).toBe(1);
    expect(reasonReads).toBe(1);
    expect(JSON.stringify(detail)).not.toContain(PRIVATE);
  });
});

// INV05: a run that did not finish its collection never learned how many
// account details and monthly fragments there were, so its result and its
// stored manifest leave both counts out instead of reporting 0. A finished
// run reports what it read, including a known 0 for an empty account list.
// The provider is a synthetic `fetch`; nothing leaves the test.
describe("Money Forward run counts are reported only when the collection finished", () => {
  const COUNT_FIELDS = ["accountDetailCount", "monthlyFragmentCount"] as const;

  async function syntheticProvider(accounts: readonly string[], failingRoute?: string) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const passkey: MoneyForwardCredential = {
      ...credential,
      keyValue: Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
        "base64url",
      ),
    };
    const csrf = '<meta name="csrf-token" content="synthetic-csrf">';
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const route = `${url.hostname}${url.pathname}`;
      if (failingRoute !== undefined && route.startsWith(failingRoute))
        return new Response(PRIVATE, { status: 503 });
      if (route === "id.moneyforward.com/sign_in") return new Response(csrf);
      if (route === "id.moneyforward.com/webauthn/assertion/options")
        return Response.json({ challenge: "synthetic-challenge" });
      if (route === "id.moneyforward.com/webauthn/assertion")
        return Response.json({ redirectPath: "/me" });
      if (route === "id.moneyforward.com/me") return new Response("<html></html>");
      if (route === "moneyforward.com/accounts")
        return new Response(
          `<a href="/sign_out">out</a>${accounts.map((hash) => `<a href="/accounts/show/${hash}">x</a>`).join("")}`,
        );
      if (route.startsWith("moneyforward.com/accounts/show/")) {
        const hash = url.pathname.slice("/accounts/show/".length);
        return new Response(
          `${csrf}<input name="account[id_hash]" value="${hash}"><input name="service[id]" value="1">`,
        );
      }
      if (route === "moneyforward.com/cf/fetch") return new Response("<table></table>");
      return new Response("unexpected", { status: 404 });
    }) as typeof fetch);
    return JSON.stringify(passkey);
  }

  async function storedManifest(data: FakeR2Bucket, terminalKey: string) {
    const terminal = JSON.parse(new TextDecoder().decode(data.entries.get(terminalKey)!.bytes)) as {
      artifacts: { artifactKey: string; storageRef: { key: string } }[];
    };
    const entry = terminal.artifacts.find((artifact) => artifact.artifactKey === "manifest.json");
    if (entry === undefined) return undefined;
    return JSON.parse(new TextDecoder().decode(data.entries.get(entry.storageRef.key)!.bytes));
  }

  for (const [label, accounts, counts] of [
    ["two accounts", ["hash-a", "hash-b"], { accountDetailCount: 2, monthlyFragmentCount: 24 }],
    ["no account", [], { accountDetailCount: 0, monthlyFragmentCount: 0 }],
  ] as const) {
    test(`a finished run reports its counts (${label})`, async () => {
      captureLogs();
      const data = new FakeR2Bucket();
      const result = await runSharedCollection(fixture(await syntheticProvider(accounts), data));
      expect(result.status).toBe("success");
      expect(result).toMatchObject(counts);
      expect(await storedManifest(data, result.terminalKey)).toMatchObject(counts);
    });
  }

  for (const [label, failingRoute] of [
    ["the passkey options", "id.moneyforward.com/webauthn/assertion/options"],
    ["an account detail", "moneyforward.com/accounts/show/"],
    ["a monthly fragment", "moneyforward.com/cf/fetch"],
  ] as const) {
    test(`a run stopped at ${label} leaves both counts out`, async () => {
      const logs = captureLogs();
      const data = new FakeR2Bucket();
      const secret = await syntheticProvider(["hash-a", "hash-b"], failingRoute);
      const result = await runSharedCollection(fixture(secret, data));
      expect(result.status).toBe("failed");
      expect(result.failureCount).toBe(1);
      expect(result.persistence).toBe("persisted");
      for (const field of COUNT_FIELDS) expect(Object.hasOwn(result, field)).toBe(false);
      // A failed run keeps no artifact, so no manifest carries a count either.
      expect(await storedManifest(data, result.terminalKey)).toBeUndefined();
      expect(logs.join()).not.toContain(PRIVATE);
    });
  }

  test("a run with no credential leaves both counts out", async () => {
    captureLogs();
    const fetch = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("unexpected fetch");
    }) as unknown as typeof globalThis.fetch);
    const result = await runSharedCollection(
      Object.assign({} as Env, { COLLECTOR_SCHEMA_VERSION: "test", DATA: new FakeR2Bucket() }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    for (const field of COUNT_FIELDS) expect(Object.hasOwn(result, field)).toBe(false);
  });

  test("a successful input without its account count derives no identity", async () => {
    const data = new FakeR2Bucket();
    const outcome = await persistSharedRun(data, {
      schemaVersion: "test",
      runId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      startedAt: "2026-09-11T21:15:00.000Z",
      completedAt: "2026-09-11T21:17:00.000Z",
      status: "success",
      artifacts: [
        {
          dataset: "accounts-index",
          filename: "accounts.html",
          mediaType: "text/html; charset=utf-8",
          body: "<html>synthetic index</html>",
        },
      ],
      failures: [],
    });
    expect(outcome.identity).toBe("identity_incomplete");
    const manifest = await storedManifest(data, outcome.result.terminalKey);
    for (const field of COUNT_FIELDS) expect(Object.hasOwn(manifest, field)).toBe(false);
  });
});
