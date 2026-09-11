import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  roomFileExists,
  verifyWritable,
  writeRoomFile,
} from "../../server/persist.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "crew-persist-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("persist", () => {
  it("roomFileExists reports false before a write and true after", async () => {
    await withTempDir(async (dataDir) => {
      const roomId = crypto.randomUUID();
      expect(await roomFileExists(dataDir, roomId)).toBe(false);
      await writeRoomFile(dataDir, roomId, { hello: "world" });
      expect(await roomFileExists(dataDir, roomId)).toBe(true);
    });
  });

  it("verifyWritable resolves for a writable DATA_DIR and rejects for a read-only one", async () => {
    await withTempDir(async (dataDir) => {
      await expect(verifyWritable(dataDir)).resolves.toBeUndefined();
      const roomsPath = join(dataDir, "rooms");
      await mkdir(roomsPath, { recursive: true });
      const { chmod } = await import("node:fs/promises");
      await chmod(roomsPath, 0o500);
      try {
        await expect(verifyWritable(dataDir)).rejects.toBeTruthy();
      } finally {
        await chmod(roomsPath, 0o700);
      }
    });
  });

  it("cleans up the .tmp file when the atomic rename fails", async () => {
    await withTempDir(async (dataDir) => {
      const roomId = crypto.randomUUID();
      const roomsPath = join(dataDir, "rooms");
      await mkdir(roomsPath, { recursive: true });
      // Make the rename target a directory so rename() fails with EISDIR/ENOTEMPTY.
      await mkdir(join(roomsPath, `${roomId}.json`), { recursive: true });
      await expect(writeRoomFile(dataDir, roomId, { a: 1 })).rejects.toBeTruthy();
      const leftovers = (await readdir(roomsPath)).filter((f) => f.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    });
  });
});
