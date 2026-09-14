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
    if (await preparation.getByText("카드 두 장을 선택하면").count()) break;
    const goal = page.locator(".target-list button:not([aria-disabled='true'])");
    await step(page, (await goal.count()) ? goal.first() : page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  }
  await expect(preparation).toContainText("카드 두 장을 선택하면");

  const choices = preparation.locator("button.token-choice");
  if (await choices.count()) {
    const before = await choices.locator(".task-order").allTextContents();
    const revision = await page.locator(".room-view").getAttribute("data-revision");
    await choices.nth(0).click();
    await expect(preparation.getByRole("button", { name: "현재 토큰 배치 확정" })).toBeDisabled();
    await choices.nth(1).click();
    expect(await choices.locator(".task-order").allTextContents()).toEqual([before[1], before[0], ...before.slice(2)]);
    await expect(page.locator(".room-view")).toHaveAttribute("data-revision", revision!);
    await step(page, preparation.getByRole("button", { name: "현재 토큰 배치 확정", exact: true }));
  } else await step(page, page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  await expect(preparation).toHaveCount(0);
  await expect(page.locator(".mission-task-draft")).toBeVisible();
});

test('local demo restart vote keeps AI responses accessible inside the dialog', async ({page}) => {
  await page.goto('/');
  await page.getByRole('combobox',{name:'시작 미션',exact:true}).selectOption('4');
  await page.getByRole('button',{name:'탐사선 만들기',exact:true}).click();
  for(const name of ['데모 대원 채우기','탑승 준비 완료','임무 시작']) await step(page,page.getByRole('button',{name,exact:true}));
  await page.getByRole('button',{name:'테이블 보기',exact:true}).click();
  await step(page,page.getByRole('button',{name:'게임 포기 · 재시작',exact:true}));
  const modal=page.getByRole('dialog',{name:'게임 포기 및 재시작 동의'});
  await expect(modal).toBeVisible();
  await step(page,modal.getByRole('button',{name:'데모 대원 진행',exact:true}));
  await expect(modal).toContainText('2/3명 동의');
  await step(page,modal.getByRole('button',{name:'데모 대원 진행',exact:true}));
  await expect(modal).not.toBeVisible();
  await expect(page.locator('.attempt')).toContainText('2번째 시도');
});
