// Synthetic `GET /api/v2/delegations` answers for the schedules and confirm
// page tests. No real subject, source or account appears here.
import { expect } from "bun:test";
import type { Page } from "playwright";
import type { DelegationStatus } from "../../../packages/observation-shared/src/delegation-status-contract.ts";

const DELEGATION_EVALUATED_AT = "2026-10-09T00:00:00.000Z";
const IN_FORCE_PRINCIPAL = "mcp-client:owner-synthetic-delegate";
const EXPIRED_PRINCIPAL = "mcp-client:retired-synthetic-delegate";

export function delegationStatusFixture(
  configuration: DelegationStatus["configuration"],
): DelegationStatus {
  return {
    schemaVersion: "kogane-delegation-status-v1",
    evaluatedAt: DELEGATION_EVALUATED_AT,
    configuration,
    delegations:
      configuration !== "valid"
        ? []
        : [
            {
              principal: IN_FORCE_PRINCIPAL,
              delegatedBy: "owner-synthetic-delegate",
              role: "maintainer",
              capabilities: [
                "schedules.maintenance.update",
                "schedules.survey.decide",
                "operations.import.request",
                "operations.replay.request",
                "operations.read",
              ],
              scopes: {
                sources: ["synthetic-source-a", "synthetic-source-b"],
                accounts: "*",
                scheduleSources: [],
              },
              issuedAt: "2026-10-01T00:00:00Z",
              notAfter: "2026-11-01T00:00:00Z",
              writesPerDay: 30,
              state: "in_force",
              delegationRef: `dlg_${"0123456789abcdef".repeat(4)}`,
            },
            {
              principal: EXPIRED_PRINCIPAL,
              delegatedBy: "retired-synthetic-delegate",
              role: "reviewer",
              capabilities: [
                "commands.plan",
                "commands.decide.card-settlement",
                "commands.decide.relation",
              ],
              scopes: { sources: "*", accounts: "*", scheduleSources: [] },
              issuedAt: "2026-09-01T00:00:00Z",
              notAfter: "2026-10-01T00:00:00Z",
              writesPerDay: 5,
              state: "expired",
              delegationRef: `dlg_${"f".repeat(64)}`,
            },
          ],
  };
}

/**
 * What both pages must show for each configuration, read from the rendered
 * notice only: the server's state, never a state the browser derived, and
 * nothing that acts on a delegation.
 */
export async function expectDelegationNotice(
  page: Page,
  configuration: DelegationStatus["configuration"] | "unavailable",
): Promise<void> {
  const notice = page.getByRole("region", { name: "AIへの委任" });
  await notice.waitFor();
  await notice
    .locator('[role="status"]')
    .filter({ hasText: "読み込んでいます" })
    .waitFor({ state: "detached" });
  const text = await notice.innerText();
  if (configuration === "none")
    expect(text).toContain("委任はありません。AIは読み取りと提案のみ行い");
  if (configuration === "unavailable") expect(text).toContain("委任の状態を確認できません");
  if (configuration === "misconfigured")
    expect(await notice.getByRole("alert").innerText()).toContain(
      "委任の設定に誤りがあるため、AIへの委任はすべて無効です",
    );
  if (configuration === "valid") {
    const entries = notice.locator(".delegation-entry");
    expect(await entries.count()).toBe(2);
    const live = entries.filter({ hasText: IN_FORCE_PRINCIPAL });
    expect(await live.locator(".badge").innerText()).toBe("有効");
    expect(await live.innerText()).toContain("役割 保守");
    expect(await live.innerText()).toContain("1日あたりの書き込み上限 30 件");
    // Japan time, as every other time on these pages.
    expect(await live.innerText()).toContain("2026/10/01 9:00 から 2026/11/01 9:00 まで");
    expect(await live.getByText("メンテナンス時間の変更").isVisible()).toBe(false);
    await live.getByText("権限と範囲", { exact: true }).click();
    expect(await live.getByText("メンテナンス時間の変更").isVisible()).toBe(true);
    expect(await live.innerText()).toContain("取得元 2件指定 · 口座 すべて · スケジュール なし");
    const retired = entries.filter({ hasText: EXPIRED_PRINCIPAL });
    expect(await retired.locator(".badge").innerText()).toBe("期限切れ");
    expect(await retired.innerText()).toContain("役割 確認");
  } else expect(await notice.locator(".delegation-entry").count()).toBe(0);
  // Read-only: no control acts on a delegation.
  expect(await notice.locator("button, input, select, textarea, form").count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
