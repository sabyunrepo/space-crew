import { test, expect, type Page, type Locator } from '@playwright/test';
async function step(page: Page, button: Locator) {
  const room = page.locator('.room-view'); const revision = await room.getAttribute('data-revision');
  await button.click(); await expect(room).not.toHaveAttribute('data-revision', revision!);
  await expect(room).toHaveAttribute('aria-busy', 'false');
}
for (const mission of [4, 6]) test(`mission ${mission}: own signal, cancel, confirm and compact status`, async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: '시작 미션', exact: true }).selectOption(String(mission));
  await page.getByRole('button', { name: '탐사선 만들기', exact: true }).click();
  for (const name of ['데모 대원 채우기', '탑승 준비 완료', '임무 시작']) await step(page, page.getByRole('button', { name, exact: true }));
  for (let i = 0; i < 16 && await page.locator('.mission-setup-modal').count(); i++) {
    const goal = page.locator('.target-list button:not([aria-disabled="true"])');
    await step(page, await goal.count() ? goal.first() : page.getByRole('button', { name: '데모 대원 진행' }));
  }
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '상단 안내 펼치기', exact: true }).click();
  await expect(page.locator('.status-bar .mission-panel')).toBeVisible();
  await expect(page.locator('.game-table-body > .mission-panel')).toHaveCount(0);
  const restart = page.getByRole('button', { name: '게임 포기 · 재시작', exact: true });
  expect((await restart.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(page.locator('.status-invite + .status-restart')).toHaveCount(1);
  await page.getByRole('button', { name: '미션 조건', exact: true }).click();
  const details = page.getByRole('dialog', { name: '미션 조건 상세' });
  await expect(details).toBeVisible(); await expect(details).toContainText(`미션 0${mission}`);
  const crew = details.getByRole('region', { name: '참가 대원 3명' });
  await expect(crew.getByRole('listitem')).toHaveCount(3);
  await expect(crew.locator('img')).toHaveCount(3);
  await expect(crew).toContainText('사령관');
  await expect(crew).toContainText('나');
  await details.getByRole('button', { name: '닫기' }).click();
  if (info.project.name === 'mobile') await page.getByRole('button', { name: '상단 안내 접기', exact: true }).click();
  await expect(page.locator('.player-seat:not(.seat-south) .seat-communication-button')).toHaveCount(0);
  const signal = page.locator('.seat-south .seat-communication-button');
  const beforeToggle = await page.locator('.room-view').getAttribute('data-revision');
  await signal.click();
  await expect(signal).toHaveAccessibleName('교신 취소');
  await expect(signal).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.hand-comm-cancel')).toHaveCount(0);
  await signal.click();
  await expect(signal).toHaveAccessibleName('교신하기');
  await expect(signal).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: '선택한 카드 내기', exact: true })).toBeDisabled();
  await expect(page.locator('.room-view')).toHaveAttribute('data-revision', beforeToggle!);
  await signal.click();
  const card = page.locator('.hand-cards button[aria-disabled="false"]').first();
  const revision = await page.locator('.room-view').getAttribute('data-revision');
  await card.click({ position: { x: 4, y: 30 } });
  const modal = page.getByRole('dialog', { name: '이 카드로 교신할까요?' });
  await expect(modal).toBeVisible();
  expect((await modal.locator('.communication-card').boundingBox())!.width).toBeGreaterThanOrEqual(120);
  await expect(page.locator('.communication-options')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(modal).toHaveCount(0);
  await expect(page.locator('.room-view')).toHaveAttribute('data-revision', revision!);
  await expect(card).toBeFocused();
  await signal.click();
  await expect(page.locator('.hand-cards button[aria-pressed="true"]')).toHaveCount(0);
  await signal.click();
  await card.click({ position: { x: 4, y: 30 } });
  await expect(modal).toBeVisible();
  if (mission === 6) {
    await expect(modal.locator('.token-hidden')).toBeVisible();
    await expect(modal).toContainText('최고·최저·유일 여부 비공개');
  }
  await page.screenshot({ path: `artifacts/qa/communication/${info.project.name}-${mission}-confirm.png` });
  await step(page, modal.getByRole('button', { name: '교신 보내기', exact: true }));
  await expect(modal).toHaveCount(0);
  await expect(page.locator('.seat-south .communication-card.broadcast')).toBeVisible();
  if (mission === 6) await expect(page.locator('.seat-south .token-hidden')).toBeVisible();
  await expect(signal).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});
