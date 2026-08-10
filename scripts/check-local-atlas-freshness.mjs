import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { repairCoherentAtlas } from "./build-local-assets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(
  projectRoot,
  ".local-assets",
  "qq-penguin",
  "coherent-v2-run",
  "final",
  "spritesheet-extended.webp",
);
const outputRoot = path.join(projectRoot, ".local-assets", "qq-penguin", "codex-pet");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex").toUpperCase();
}

async function expectedOutputs() {
  const repaired = await repairCoherentAtlas(sourcePath);
  const atlas = sharp(repaired.data, { raw: repaired.info });
  const [webp, png] = await Promise.all([
    atlas.clone().webp({ lossless: true, quality: 100, alphaQuality: 100, effort: 6, exact: true }).toBuffer(),
    atlas.clone().png({ palette: false, compressionLevel: 9 }).toBuffer(),
  ]);
  return { webp, png };
}

const expected = await expectedOutputs();
const targets = [
  { extension: "webp", expected: expected.webp },
  { extension: "png", expected: expected.png },
];

for (const target of targets) {
  const outputPath = path.join(outputRoot, `spritesheet.${target.extension}`);
  let actual;
  try {
    actual = await fs.readFile(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Generated local atlas is missing: ${outputPath}. Run 'pnpm assets:prepare' first.`);
    }
    throw error;
  }
  if (!actual.equals(target.expected)) {
    throw new Error(
      `Generated ${target.extension} atlas is stale or was changed outside the approved local repair step. ` +
      `Expected ${sha256(target.expected)}, got ${sha256(actual)}. Run 'pnpm assets:prepare' first.`,
    );
  }
}

console.log(
  "Generated local atlas matches the validated source plus deterministic scale, right-chest scarf, and blue-halo repairs.",
);
