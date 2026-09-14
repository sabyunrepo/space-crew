import { test, expect } from "@playwright/test";
for (const capacity of [3, 4, 5]) test(`${capacity} directions: character, signal, play and always-visible owner goals`, async ({ page }, info) => {
  await page.goto("/");
  await expect(page.locator(".character-options button")).toHaveCount(15);
  await page.locator(".character-options").scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator(".character-options img").evaluateAll(imgs => imgs.every(img => (img as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.getByRole("button", { name: "요시 선택", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "대원 이름", exact: true })).toHaveValue("요시");
  await page.getByRole("button", { name: `${capacity}명`, exact: true }).click();
  await page.locator(".mission-select select").selectOption("4");
  await page.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\//);
  const step = async (button: ReturnType<typeof page.locator>) => {
    const room = page.locator(".room-view"); const revision = await room.getAttribute("data-revision");
    await button.click(); await expect(room).not.toHaveAttribute("data-revision", revision!);
  };
  await step(page.getByRole("button", { name: "데모 대원 채우기", exact: true }));
  await step(page.getByRole("button", { name: "탑승 준비 완료", exact: true }));
  await step(page.getByRole("button", { name: "임무 시작", exact: true }));
  for (let i = 0; i < 16 && !(await page.locator(".table-surface").count()); i++) {
    const goal = page.locator('.target-list button:not([aria-disabled="true"])');
    await step(await goal.count() ? goal.first() : page.getByRole("button", { name: "데모 대원 진행" }));
  }
  await expect(page.locator(".player-seat")).toHaveCount(capacity);
  await expect(page.locator(".seat-task")).toHaveCount(3);
  const goalRatio = await page.locator(".player-seat").filter({ has: page.locator(".seat-task") }).first().evaluate(el => el.querySelector(".seat-task")!.getBoundingClientRect().width / el.querySelector(".character-card")!.getBoundingClientRect().width);
  expect(goalRatio).toBeGreaterThan(.9);
  await expect(page.locator(".mission-public-tasks")).toHaveCount(0);
  await expect(page.locator(".player-seat[aria-current='true']")).toHaveCount(1);
  await expect(page.locator(".seat-turn-badge")).toBeVisible();
  await expect(page.locator(".seat-south .character-card")).toHaveAttribute("data-character-id", "green-dino");
  await expect(page.locator(".mission-panel-summary")).toBeVisible();
  await expect(page.getByRole("button", { name: "자세히", exact: true })).toHaveCount(0);
  const before = await page.locator(".player-seat").evaluateAll(els => els.map(el => [el.getAttribute("data-player-id"), el.getAttribute("data-position")]));
  await page.reload(); await expect(page.locator(".player-seat")).toHaveCount(capacity);
  expect(await page.locator(".player-seat").evaluateAll(els => els.map(el => [el.getAttribute("data-player-id"), el.getAttribute("data-position")]))).toEqual(before);
  // Bounding boxes catch clipping even when Playwright considers the element visible.
  const bounds = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
    return { height: innerHeight, scrollHeight: document.documentElement.scrollHeight, mission: rect(".mission-panel"), central: rect(".central-trick"), hand: rect(".hand-dock"), width: innerWidth,
      seats: [...document.querySelectorAll(".player-seat")].map(el => el.getBoundingClientRect().toJSON()),
      rows: [...document.querySelectorAll(".player-seat")].map(el => ({
        columns: [...el.querySelectorAll(".seat-column")].map(x => x.getBoundingClientRect().toJSON()),
        goals: el.querySelector(".seat-missions")!.getBoundingClientRect().toJSON(),
      })) };
  });
  expect(bounds.scrollHeight).toBeLessThanOrEqual(bounds.height + 1);
  expect(bounds.hand.bottom).toBeLessThanOrEqual(bounds.height);
  for (const seat of bounds.seats) { expect(seat.top).toBeGreaterThanOrEqual(bounds.mission.bottom); expect(seat.bottom).toBeLessThanOrEqual(bounds.hand.top); expect(seat.left).toBeGreaterThanOrEqual(0); expect(seat.right).toBeLessThanOrEqual(bounds.width); }
  for (const { columns, goals } of bounds.rows) { expect(columns[0].right).toBeLessThan(columns[1].left); expect(columns).toHaveLength(2); expect(goals.top).toBeGreaterThanOrEqual(columns[0].bottom); }
  await expect(page.locator(".central-play")).toHaveCount(capacity);
  for (const seat of bounds.seats) {
    const center = bounds.central;
    expect(seat.right <= center.left || center.right <= seat.left || seat.bottom <= center.top || center.bottom <= seat.top).toBe(true);
  }
  for (let i=0;i<bounds.seats.length;i++) for(let j=i+1;j<bounds.seats.length;j++) {
    const a=bounds.seats[i],b=bounds.seats[j];
    expect(a.right<=b.left || b.right<=a.left || a.bottom<=b.top || b.bottom<=a.top).toBe(true);
  }
  const playable = page.locator('.hand-cards button[aria-disabled="false"]');
  if (await playable.count()) {
    await playable.first().click({ position: { x: 4, y: 30 } });
    await step(page.getByRole("button", { name: "선택한 카드 내기", exact: true }));
  } else await step(page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  await expect(page.locator(".central-play .played-card")).toHaveCount(1);
  const submitBounds = await page.getByRole("button", { name: "선택한 카드 내기", exact: true }).boundingBox();
  const handBounds = await page.locator(".hand-cards").boundingBox();
  expect(submitBounds!.y + submitBounds!.height).toBeLessThanOrEqual(handBounds!.y);
  expect(Math.abs(submitBounds!.x + submitBounds!.width / 2 - handBounds!.x - handBounds!.width / 2)).toBeLessThan(1);
  if (info.project.name === "desktop") {
    const compactWidth = (await page.locator(".central-play .played-card").boundingBox())!.width;
    await page.setViewportSize({ width: 2279, height: 1456 });
    await expect.poll(async () => (await page.locator(".central-play .played-card").boundingBox())!.width).toBeGreaterThan(compactWidth * 1.5);
    const expanded = await page.locator(".central-trick").boundingBox();
    const dock = await page.locator(".hand-dock").boundingBox();
    expect(expanded!.y + expanded!.height).toBeLessThanOrEqual(dock!.y);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  }

  await expect(page.locator(".player-seat .played-card")).toHaveCount(0);
  await page.screenshot({ path: `artifacts/qa/characters/${info.project.name}-${capacity}-table.png` });
});

test("communication token geometry and used-card cleanup", async ({ page }) => {
  await page.goto("/tests/fixtures/communication.html");
  await expect(page.locator(".broadcast")).toHaveCount(3);
  const ratios = await page.locator(".communication-card.broadcast").evaluateAll(cards => cards.map(card => { const c=card.getBoundingClientRect(), t=card.querySelector(".signal-token")!.getBoundingClientRect(); return (t.top+t.height/2-c.top)/c.height; }));
  ratios.forEach((ratio,i) => expect(ratio).toBeCloseTo([.15,.5,.85][i],2));
  await expect(page.locator(".communication-card.used img")).toHaveCount(0);
  await expect(page.locator(".communication-card.used")).toHaveAccessibleName("교신 사용 완료 · 공개한 카드를 냈습니다");
});


test("character selection supplies a name that can still be edited", async ({ page }) => {
  await page.goto("/");
  for (const name of ["스폰지밥", "요시", "콜드", "코랄", "베이", "트리"]) {
    await page.getByRole("button", { name: `${name} 선택`, exact: true }).click();
    await expect(page.getByRole("textbox", { name: "대원 이름", exact: true })).toHaveValue(name);
  }
  await page.getByRole("textbox", { name: "대원 이름", exact: true }).fill("내 별명");
  await page.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
  await expect(page.locator(".crew-member").filter({ hasText: "내 별명" })).toHaveCount(1);
});
