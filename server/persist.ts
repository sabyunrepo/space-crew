import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function roomsDir(dataDir: string): string {
  return join(dataDir, "rooms");
}

function roomFile(dataDir: string, roomId: string): string {
  return join(roomsDir(dataDir), `${roomId}.json`);
}

export async function roomFileExists(
  dataDir: string,
  roomId: string,
): Promise<boolean> {
  try {
    await stat(roomFile(dataDir, roomId));
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

/**
 * Probes that DATA_DIR/rooms is writable by writing and deleting a temp
 * file. Call once at startup so a misconfigured volume fails fast with a
 * clear log instead of surfacing as opaque 500s on the first room write.
 */
export async function verifyWritable(dataDir: string): Promise<void> {
  const dir = roomsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const probe = join(dir, `.write-check.${process.pid}.${Date.now()}.tmp`);
  await writeFile(probe, "ok", "utf8");
  await rm(probe, { force: true });
}

export async function readRoomFile<T>(
  dataDir: string,
  roomId: string,
): Promise<T | null> {
  try {
    const raw = await readFile(roomFile(dataDir, roomId), "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function writeRoomFile(
  dataDir: string,
  roomId: string,
  data: unknown,
): Promise<void> {
  const dir = roomsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const target = roomFile(dataDir, roomId);
  const tmp = join(dir, `.${roomId}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(data), "utf8");
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function listRoomIds(dataDir: string): Promise<string[]> {
  try {
    const files = await readdir(roomsDir(dataDir));
    return files
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => f.slice(0, -".json".length));
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

export async function pruneStaleRoomFiles(
  dataDir: string,
  maxAgeMs: number,
  now = Date.now(),
): Promise<string[]> {
  const ids = await listRoomIds(dataDir);
  const removed: string[] = [];
  for (const id of ids) {
    const info = await stat(roomFile(dataDir, id)).catch(() => null);
    if (!info) continue;
    if (now - info.mtimeMs > maxAgeMs) {
      await rm(roomFile(dataDir, id), { force: true });
      removed.push(id);
    }
  }
  return removed;
}
