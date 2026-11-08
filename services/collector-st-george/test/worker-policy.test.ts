import { describe, expect, test, spyOn } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  CollectionCoordinator,
  REQUESTED_LOGIN_SPACING_MS,
  authorized,
  blocksLaterLogins,
  credentialDigest,
  parseCollectionOutput,
  parseCredential,
  type StateStorage,
} from "../src/worker-policy";
import { persistSharedRun } from "../src/shared-collection";
import { snapshot } from "./fixture";
import { RUN_STAGES, type RunDiagnostic } from "../src/run-diagnostic";

const loginDiagnostic = (loginPostCount: 0 | 1 | 2, stage = "login-state"): RunDiagnostic => ({
  stage,
  errorType: "CollectionError",
  refusal: "unknown",
  loginPostCount,
  durationMs: 1,
  notices: [],
});

class Storage implements StateStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async transaction<T>(closure: (storage: StateStorage) => Promise<T>): Promise<T> {
    const before = structuredClone(this.values);
    try {
      return await closure(this);
    } catch (error) {
      this.values = before;
      throw error;
    }
  }
}
describe("durable collection policy", () => {
  test("ambiguous bank failures pause only after an observed login POST or without a diagnostic", async () => {
    for (const reason of ["http-denied", "bank-request-error", "unexpected-route"] as const) {
      for (const count of [0, 1, 2, undefined] as const) {
        const state = new Storage();
        const bucket = new FakeR2Bucket();
        let reads = 0;
        let digests = 0;
        const create = () =>
          new CollectionCoordinator(
            state,
            async () => {
              reads++;
              return {
                status: "failed",
                reason,
                ...(count === undefined ? {} : { diagnostic: loginDiagnostic(count) }),
              };
            },
            (run) => persistSharedRun(bucket, run),
            async () => {
              digests++;
              return "unchanged";
            },
          );
        expect(await create().trigger()).toMatchObject({
          status: count === 0 ? "failed" : "blocked",
          reason,
        });
        if (count === 0) {
          expect(state.values.get("state")).toBeUndefined();
          expect(digests).toBe(0);
        }
        expect(await create().trigger()).toMatchObject({
          status: count === 0 ? "failed" : "paused",
          reason,
        });
        expect(reads).toBe(count === 0 ? 2 : 1);
      }
    }
  });
  test("explicit refusal and challenge codes pause regardless of the observed POST count", async () => {
    for (const reason of [
      "login-rejected",
      "authentication-challenge",
      "human-required",
    ] as const) {
      for (const count of [0, 1, 2] as const) {
        const state = new Storage();
        const bucket = new FakeR2Bucket();
        let reads = 0;
        const coordinator = new CollectionCoordinator(
          state,
          async () => {
            reads++;
            return { status: "failed", reason, diagnostic: loginDiagnostic(count) };
          },
          (run) => persistSharedRun(bucket, run),
        );
        expect(await coordinator.trigger()).toMatchObject({ status: "blocked", reason });
        expect(await coordinator.trigger()).toMatchObject({ status: "paused", reason });
        expect(reads).toBe(1);
      }
    }
  });
  test("a zero POST count only makes a failure retryable before the login click", () => {
    const preSubmit = [
      "request-validation",
      "profile-create",
      "relay-start",
      "display-start",
      "browser-start",
      "browser-ready",
      "browser-connect",
      "extractor-load",
      "login-navigate",
      "login-state",
      "login-form",
      "credential-user-id",
      "credential-security-number",
      "credential-password",
      "login-pre-submit-state",
    ];
    for (const stage of preSubmit) expect(RUN_STAGES.has(stage)).toBe(true);
    for (const reason of ["http-denied", "bank-request-error", "unexpected-route"] as const) {
      for (const stage of RUN_STAGES) {
        // The click and everything after it (and an unknown stage) may have sent the
        // credential by a route the exact-URL POST count does not see.
        expect(blocksLaterLogins(reason, loginDiagnostic(0, stage))).toBe(
          !preSubmit.includes(stage),
        );
        expect(blocksLaterLogins(reason, loginDiagnostic(1, stage))).toBe(true);
      }
    }
  });
  test("an invalid zero-POST diagnostic cannot make an ambiguous failure retryable", async () => {
    const state = new Storage();
    const bucket = new FakeR2Bucket();
    const coordinator = new CollectionCoordinator(
      state,
      async () => ({
        status: "failed",
        reason: "http-denied",
        diagnostic: { ...loginDiagnostic(0), stage: "private-invalid-stage" },
      }),
      (run) => persistSharedRun(bucket, run),
    );
    expect(await coordinator.trigger()).toMatchObject({ status: "blocked", reason: "http-denied" });
    expect(await coordinator.trigger()).toMatchObject({ status: "paused", reason: "http-denied" });
  });
  test("a persistence retry retains the zero-POST diagnostic without contacting the bank again", async () => {
    const state = new Storage();
    const bucket = new FakeR2Bucket();
    let reads = 0;
    let outage = true;
    const create = () =>
      new CollectionCoordinator(
        state,
        async () => {
          reads++;
          return { status: "failed", reason: "http-denied", diagnostic: loginDiagnostic(0) };
        },
        (run) => {
          if (outage) throw new Error("synthetic persistence outage");
          return persistSharedRun(bucket, run);
        },
      );
    expect(await create().trigger()).toMatchObject({
      status: "failed",
      reason: "persistence-incomplete",
    });
    outage = false;
    expect(await create().trigger()).toMatchObject({ status: "failed", reason: "http-denied" });
    expect(reads).toBe(1);
    expect(state.values.get("state")).toBeUndefined();
    expect(await create().trigger()).toMatchObject({ status: "failed", reason: "http-denied" });
    expect(reads).toBe(2);
  });
  test("legacy blocked state has no invented run id and never starts a bank request", async () => {
    const state = new Storage();
    await state.put("state", { kind: "blocked", reason: "login-rejected" });
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        throw new Error("must not call provider");
      },
      async () => {
        throw new Error("must not persist");
      },
    );
    expect(await coordinator.trigger()).toEqual({ status: "paused", reason: "login-rejected" });
  });
  test("an R2 outage retries a large captured snapshot after restart without another bank request", async () => {
    const state = new Storage();
    const bucket = new FakeR2Bucket();
    const financial = snapshot();
    financial.accounts[0]!.transactions = Array.from({ length: 200 }, () => ({
      ...financial.accounts[0]!.transactions[0]!,
      description: "Synthetic purchase ".repeat(40),
    }));
    expect(new TextEncoder().encode(JSON.stringify(financial)).length).toBeGreaterThan(128 * 1024);
    let reads = 0;
    let outage = true;
    const collect = async () => {
      reads++;
      return { status: "success" as const, snapshot: financial };
    };
    const persist = async (run: Parameters<typeof persistSharedRun>[1]) => {
      if (outage) throw new Error("synthetic storage outage");
      return persistSharedRun(bucket, run);
    };
    const first = new CollectionCoordinator(state, collect, persist);
    expect(await first.trigger()).toMatchObject({
      status: "failed",
      reason: "persistence-incomplete",
    });
    const chunks = [...state.values.values()].filter(
      (value): value is Uint8Array => value instanceof Uint8Array,
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.byteLength <= 64 * 1024)).toBe(true);
    outage = false;
    const restarted = new CollectionCoordinator(state, collect, persist);
    expect(await restarted.trigger()).toMatchObject({ status: "stored" });
    expect(reads).toBe(1);
    expect(state.values.size).toBe(0);
  });
  test("a refused, challenged or unrecognised login pauses later logins; a requested collection tries one", async () => {
    for (const reason of [
      "login-rejected",
      "authentication-challenge",
      "human-required",
      "http-denied",
      "bank-request-error",
      "unexpected-route",
    ] as const) {
      const state = new Storage();
      const bucket = new FakeR2Bucket();
      let reads = 0;
      let clock = Date.parse("2026-11-08T00:00:00.000Z");
      const create = () =>
        new CollectionCoordinator(
          state,
          async () => {
            reads++;
            return { status: "failed", reason };
          },
          (run) => persistSharedRun(bucket, run),
          async () => "unchanged",
          () => clock,
        );
      const first = await create().trigger();
      expect(first).toMatchObject({ status: "blocked", reason });
      expect(first.runId).toBeString();
      const restarted = create();
      // The alarm never lifts a pause.
      expect(await restarted.trigger()).toEqual({ status: "paused", reason, runId: first.runId! });
      expect(reads).toBe(1);
      // A requested collection tries exactly one login; a second refusal pauses again.
      expect(await restarted.trigger({ operatorRequested: true })).toMatchObject({
        status: "blocked",
        reason,
      });
      expect(reads).toBe(2);
      // Another request within 24 hours does not log in again, whoever sends it.
      clock += REQUESTED_LOGIN_SPACING_MS - 1;
      expect(await restarted.trigger({ operatorRequested: true })).toMatchObject({
        status: "paused",
        reason,
      });
      expect(reads).toBe(2);
      clock += 1;
      await restarted.trigger({ operatorRequested: true });
      expect(reads).toBe(3);
    }
  });
  test("a changed credential lifts the pause by itself; an unreadable one does not", async () => {
    const state = new Storage();
    let credential: string | null = "first";
    let reads = 0;
    let outcome: "failed" | "success" = "failed";
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        reads++;
        return outcome === "failed"
          ? { status: "failed", reason: "login-rejected" }
          : { status: "success", snapshot: snapshot() };
      },
      (run) => persistSharedRun(new FakeR2Bucket(), run),
      async (salt) => (credential === null ? null : `${credential}:${salt}`),
    );
    expect(await coordinator.trigger()).toMatchObject({ status: "blocked" });
    const paused = state.values.get("state") as { credential?: { salt: string; hash: string } };
    expect(paused.credential?.salt).toBeString();
    expect(paused.credential?.hash).toBe(`first:${paused.credential!.salt}`);
    expect(await coordinator.trigger()).toMatchObject({ status: "paused" });
    credential = null;
    expect(await coordinator.trigger()).toMatchObject({ status: "paused" });
    expect(reads).toBe(1);
    credential = "second";
    outcome = "success";
    expect(await coordinator.trigger()).toMatchObject({ status: "stored" });
    expect(reads).toBe(2);
    // The digest is gone with the pause.
    expect(state.values.size).toBe(0);
  });
  test("the credential digest reads the parsed fields, not the JSON spelling", async () => {
    const salt = btoa("synthetic-salt-0");
    const a = await credentialDigest({ userId: "u", securityNumber: "1", password: "p" }, salt);
    expect(a).toBe(
      await credentialDigest(
        parseCredential('{"userId":"u","securityNumber":"1","password":"p"}'),
        salt,
      ),
    );
    expect(a).toBe(
      await credentialDigest(
        parseCredential('{ "password": "p",\n  "securityNumber": "1", "userId": "u" }\n'),
        salt,
      ),
    );
    expect(a).not.toBe(
      await credentialDigest({ userId: "u", securityNumber: "1", password: "q" }, salt),
    );
    expect(a).not.toBe(
      await credentialDigest(
        { userId: "u", securityNumber: "1", password: "p" },
        btoa("synthetic-salt-1"),
      ),
    );
    // A base64 SHA-256 output: nothing of the credential is kept in it.
    expect(a).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(a).not.toContain("SYNTHETIC_SECRET_PASSWORD");
    expect(
      await credentialDigest(
        { userId: "u", securityNumber: "1", password: "SYNTHETIC_SECRET_PASSWORD" },
        salt,
      ),
    ).not.toContain("SYNTHETIC_SECRET_PASSWORD");
  });
  test("a refused run persisted late keeps the digest of the credential it sent", async () => {
    const state = new Storage();
    let credential = "old";
    let outage = true;
    let reads = 0;
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        reads++;
        return { status: "failed", reason: "login-rejected" };
      },
      async (run) => {
        if (outage) throw new Error("synthetic storage outage");
        return persistSharedRun(new FakeR2Bucket(), run);
      },
      async (salt) => `${credential}:${salt}`,
    );
    expect(await coordinator.trigger()).toMatchObject({ reason: "persistence-incomplete" });
    // The owner rotates the secret before the refused run is stored.
    credential = "new";
    outage = false;
    expect(await coordinator.trigger()).toMatchObject({ status: "blocked" });
    const paused = state.values.get("state") as { credential?: { salt: string; hash: string } };
    expect(paused.credential?.hash).toBe(`old:${paused.credential!.salt}`);
    // So the new credential is tried by the next alarm, with no request.
    expect(await coordinator.trigger()).toMatchObject({ status: "blocked" });
    expect(reads).toBe(2);
  });
  test("a requested lift refused by the lease keeps the pause and the day's request", async () => {
    const state = new Storage();
    let busy = false;
    let reads = 0;
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        if (busy) throw new Error("collection_busy_or_uncertain");
        reads++;
        return { status: "failed", reason: "login-rejected" };
      },
      (run) => persistSharedRun(new FakeR2Bucket(), run),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await coordinator.trigger()).toMatchObject({ status: "blocked" });
      const pause = state.values.get("state");
      busy = true;
      expect(await coordinator.trigger({ operatorRequested: true })).toEqual({ status: "busy" });
      expect(state.values.get("state")).toEqual(pause);
      expect(state.values.has("requestedLoginAt")).toBe(false);
      // The alarm still does not log in; a later request still can.
      busy = false;
      expect(await coordinator.trigger()).toMatchObject({ status: "paused" });
      expect(reads).toBe(1);
      expect(await coordinator.trigger({ operatorRequested: true })).toMatchObject({
        status: "blocked",
      });
      expect(reads).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
  test("a legacy login block is lifted by one requested collection", async () => {
    const state = new Storage();
    await state.put("state", { kind: "blocked", reason: "login-rejected", runId: "legacy" });
    let reads = 0;
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        reads++;
        return { status: "success", snapshot: snapshot() };
      },
      (run) => persistSharedRun(new FakeR2Bucket(), run),
    );
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await coordinator.trigger()).toMatchObject({ status: "paused", runId: "legacy" });
      expect(await coordinator.trigger({ operatorRequested: true })).toMatchObject({
        status: "stored",
      });
      expect(reads).toBe(1);
      expect(state.values.get("state")).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
  test("a pause and every skipped run log which run paused, since when and what lifts it", async () => {
    const state = new Storage();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const coordinator = new CollectionCoordinator(
        state,
        async () => ({ status: "failed", reason: "login-rejected" }),
        (run) => persistSharedRun(new FakeR2Bucket(), run),
      );
      const first = await coordinator.trigger();
      await coordinator.trigger();
      await coordinator.trigger({ operatorRequested: true });
      const events = warn.mock.calls.map(([line]) => JSON.parse(line as string));
      const paused = {
        event: "st-george-collection-paused",
        reason: "login-rejected",
        pausedRunId: first.runId,
        pausedSince: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        liftedBy: "credential-change-or-requested-collection",
      };
      expect(events.slice(0, 3)).toEqual([
        paused,
        {
          event: "st-george-collection-skipped-paused",
          reason: "login-rejected",
          pausedRunId: first.runId,
          pausedSince: events[0].pausedSince,
          liftedBy: "credential-change-or-requested-collection",
        },
        {
          event: "st-george-pause-lifted",
          reason: "login-rejected",
          pausedRunId: first.runId,
          cause: "requested-collection",
        },
      ]);
      expect(events[3]).toMatchObject({ event: "st-george-collection-paused" });
    } finally {
      warn.mockRestore();
    }
  });
  test("lifting a block of the older policy is logged with its reason", async () => {
    const state = new Storage();
    await state.put("state", { kind: "blocked", reason: "runtime-failed" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await new CollectionCoordinator(
        state,
        async () => ({ status: "success", snapshot: snapshot() }),
        (run) => persistSharedRun(new FakeR2Bucket(), run),
      ).trigger();
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
        event: "st-george-pause-lifted",
        reason: "runtime-failed",
        pausedRunId: null,
        cause: "not-a-login-refusal",
      });
    } finally {
      warn.mockRestore();
    }
  });
  test("any other failure is a failed run and the next trigger tries again", async () => {
    for (const reason of [
      "runtime-failed",
      "network-error",
      "container-failed",
      "login-layout-unknown",
      "session-expired",
      "invalid-credentials",
    ] as const) {
      const state = new Storage();
      const bucket = new FakeR2Bucket();
      let reads = 0;
      const coordinator = new CollectionCoordinator(
        state,
        async () => {
          reads++;
          return { status: "failed", reason };
        },
        (run) => persistSharedRun(bucket, run),
      );
      const first = await coordinator.trigger();
      expect(first).toMatchObject({ status: "failed", reason });
      expect(first.runId).toBeString();
      expect(first.terminalKey).toBeString();
      expect(state.values.size).toBe(0);
      expect(await coordinator.trigger()).toMatchObject({ status: "failed", reason });
      expect(reads).toBe(2);
    }
  });
  test("a block left by the older any-failure policy no longer stops the run", async () => {
    const state = new Storage();
    await state.put("state", {
      kind: "blocked",
      reason: "runtime-failed",
      runId: "00000000-0000-4000-8000-000000000000",
    });
    let reads = 0;
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        reads++;
        return { status: "success", snapshot: snapshot() };
      },
      (run) => persistSharedRun(new FakeR2Bucket(), run),
    );
    expect(await coordinator.trigger()).toMatchObject({ status: "stored" });
    expect(reads).toBe(1);
    expect(state.values.size).toBe(0);
  });
  test("a lease held by another execution is busy, contacts nobody and records no run", async () => {
    const state = new Storage();
    let persisted = 0;
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        throw new Error("collection_busy_or_uncertain");
      },
      async () => {
        persisted++;
        throw new Error("must not persist");
      },
    );
    expect(await coordinator.trigger()).toEqual({ status: "busy" });
    expect(persisted).toBe(0);
    expect(state.values.size).toBe(0);
  });
  test("an in-flight marker left by a reset object does not stop the next attempt", async () => {
    const state = new Storage();
    await state.put("state", { kind: "running" });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let reads = 0;
    try {
      const coordinator = new CollectionCoordinator(
        state,
        async () => {
          reads++;
          return { status: "success", snapshot: snapshot() };
        },
        (run) => persistSharedRun(new FakeR2Bucket(), run),
      );
      expect(await coordinator.trigger()).toMatchObject({ status: "stored" });
      expect(reads).toBe(1);
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toEqual({
        event: "st-george-interrupted-attempt-cleared",
      });
    } finally {
      warn.mockRestore();
    }
  });
  test("concurrent triggers never start a second authentication", async () => {
    const state = new Storage();
    const bucket = new FakeR2Bucket();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const coordinator = new CollectionCoordinator(
      state,
      async () => {
        reads++;
        await wait;
        return { status: "success", snapshot: snapshot() };
      },
      (run) => persistSharedRun(bucket, run),
    );
    const pending = coordinator.trigger();
    expect(await coordinator.trigger()).toEqual({ status: "busy" });
    expect(await coordinator.trigger({ operatorRequested: true })).toEqual({ status: "busy" });
    release();
    expect(await pending).toMatchObject({ status: "stored" });
    expect(reads).toBe(1);
  });
  test("a holder that stopped itself fails with its own reason, not container-failed", async () => {
    // ADR 0085: withCollectionLease rejects with the stop's code. The lease is
    // released only once that action settles, so the next attempt cannot overlap it.
    for (const [code, reason] of [
      ["collection_deadline_exceeded", "deadline-exceeded"],
      ["collection_lease_lost", "collection-interrupted"],
    ] as const) {
      const state = new Storage();
      let calls = 0;
      const coordinator = new CollectionCoordinator(
        state,
        async () => {
          calls++;
          throw new Error(code);
        },
        (run) => persistSharedRun(new FakeR2Bucket(), run),
      );
      expect(await coordinator.trigger()).toMatchObject({ status: "failed", reason });
      expect(await coordinator.trigger()).toMatchObject({ status: "failed", reason });
      expect(calls).toBe(2);
    }
  });
  test("credentials and error text cannot enter the safe outcome", () => {
    expect(() => parseCredential('{"password":"synthetic"}')).toThrow("invalid-credentials");
    expect(
      parseCollectionOutput({
        status: "failed",
        reason: "password=synthetic",
        cookie: "synthetic",
      }),
    ).toEqual({ status: "failed", reason: "container-failed" });
    expect(
      authorized(
        new Request("https://test", { headers: { authorization: "Bearer " + "x".repeat(32) } }),
        "x".repeat(32),
      ),
    ).toBe(true);
    expect(
      authorized(
        new Request("https://test", { headers: { authorization: "Bearer short" } }),
        "short",
      ),
    ).toBe(false);
  });
});
