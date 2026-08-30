import { DurableObject } from "cloudflare:workers";
import {
  beginVPointEmailLogin,
  completeVPointEmailLogin,
  type VPointEmailChallengeState,
} from "./auth";

const SESSION_KEY = "session-cookie";
const PENDING_KEY = "email-challenge";
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export interface EmailChallengeResult {
  status: "created" | "pending";
  requestedAt: string;
}

export class VPointSession extends DurableObject<Env> {
  private authInFlight: Promise<EmailChallengeResult> | null = null;
  private readonly state: DurableObjectState;
  private readonly environment: Env;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    this.state = state;
    this.environment = env;
  }

  async getSession(): Promise<string | null> {
    return await this.state.storage.get<string>(SESSION_KEY) ?? null;
  }

  async invalidateSession(): Promise<void> {
    await this.state.storage.delete(SESSION_KEY);
  }

  async hasPendingChallenge(): Promise<boolean> {
    const pending = await this.state.storage.get<VPointEmailChallengeState>(
      PENDING_KEY,
    );
    return Boolean(pending && isFresh(pending.requestedAt));
  }

  async ensureEmailChallenge(): Promise<EmailChallengeResult> {
    const existing = await this.state.storage.get<VPointEmailChallengeState>(
      PENDING_KEY,
    );
    if (existing && isFresh(existing.requestedAt)) {
      return { status: "pending", requestedAt: existing.requestedAt };
    }
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.createEmailChallenge();
    try {
      return await this.authInFlight;
    } finally {
      this.authInFlight = null;
    }
  }

  async completeEmailCode(code: string): Promise<{ status: "authenticated" }> {
    const pending = await this.state.storage.get<VPointEmailChallengeState>(
      PENDING_KEY,
    );
    if (!pending || !isFresh(pending.requestedAt)) {
      await this.state.storage.delete(PENDING_KEY);
      throw new Error("No current V Point email challenge");
    }
    try {
      const result = await completeVPointEmailLogin({ state: pending, code });
      await this.state.storage.put(SESSION_KEY, result.sessionCookie);
      await this.state.storage.delete(PENDING_KEY);
      return { status: "authenticated" };
    } catch (error) {
      await this.state.storage.delete(PENDING_KEY);
      throw error;
    }
  }

  private async createEmailChallenge(): Promise<EmailChallengeResult> {
    await this.state.storage.delete(PENDING_KEY);
    const memberNumber = this.environment.VPOINT_MEMBER_NUMBER;
    if (!memberNumber) {
      throw new Error("Missing Worker secret: VPOINT_MEMBER_NUMBER");
    }
    const challenge = await beginVPointEmailLogin({ memberNumber });
    await this.state.storage.put(PENDING_KEY, challenge.state);
    return { status: "created", requestedAt: challenge.requestedAt };
  }
}

function isFresh(requestedAt: string): boolean {
  const timestamp = Date.parse(requestedAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < CHALLENGE_TTL_MS;
}
