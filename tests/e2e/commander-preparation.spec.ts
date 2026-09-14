import { expect, test, type Page, type Locator } from "@playwright/test";

async function step(page: Page, button: Locator) {
  const revision = await page.locator(".room-view").getAttribute("data-revision");
  await button.click();
  await expect(page.locator(".room-view")).not.toHaveAttribute("data-revision", revision!);
  await expect(page.locator(".room-view")).toHaveAttribute("aria-busy", "false");
}
for (const mission of [33, 20, 24]) test(`commander answers then decides; mission ${mission} reveals only permitted tasks`, async ({ page }, info) => {
  // An unchanged deck deals rocket4 (index39) to the first of three players.
  await page.addInitScript(() => { Math.random = () => .999999; });
  await page.goto("/");
  await page.getByRole("combobox", { name: "시작 미션", exact: true }).selectOption(String(mission));
  await page.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
  for (const name of ["데모 대원 채우기", "탑승 준비 완료", "임무 시작"])
    await step(page, page.getByRole("button", { name, exact: true }));
  const total = mission === 33 ? 0 : mission === 20 ? 2 : 6;
  await expect(page.locator(".mission-setup-modal .mission-task-info")).toContainText(`목표 카드 총 ${total}장`);
  await expect(page.locator(".mission-public-tasks .seat-task")).toHaveCount(0);
  await step(page, page.getByRole("button", { name: "임무 확인 완료", exact: true }));
  for (let i = 0; i < 3 && !(await page.locator(".mission-preparation").count()); i++)
    await step(page, page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  const prep = page.locator(".mission-preparation");
  await expect(prep).toContainText("내가 지휘관");
  await expect(prep.getByRole("heading", { name: "1. 내 응답", exact: true })).toBeVisible();
  await expect(prep.getByRole("combobox", { name: "담당 대원", exact: true })).toHaveCount(0);
  await step(page, prep.getByRole("button", { name: "예", exact: true }));
  await expect(prep.locator(".preparation-next-action")).toContainText("내 응답: 예");
  for (let i = 0; i < 3 && !(await prep.locator(".preparation-decision").count()); i++)
    await step(page, page.getByRole("button", { name: "데모 대원 진행", exact: true }));
  await expect(prep.locator(".preparation-next-action")).toContainText("내 결정 차례입니다");
  await expect(prep.locator(".preparation-next-action")).not.toContainText("기다립니다");
  await page.reload();
  const recipient = prep.getByRole("combobox", { name: "담당 대원", exact: true });
  await expect(recipient).toBeFocused();
  await expect(prep.getByRole("button", { name: "예", exact: true })).toHaveCount(0);
  await expect(prep.locator(".preparation-active-task .seat-task")).toHaveCount(mission === 24 ? 1 : 0);
  await expect(page.locator(".mission-public-tasks .seat-task")).toHaveCount(mission === 24 ? 1 : 0);
  await recipient.selectOption({ label: "루나" });
  const confirm = prep.getByRole("button", { name: mission === 24 ? "목표 배정" : "담당자 확정", exact: true });
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: `artifacts/qa/missions/m${mission}-commander-choice-${info.project.name}.png` });
  await step(page, confirm);
  if (mission === 24) {
    await expect(prep.getByRole("button", { name: "예", exact: true })).toBeVisible();
    await expect(page.locator(".player-seat .seat-task")).toHaveCount(1);
    await expect(page.locator(".mission-setup-modal .mission-task-info")).toContainText("배정 1장 · 아직 비공개 4장");
  } else {
    await expect(page.locator(".mission-setup-modal")).toHaveCount(0);
    await expect(page.locator(".player-seat .seat-task")).toHaveCount(total);
  }
});
