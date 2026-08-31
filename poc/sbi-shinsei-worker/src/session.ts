import { AuthenticationBoundaryError } from "./errors";
import type { LoginSession, SessionStateStore } from "./types";

export class InMemorySessionState implements SessionStateStore {
  #authorization: string;
  #csrfToken: string;

  constructor(session: LoginSession) {
    if (!session.authorization || !session.csrfToken) {
      throw new AuthenticationBoundaryError(
        "A complete PowerDirect session is required",
      );
    }
    this.#authorization = session.authorization;
    this.#csrfToken = session.csrfToken;
  }

  getAuthorization(): string {
    return this.#authorization;
  }

  getCsrfToken(): string {
    return this.#csrfToken;
  }

  rotateCsrfToken(nextToken: string): void {
    if (!nextToken || nextToken.length > 16_384) {
      throw new AuthenticationBoundaryError(
        "PowerDirect supplied an invalid CSRF token",
      );
    }
    this.#csrfToken = nextToken;
  }
}
