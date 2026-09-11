import { test, expect } from "@playwright/test";

test("separate users cannot join the local-only room; same-profile tab resumes the same seat", async ({
  browser,
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "대원 이름", exact: true })
    .fill("방장-A");
  await page
    .getByRole("button", { name: "탐사선 만들기", exact: true })
    .click();
  await expect(page).toHaveURL(/\/rooms\//);
  const roomUrl = page.url();
  await page.getByRole("button", { name: "초대 링크", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("복사했습니다");
  const invite = await page.evaluate(() => navigator.clipboard.readText());
  const observations: unknown[] = [];
  for (const nickname of ["독립-B", "독립-C"]) {
    const guestContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    try {
      const guest = await guestContext.newPage();
      await guest.goto(invite);
      await guest
        .getByRole("textbox", { name: "대원 이름", exact: true })
        .fill(nickname);
      await guest.getByRole("button", { name: "탐사선 탑승하기" }).click();
      await expect(guest.getByRole("alert")).toContainText(
        "로컬 데모 링크는 같은 브라우저에서만",
      );
      await expect(guest).toHaveURL(/\/join#/);
      observations.push({
        user: nickname,
        joined: false,
        message: await guest.getByRole("alert").innerText(),
      });
      await guest.screenshot({
        path: `artifacts/qa/independent-${nickname.at(-1)}-${testInfo.project.name}.png`,
        fullPage: true,
      });
    } finally {
      await guestContext.close();
    }
  }
  const sibling = await context.newPage();
  await sibling.goto(invite);
  await sibling
    .getByRole("textbox", { name: "대원 이름", exact: true })
    .fill("새 대원인 척");
  await sibling.getByRole("button", { name: "탐사선 탑승하기" }).click();
  await expect(sibling).toHaveURL(roomUrl);
  await expect(
    sibling.locator(".crew-member").filter({ hasText: "방장-A" }),
  ).toContainText("나");
  await expect(
    sibling.locator(".crew-member").filter({ hasText: "새 대원인 척" }),
  ).toHaveCount(0);
  await sibling
    .getByRole("button", { name: "탑승 준비 완료", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "준비 취소", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "임무 시작", exact: true }),
  ).toBeDisabled();
  observations.push({
    sameProfile: "same seat; ready state synchronized",
    independentMultiplayer: "BLOCKED: no shared backend",
  });
  await testInfo.attach("multiplayer-boundary.json", {
    body: JSON.stringify(observations, null, 2),
    contentType: "application/json",
  });
  await sibling.close();
});
