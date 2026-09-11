import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  // server-multiplayer.spec.ts는 서버 모드 전용(playwright.server.config.ts,
  // `npm run test:e2e:server`)이며 mock 모드(이 설정, `npm run dev`)에서는
  // 크로스 컨텍스트 입장 등 서버 전용 동작에 의존해 실행할 수 없다.
  testIgnore: "server-multiplayer.spec.ts",
  fullyParallel: true,
  timeout: 60000,
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
  reporter: "list",
});
