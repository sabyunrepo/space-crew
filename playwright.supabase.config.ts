import { defineConfig, devices } from "@playwright/test";

// server-multiplayer.spec.ts의 시드 헬퍼가 이 값으로 Node 서버 전용 REST 시드
// 대신 UI(방 생성 + 초대 링크 참가) 시드를 쓰도록 분기한다.
process.env.E2E_BACKEND = "supabase";

/**
 * Supabase 모드 통합 검증. 실제 셀프호스팅 Supabase 프로젝트(crew-api Edge
 * Function + private Broadcast)에 붙는 프런트를 빌드해 preview로 띄우고,
 * 서버 모드와 같은 다인 시나리오를 서로 다른 브라우저 컨텍스트로 돌린다.
 *
 * 필요한 환경 변수(저장소에 저장하지 않는다): VITE_SUPABASE_URL,
 * VITE_SUPABASE_ANON_KEY, VITE_SUPABASE_PROJECT_ID.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "server-multiplayer.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  use: { baseURL: "http://127.0.0.1:18082", trace: "retain-on-failure" },
  projects: [{ name: "supabase", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "VITE_BACKEND_MODE=supabase npm run build && npx vite preview --host 127.0.0.1 --port 18082 --strictPort",
    url: "http://127.0.0.1:18082",
    reuseExistingServer: false,
    timeout: 240_000,
  },
  reporter: "list",
});
