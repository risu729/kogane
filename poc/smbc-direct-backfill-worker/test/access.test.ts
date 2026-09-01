import { describe, expect, test } from "bun:test";
import { accessJwtSubject } from "../src/access";

describe("accessJwtSubject", () => {
  test("extracts a bounded subject from an Access JWT payload", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "access-user-123" })).toString("base64url");
    expect(accessJwtSubject(`header.${payload}.signature`)).toBe("access-user-123");
  });

  test("rejects malformed and subject-free assertions", () => {
    expect(accessJwtSubject(null)).toBeNull();
    expect(accessJwtSubject("not-a-jwt")).toBeNull();
    const payload = Buffer.from(JSON.stringify({ email: "user@example.com" })).toString("base64url");
    expect(accessJwtSubject(`header.${payload}.signature`)).toBeNull();
  });
});
