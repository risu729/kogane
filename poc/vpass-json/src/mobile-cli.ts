#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { intro, isCancel, log, outro, password, text } from "@clack/prompts";
import { MobileVpassClient } from "./mobile-vpass-client";
import type { RawJsonResponse } from "./vpass-client";

function argument(name: string, envName: string): string {
  const inline = Bun.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = Bun.argv.indexOf(name);
  return (index >= 0 ? Bun.argv[index + 1] : undefined) ?? process.env[envName] ?? "";
}

function outputRoot(): string {
  const configured = argument("--output", "VPASS_OUTPUT");
  const stamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z");
  return resolve(configured || `output/mobile-${stamp}`);
}

async function save(root: string, path: string, response: RawJsonResponse): Promise<void> {
  const destination = resolve(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, response.rawBytes);
}

async function credential(envName: string, prompt: string, masked: boolean): Promise<string> {
  const fromEnvironment = process.env[envName];
  if (fromEnvironment) return fromEnvironment;
  const result = masked
    ? await password({ message: prompt, validate: (value) => (value ? undefined : "Required") })
    : await text({
        message: prompt,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });
  if (isCancel(result)) throw new Error("Cancelled");
  return masked ? result : result.trim();
}

async function main(): Promise<void> {
  intro("Kogane Vpass Android JSON collector");
  const authKeyPath = argument("--auth-key", "VPASS_AUTH_PUBLIC_KEY_PATH");
  const configKeyPath = argument("--config-key", "VPASS_CONFIG_PUBLIC_KEY_PATH");
  if (!authKeyPath || !configKeyPath) throw new Error("--auth-key and --config-key are required");
  const root = outputRoot();
  await mkdir(root, { recursive: true });
  let loginId = await credential("VPASS_ID", "Vpass ID", false);
  let secret = await credential("VPASS_PASSWORD", "Vpass password", true);
  const client = new MobileVpassClient();
  try {
    await client.login(
      loginId,
      secret,
      new Uint8Array(await readFile(authKeyPath)),
      new Uint8Array(await readFile(configKeyPath)),
    );
  } finally {
    loginId = "";
    secret = "";
  }
  log.success("Authenticated without a browser");

  const { cards, evidence: cardList } = await client.listCards();
  await save(root, "session/card-list.json", cardList);
  const manifest: {
    format: string;
    startedAt: string;
    completedAt?: string;
    cardCount: number;
    transactionCount: number;
    cards: Array<{ index: number; monthCount: number; transactionCount: number }>;
  } = {
    format: "kogane-vpass-android-json-poc/v1",
    startedAt: new Date().toISOString(),
    cardCount: cards.length,
    transactionCount: 0,
    cards: [],
  };

  for (const [index, card] of cards.entries()) {
    const cardNumber = index + 1;
    const cardDirectory = `card-${String(cardNumber).padStart(3, "0")}`;
    const selection = await client.selectCard(card.value);
    await save(root, `${cardDirectory}/select-card.json`, selection);
    const { months, evidence: top } = await client.listAvailableMonths();
    await save(root, `${cardDirectory}/web-meisai-top.json`, top);
    let cardTransactions = 0;
    log.step(`Card ${cardNumber}/${cards.length}: ${months.length} months`);
    for (const month of months) {
      const statement = await client.fetchStatementMonth(month);
      for (const page of statement.pages) {
        await save(
          root,
          `${cardDirectory}/months/${month}/${page.kind}-${String(page.pageIndex).padStart(3, "0")}.json`,
          page,
        );
      }
      cardTransactions += statement.transactionCount;
      log.info(`${month}: ${statement.transactionCount} rows, ${statement.pages.length} pages`);
    }
    manifest.cards.push({
      index: cardNumber,
      monthCount: months.length,
      transactionCount: cardTransactions,
    });
    manifest.transactionCount += cardTransactions;
  }
  manifest.completedAt = new Date().toISOString();
  await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  outro(`Saved ${manifest.transactionCount} rows across ${manifest.cardCount} cards to ${root}`);
  if (manifest.transactionCount === 0) process.exitCode = 2;
}

await main();
