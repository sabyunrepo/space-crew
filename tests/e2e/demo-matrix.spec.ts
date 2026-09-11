import { test, expect, type Locator, type Page } from "@playwright/test";

async function step(page: Page, button: Locator) {
  const room = page.locator(".room-view");
  const revision = await room.getAttribute("data-revision");
  await button.click();
  await expect(room).not.toHaveAttribute("data-revision", revision!);
  await expect(room).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("alert")).toHaveCount(0);
}
async function choose(page: Page, index: number) {
  const card = page.locator(".hand-cards button").nth(index);
  if ((await card.getAttribute("aria-pressed")) !== "true") await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
}
const scenarios = [3, 4, 5]
  .flatMap((capacity) =>
    [1, 2, 3, 4].map((mission) => ({
      capacity,
      mission,
      seed: capacity * 100 + mission,
      expectedSuccess: false,
    })),
  )
  .concat(
    [3, 4, 5].map((capacity) => ({
      capacity,
      mission: 1,
      seed: capacity === 5 ? 3 : 2,
      expectedSuccess: true,
    })),
  );
for (const { capacity, mission, seed, expectedSuccess } of scenarios) {
  test(`demo only: ${capacity} seats, mission ${mission}${expectedSuccess ? ", success path" : ""}, communicate, finish, resume and retry/next`, async ({
    page,
  }, info) => {
    test.setTimeout(90000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Reproducible shuffle only; all gameplay uses the UI, no injected hands/state or API mocks.
    await page.addInitScript((seed) => {
      let n = seed;
      Math.random = () => {
        n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
        return n / 4294967296;
      };
    }, seed);
    await page.goto("/");
    await page
      .getByRole("button", { name: `${capacity}명`, exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "시작 미션", exact: true })
      .selectOption(String(mission));
    await page
      .getByRole("button", { name: "탐사선 만들기", exact: true })
      .click();
    await expect(page).toHaveURL(/\/rooms\//);
    await step(page, page.getByRole("button", { name: "데모 대원 채우기" }));
    await step(
      page,
      page.getByRole("button", { name: "탑승 준비 완료", exact: true }),
    );
    if (expectedSuccess)
      await page.evaluate((seed) => {
        let n = seed;
        Math.random = () => {
          n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
          return n / 4294967296;
        };
      }, seed);
    await step(
      page,
      page.getByRole("button", { name: "임무 시작", exact: true }),
    );
    await expect(page.locator(".hand-cards button")).toHaveCount(
      Math.ceil(40 / capacity),
    );
    const hand = await page
      .locator(".hand-cards img")
      .evaluateAll((els) => els.map((e) => e.getAttribute("alt")));
    const revision = await page
      .locator(".room-view")
      .getAttribute("data-revision");
    await page.reload();
    await expect(page.locator(".room-view")).toHaveAttribute(
      "data-revision",
      revision!,
    );
    expect(
      await page
        .locator(".hand-cards img")
        .evaluateAll((els) => els.map((e) => e.getAttribute("alt"))),
    ).toEqual(hand);
    await step(
      page,
      page.getByRole("button", { name: "임무 확인 완료", exact: true }),
    );
    await expect(page.locator(".crew-member").first()).toContainText(
      "브리핑 확인 완료",
    );
    await expect(page.locator(".crew-member").nth(1)).toContainText(
      "브리핑 확인 중",
    );
    for (let i = 1; i < capacity; i++)
      await step(page, page.getByRole("button", { name: "데모 대원 진행" }));
    for (
      let i = 0;
      i < 4 && !(await page.locator(".table-surface").count());
      i++
    ) {
      const own = page.locator(".target-list button:not([disabled])");
      await step(
        page,
        (await own.count())
          ? own.first()
          : page.getByRole("button", { name: "데모 대원 진행" }),
      );
    }
    await expect(page.locator(".table-surface")).toBeVisible();
    // Any crew member may communicate before the leading card, including off-turn.
    let communicated = false;
    for (
      let i = 0;
      i < (await page.locator(".hand-cards button").count());
      i++
    ) {
      await choose(page, i);
      const signal = page.locator(".communication-options button");
      if (await signal.count()) {
        await step(page, signal.first());
        communicated = true;
        break;
      }
    }
    expect(communicated).toBe(true);
    await expect(page.locator(".crew-member .communication")).toHaveCount(1);
    await expect(page.locator(".communication-options button")).toHaveCount(0);
    let ownPlays = 0,
      botPlays = 0;
    for (
      let i = 0;
      i < 75 && !(await page.locator(".result-box").count());
      i++
    ) {
      const bot = page.getByRole("button", { name: "데모 대원 진행" });
      const next = page.getByRole("button", { name: "다음 트릭", exact: true });
      if (await bot.isVisible()) {
        await step(page, bot);
        botPlays++;
        continue;
      }
      if (await next.isVisible()) {
        await step(page, next);
        continue;
      }
      let played = false;
      for (
        let index = 0;
        index < (await page.locator(".hand-cards button").count());
        index++
      ) {
        await choose(page, index);
        const submit = page.getByRole("button", { name: "선택한 카드 내기" });
        if (await submit.isEnabled()) {
          await step(page, submit);
          ownPlays++;
          played = true;
          break;
        }
      }
      expect(played).toBe(true);
    }
    await expect(page.locator(".result-box")).toBeVisible();
    const outcome = await page.locator(".result-box h2").innerText();
    if (expectedSuccess)
      await expect(page.locator(".result-box")).toHaveClass(/success/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await expect(page.locator(".result-box h2")).toHaveText(outcome);
    await expect(page.locator(".crew-member .communication")).toHaveCount(1);
    const retry = page.getByRole("button", { name: "같은 미션 다시 도전" });
    const nextMission = page.getByRole("button", {
      name: "다음 임무",
      exact: true,
    });
    await page.screenshot({
      path: `artifacts/qa/demo-${capacity}p-m${mission}${expectedSuccess ? "-success" : ""}-${info.project.name}.png`,
      fullPage: true,
    });
    if (await retry.isVisible()) {
      await step(page, retry);
      await expect(page.locator(".mission-strip")).toContainText(
        `MISSION ${String(mission).padStart(2, "0")}`,
      );
      await expect(page.locator(".attempt")).toContainText("2번째 시도");
      await expect(page.locator(".crew-member .communication")).toHaveCount(0);
    } else if (mission < 4) {
      await step(page, nextMission);
      await expect(page.locator(".mission-strip")).toContainText(
        `MISSION ${String(mission + 1).padStart(2, "0")}`,
      );
    } else await expect(nextMission).toBeDisabled();
    expect(errors).toEqual([]);
    await info.attach("demo-result.json", {
      body: JSON.stringify({
        capacity,
        mission,
        seed,
        expectedSuccess,
        outcome,
        ownPlays,
        botPlays,
        communicated,
        realMultiplayer: false,
      }),
      contentType: "application/json",
    });
  });
}
