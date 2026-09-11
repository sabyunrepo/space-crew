import { test, expect, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * Task 5 — 서버 모드(`VITE_BACKEND_MODE=server`, 실제 Node 서버 + WS) 통합
 * 검증. mock 모드 e2e(`tests/e2e/*.spec.ts`, `playwright.config.ts`)와 달리
 * 서로 다른 브라우저 컨텍스트(= 서로 다른 브라우저·기기를 흉내)가 초대
 * 링크로 같은 방에 실제로 들어와 카드를 주고받는다.
 */

async function step(page: Page, button: Locator) {
  const room = page.locator(".room-view");
  const revision = await room.getAttribute("data-revision");
  await button.click();
  await expect(room).not.toHaveAttribute("data-revision", revision ?? "");
  await expect(room).toHaveAttribute("aria-busy", "false");
}

/** 손패 카드는 겹쳐 배치되므로 항상 노출되는 왼쪽 가장자리를 클릭한다. */
async function tapCard(card: Locator) {
  const box = await card.boundingBox();
  if (!box) throw new Error("card not visible");
  await card.click({ position: { x: 6, y: box.height / 2 } });
}

type Ctx = { label: string; page: Page; isHost: boolean };

/**
 * 한 컨텍스트에서 지금 할 수 있는 행동이 있으면 하나 실행하고 true를,
 * 없으면 false를 반환한다(다른 대원의 차례를 기다리는 중). 여러 컨텍스트를
 * 돌아가며 이 함수를 반복 호출하는 것이 곧 "실제로 같이 플레이하기"다.
 */
async function tick(
  ctx: Ctx,
  illegalCheck: { done: boolean },
  wsCheck?: { done: boolean; peers: Ctx[] },
): Promise<boolean> {
  const { page, isHost } = ctx;

  const briefingBtn = page.getByRole("button", {
    name: "임무 확인 완료",
    exact: true,
  });
  if (await briefingBtn.isVisible().catch(() => false)) {
    await step(page, briefingBtn);
    return true;
  }

  const taskBtn = page
    .locator(".target-list button:not([aria-disabled='true'])")
    .first();
  if (await taskBtn.isVisible().catch(() => false)) {
    await step(page, taskBtn);
    return true;
  }

  // Hand은 briefing·task_selection·trick_result 단계에서도 항상 렌더링되고,
  // 그 단계들의 handAvailability(mode:"view")는 모든 카드를 enabled로 두므로
  // "aria-disabled 아닌 카드가 있다"만으로는 "지금이 playing 단계다"를 판별할
  // 수 없다. StatusBar 문구는 playing 단계일 때만 "차례"를 포함하므로 이를
  // 함께 확인해 다른 단계에서 손패를 잘못 제출 시도하지 않게 한다.
  const statusText = await page
    .locator(".status-message span")
    .innerText()
    .catch(() => "");
  const isPlayingPhase = statusText.includes("차례");
  const legalCards = page.locator(".hand-cards button:not([aria-disabled='true'])");
  const legalCount = isPlayingPhase ? await legalCards.count().catch(() => 0) : 0;
  if (legalCount > 0) {
    if (!illegalCheck.done) {
      const illegal = page.locator(".hand-cards button[aria-disabled='true']");
      const illegalCount = await illegal.count();
      if (illegalCount > 0) {
        const bad = illegal.first();
        await expect(bad).toHaveAttribute("aria-disabled", "true");
        const title = await bad.getAttribute("title");
        expect(title).toBeTruthy();
        illegalCheck.done = true;
      }
    }
    await tapCard(legalCards.first());
    const submit = page.getByRole("button", { name: "선택한 카드 내기" });
    await expect(submit).toBeEnabled();
    await step(page, submit);
    // WS push 검증: 카드를 낸 화면 자신은 새로고침 없이도 즉시 반영되므로
    // (이미 자신의 명령 응답으로 반영됨) 의미가 없다 — 대신 "제3자" 화면이
    // 아무것도 하지 않았는데도 5초 안에 방금 낸 카드를 보게 되는지 확인한다.
    if (wsCheck && !wsCheck.done) {
      const peer = wsCheck.peers.find((p) => p.page !== page);
      if (peer) {
        wsCheck.done = true;
        await expect(
          peer.page.locator(".played-cards .played-slot .card"),
        ).not.toHaveCount(0, { timeout: 5000 });
      }
    }
    return true;
  }

  if (isHost) {
    const nextTrick = page.getByRole("button", {
      name: "다음 트릭",
      exact: true,
    });
    if (await nextTrick.isVisible().catch(() => false)) {
      await step(page, nextTrick);
      return true;
    }
  }
  return false;
}

async function anyResult(pages: Page[]): Promise<boolean> {
  for (const page of pages) {
    if (await page.locator(".result-box").count()) return true;
  }
  return false;
}

/**
 * `tick()`을 여러 컨텍스트에 돌아가며 반복 호출해 결과 화면(성공/실패)에
 * 도달할 때까지 게임을 진행한다. `onTrickAdvanced`는 host가 "다음 트릭"을
 * 눌러 다음 트릭으로 넘어갈 때마다(트릭 번호 무관하게) 호출된다 — 중간에
 * 새로고침 검증 등 부수 작업을 끼워 넣는 용도.
 */
async function playUntilResult(
  contexts: Ctx[],
  illegalCheck: { done: boolean },
  options?: {
    wsCheck?: { done: boolean; peers: Ctx[] };
    onTrickAdvanced?: (trickAdvanceCount: number) => Promise<void>;
  },
) {
  let round = 0;
  const maxRounds = 300;
  let trickAdvanceCount = 0;
  while (round < maxRounds && !(await anyResult(contexts.map((c) => c.page)))) {
    let acted = false;
    for (const ctx of contexts) {
      const before =
        ctx.isHost &&
        (await ctx.page
          .getByRole("button", { name: "다음 트릭", exact: true })
          .isVisible()
          .catch(() => false));
      if (await tick(ctx, illegalCheck, options?.wsCheck)) {
        acted = true;
        if (before) {
          trickAdvanceCount++;
          if (options?.onTrickAdvanced) await options.onTrickAdvanced(trickAdvanceCount);
        }
      }
    }
    round++;
    if (!acted) await contexts[0].page.waitForTimeout(300);
  }
  expect(round).toBeLessThan(maxRounds);
}

test.describe("서버 모드 다인 플레이", () => {
  test("세 브라우저가 초대 링크로 같은 방에 들어와 미션 1을 결과까지 진행한다", async ({
    browser,
  }, testInfo) => {
    // 3인 실제 네트워크 왕복으로 미션 1을 최대 13트릭까지 끝까지 진행할 수
    // 있어 60~150초로는 부족할 때가 있다.
    test.setTimeout(240_000);

    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const ctxC = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctxA.grantPermissions(["clipboard-read", "clipboard-write"]);

    const contextsToClose: BrowserContext[] = [ctxA, ctxB, ctxC];
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const pageC = await ctxC.newPage();

      // 손패 비공개 검증: 트릭이 진행되면 낸 카드 ID는 trick/lastTrick/tasks
      // 등 "공개" 필드로 모두에게 정상적으로 보이므로, "A의 손패에 한 번이라도
      // 있었던 카드 ID가 B 응답에 등장하면 안 된다" 식의 검사는 공개된 필드와
      // 충돌해 오탐이 난다(실제로 확인함). 대신 계약 자체("project() 결과만
      // 반환 — `me.hand`는 항상 자기 자신의 것 하나뿐이어야 한다")를 구조적으로
      // 검사한다: B가 받는 모든 응답 본문에 `"hand":` 키가 하나(본인 것) 넘게
      // 등장하면 다른 대원의 손패 배열이 함께 직렬화된 것이므로 실패해야 한다.
      const bResponseBodies: string[] = [];
      pageB.on("response", async (res) => {
        if (!res.url().includes("/api/")) return;
        try {
          bResponseBodies.push(await res.text());
        } catch {
          // ignore
        }
      });

      // --- A: 방 생성 (3인, 미션 1은 기본값) ---
      await pageA.goto("/");
      await pageA
        .getByRole("textbox", { name: "대원 이름", exact: true })
        .fill("선장A");
      await pageA
        .getByRole("button", { name: "탐사선 만들기", exact: true })
        .click();
      await expect(pageA).toHaveURL(/\/rooms\//);
      const roomUrl = pageA.url();

      await pageA
        .getByRole("button", { name: "초대 링크", exact: true })
        .click();
      await expect(pageA.getByRole("status")).toContainText("복사했습니다");
      const invite = await pageA.evaluate(() =>
        navigator.clipboard.readText(),
      );
      expect(invite).toContain("/join#");

      // --- B, C: 초대 링크로 실제 입장(서버 모드는 서로 다른 브라우저도 같은 방에 들어간다) ---
      for (const [page, nickname] of [
        [pageB, "대원B"],
        [pageC, "대원C"],
      ] as const) {
        await page.goto(invite);
        await page
          .getByRole("textbox", { name: "대원 이름", exact: true })
          .fill(nickname);
        await page
          .getByRole("button", { name: "탐사선 탑승하기", exact: true })
          .click();
        await expect(page).toHaveURL(roomUrl);
      }

      // --- 전원 준비 ---
      for (const page of [pageA, pageB, pageC]) {
        await step(
          page,
          page.getByRole("button", { name: "탑승 준비 완료", exact: true }),
        );
      }

      // --- A(방장)가 미션 시작 ---
      await step(
        pageA,
        pageA.getByRole("button", { name: "임무 시작", exact: true }),
      );

      const contexts: Ctx[] = [
        { label: "A", page: pageA, isHost: true },
        { label: "B", page: pageB, isHost: false },
        { label: "C", page: pageC, isHost: false },
      ];
      const illegalCheck = { done: false };
      const wsCheck = { done: false, peers: contexts };
      let reloadedB = false;

      await playUntilResult(contexts, illegalCheck, {
        wsCheck,
        onTrickAdvanced: async (trickAdvanceCount) => {
          // 트릭 2로 넘어간 직후(첫 "다음 트릭" 클릭 이후) B를 새로고침해
          // 같은 자리·손패 수로 복귀하는지 확인한다(§ 서버 재접속·복원 검증).
          if (reloadedB || trickAdvanceCount !== 1) return;
          reloadedB = true;
          const nicknameLocator = pageB
            .locator(".crew-member")
            .filter({ hasText: "대원B" });
          await expect(nicknameLocator).toBeVisible();
          const handCountBefore = await pageB
            .locator(".hand-cards button")
            .count();

          await pageB.reload();

          await expect(
            pageB.locator(".crew-member").filter({ hasText: "대원B" }),
          ).toBeVisible();
          await expect(pageB.locator(".hand-dock")).toBeVisible();
          const handCountAfter = await pageB
            .locator(".hand-cards button")
            .count();
          expect(handCountAfter).toBe(handCountBefore);
        },
      });

      expect(illegalCheck.done).toBe(true);
      expect(wsCheck.done).toBe(true);

      const resultTexts = await Promise.all(
        [pageA, pageB, pageC].map((page) =>
          page.locator(".result-box h2").innerText(),
        ),
      );
      expect(resultTexts[0]).toBe(resultTexts[1]);
      expect(resultTexts[0]).toBe(resultTexts[2]);

      expect(bResponseBodies.length).toBeGreaterThan(0);
      for (const body of bResponseBodies) {
        const handKeyCount = (body.match(/"hand":/g) ?? []).length;
        expect(handKeyCount).toBeLessThanOrEqual(1);
      }

      await testInfo.attach("server-multiplayer-result.json", {
        body: JSON.stringify(
          { result: resultTexts[0], bResponseCount: bResponseBodies.length },
          null,
          2,
        ),
        contentType: "application/json",
      });

      await pageA.screenshot({ path: "artifacts/qa/v2/server-a-result.png" });
      await pageB.screenshot({ path: "artifacts/qa/v2/server-b-result.png" });
    } finally {
      for (const ctx of contextsToClose) await ctx.close();
    }
  });

  test("AI 대원으로 빈 자리를 채우면 서버가 AI 차례를 자동 진행한다", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await ctx.newPage();
      await page.goto("/");
      await page
        .getByRole("textbox", { name: "대원 이름", exact: true })
        .fill("선장A");
      await page
        .getByRole("button", { name: "탐사선 만들기", exact: true })
        .click();
      await expect(page).toHaveURL(/\/rooms\//);

      await step(
        page,
        page.getByRole("button", { name: "데모 대원 채우기", exact: true }),
      );
      // 서버 모드는 demoStep을 구현하지 않는다(서버가 자동 진행) — 수동
      // "데모 대원 진행" 버튼이 없어야 한다.
      await expect(
        page.getByRole("button", { name: "데모 대원 진행" }),
      ).toHaveCount(0);

      await step(
        page,
        page.getByRole("button", { name: "탑승 준비 완료", exact: true }),
      );
      await step(
        page,
        page.getByRole("button", { name: "임무 시작", exact: true }),
      );

      const solo: Ctx[] = [{ label: "A", page, isHost: true }];
      const illegalCheck = { done: false };
      await playUntilResult(solo, illegalCheck);

      await expect(page.locator(".result-box h2")).toBeVisible();
      await page.screenshot({ path: "artifacts/qa/v2/server-ai-result.png" });
    } finally {
      await ctx.close();
    }
  });
});
