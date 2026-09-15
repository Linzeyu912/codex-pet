import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { auditAnimation } from "./check-animation-continuity.mjs";
import { projectRoot } from "./lib/project-utils.mjs";

const main = path.join(projectRoot, "public/local/spritesheet.png");
const pose = path.join(projectRoot, "public/local/desktop-poses.png");
const valid = await auditAnimation(main, pose);
assert.equal(valid.ok, true, valid.errors.join("\n"));
const root = await fs.mkdtemp(path.join(projectRoot, ".local-assets/character-regression-"));
const original = await sharp(pose).ensureAlpha().raw().toBuffer();
const write = async (name, data) => {
  const file = path.join(root, name);
  await sharp(data, { raw: { width: 768, height: 832, channels: 4 } }).png().toFile(file);
  return file;
};
// Simulate the original bug: one pose auto-fits to a smaller cell.
const scaled = Buffer.from(original);
const small = await sharp(pose).extract({ left: 0, top: 0, width: 192, height: 208 })
  .resize(154, 166, { kernel: "nearest" }).raw().toBuffer();
for (let y = 0; y < 208; y++) scaled.fill(0, y * 768 * 4, (y * 768 + 192) * 4);
for (let y = 0; y < 166; y++) small.copy(scaled, ((y + 22) * 768 + 19) * 4, y * 154 * 4, (y + 1) * 154 * 4);
const scaleAudit = await auditAnimation(main, await write("wrong-scale.png", scaled));
assert(scaleAudit.errors.some(e => e.includes("camera scale")), "must reject independent pose scale changes");
// A new red tail beneath the back neck ring must be rejected.
const scarf = Buffer.from(original);
for (let y = 136; y < 146; y++) for (let x = 115; x < 125; x++) {
  const o = ((2 * 208 + y) * 768 + 3 * 192 + x) * 4;
  scarf.set([240, 0, 0, 255], o);
}
const scarfAudit = await auditAnimation(main, await write("wrong-scarf.png", scarf));
assert(scarfAudit.errors.some(e => e.includes("dangling scarf")), "must reject a back scarf tab");
// A left-facing view must not lose its one near-side tab again.
const missingTab = Buffer.from(original);
for (let y = 128; y < 152; y++) for (let x = 45; x < 130; x++) {
  const o = (y * 768 + x) * 4;
  if (missingTab[o] > 150 && missingTab[o + 1] < missingTab[o] * .24 && missingTab[o + 2] < missingTab[o] * .24)
    missingTab.set([24, 24, 24, 255], o);
}
const missingTabAudit = await auditAnimation(main, await write("missing-side-scarf.png", missingTab));
assert(missingTabAudit.errors.some(e => e.includes("missing the visible scarf tab")), "must reject a missing left-facing tab");
// The semantic check must detect reversed directional eye frames.
const reversed = await sharp(main).ensureAlpha().raw().toBuffer();
const originalMain = Buffer.from(reversed), frameBytes = 192 * 4;
for (let y = 0; y < 208; y++) {
  const a = ((9 * 208 + y) * 1536 + 4 * 192) * 4;
  const b = ((10 * 208 + y) * 1536 + 4 * 192) * 4;
  originalMain.copy(reversed, a, b, b + frameBytes);
  originalMain.copy(reversed, b, a, a + frameBytes);
}
const reversedPath = path.join(root, "wrong-gaze.png");
await sharp(reversed, { raw: { width: 1536, height: 2288, channels: 4 } }).png().toFile(reversedPath);
const gazeAudit = await auditAnimation(reversedPath, pose);
assert(gazeAudit.errors.some(e => e.includes("Pupil")), "must reject reversed gaze directions");
console.log("Character regressions passed: shared scale, fixed-side scarf visibility, semantic gaze.");
