/** Sign-off after collection is cleanup; only a closed flag crosses the stream. */
export async function signOut(page, diagnostics) {
  try {
    await diagnostics.step(
      "logout",
      async () => {
        const candidates = page.getByRole("link", { name: /ログアウト/u });
        const count = await candidates.count();
        for (let index = 0; index < count; index += 1) {
          const candidate = candidates.nth(index);
          if (!(await candidate.isVisible())) continue;
          await candidate.click();
          await page.waitForLoadState("domcontentloaded");
          return;
        }
        throw new Error("logout_control_missing");
      },
      { blame: false },
    );
    return { type: "logout", failed: false };
  } catch {
    return { type: "logout", failed: true };
  }
}
