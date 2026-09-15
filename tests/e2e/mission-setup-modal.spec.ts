import { expect, test, type Locator, type Page } from "@playwright/test";

async function step(page: Page, button: Locator) {
  const room = page.locator(".room-view");
  const revision = await room.getAttribute("data-revision");
  await button.click();
  await expect(room).not.toHaveAttribute("data-revision", revision!);
  await expect(room).toHaveAttribute("aria-busy", "false");
}
async function launch(page: Page, mission: number) {
  await page.goto("/");
  await page.getByRole("button", { name: "5명", exact: true }).click();
  await page.getByRole("combobox", { name: "시작 미션", exact: true }).selectOption(String(mission));
  await page.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
  for (const name of ["데모 대원 채우기", "탑승 준비 완료", "임무 시작"])
    await step(page, page.getByRole("button", { name, exact: true }));
}

for (const [mission, tasks, condition] of [[7, 3, "Ω"], [22, 5, "상대 순서 토큰"]] as const) {
  test(`mission ${mission}: conditions and selection share one dialog without a separate confirmation`, async ({ page }, info) => {
    await launch(page, mission);
    const modal = page.getByRole("dialog", { name: "목표 카드 선택", exact: true });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(condition);
    await expect(modal.locator(".target-list button")).toHaveCount(tasks);
    await expect(modal.locator(".hand-cards, .player-seat, .seat-missions")).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "임무 확인 완료", exact: true })).toHaveCount(0);
    await expect(modal.locator(".mission-task-info")).toHaveCount(0);
    await expect(page.locator(".seat-south")).toContainText("브리핑 확인 완료");
    await expect(modal.locator(".target-list button:enabled")).toHaveCount(0);
    const original = await modal.elementHandle();
    for (let i = 0; i < 4; i++) {
      await step(page, page.getByRole("button", { name: "데모 대원 진행", exact: true }));
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      expect(await page.evaluate(el => el === document.querySelector(".mission-setup-modal"), original)).toBe(true);
    }
    await expect(modal.locator(".setup-turn-notice")).not.toContainText("명 준비");
    await page.screenshot({ path: `artifacts/qa/missions/m${mission}-combined-setup-${info.project.name}.png` });
    for (let i = 0; i < 16 && await page.locator(".mission-setup-modal").count(); i++) {
      const choices = modal.locator('.target-list button:not([aria-disabled="true"])');
      await step(page, await choices.count() ? choices.first() : page.getByRole("button", { name: "데모 대원 진행", exact: true }));
    }
    await expect(page.locator(".mission-setup-modal")).toHaveCount(0);
    await expect(page.locator(".seat-task")).toHaveCount(tasks);
    await expect(page.locator(".hand-dock .hand-card")).toHaveCount(8);
    if (info.project.name === "desktop") {
      const tokenTask = page.locator(".seat-task:has(.task-order)").first();
      const tokenLabel = (await tokenTask.locator(".task-order").textContent())!.trim();
      await tokenTask.hover();
      const previewToken = page.getByRole("tooltip", { name: "카드 정보" }).locator(".task-order");
      await expect(previewToken).toHaveText(tokenLabel);
      expect((await previewToken.boundingBox())!.height).toBeGreaterThanOrEqual(38);
    }
  });
}

test("combined setup can be closed, reopened and resumed without confirming twice", async ({ page }) => {
  await launch(page, 7);
  const modal = page.getByRole("dialog", { name: "목표 카드 선택", exact: true });
  await expect(page.locator(".seat-south")).toContainText("브리핑 확인 완료");
  const revision = await page.locator(".room-view").getAttribute("data-revision");
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
  await expect(page.locator(".room-view")).toHaveAttribute("data-revision", revision!);
  await expect(page.getByRole("button", { name: "임무 준비 열기", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "임무 준비 열기", exact: true }).click();
  await expect(modal).toBeVisible();
  await expect(page.locator(".room-view")).toHaveAttribute("data-revision", revision!);
  await page.reload();
  await expect(modal).toBeVisible();
  await expect(page.locator(".room-view")).toHaveAttribute("data-revision", revision!);
  await expect(modal.locator(".target-list button")).toHaveCount(3);
  const box = await modal.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
});

test('briefing already uses final viewport geometry and native close can reopen', async ({ page }) => {
  await launch(page, 22);
  const modal = page.getByRole('dialog', { name: '목표 카드 선택', exact: true });
  await expect(modal).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveClass(/gameplay-fixed/);
  const geometry = () => page.evaluate(() => ({
    header: document.querySelector('.site-header')!.getBoundingClientRect().height,
    handCard: document.querySelector('.hand-card')!.getBoundingClientRect().width,
    hand: document.querySelector('.hand-dock')!.getBoundingClientRect().height,
    height: document.querySelector('.game-table')!.getBoundingClientRect().height,
    overflow: document.documentElement.scrollHeight > innerHeight,
  }));
  const before = await geometry(); expect(before.overflow).toBe(false);
  // Browser-native close must synchronize React state even without our dismiss button.
  await modal.evaluate(el => (el as HTMLDialogElement).close());
  await expect(modal).not.toBeVisible();
  await page.getByRole('button', { name: '임무 준비 열기', exact: true }).click();
  await expect(modal).toBeVisible();
  for (let i = 0; i < 4; i++) await step(page, page.getByRole('button', { name: '데모 대원 진행' }));
  const after = await geometry();
  expect(after.overflow).toBe(false);
  expect(after.header).toBe(before.header);
  expect(after.handCard).toBeCloseTo(before.handCard, 0);
  expect(after.height).toBe(before.height);
  // Repeated explicit reopen must keep the same dialog and must not send more ready commands.
  for (let i = 0; i < 3; i++) {
    const revision = await page.locator('.room-view').getAttribute('data-revision');
    await modal.getByRole('button', { name: '테이블 보기' }).click();
    await page.getByRole('button', { name: '임무 준비 열기', exact: true }).click();
    await expect(modal).toBeVisible();
    await expect(page.locator('.room-view')).toHaveAttribute('data-revision', revision!);
  }
});
