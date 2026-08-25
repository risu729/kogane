#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { intro, isCancel, log, outro, password, text } from "@clack/prompts";
import { VpassClient, type RawJsonResponse } from "./vpass-client";

interface PageManifest {
  file: string;
  kind: "top" | "answer";
  transactionCount: number;
}

interface MonthManifest {
  yyyymm: string;
  kind: "web-meisai-top" | "customized-meisai";
  transactionCount: number;
  pages: PageManifest[];
}

interface CardManifest {
  index: number;
  name: string;
  availableMonths: string[];
  months: MonthManifest[];
}

interface RunManifest {
  format: "kogane-vpass-json-poc/v1";
  startedAt: string;
  completedAt?: string;
  cards: CardManifest[];
}

function defaultOutputDirectory(): string {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  return resolve("output", stamp);
}

function outputArgument(): string {
  const index = Bun.argv.indexOf("--output");
  if (index >= 0) {
    const value = Bun.argv[index + 1];
    if (!value) throw new Error("--output requires a directory");
    return resolve(value);
  }
  const inline = Bun.argv.find((argument) => argument.startsWith("--output="));
  return inline ? resolve(inline.slice("--output=".length)) : defaultOutputDirectory();
}

async function saveEvidence(
  root: string,
  relativePath: string,
  evidence: RawJsonResponse,
): Promise<void> {
  const absoluteRoot = resolve(root);
  const destination = resolve(absoluteRoot, relativePath);
  const fromRoot = relative(absoluteRoot, destination);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Evidence path escaped output root");
  }
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, evidence.rawBytes);
}

async function saveManifest(root: string, manifest: RunManifest): Promise<void> {
  await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  intro("Kogane Vpass JSON PoC");
  const outputRoot = outputArgument();
  await mkdir(outputRoot, { recursive: true });

  const userIdResult = await text({
    message: "Vpass ID",
    validate: (value) => (value?.trim() ? undefined : "Vpass ID is required"),
  });
  if (isCancel(userIdResult)) {
    outro("Cancelled");
    return;
  }

  const passwordResult = await password({
    message: "Vpass password",
    validate: (value) => (value ? undefined : "Password is required"),
  });
  if (isCancel(passwordResult)) {
    outro("Cancelled");
    return;
  }

  let secret = passwordResult;
  const client = new VpassClient();
  try {
    await client.login(userIdResult.trim(), secret);
  } finally {
    secret = "";
  }
  log.success("Authenticated without a browser");

  const manifest: RunManifest = {
    format: "kogane-vpass-json-poc/v1",
    startedAt: new Date().toISOString(),
    cards: [],
  };
  const { cards, evidence: cardListEvidence } = await client.listCards();
  await saveEvidence(outputRoot, "session/card-list.json", cardListEvidence);

  for (const [zeroBasedIndex, card] of cards.entries()) {
    const cardIndex = zeroBasedIndex + 1;
    const cardDirectory = `card-${String(cardIndex).padStart(2, "0")}`;
    log.step(`Card ${cardIndex}/${cards.length}: ${card.name}`);

    const selectEvidence = await client.selectCard(card.value);
    await saveEvidence(outputRoot, `${cardDirectory}/select-card.json`, selectEvidence);
    const { months, evidence: monthListEvidence } = await client.listAvailableMonths();
    await saveEvidence(outputRoot, `${cardDirectory}/available-months.json`, monthListEvidence);

    const cardManifest: CardManifest = {
      index: cardIndex,
      name: card.name,
      availableMonths: months,
      months: [],
    };
    manifest.cards.push(cardManifest);
    await saveManifest(outputRoot, manifest);

    for (const yyyymm of months) {
      log.info(`Fetching ${yyyymm}`);
      const statement = await client.fetchStatementMonth(yyyymm);
      const monthDirectory = `${cardDirectory}/${yyyymm}`;
      const pageManifest: PageManifest[] = [];

      for (const page of statement.pages) {
        const fileName = `${page.kind}-${String(page.pageIndex).padStart(3, "0")}.json`;
        const relativePath = `${monthDirectory}/${fileName}`;
        await saveEvidence(outputRoot, relativePath, page);
        pageManifest.push({
          file: relativePath,
          kind: page.kind,
          transactionCount: page.transactionCount,
        });
      }

      cardManifest.months.push({
        yyyymm,
        kind: statement.kind,
        transactionCount: statement.transactionCount,
        pages: pageManifest,
      });
      await saveManifest(outputRoot, manifest);
    }
  }

  manifest.completedAt = new Date().toISOString();
  await saveManifest(outputRoot, manifest);
  outro(`Saved raw Vpass JSON to ${outputRoot}`);
}

await main();
