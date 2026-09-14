import { test, expect, type Locator, type Page } from "@playwright/test";

async function step(page: Page, button: Locator) {
  const room = page.locator(".room-view");
  const revision = await room.getAttribute("data-revision");
  await button.click();
  await expect(room).not.toHaveAttribute("data-revision", revision!);
  await expect(room).toHaveAttribute("aria-busy", "false");
}
/**
 * 손패 카드는 겹쳐 배치되어 다음 카드가 이전 카드의 오른쪽 위로 겹친다.
 * 항상 노출되는 왼쪽 가장자리를 눌러야 실제 사용자처럼 올바른 카드를 클릭한다.
 */
async function tapCard(card: Locator, options?: { force?: boolean }) {
  const box = await card.boundingBox();
  if (!box) throw new Error("card not visible");
  await card.click({
    position: { x: 6, y: box.height / 2 },
    force: options?.force,
  });
}

test("illegal cards are greyed out, aria-disabled and unselectable; legal cards remain playable", async ({
  page,
}) => {
  test.setTimeout(90000);
  // Reproducible shuffle only; gameplay itself goes through the real UI.
  await page.addInitScript(() => {
    let n = 777;
    Math.random = () => {
      n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
      return n / 4294967296;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "4명", exact: true }).click();
  await page
    .getByRole("combobox", { name: "시작 미션", exact: true })
    .selectOption("4");
  await page
    .getByRole("button", { name: "탐사선 만들기", exact: true })
    .click();
  await expect(page).toHaveURL(/\/rooms\//);
  await step(page, page.getByRole("button", { name: "데모 대원 채우기" }));
  await step(
    page,
    page.getByRole("button", { name: "탑승 준비 완료", exact: true }),
  );
  await step(
    page,
    page.getByRole("button", { name: "임무 시작", exact: true }),
  );
  // 브리핑: 나부터 확인하고, 데모 대원들을 진행시킨다.
  if (await page.getByRole("button", { name: "임무 확인 완료", exact: true }).isVisible())
      await step(page, page.getByRole("button", { name: "임무 확인 완료", exact: true }));
  for (let i = 0; i < 3; i++)
    await step(page, page.getByRole("button", { name: "데모 대원 진행" }));
  // 임무 선택: 내 차례면 첫 목표를 고르고, 아니면 데모 대원을 진행시킨다.
  for (
    let i = 0;
    i < 6 && !(await page.locator(".table-surface").count());
    i++
  ) {
    const own = page.locator(
      ".target-list button:not([aria-disabled='true'])",
    );
    await step(
      page,
      (await own.count())
        ? own.first()
        : page.getByRole("button", { name: "데모 대원 진행" }),
    );
  }
  await expect(page.locator(".table-surface")).toBeVisible();
  let checkedIllegalCard = false;
  for (
    let turn = 0;
    turn < 60 &&
    !checkedIllegalCard &&
    !(await page.locator(".result-box").count());
    turn++
  ) {
    const bot = page.getByRole("button", { name: "데모 대원 진행" });
    const next = page.getByRole("button", { name: "다음 트릭", exact: true });
    if (await bot.isVisible()) {
      await step(page, bot);
      continue;
    }
    if (await next.isVisible()) {
      await step(page, next);
      continue;
    }
    // 내 차례: 규칙상 낼 수 없는 카드가 있는지 확인한다.
    const cards = page.locator(".hand-cards button");
    const count = await cards.count();
    const illegal = page.locator(".hand-cards button[aria-disabled='true']");
    const legal = page.locator(
      ".hand-cards button:not([aria-disabled='true'])",
    );
    if ((await illegal.count()) > 0) {
      checkedIllegalCard = true;
      const bad = illegal.first();
      await expect(bad).toHaveAttribute("aria-disabled", "true");
      const title = await bad.getAttribute("title");
      expect(title).toBeTruthy();
      // 불가 카드를 눌러도 선택되지 않는다(Playwright의 자동 actionability 체크가
      // aria-disabled를 이미 막지만, force로 실제 클릭 핸들러 동작까지 확인한다).
      await tapCard(bad, { force: true });
      await expect(bad).not.toHaveAttribute("aria-pressed", "true");
      const submitAfterIllegalTap = page.getByRole("button", {
        name: "선택한 카드 내기",
      });
      await expect(submitAfterIllegalTap).toBeDisabled();
      // 합법 카드는 선택하고 제출할 수 있다.
      const good = legal.first();
      await tapCard(good);
      await expect(good).toHaveAttribute("aria-pressed", "true");
      const submit = page.getByRole("button", { name: "선택한 카드 내기" });
      await expect(submit).toBeEnabled();
      await step(page, submit);
    } else {
      // 아직 선도 색 제약이 없다(내가 선도) — 합법 카드 아무거나 내고 계속 진행한다.
      for (let i = 0; i < count; i++) {
        const card = cards.nth(i);
        if ((await card.getAttribute("aria-disabled")) === "true") continue;
        if ((await card.getAttribute("aria-pressed")) !== "true")
          await tapCard(card);
        const submit = page.getByRole("button", { name: "선택한 카드 내기" });
        if (await submit.isEnabled()) {
          await step(page, submit);
          break;
        }
      }
    }
  }
  expect(checkedIllegalCard).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
