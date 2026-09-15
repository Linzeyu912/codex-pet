import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { projectRoot, realFileWithin, preflightSafeOutputTree, materializeSafeOutputTree,
  safeOutputFrom, atomicReplaceSafeOutputs } from "./lib/project-utils.mjs";
import { loadCharacter, animateEyes, placeFrame, buildAtlas, MAIN_ROWS } from "./lib/red-penguin.mjs";

export const SOURCE_PATH = path.join(projectRoot, "public", "qq-penguin-source.png");
export const OUTPUT_ROOT = path.join(projectRoot, ".local-assets", "qq-penguin", "codex-pet");
export const PET_MANIFEST = Object.freeze({
  id: "qq-penguin", displayName: "红围巾企鹅", spriteVersionNumber: 2,
  description: "怀念 QQ 农场的红围巾企鹅。非官方同人作品，如有侵权，请联系删除。",
  spritesheetPath: "spritesheet.webp",
});

export async function renderAssets() {
  await realFileWithin(projectRoot, SOURCE_PATH, "Character source");
  const sourceBytes = await fs.readFile(SOURCE_PATH);
  const { poses, sourceMetrics, scale } = await loadCharacter(sourceBytes);
  const frames = MAIN_ROWS.map((row) => row.map((spec) => {
    const pose = poses[spec.pose];
    const edited = spec.look || spec.blink ? animateEyes(pose, spec) : pose;
    return placeFrame(edited, spec.dy ?? 0);
  }));
  const main = buildAtlas(frames, 8, 11);
  const desktop = buildAtlas(Array.from({ length: 4 }, (_, row) =>
    poses.slice(row * 4, row * 4 + 4).map((pose) => placeFrame(pose))), 4, 4);
  const png = await sharp(main, { raw: { width: 1536, height: 2288, channels: 4 } }).png().toBuffer();
  // libvips discards RGB under alpha=0 when encoding WebP. The Codex validator
  // requires exact transparent pixels as well as lossless visible pixels.
  const encoded = spawnSync(process.env.CODEX_PET_PYTHON || "python", [path.join(projectRoot, "scripts/encode-exact-webp.py"), "-", "-"], {
    input: png, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  if (encoded.error || encoded.status !== 0) throw new Error(`Exact WebP encoding requires Python + Pillow: ${encoded.error?.message ?? encoded.stderr.toString()}`);
  const webp = encoded.stdout;
  const posePng = await sharp(desktop, { raw: { width: 768, height: 832, channels: 4 } }).png().toBuffer();
  const front = await sharp(placeFrame(poses[9]), { raw: { width: 192, height: 208, channels: 4 } }).png().toBuffer();
  const audit = {
    schema: "qq-penguin-shared-camera/v1", sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    atlasSha256: createHash("sha256").update(png).digest("hex"),
    posesSha256: createHash("sha256").update(posePng).digest("hex"),
    scale, baseline: 187, sourceMetrics,
    poses: poses.map(({ width, height }) => ({ width, height })),
    scarf: "One tab fixed on the character's left: visible in front and left-facing profiles, occluded in right-facing and back views.",
  };
  return { "spritesheet.png": png, "spritesheet.webp": webp, "desktop-poses.png": posePng,
    "pixel-base-normalized.png": front, "pet.json": Buffer.from(JSON.stringify(PET_MANIFEST, null, 2) + "\n"),
    "geometry.json": Buffer.from(JSON.stringify(audit, null, 2) + "\n") };
}

export async function buildLocalAssets({ copyToPublic = true } = {}) {
  const roots = [OUTPUT_ROOT, ...(copyToPublic ? [path.join(projectRoot, "public", "local")] : [])];
  const names = ["spritesheet.png", "spritesheet.webp", "desktop-poses.png", "pixel-base-normalized.png", "pet.json", "geometry.json"];
  const plans = await Promise.all(roots.map((rootPath) => preflightSafeOutputTree({
    anchorPath: projectRoot, rootPath, outputPaths: names.map((name) => path.join(rootPath, name)), label: "Red scarf pet assets",
  })));
  const assets = await renderAssets();
  const replacements = [];
  for (let i = 0; i < plans.length; i++) {
    const tree = await materializeSafeOutputTree(plans[i]);
    for (const name of names) replacements.push({ output: safeOutputFrom(tree, path.join(roots[i], name)), contents: assets[name] });
  }
  await atomicReplaceSafeOutputs(replacements);
  console.log(`Built red-scarf penguin for desktop and Codex: ${OUTPUT_ROOT}`);
  return { built: true, sourcePath: SOURCE_PATH, outputRoot: OUTPUT_ROOT, petId: "qq-penguin",
    spritesheetPath: path.join(OUTPUT_ROOT, "spritesheet.webp"), pngSpritesheetPath: path.join(OUTPUT_ROOT, "spritesheet.png"),
    normalizedPath: path.join(OUTPUT_ROOT, "pixel-base-normalized.png"),
    desktopPosesPath: path.join(OUTPUT_ROOT, "desktop-poses.png"), hasDesktopPoses: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildLocalAssets();
