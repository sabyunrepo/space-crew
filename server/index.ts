import { createApp } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const STATIC_DIR = process.env.STATIC_DIR ?? new URL("../dist", import.meta.url).pathname;
const STALE_ROOM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const { server, store } = createApp({ dataDir: DATA_DIR, staticDir: STATIC_DIR });

store
  .pruneStaleRooms(STALE_ROOM_MAX_AGE_MS)
  .then((removed) => {
    if (removed.length)
      console.log(`[crew] 30일 이상 갱신 없는 방 ${removed.length}개 정리`);
  })
  .catch((error) => {
    console.error("[crew] 오래된 방 정리 실패", error);
  });

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[crew] listening on 0.0.0.0:${PORT} (DATA_DIR=${DATA_DIR})`);
});

function shutdown() {
  store.shutdown();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
