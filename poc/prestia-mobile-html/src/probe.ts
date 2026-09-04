#!/usr/bin/env bun

import { isCancel, intro, log, outro, password } from "@clack/prompts";
import { PrestiaMobileClient, type Credentials } from "./client";

async function readStdinJson(): Promise<Credentials> {
  const text = await Bun.stdin.text();
  const parsed: unknown = JSON.parse(text);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("userId" in parsed) ||
    !("password" in parsed) ||
    typeof parsed.userId !== "string" ||
    typeof parsed.password !== "string" ||
    !parsed.userId ||
    !parsed.password
  ) {
    throw new Error("stdin must contain { userId, password }");
  }
  return { userId: parsed.userId, password: parsed.password };
}

async function promptCredentials(): Promise<Credentials> {
  const userId = await password({ message: "PRESTIA user ID" });
  if (isCancel(userId) || !userId) throw new Error("Cancelled");
  const secret = await password({ message: "PRESTIA password" });
  if (isCancel(secret) || !secret) throw new Error("Cancelled");
  return { userId, password: secret };
}

async function main(): Promise<void> {
  intro("PRESTIA Mobile read-only HTML probe");
  const client = new PrestiaMobileClient();
  const bootstrap = await client.bootstrap();
  log.info(`Bootstrap: ${JSON.stringify(client.safe(bootstrap))}`);
  if (bootstrap.status !== 200 || bootstrap.summary.accessDenied || !bootstrap.summary.loginFormPresent) {
    throw new Error("Bootstrap was not accepted; stopping before credentials");
  }

  if (Bun.argv.includes("--bootstrap-only")) {
    outro("Bootstrap succeeded; no credential was requested and no response was saved");
    return;
  }

  let credentials = Bun.argv.includes("--stdin-json")
    ? await readStdinJson()
    : await promptCredentials();
  const login = await client.login(bootstrap, credentials);
  credentials = { userId: "", password: "" };
  log.info(`Login: ${JSON.stringify(client.safe(login))}`);

  if (login.redirectLocationPresent || login.status >= 300) {
    throw new Error("Credential response redirected; stopped without following or resending");
  }
  if (login.summary.otpFormPresent) {
    outro("OTP is required; stopped without retry or OTP submission");
    return;
  }
  if (
    login.status !== 200 ||
    login.summary.accessDenied ||
    login.summary.loginFormPresent
  ) {
    throw new Error("Login was not accepted; stopped without retry");
  }

  const home = await client.home(login);
  log.info(`Home: ${JSON.stringify(client.safe(home))}`);
  if (
    home.status !== 200 ||
    home.redirectLocationPresent ||
    home.summary.accessDenied ||
    home.summary.loginFormPresent ||
    !home.summary.homeFormPresent
  ) {
    throw new Error("Home session was not established; stopped without retry");
  }

  await client.withBestEffortSignoff(home, async () => {
    const balance = await client.balance(home);
    log.info(`Balance: ${JSON.stringify(client.safe(balance))}`);
    if (balance.status !== 200 || balance.redirectLocationPresent || balance.summary.accessDenied) {
      throw new Error("Balance summary failed; stopped without retry");
    }
  });
  outro("Probe finished; no body, credential, cookie, token, account number, or balance was saved");
}

await main();
