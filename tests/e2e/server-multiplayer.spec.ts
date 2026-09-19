import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * Task 5 — 서버 모드(`VITE_BACKEND_MODE=server`, 실제 Node 서버 + WS) 통합
 * 검증. mock 모드 e2e(`tests/e2e/*.spec.ts`, `playwright.config.ts`)와 달리
 * 서로 다른 브라우저 컨텍스트(= 서로 다른 브라우저·기기를 흉내)가 초대
 * 링크로 같은 방에 실제로 들어와 카드를 주고받는다.
 */

/**
 * 백엔드별 시드(준비) 분기. `playwright.supabase.config.ts`가 `E2E_BACKEND`를
 * 지정하거나(그 값이 없으면 `VITE_BACKEND_MODE`) "supabase"면 Supabase 모드로
 * 본다 — 이때는 Node 서버 전용 REST 시드(`/api/rooms`, `/api/join`,
 * localStorage 토큰 주입) 대신 UI로 방을 만들고 초대 링크로 참가한다.
 */
const BACKEND: "server" | "supabase" =
  process.env.E2E_BACKEND === "supabase" || process.env.VITE_BACKEND_MODE === "supabase"
    ? "supabase"
    : "server";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

/** Supabase 모드에서 컨텍스트마다 겹치지 않게 고를 캐릭터(최대 5인). */
const SEED_CHARACTERS: readonly [label: string, id: string][] = [
  ["요시", "green-dino"], ["일루", "ilu"], ["베이", "bay"], ["콜드", "snow"], ["트리", "tree"],
];

/**
 * Supabase 모드 전용 시드: UI로 방을 만들고(호스트) 초대 링크로 나머지 인원이
 * 참가해 동일한 사전조건(지정 미션·인원)을 만든다 — 이미 통과하는
 * "서버 모드 다인 플레이" 3인 테스트와 `${capacity} real players...` 테스트가
 * 쓰는 것과 같은 UI 흐름이다. 신원은 브라우저 컨텍스트별 Supabase 익명 로그인
 * 세션(localStorage)이므로 별도 토큰 주입이 필요 없다.
 */
