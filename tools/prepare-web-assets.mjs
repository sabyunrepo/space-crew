import sharp from "sharp";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
const source = "assets/cards/deck/v3";
await mkdir("public/cards", { recursive: true });
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
