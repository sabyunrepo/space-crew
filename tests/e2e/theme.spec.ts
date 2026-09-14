import { test, expect, type Page, type Locator } from "@playwright/test";

async function step(page: Page, button: Locator) {
  const room = page.locator(".room-view");
  const revision = await room.getAttribute("data-revision");
  await button.click();
  await expect(room).not.toHaveAttribute("data-revision", revision!);
  await expect(room).toHaveAttribute("aria-busy", "false");
}
async function contrast(page: Page, text: string, surface: string) {
  await expect.poll(() => page.evaluate(({ text, surface }) => {
    const luminance = (value: string) => {
      const channels = value.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(v => {
        const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
      });
      return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
    };
    const foreground = luminance(getComputedStyle(document.querySelector(text)!).color);
    const background = luminance(getComputedStyle(document.querySelector(surface)!).backgroundColor);
    return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
  }, { text, surface }), { message: `${text} on ${surface}` }).toBeGreaterThanOrEqual(4.5);
}

test("theme selection persists, synchronizes tabs and works in the guide", async ({ page, context }, info) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "다크 테마", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "라이트 테마", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "라이트 테마", exact: true }).locator("svg")).toBeVisible();
  await contrast(page, ".hero-description", "html");
  await contrast(page, ".theme-picker button[aria-pressed=true]", ".theme-picker button[aria-pressed=true]");
  await contrast(page, ".launch-panel label", ".launch-panel");
  await contrast(page, ".launch-panel .primary", ".launch-panel .primary");
  await page.screenshot({ path: `artifacts/qa/themes/home-light-${info.project.name}.png` });
  await page.reload();
  await expect(page.getByRole("button", { name: "라이트 테마", exact: true })).toHaveAttribute("aria-pressed", "true");
  const other = await context.newPage(); await other.goto("/");
  await page.getByRole("button", { name: "다크 테마", exact: true }).click();
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "플레이 가이드", exact: true }).click();
  await page.getByRole("button", { name: "라이트 테마", exact: true }).click();
  await contrast(page, ".guide-content p", "html");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/qa/themes/guide-light-${info.project.name}.png` });
  await other.close();
});

for (const theme of ["light", "dark"] as const) test(`${theme} theme covers setup and the five-player board without changing gameplay`, async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: theme === "light" ? "라이트 테마" : "다크 테마", exact: true }).click();
  await page.getByRole("button", { name: "5명", exact: true }).click();
  await page.locator(".mission-select select").selectOption("7");
  await page.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
  for (const name of ["데모 대원 채우기", "탑승 준비 완료", "임무 시작"])
    await step(page, page.getByRole("button", { name, exact: true }));
  await expect(page.locator(".mission-setup-modal")).toBeVisible();
  if (theme === "light") {
    await contrast(page, ".setup-mission-conditions > p", ".mission-setup-modal");
    await contrast(page, ".setup-turn-notice", ".mission-setup-modal");
  }
  await page.screenshot({ path: `artifacts/qa/themes/setup-${theme}-${info.project.name}.png` });
  for (let i = 0; i < 16 && await page.locator(".mission-setup-modal").count(); i++) {
    const goal = page.locator('.target-list button:not([aria-disabled="true"])');
    await step(page, await goal.count() ? goal.first() : page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  }
  await expect(page.locator(".player-seat")).toHaveCount(5);
  if (theme === "light") {
    await contrast(page, ".seat-south .seat-heading strong", ".seat-south");
    await contrast(page, ".central-player-name", ".central-trick");
    await contrast(page, ".mission-progress", ".status-bar");
    await contrast(page, ".mission-panel-strip .eyebrow", ".status-bar");
    await contrast(page, ".seat-turn-badge", ".seat-turn-badge");
    await contrast(page, ".hand-controls > span", ".hand-dock");
  }
  const revision = await page.locator(".room-view").getAttribute("data-revision");
  const hand = await page.locator(".hand-cards img").evaluateAll(imgs => imgs.map(img => img.getAttribute("src")));
  await page.getByRole("button", { name: theme === "light" ? "다크 테마" : "라이트 테마", exact: true }).click();
  await expect(page.locator(".room-view")).toHaveAttribute("data-revision", revision!);
  expect(await page.locator(".hand-cards img").evaluateAll(imgs => imgs.map(img => img.getAttribute("src")))).toEqual(hand);
  await page.getByRole("button", { name: theme === "light" ? "라이트 테마" : "다크 테마", exact: true }).click();
  for (const width of info.project.name === "mobile" ? [320, 390] : [1280, 2279]) {
    await page.setViewportSize({ width, height: width === 2279 ? 1456 : info.project.name === "mobile" ? 844 : 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    const buttons = await page.locator(".theme-picker button").evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()));
    for (const button of buttons) { expect(button.left).toBeGreaterThanOrEqual(0); expect(button.right).toBeLessThanOrEqual(width); }
  }
  await page.screenshot({ path: `artifacts/qa/themes/board-${theme}-${info.project.name}.png` });
  for (let turn = 0; turn < 80 && !(await page.locator(".mission-result-modal").count()); turn++) {
    const bot = page.getByRole("button", { name: "데모 대원 진행", exact: true });
    const next = page.getByRole("button", { name: "다음 트릭", exact: true });
    if (await bot.isVisible()) await step(page, bot);
    else if (await next.isVisible()) await step(page, next);
    else {
      const card = page.locator('.hand-cards button[aria-disabled="false"]').first();
      const box = await card.boundingBox();
      await card.click({ position: { x: 4, y: box!.height / 2 } });
      await step(page, page.getByRole("button", { name: "선택한 카드 내기", exact: true }));
    }
  }
  await expect(page.locator(".mission-result-modal")).toBeVisible();
  if (theme === "light") {
    await contrast(page, ".mission-result-modal .result-box p", ".mission-result-modal");
    await contrast(page, ".result-continue", ".result-continue");
  }
  await page.screenshot({ path: `artifacts/qa/themes/result-${theme}-${info.project.name}.png` });
  expect(errors).toEqual([]);
});
