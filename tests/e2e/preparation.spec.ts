import { expect, test, type Locator, type Page } from "@playwright/test";

async function step(page: Page, button: Locator) {
  const room = page.locator(".room-view");
  const revision = await room.getAttribute("data-revision");
  await button.click();
  await expect(room).not.toHaveAttribute("data-revision", revision!);
  await expect(room).toHaveAttribute("aria-busy", "false");
}

test("mission preparation remains actionable on desktop and mobile", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto("/");
  await page.getByRole("combobox", { name: "시작 미션", exact: true }).selectOption("5");
  await page.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
  await step(page, page.getByRole("button", { name: "데모 대원 채우기", exact: true }));
  await step(page, page.getByRole("button", { name: "탑승 준비 완료", exact: true }));
  await step(page, page.getByRole("button", { name: "임무 시작", exact: true }));
  if (await page.getByRole("button", { name: "임무 확인 완료", exact: true }).isVisible())
    await step(page, page.getByRole("button", { name: "임무 확인 완료", exact: true }));

  const preparation = page.locator(".mission-preparation");
  for (let i = 0; i < 3 && !(await preparation.count()); i++)
    await step(page, page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  await expect(preparation).toBeVisible();
  await expect(preparation).toContainText("트릭을 하나도");

  // The table is also visible during preparation. Continue until the persisted
  // preparation state itself has been consumed and the playing state resumes.
  for (let i = 0; i < 12 && (await preparation.count()); i++) {
    if (await page.getByRole("button", { name: "좋음", exact: true }).count()) {
      await step(page, page.getByRole("button", { name: "좋음", exact: true }));
      continue;
    }
    const crew = page.locator(".mission-preparation select").first();
    if (await crew.count()) {
      if ((await crew.inputValue()) === "") await crew.selectOption({ index: 1 });
      const confirm = page.getByRole("button", { name: "담당자 확정", exact: true });
      if (await confirm.isEnabled()) { await step(page, confirm); continue; }
    }
    await step(page, page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  }

  await expect(preparation).toHaveCount(0);
  await expect(page.locator(".table-surface")).toBeVisible();
  await expect(page.locator(".mission-panel")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("mission 23 exposes and completes the token-edit preparation path", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "시작 미션", exact: true }).selectOption("23");
  await page.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
  await step(page, page.getByRole("button", { name: "데모 대원 채우기", exact: true }));
  await step(page, page.getByRole("button", { name: "탑승 준비 완료", exact: true }));
  await step(page, page.getByRole("button", { name: "임무 시작", exact: true }));
  if (await page.getByRole("button", { name: "임무 확인 완료", exact: true }).isVisible())
    await step(page, page.getByRole("button", { name: "임무 확인 완료", exact: true }));

  const preparation = page.locator(".mission-preparation");
  for (let i = 0; i < 20; i++) {
    if (await preparation.getByText("토큰 두 개를 서로 교환").count()) break;
    const goal = page.locator(".target-list button:not([aria-disabled='true'])");
    await step(page, (await goal.count()) ? goal.first() : page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  }
  await expect(preparation).toContainText("토큰 두 개를 서로 교환");

  const reset = preparation.getByRole("button", { name: "원래 배치로 되돌리기", exact: true });
  if (await reset.count()) {
    const selects = preparation.locator("select");
    await selects.nth(0).selectOption({ index: 1 });
    await selects.nth(1).selectOption({ index: 1 });
    await step(page, preparation.getByRole("button", { name: "토큰 변경", exact: true }));
    await step(page, reset);
    await step(page, preparation.getByRole("button", { name: "현재 토큰 배치 확정", exact: true }));
  } else {
    await step(page, page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  }
  await expect(preparation).toHaveCount(0);
  await expect(page.locator(".mission-task-draft")).toBeVisible();
});
