import { test, expect } from '@playwright/test';
test('completed goals, next priority, lead effect and distinct signal states', async ({page}, info) => {
  await page.goto('/tests/fixtures/card-states.html');
  const goals=page.getByRole('region',{name:'목표 상태'});
  const signals=page.getByRole('region',{name:'교신 상태 비교'});
  await expect(goals.locator('.task-order')).toHaveText(['>','>>','>>>','>>>>']);
  await expect(goals.locator('.current-goal')).toHaveAccessibleName(/초록 2.*현재 우선 목표/);
  await expect(page.locator('.card-value, .lead-card-label')).toHaveCount(0);
  await expect(page.locator('.central-play .lead-card')).toHaveCount(1);
  await expect(page.locator('.lead-card')).toHaveAccessibleName(/파랑 5.*선도 카드/);
  for (const theme of ['dark','light']) {
    if(theme==='light')await page.getByRole('button',{name:'테마 전환'}).click();
    expect(await goals.locator('.success img').evaluate(el=>getComputedStyle(el).filter)).toContain('grayscale(1)');
    expect(await goals.locator('.current-goal').evaluate(el=>getComputedStyle(el).outlineStyle)).toBe('solid');
    const backgrounds=await signals.locator('.signal-back').evaluateAll(els=>els.map(el=>getComputedStyle(el).background));
    expect(new Set(backgrounds).size).toBe(3);
    await expect(signals.locator('.blocked .lucide-radio-off')).toHaveCount(2);
    await expect(signals.locator('.used img')).toHaveCount(0);
    await expect(signals.locator('.broadcast .token-hidden')).toHaveText('D');
    await page.screenshot({path:`artifacts/qa/card-states/${info.project.name}-${theme}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'다음 목표 완료'}).click();
  await expect(goals.locator('.success')).toHaveCount(2);
  await expect(goals.locator('.current-goal')).toHaveAccessibleName(/노랑 3.*현재 우선 목표/);
  await page.getByRole('button',{name:'대원 교신 제한 전환'}).click();
  await expect(page.getByRole('button',{name:'교신하기',exact:true})).toHaveCount(0);
  await expect(page.locator('section.player-seat .communication-card.blocked')).toHaveAccessibleName('교신 금지');
  await page.getByRole('button',{name:'대원 교신 제한 전환'}).click();
  await expect(page.getByRole('button',{name:'교신하기',exact:true})).toBeVisible();
  if (info.project.name === 'desktop') {
    const seat = page.locator('.seat-layout .player-seat').filter({has:page.locator('.seat-task')});
    await expect(seat).toHaveAttribute('data-goal-flow','vertical');
    await page.getByRole('button',{name:'목표 영역 비율 전환'}).click();
    await expect(seat).toHaveAttribute('data-goal-flow','horizontal');
    const signal = (await seat.locator('.communication-card').boundingBox())!;
    const cards=await seat.locator('.seat-task').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().toJSON()));
    for (const card of cards) {
      expect(Math.abs(card.width - signal.width)).toBeLessThan(1);
      expect(Math.abs(card.height - signal.height)).toBeLessThan(1);
    }
    expect(cards[0].top).toBeCloseTo(cards[1].top,0);
    expect(cards[1].left).toBeGreaterThan(cards[0].left);
  }
});
