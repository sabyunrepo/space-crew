import { defineConfig, devices } from "@playwright/test";

/**
 * Task 5 서버 모드 통합 검증 전용 설정. `playwright.config.ts`(mock 모드,
 * `npm run dev`)와 분리해, 실제 Node 서버(`server/`)를 빌드·기동하고 그
 * 위에서 여러 브라우저 컨텍스트로 실제 다인 플레이를 검증한다.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "server-multiplayer.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  use: { baseURL: "http://127.0.0.1:18081", trace: "retain-on-failure" },
  projects: [{ name: "server", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // 서버 모드로 빌드한 뒤, 임시 DATA_DIR과 전용 포트(18081)로 실제 서버를
    // 기동한다. 다른 테스트 실행과 데이터가 섞이지 않도록 매번 새 임시
    // 디렉터리를 만든다.
    command:
      'VITE_BACKEND_MODE=server npm run build && npm run build:server && DATA_DIR="$(mktemp -d)" PORT=18081 npm start',
    url: "http://127.0.0.1:18081/healthz",
    reuseExistingServer: false,
    timeout: 180_000,
  },
  reporter: "list",
});
