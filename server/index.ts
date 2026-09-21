import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { verifyWritable } from "./persist.ts";
import { createPgPool, pruneStaleRooms } from "./crew-api.ts";
import type { DbPool } from "../supabase/functions/_shared/db.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const STATIC_DIR =
  process.env.STATIC_DIR ?? fileURLToPath(new URL("../dist", import.meta.url));
const STALE_ROOM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SHUTDOWN_GRACE_MS = 5000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[crew] CREW_DB_URL이 설정된 DB 모드에는 ${name} 환경변수가 필요합니다.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const dbUrl = process.env.CREW_DB_URL;
  let dbPool: DbPool | undefined;
  let closePool: (() => Promise<void>) | undefined;
  let projectId: string | undefined;
  let jwtSecret: string | undefined;
  let allowedOrigins: string[] | undefined;

  if (dbUrl) {
    jwtSecret = requireEnv("CREW_JWT_SECRET");
    projectId = requireEnv("CREW_PROJECT_ID");
    allowedOrigins = requireEnv("CREW_ALLOWED_ORIGINS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    ({ pool: dbPool, close: closePool } = createPgPool(dbUrl));
  } else {
    try {
      await verifyWritable(DATA_DIR);
    } catch (error) {
      console.error(
        `[crew] DATA_DIR(${DATA_DIR})에 쓸 수 없습니다. 볼륨 마운트와 권한을 확인하세요.`,
        error,
      );
      process.exit(1);
    }
  }

  const { server, store, close } = createApp({
    dataDir: DATA_DIR,
    staticDir: STATIC_DIR,
    dbPool,
    projectId,
    jwtSecret,
    allowedOrigins,
    closePool,
  });

  if (dbPool) {
    pruneStaleRooms(dbPool, STALE_ROOM_MAX_AGE_MS)
      .then((removed) => {
        if (removed) console.log(`[crew] 30일 이상 갱신 없는 방 ${removed}개 정리`);
      })
      .catch((error) => {
        console.error("[crew] 오래된 방 정리 실패", error);
      });
  } else {
    store
      .pruneStaleRooms(STALE_ROOM_MAX_AGE_MS)
      .then((removed) => {
        if (removed.length)
          console.log(`[crew] 30일 이상 갱신 없는 방 ${removed.length}개 정리`);
      })
      .catch((error) => {
        console.error("[crew] 오래된 방 정리 실패", error);
      });
  }

  // 호스트를 지정하지 않으면 IPv4·IPv6 모두 수신한다. Alpine은 localhost를 ::1로
  // 해석하므로 0.0.0.0 전용이면 Coolify 헬스 체크(wget localhost)가 거부된다.
  server.listen(PORT, () => {
    console.log(`[crew] listening on :${PORT} (DATA_DIR=${DATA_DIR})`);
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