async function seedSupabaseRoom(params: {
  browser: Browser;
  contexts: BrowserContext[];
  pages: Page[];
  capacity: number;
  startMission: number;
  namePrefix: string;
  viewportFor?: (i: number) => { width: number; height: number };
  onPage?: (page: Page, i: number) => void;
}): Promise<string> {
  const viewportFor =
    params.viewportFor ?? ((i: number) => (i % 2 ? { width: 390, height: 844 } : { width: 1440, height: 900 }));

  const hostCtx = await params.browser.newContext({ viewport: viewportFor(0) });
  params.contexts.push(hostCtx);
  await hostCtx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const host = await hostCtx.newPage();
  params.pages.push(host);
  params.onPage?.(host, 0);

  await host.goto("/");
  if (params.capacity !== 3)
    await host.getByRole("button", { name: `${params.capacity}명`, exact: true }).click();
  await host.locator(".mission-select select").selectOption(String(params.startMission));
  await host.getByRole("button", { name: `${SEED_CHARACTERS[0][0]} 선택`, exact: true }).click();
  await host.getByRole("textbox", { name: "대원 이름", exact: true }).fill(`${params.namePrefix}0`);
  // 같은 브라우저의 연속된 컨텍스트는 localhost의 운영용 요청 제한 버킷을 공유한다.
  await expect(async () => {
    if (!host.url().includes("/rooms/"))
      await host.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
    await expect(host).toHaveURL(/\/rooms\//, { timeout: 1000 });
  }).toPass({ intervals: [6500], timeout: 30000 });

  await host.getByRole("button", { name: "초대 링크", exact: true }).click();
  await expect(host.getByRole("status")).toContainText("복사했습니다");
  const invite = await host.evaluate(() => navigator.clipboard.readText());
  const roomUrl = host.url();

  for (let i = 1; i < params.capacity; i++) {
    const ctx = await params.browser.newContext({ viewport: viewportFor(i) });
    params.contexts.push(ctx);
    const page = await ctx.newPage();
    params.pages.push(page);
    params.onPage?.(page, i);
    await page.goto(invite);
    await page.getByRole("textbox", { name: "대원 이름", exact: true }).fill(`${params.namePrefix}${i}`);
    await page.getByRole("button", { name: `${SEED_CHARACTERS[i][0]} 선택`, exact: true }).click();
    await expect(async () => {
      if (page.url().includes("/join"))
        await page.getByRole("button", { name: "탐사선 탑승하기", exact: true }).click();
      await expect(page).toHaveURL(roomUrl, { timeout: 1000 });
    }).toPass({ intervals: [6500], timeout: 30000 });
  }

  for (const page of params.pages)
    await step(page, page.getByRole("button", { name: "탑승 준비 완료", exact: true }));

  return roomUrl.match(/\/rooms\/([^/?#]+)/)![1];
}

/**
 * 특정 플레이어(page) 시점의 최신 Snapshot을 REST로 가져온다. 서버 모드는
 * `/api/rooms/:id` + 발급된 playerToken, Supabase 모드는 crew-api Edge
 * Function(`?route=`, 하위 경로 금지)에 그 브라우저의 Supabase 익명 로그인
 * 세션 access_token을 실어 호출한다 — 신원이 곧 그 세션이므로 `page`의
 * localStorage에서 그대로 읽는다.
 */
async function fetchView(
  request: APIRequestContext,
  page: Page,
  roomId: string,
  serverToken?: string,
): Promise<any> {
  if (BACKEND === "server") {
    const response = await request.get(`/api/rooms/${roomId}`, {
      headers: { Authorization: `Bearer ${serverToken}` },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  }
  const accessToken = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.includes("-auth-token"));
    if (!key) return null;
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null")?.access_token ?? null;
    } catch {
      return null;
    }
  });
  const response = await request.get(
    `${SUPABASE_URL}/functions/v1/crew-api?route=${encodeURIComponent(`/rooms/${roomId}`)}`,
    { headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY ?? "" } },
  );
  expect(response.ok()).toBe(true);
  return response.json();
}

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
    const playedLabel = await legalCards.first().getAttribute("aria-label");
    const actorId = await page.locator(".seat-south").getAttribute("data-player-id");
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
          peer.page.locator(`.central-play[data-player-id="${actorId}"] .card img`),
        ).toHaveAttribute("alt", playedLabel!, { timeout: 5000 });
        await expect(peer.page.locator(".player-seat .played-card")).toHaveCount(0);
        await peer.page.screenshot({ path: "artifacts/qa/characters/server-central-play.png" });
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
        // Node 서버는 /api/, Supabase 모드는 Edge Function(/functions/v1/)으로 응답한다.
        if (!res.url().includes("/api/") && !res.url().includes("/functions/v1/")) return;
        try {
          bResponseBodies.push(await res.text());
        } catch {
          // ignore
        }
      });

      // --- A: 방 생성 (3인, 미션 1은 기본값) ---
      await pageA.goto("/");
      await pageA.getByRole("button", { name: "요시 선택", exact: true }).click();
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
        await page.getByRole("button", { name: page === pageB ? "일루 선택" : "베이 선택", exact: true }).click();
        await page
          .getByRole("textbox", { name: "대원 이름", exact: true })
          .fill(nickname);
        await page
          .getByRole("button", { name: "탐사선 탑승하기", exact: true })
          .click();
        await expect(page).toHaveURL(roomUrl);
      }

      for (const page of [pageA, pageB, pageC]) {
        await expect(page.locator('.crew-member img[alt="요시"]')).toHaveCount(1);
        await expect(page.locator('.crew-member img[alt="일루"]')).toHaveCount(1);
        await expect(page.locator('.crew-member img[alt="베이"]')).toHaveCount(1);
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
            .locator(".player-seat")
            .filter({ hasText: "대원B" });
          await expect(nicknameLocator).toBeVisible();
          const handCountBefore = await pageB
            .locator(".hand-cards button")
            .count();

          await pageB.reload();

          await expect(
            pageB.locator(".player-seat").filter({ hasText: "대원B" }),
          ).toBeVisible();
          await expect(pageB.locator(".hand-dock")).toBeVisible();
          const handCountAfter = await pageB
            .locator(".hand-cards button")
            .count();
          expect(handCountAfter).toBe(handCountBefore);
          await expect(pageB.locator(".seat-south .character-card")).toHaveAttribute("data-character-id", "ilu");
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

for (const capacity of [4, 5]) test(`${capacity} real players retain their characters and directional seats through a mission`, async ({ browser }) => {
  const identities = [
    ["요시", "green-dino"], ["일루", "ilu"], ["베이", "bay"], ["콜드", "snow"], ["트리", "tree"],
  ];
  const contexts: BrowserContext[] = [];
  const crew: Ctx[] = [];
  try {
    for (let i = 0; i < capacity; i++) {
      const context = await browser.newContext({ viewport: i % 2 ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
      contexts.push(context); crew.push({ label: String(i), page: await context.newPage(), isHost: i === 0 });
    }
    const host = crew[0].page;
    await contexts[0].grantPermissions(["clipboard-read", "clipboard-write"]);
    await host.goto("/");
    await host.getByRole("button", { name: `${capacity}명`, exact: true }).click();
    await host.locator(".mission-select select").selectOption(capacity === 5 ? "7" : "4");
    await host.getByRole("button", { name: "요시 선택", exact: true }).click();
    await host.getByRole("textbox", { name: "대원 이름", exact: true }).fill("대원0");
    // Consecutive browser cases share localhost's production rate-limit bucket.
    await expect(async () => {
      if (!host.url().includes("/rooms/"))
        await host.getByRole("button", { name: "탐사선 만들기", exact: true }).click();
      await expect(host).toHaveURL(/\/rooms\//, { timeout: 1000 });
    }).toPass({ intervals: [6500], timeout: 30000 });
    await host.getByRole("button", { name: "초대 링크", exact: true }).click();
    await expect(host.getByRole("status")).toContainText("복사했습니다");
    const invite = await host.evaluate(() => navigator.clipboard.readText());
    for(let i=1;i<capacity;i++) {
      const page = crew[i].page; await page.goto(invite);
      await page.getByRole("textbox", { name: "대원 이름", exact: true }).fill(`대원${i}`);
      await page.getByRole("button", { name: `${identities[i][0]} 선택`, exact: true }).click();
      // All contexts share localhost's IP. Previous cases consume the production
      // join bucket; retry the same idempotent entry after its refill interval.
      await expect(async () => {
        if (page.url().includes("/join"))
          await page.getByRole("button", { name: "탐사선 탑승하기", exact: true }).click();
        await expect(page).toHaveURL(host.url(), { timeout: 1000 });
      }).toPass({ intervals: [6500], timeout: 30000 });
    }
    for(const {page} of crew) await step(page, page.getByRole("button", {name:"탑승 준비 완료",exact:true}));
    await step(host,host.getByRole("button",{name:"임무 시작",exact:true}));
    for(let i=0;i<capacity;i++) {
      const page = crew[i].page;
      await expect(page.locator(".player-seat")).toHaveCount(capacity);
      await expect(page.locator(".seat-south .character-card")).toHaveAttribute("data-character-id",identities[i][1]);
      for(const [,id] of identities.slice(0,capacity)) await expect(page.locator(`.character-card[data-character-id="${id}"]`)).toHaveCount(1);
    }
    const positions = await crew[1].page.locator(".player-seat").evaluateAll(els=>els.map(el=>[el.getAttribute("data-player-id"),el.getAttribute("data-position")]));
    await crew[1].page.reload();
    await expect(crew[1].page.locator(".seat-south .character-card")).toHaveAttribute("data-character-id","ilu");
    expect(await crew[1].page.locator(".player-seat").evaluateAll(els=>els.map(el=>[el.getAttribute("data-player-id"),el.getAttribute("data-position")]))).toEqual(positions);
    await playUntilResult(crew,{done:false});
    const results = await Promise.all(crew.map(({page})=>page.locator(".result-box h2").innerText()));
    expect(new Set(results).size).toBe(1);
    for (const { page } of crew) await expect(page.locator(".mission-result-modal")).toBeVisible();
    await expect(crew[1].page.locator(".result-continue")).toHaveCount(0);
    await expect(crew[1].page.locator(".result-modal-actions")).toContainText("방장이");
    const failed = await host.locator(".mission-result-modal.failure").count() > 0;
    await crew[1].page.reload();
    await expect(crew[1].page.locator(".mission-result-modal")).toBeVisible();
    await host.screenshot({ path: `artifacts/qa/missions/result-${capacity}-host.png` });
    await crew[1].page.screenshot({ path: `artifacts/qa/missions/result-${capacity}-guest.png` });
    await step(host, host.locator(".result-continue"));
    for (const { page } of crew) {
      await expect(page.locator(".mission-result-modal")).toHaveCount(0);
      await expect(page.locator(".mission-setup-modal")).toBeVisible();
      if (failed) await expect(page.locator(".attempt")).toContainText("2번째 시도");
    }

  } finally { for(const context of contexts) await context.close(); }
});

// Real REST setup establishes independent seats; every preparation decision and
// subsequent play uses rendered controls, with public snapshots only for turn selection.
for (const [mission, capacity] of [[22, 3], [5, 3], [17, 3], [33, 4], [11, 4], [20, 3], [23, 4], [24, 5], [27, 5], [36, 5], [40, 3], [41, 4], [46, 5], [48, 3], [50, 5]] as const) {
  test(`미션 ${mission}: ${capacity}개 독립 화면에서 준비·복귀·실제 플레이`, async ({ browser, request }, info) => {
    test.setTimeout(240_000);
    const { suggestDemoCommand } = await import("../../src/game/demoPolicy.ts");
    const contexts: BrowserContext[] = [];
    const pages: Page[] = [];
    const errors: string[] = [];
    const serverTokens: string[] = [];
    let roomId = "";
    try {
      if (BACKEND === "server") {
        async function entryRequest(path: string, data: unknown) {
          for (let retry = 0; retry < 12; retry++) {
            const result = await request.post(path, { data });
            if (result.status() !== 429) return result;
            // Keep the production per-IP limit enabled. One runner represents many
            // independent people on the same IP, so wait for its token to refill.
            await new Promise(resolve => setTimeout(resolve, 6100));
          }
          throw new Error("Entry rate limiter did not refill");
        }
        const created = await entryRequest("/api/rooms", {
          commandId: crypto.randomUUID(), nickname: "선장",
          settings: { name: "미션 준비 검증", capacity, missionMode: "sequential", startMission: mission },
        });
        expect(created.ok()).toBe(true);
        const first = await created.json();
        roomId = first.entry.snapshot.roomId;
        const entries = [first];
        for (let i = 1; i < capacity; i++) {
          const res = await entryRequest("/api/join", { commandId: crypto.randomUUID(), nickname: `대원${i}`, inviteToken: first.entry.inviteToken });
          expect(res.ok()).toBe(true);
          entries.push(await res.json());
        }
        for (const [i, entry] of entries.entries()) {
          const ctx = await browser.newContext({ viewport: i % 2 ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
          contexts.push(ctx);
          serverTokens.push(entry.playerToken);
          await ctx.addInitScript(({ roomId, token }) => localStorage.setItem(`crew.server.v1.token.${roomId}`, token), { roomId, token: entry.playerToken });
          const page = await ctx.newPage(); pages.push(page);
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(`/rooms/${roomId}`);
          await step(page, page.getByRole("button", { name: "탑승 준비 완료", exact: true }));
        }
      } else {
        roomId = await seedSupabaseRoom({
          browser, contexts, pages, capacity, startMission: mission, namePrefix: "대원",
          onPage: (page) => page.on("pageerror", error => errors.push(error.message)),
        });
      }
      await step(pages[0], pages[0].getByRole("button", { name: "임무 시작", exact: true }));
      const restored = new Set<string>();
      let actions = 0;
      let reachedResult = false;
      while (actions++ < 220) {
        let acted = false;
        for (const [i, page] of pages.entries()) {
          const view = await fetchView(request, page, roomId, serverTokens[i]);
          if (["success", "failure"].includes(view.phase)) { reachedResult = true; break; }
          await expect(page.locator(".room-view")).toHaveAttribute("data-revision", String(view.revision));
          let command = suggestDemoCommand(view);
          if (mission === 27 && view.preparation?.stage === "task_transfer") {
            const own = view.tasks.find((task: { ownerId: string }) => task.ownerId === view.me.playerId);
            command = own ? { type: "transfer_task", taskId: own.id, playerId: view.players.find((p: { id: string }) => p.id !== view.me.playerId).id } : null;
          }
          if (view.phase === "preparation") {
            const stage = view.preparation.stage;
            if (!restored.has(stage) && view.preparation.answeredPlayerIds.length > 0) {
              await page.reload();
              await expect(page.locator(".room-view")).toHaveAttribute("data-revision", String(view.revision));
              await expect(page.getByRole("region", { name: "미션 준비", exact: true })).toBeVisible();
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
              await expect(pages[1].locator(".room-view")).toHaveAttribute("data-revision", String(view.revision));
              expect(await pages[1].evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
              await pages[1].screenshot({ path: `artifacts/qa/missions/m${mission}-${stage}-mobile.png`, fullPage: true });
              restored.add(stage);
              await page.screenshot({ path: `artifacts/qa/missions/m${mission}-${stage}-${i % 2 ? "mobile" : "desktop"}.png`, fullPage: true });
            }
            if (!command) continue;
            const panel = page.getByRole("region", { name: "미션 준비", exact: true });
            switch (command.type) {
              case "preparation_response": {
                const label = { yes: mission === 5 && stage === "role" ? "좋음" : "예", no: mission === 5 && stage === "role" ? "나쁨" : "아니오", unknown: "모르겠어요", first: "첫 4트릭", middle: "중간 트릭", last: "마지막 트릭" }[command.answer];
                await step(page, panel.getByRole("button", { name: label, exact: true })); break;
              }
              case "select_crew":
              case "assign_task":
                await panel.getByRole("combobox", { name: mission === 50 ? "첫 4트릭 담당 A" : "담당 대원", exact: true }).selectOption(command.playerId);
                if (command.type === "select_crew" && command.secondaryPlayerId)
                  await panel.getByRole("combobox", { name: "마지막 트릭 담당 B", exact: true }).selectOption(command.secondaryPlayerId);
                await step(page, panel.getByRole("button", { name: command.type === "assign_task" ? "목표 배정" : "담당자 확정", exact: true })); break;
              case "confirm_tokens":
                await panel.locator("button.token-choice").nth(0).click();
                await panel.locator("button.token-choice").nth(mission === 23 ? 1 : 3).click();
                await expect(panel.locator(".preview-changed")).toHaveCount(2);
                await step(page, panel.getByRole("button", { name: "현재 토큰 배치 확정", exact: true })); break;
              case "transfer_task":
                await panel.getByRole("combobox", { name: "내 목표", exact: true }).selectOption(command.taskId);
                await panel.getByRole("combobox", { name: "받을 대원", exact: true }).selectOption(command.playerId);
                await step(page, panel.getByRole("button", { name: "목표 양도 확정", exact: true })); break;
              case "skip_transfer": await step(page, panel.getByRole("button", { name: "양도 없이 시작", exact: true })); break;
              case "select_distress_card": {
                const { cardLabel } = await import("../../shared/cards.ts");
                await panel.getByRole("button", { name: cardLabel(command.cardId), exact: true }).click();
                await step(page, panel.getByRole("button", { name: "교환 카드 확정", exact: true })); break;
              }
              default: throw new Error(`Unexpected preparation command ${command.type}`);
            }
            acted = true; break;
          }
          if (await tick({ label: String(i), page, isHost: i === 0 }, { done: true })) { acted = true; break; }
        }
        if (reachedResult) break;
        if (!acted) await pages[0].waitForTimeout(150);
      }
      expect(reachedResult).toBe(true);
      const expected = await pages[0].locator(".result-box h2").innerText();
      for (const page of pages) {
        await expect(page.locator(".result-box h2")).toHaveText(expected);
        await expect(page.getByRole("alert")).toHaveCount(0);
      }
      expect(errors).toEqual([]);
      await info.attach("mission-network-result.json", { body: JSON.stringify({ mission, capacity, actions, result: expected, restoredStages: [...restored] }), contentType: "application/json" });
    } finally { for (const ctx of contexts) await ctx.close(); }
  });
}

test("cooperative controls: last goal, hover, off-turn signal and unanimous restart", async ({ browser, request }) => {
  test.setTimeout(180000);
  const viewportFor = (i: number) => i===2?{width:390,height:844}:i===0?{width:1189,height:779}:{width:2279,height:1426};
  const contexts: BrowserContext[]=[];
  const pages: Page[]=[];
  const serverTokens: string[] = [];
  let roomId = "";
  try {
    if (BACKEND === "server") {
      const post = async (path: string, data: unknown) => {
        for (let i=0;i<12;i++) {
          const response=await request.post(path,{data});
          if(response.status() !== 429) { expect(response.ok()).toBe(true); return response.json(); }
          await new Promise(resolve=>setTimeout(resolve,6200));
        }
        throw new Error("Room entry rate limit");
      };
      const first=await post('/api/rooms',{commandId:crypto.randomUUID(),nickname:'검증 선장',settings:{name:'협동 조작 검증',capacity:3,missionMode:'sequential',startMission:4}});
      const entries=[first];
      for(let i=1;i<3;i++) entries.push(await post('/api/join',{commandId:crypto.randomUUID(),nickname:`검증 대원${i}`,inviteToken:first.entry.inviteToken}));
      roomId=first.entry.snapshot.roomId;
      for(let i=0;i<3;i++) {
        const context=await browser.newContext({viewport: viewportFor(i)});contexts.push(context);
        serverTokens.push(entries[i].playerToken);
        await context.addInitScript(({roomId,token})=>localStorage.setItem(`crew.server.v1.token.${roomId}`,token),{roomId,token:entries[i].playerToken});
        const page=await context.newPage();pages.push(page);
        await page.goto(`/rooms/${roomId}`);
        await step(page,page.getByRole('button',{name:'탑승 준비 완료',exact:true}));
      }
    } else {
      roomId = await seedSupabaseRoom({ browser, contexts, pages, capacity: 3, startMission: 4, namePrefix: "검증 대원", viewportFor });
    }
    const snapshot = async (i = 0) => fetchView(request, pages[i], roomId, serverTokens[i]);
    await step(pages[0],pages[0].getByRole('button',{name:'임무 시작',exact:true}));
    await expect.poll(async()=>(await snapshot()).phase).toBe('task_selection');
    const playerIds = await Promise.all(pages.map(async (page) => {
      await expect(page.locator('.seat-south')).toBeVisible();
      return page.locator('.seat-south').getAttribute('data-player-id');
    }));
    let snap=await snapshot();
    while(snap.phase==='task_selection') {
      const i=playerIds.indexOf(snap.turnPlayerId);
      const remaining=snap.tasks.filter((t: {ownerId:string|null})=>!t.ownerId);
      const last=remaining.length===2?remaining[1]:null;
      const next=snap.players[(snap.players.findIndex((p:{id:string})=>p.id===snap.turnPlayerId)+1)%3].id;
      await step(pages[i],pages[i].locator('.target-list button:enabled').first());
      snap=await snapshot();
      if(last) {expect(snap.tasks.find((t:{id:string})=>t.id===last.id).ownerId).toBe(next);expect(snap.phase).toBe('playing');}
    }
    const host=pages[0];
    for (const peer of pages) {
      await expect(peer.locator('.hand-dock .seat-south')).toHaveCount(1);
      await expect(peer.locator('.seat-layout .player-seat')).toHaveCount(2);
      const signal = await peer.locator('.own-seat-dock .communication-card').boundingBox();
      expect(signal!.width).toBeGreaterThanOrEqual(peer.viewportSize()!.width > 700 ? 64 : 48);
      expect(await peer.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);

    }
    await host.screenshot({path:'artifacts/qa/missions/readable-dock-1189.png'});
    await expect(host.locator('.mission-setup-modal')).toHaveCount(0);
    expect((await host.locator('.mission-panel').boundingBox())!.height).toBeLessThan(90);
    const goal=host.locator('.player-seat .seat-task').first();
    await goal.hover();
    await expect(host.getByRole('tooltip',{name:'카드 정보'})).toBeVisible();
    await expect(host.getByRole('tooltip')).toContainText(await goal.locator('img').getAttribute('alt') ?? '');
    await host.keyboard.press('Escape');
    await expect(host.getByRole('tooltip')).not.toBeVisible();
    const actor=playerIds.indexOf(snap.turnPlayerId);
    await tapCard(pages[actor].locator('.hand-cards button[aria-disabled="false"]').first());
    await step(pages[actor],pages[actor].getByRole('button',{name:'선택한 카드 내기',exact:true}));
    snap=await snapshot();expect(snap.trick).toHaveLength(1);
    const views=await Promise.all(pages.map((_,i)=>snapshot(i)));
    const communicator=views.findIndex(v=>v.me.playerId!==snap.turnPlayerId && v.me.canCommunicate);
    expect(communicator).toBeGreaterThanOrEqual(0);
    const page=pages[communicator];
    await page.getByRole('button',{name:'교신하기',exact:true}).click();
    await page.getByRole('button',{name:'교신 취소',exact:true}).click();
    expect((await snapshot()).revision).toBe(snap.revision);
    await page.getByRole('button',{name:'교신하기',exact:true}).click();
    await tapCard(page.locator('.hand-cards button[aria-disabled="false"]').first());
    await step(page,page.locator('.communication-modal .primary').first());
    const signalled=await snapshot();
    expect(signalled.turnPlayerId).toBe(snap.turnPlayerId);expect(signalled.trick).toEqual(snap.trick);
    for(const peer of pages) await expect(peer.locator('.player-seat .communication-card.broadcast')).toHaveCount(1);
    const attempt=snap.attemptId;
    await step(pages[1],pages[1].getByRole('button',{name:'게임 포기 · 재시작',exact:true}));
    for(const peer of pages) await expect(peer.getByRole('dialog',{name:'게임 포기 및 재시작 동의'})).toBeVisible();
    await pages[2].reload();
    await expect(pages[2].getByRole('dialog',{name:'게임 포기 및 재시작 동의'})).toBeVisible();
    await step(pages[2],pages[2].getByRole('button',{name:'반대 · 게임 계속',exact:true}));
    expect((await snapshot()).attemptId).toBe(attempt);
    await step(pages[1],pages[1].getByRole('button',{name:'게임 포기 · 재시작',exact:true}));
    await step(pages[0],pages[0].getByRole('button',{name:'동의 · 다시 시작',exact:true}));
    expect((await snapshot()).attemptId).toBe(attempt);
    await step(pages[2],pages[2].getByRole('button',{name:'동의 · 다시 시작',exact:true}));
    await expect.poll(async()=>(await snapshot()).attemptId).not.toBe(attempt);
    const restarted=await snapshot();expect(restarted.missionId).toBe(4);expect(restarted.attemptNumber).toBe(2);
    for(const peer of pages) await expect(peer.locator('.restart-vote')).not.toBeVisible();
    await host.screenshot({path:'artifacts/qa/missions/cooperative-restart.png'});
  } finally {for(const context of contexts) await context.close();}
});
