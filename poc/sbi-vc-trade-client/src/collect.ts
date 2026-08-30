import { SbiVcTradeClient } from "./client";
import type { Artifact, CollectionOptions, GatewayEnvelope } from "./types";

export async function collectSbiVcTrade(
  client: SbiVcTradeClient,
  options: CollectionOptions = {},
): Promise<Artifact[]> {
  const pageSize = options.pageSize ?? 30;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("pageSize must be an integer from 1 to 1000");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new Error("maxPages must be an integer from 1 to 1000");
  }
  const artifacts: Artifact[] = [
    { name: "cash-balances.json", response: await client.cashBalances() },
    { name: "account-margin.json", response: await client.accountMargin() },
  ];
  artifacts.push({
    name: "executions-recent-page-0001.json",
    response: await client.executions({
      pageNumber: 0,
      pageSize,
      historical: false,
    }),
  });
  artifacts.push(...await collectPages({
    name: "executions-historical",
    pageSize,
    maxPages,
    fetchPage: (pageNumber) => client.executions({
      pageNumber,
      pageSize,
      historical: true,
    }),
  }));
  artifacts.push(...await collectPages({
    name: "cashflows-historical",
    pageSize,
    maxPages,
    fetchPage: (pageNumber) => client.cashflows({
      pageNumber,
      pageSize,
      historical: true,
    }),
  }));
  return artifacts;
}

async function collectPages(options: {
  name: string;
  pageSize: number;
  maxPages: number;
  fetchPage: (pageNumber: number) => Promise<GatewayEnvelope>;
}): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];
  for (let pageNumber = 0; pageNumber < options.maxPages; pageNumber += 1) {
    const response = await options.fetchPage(pageNumber);
    artifacts.push({
      name: `${options.name}-page-${String(pageNumber + 1).padStart(4, "0")}.json`,
      response,
    });
    const page = pageInfo(response.body);
    if (page === null || page.listLength === 0) break;
    if ((pageNumber + 1) * options.pageSize >= page.totalSize) break;
    if (pageNumber + 1 === options.maxPages) {
      throw new Error(`${options.name} exceeded maxPages=${options.maxPages}`);
    }
  }
  return artifacts;
}

function pageInfo(body: unknown): { listLength: number; totalSize: number } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (!Array.isArray(value.list) || typeof value.totalSize !== "number") return null;
  return { listLength: value.list.length, totalSize: value.totalSize };
}
