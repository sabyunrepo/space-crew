import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
const source = "assets/cards/deck/v3";
await mkdir("public/cards", { recursive: true });
const sourceExists = await stat(source)
  .then(() => true)
  .catch(() => false);
if (!sourceExists) {
  const existing = (await readdir("public/cards").catch(() => [])).filter(
    (f) => f.endsWith(".webp"),
  );
  if (existing.length === 41) {
    console.log(
      `원본 카드 자산(${source})이 없어 public/cards의 기존 webp 41개를 그대로 사용합니다.`,
    );
    process.exit(0);
  }
  throw new Error(
    `원본 자산 ${source}이 없고 public/cards에도 webp 41개가 없습니다 (found ${existing.length}).`,
  );
}
// sharp's native binding is only ever needed on this path (regenerating
// webp files from source PNGs), so it is loaded lazily: a container build
// that excludes `assets/` (see .dockerignore) never touches sharp at all.
const { default: sharp } = await import("sharp");
const files = (await readdir(join(source, "playing"))).filter((f) =>
  f.endsWith(".png"),
);
if (files.length !== 40)
  throw new Error(`Expected 40 cards, found ${files.length}`);
for (const file of [...files, "common-back.png"]) {
  const input = join(source, file === "common-back.png" ? "" : "playing", file);
  const output = join("public/cards", file.replace(".png", ".webp"));
  const fresh = await stat(output)
    .then(async (s) => s.mtimeMs >= (await stat(input)).mtimeMs)
    .catch(() => false);
  if (!fresh)
    await sharp(input)
      .resize({ width: 640, withoutEnlargement: true })
      .webp({ quality: 83 })
      .toFile(output);
}
console.log("40 card fronts + 1 back ready in public/cards");
