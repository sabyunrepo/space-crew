import { test, expect, type Locator } from "@playwright/test";
test("create, invite, resume and play a mission with private hand controls", async ({
  page,
  context,
}) => {
  const step = async (button: Locator) => {
    const room = page.locator(".room-view");
    const revision = await room.getAttribute("data-revision");
    await button.click();
    await expect(room).not.toHaveAttribute("data-revision", revision!);
    await expect(room).toHaveAttribute("aria-busy", "false");
  };
  // 손패 카드는 겹쳐 배치되어 다음 카드가 오른쪽 위로 겹친다. 항상 노출되는
  // 왼쪽 가장자리를 눌러야 실제 사용자처럼 올바른 카드를 클릭한다.
  const tapCard = async (card: Locator) => {
    const box = await card.boundingBox();
    if (!box) throw new Error("card not visible");
    await card.click({ position: { x: 6, y: box.height / 2 } });
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "목적지는 멀리. 우리는 함께." }),
  ).toBeVisible();
  await expect(page.locator(".hero-card img")).toHaveCount(3);
  expect(
    await page
      .locator(".hero-card img")
      .evaluateAll((images) =>
        images.every(
          (img) =>
            (img as HTMLImageElement).complete &&
            (img as HTMLImageElement).naturalWidth > 0,
        ),
      ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "탐사선 만들기", exact: true })
    .click();
  await expect(page).toHaveURL(/\/rooms\//);
  const originalRoomUrl = page.url();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "초대 링크", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("복사했습니다");
  const invite = await page.evaluate(() => navigator.clipboard.readText());
  expect(invite).toContain("/join#");
  await page.goto(invite);
  await page.getByRole("button", { name: "탐사선 탑승하기" }).click();
  await expect(page).toHaveURL(originalRoomUrl);
  await expect(page.locator(".room-view")).toHaveAttribute("aria-busy", "false");
  await step(page.getByRole("button", { name: "데모 대원 채우기" }));
  await step(page.getByRole("button", { name: "탑승 준비 완료", exact: true }));
  await step(page.getByRole("button", { name: "임무 시작", exact: true }));
  await expect(
    page.getByRole("dialog", { name: "목표 카드 선택", exact: true }),
  ).toBeVisible();
  const hand = await page
    .locator(".hand-cards img")
    .evaluateAll((images) => images.map((img) => img.getAttribute("alt")));
  const url = page.url();
  await page.reload();
  await expect(page.locator(".hand-cards .card")).toHaveCount(14);
  expect(
    await page
      .locator(".hand-cards img")
      .evaluateAll((images) => images.map((img) => img.getAttribute("alt"))),
  ).toEqual(hand);
  for (let i = 0; i < 2; i++)
    await step(page.getByRole("button", { name: "데모 대원 진행" }));
  for (let i = 0; i < 8; i++) {
    if (await page.locator(".target-list button:not([aria-disabled='true'])").count())
      await step(page.locator(".target-list button:not([aria-disabled='true'])").first());
    else if (
      await page.getByRole("button", { name: "데모 대원 진행" }).isVisible()
    )
      await step(page.getByRole("button", { name: "데모 대원 진행" }));
    if (await page.locator(".table-surface").count()) break;
  }
  await expect(page.locator(".table-surface")).toBeVisible();
  for (let turn = 0; turn < 70; turn++) {
    if (await page.locator(".result-box").count()) break;
    const bot = page.getByRole("button", { name: "데모 대원 진행" }),
      next = page.getByRole("button", { name: "다음 트릭", exact: true });
    if (await bot.isVisible()) {
      await step(bot);
      continue;
    }
    if (await next.isVisible()) {
      await step(next);
      continue;
    }
    const cards = page.locator(".hand-cards button");
    let played = false;
    for (let i = 0; i < (await cards.count()); i++) {
      // 규칙상 낼 수 없는(aria-disabled) 카드는 선택되지 않으므로 건너뛴다.
      if ((await cards.nth(i).getAttribute("aria-disabled")) === "true")
        continue;
      if ((await cards.nth(i).getAttribute("aria-pressed")) !== "true")
        await tapCard(cards.nth(i));
      await expect(cards.nth(i)).toHaveAttribute("aria-pressed", "true");
      const submit = page.getByRole("button", { name: "선택한 카드 내기" });
      if (await submit.isEnabled()) {
        await step(submit);
        played = true;
        break;
      }
    }
    expect(played).toBe(true);
  }
  await expect(page.locator(".result-box")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(page.locator(".result-box")).toBeVisible();
  expect(page.url()).toBe(url);
  const resultModal = page.locator(".mission-result-modal");
  await expect(resultModal).toBeVisible();
  await expect(resultModal.locator("h2")).toBeFocused();
  const resultRevision = await page.locator(".room-view").getAttribute("data-revision");
  await page.keyboard.press("Escape");
  await expect(resultModal).not.toBeVisible();
  await expect(page.locator(".room-view")).toHaveAttribute("data-revision", resultRevision!);
  await expect(page.getByRole("button", { name: "결과 다시 보기", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "결과 다시 보기", exact: true }).click();
  await expect(resultModal).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({
    path: `test-results/room-${test.info().project.name}.png`,
    fullPage: true,
  });
});
test("all 50 missions selectable, random mode explained, all 41 assets load", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "50개 미션 살펴보기" }).click();
  await expect(page.locator(".mission-catalogue article")).toHaveCount(50);
  await page
    .locator(".mission-catalogue article")
    .last()
    .getByRole("button", { name: "선택", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "시작 미션", exact: true }),
  ).toHaveValue("50");
  await page.getByRole("button", { name: "랜덤 탐사" }).click();
  await expect(
    page.getByText("현재 실행 가능한 1~50번 미션 중 추첨합니다.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "카드 도감", exact: true }).click();
  await expect(page.locator(".card-catalogue img")).toHaveCount(41);
  for (const img of await page.locator(".card-catalogue img").all()) {
    await img.scrollIntoViewIfNeeded();
    await expect(img).toHaveJSProperty("complete", true);
    expect(
      await img.evaluate((el) => (el as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
  }
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.screenshot({
    path: `test-results/home-${test.info().project.name}.png`,
    fullPage: true,
  });
});
