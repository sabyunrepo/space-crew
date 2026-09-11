import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { verifyWritable } from "./persist.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const STATIC_DIR =
  process.env.STATIC_DIR ?? fileURLToPath(new URL("../dist", import.meta.url));
const STALE_ROOM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 5000;

async function main() {
  try {
    await verifyWritable(DATA_DIR);
  } catch (error) {
    console.error(
      `[crew] DATA_DIR(${DATA_DIR})에 쓸 수 없습니다. 볼륨 마운트와 권한을 확인하세요.`,
      error,
    );
    process.exit(1);
  }

  const { server, store, close } = createApp({
    dataDir: DATA_DIR,
    staticDir: STATIC_DIR,
  });

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
    close().catch((error) => {
      console.error("[crew] graceful shutdown 중 오류", error);
    });
    // Belt-and-suspenders: if some connection refuses to close in time,
    // exit anyway rather than hang the container past its stop timeout.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
