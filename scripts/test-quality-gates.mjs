import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  BLIND_DIRECTION_PAIRS,
  BLIND_VERDICT_SCHEMA,
  DIRECTION_LABELS,
  blindDirectionReportPasses,
  directionContinuityReportPasses,
  directionSemanticsReportPasses,
} from "./lib/atlas-quality.mjs";
import { renderBlindDirectionSheet } from "./lib/blind-sheet.mjs";
import {
  auditDesktopActionPlaybacks,
  desktopPoseActionPlaybacks,
  inspectDesktopPoseAtlas,
} from "./lib/pose-atlas-quality.mjs";
import {
  atomicWritePrepared,
  prepareAtomicOutputs,
} from "./create-atlas-run-summary.mjs";
import {
  atomicReplaceSafeOutputs,
  materializeSafeOutputTree,
  preflightSafeOutputTree,
  removeSafeOutputs,
  safeOutputFrom,
} from "./lib/project-utils.mjs";
import {
  DEFAULT_CHROMA_FRINGE_OPTIONS,
  auditChromaFringeRgba,
  removeChromaFringeRgba,
} from "./remove-chroma-fringe.mjs";

assert.deepEqual(
  {
    chromaKey: DEFAULT_CHROMA_FRINGE_OPTIONS.chromaKey,
    distanceThreshold: DEFAULT_CHROMA_FRINGE_OPTIONS.distanceThreshold,
    edgeRadius: DEFAULT_CHROMA_FRINGE_OPTIONS.edgeRadius,
    alphaMinimum: DEFAULT_CHROMA_FRINGE_OPTIONS.alphaMinimum,
  },
  { chromaKey: [0, 255, 255], distanceThreshold: 96, edgeRadius: 2, alphaMinimum: 16 },
  "chroma-fringe defaults must stay aligned with Codex validate_atlas.py",
);
assert.throws(
  () => execFileSync(
    process.execPath,
    ["scripts/remove-chroma-fringe.mjs", "--input", "same.png", "--output", "same.png"],
    { stdio: "pipe" },
  ),
  "the cleanup CLI must refuse to overwrite its input path",
);

const chromaFixtureWidth = 9;
const chromaFixtureHeight = 9;
const chromaFixture = Buffer.alloc(chromaFixtureWidth * chromaFixtureHeight * 4);
for (let y = 1; y <= 7; y += 1) {
  for (let x = 1; x <= 7; x += 1) {
    const offset = (y * chromaFixtureWidth + x) * 4;
    chromaFixture[offset] = 220;
    chromaFixture[offset + 1] = 30;
    chromaFixture[offset + 2] = 40;
    chromaFixture[offset + 3] = 255;
  }
}
const edgeChromaOffset = (4 * chromaFixtureWidth + 1) * 4;
const interiorChromaOffset = (4 * chromaFixtureWidth + 4) * 4;
for (const offset of [edgeChromaOffset, interiorChromaOffset]) {
  chromaFixture[offset] = 0;
  chromaFixture[offset + 1] = 255;
  chromaFixture[offset + 2] = 255;
}
const chromaFixtureMetadata = {
  width: chromaFixtureWidth,
  height: chromaFixtureHeight,
  channels: 4,
};
const chromaFixtureOptions = {
  columns: 1,
  rows: 1,
  cellWidth: chromaFixtureWidth,
  cellHeight: chromaFixtureHeight,
};
const chromaAudit = auditChromaFringeRgba(
  chromaFixture,
  chromaFixtureMetadata,
  chromaFixtureOptions,
);
assert.equal(chromaAudit.total, 1, "only cyan within the official two-pixel edge radius is fringe");
assert.equal(chromaAudit.mask[edgeChromaOffset / 4], 1, "the visible edge-cyan pixel must be audited");
assert.equal(chromaAudit.mask[interiorChromaOffset / 4], 0, "interior cyan outside the edge radius is not fringe");
const cleanedChromaFixture = removeChromaFringeRgba(
  chromaFixture,
  chromaFixtureMetadata,
  chromaFixtureOptions,
);
assert.equal(cleanedChromaFixture.changedPixels, 1, "cleanup must change exactly the audited fringe mask");
assert.equal(cleanedChromaFixture.after.total, 0, "cleanup must remove all officially audited fringe");
assert.deepEqual(
  [...cleanedChromaFixture.data.subarray(edgeChromaOffset, edgeChromaOffset + 4)],
  [220, 30, 40, 255],
  "fringe RGB should come from the local inward palette while preserving alpha",
);
assert.deepEqual(
  [...cleanedChromaFixture.data.subarray(interiorChromaOffset, interiorChromaOffset + 4)],
  [0, 255, 255, 255],
  "cleanup must not alter chroma pixels outside the official fringe mask",
);
for (let offset = 0; offset < chromaFixture.length; offset += 4) {
  assert.equal(
    cleanedChromaFixture.data[offset + 3],
    chromaFixture[offset + 3],
    "cleanup must preserve every alpha byte",
  );
  if (chromaAudit.mask[offset / 4] === 0) {
    assert.deepEqual(
      [...cleanedChromaFixture.data.subarray(offset, offset + 4)],
      [...chromaFixture.subarray(offset, offset + 4)],
      "cleanup must preserve every non-fringe pixel byte-for-byte",
    );
  }
}

const lowAlphaChromaFixture = Buffer.from(chromaFixture);
lowAlphaChromaFixture[edgeChromaOffset + 3] = 1;
assert.equal(
  auditChromaFringeRgba(
    lowAlphaChromaFixture,
    chromaFixtureMetadata,
    chromaFixtureOptions,
  ).total,
  0,
  "the official default audit ignores alpha below 16",
);
const lowAlphaCleanup = removeChromaFringeRgba(
  lowAlphaChromaFixture,
  chromaFixtureMetadata,
  { ...chromaFixtureOptions, alphaMinimum: 1 },
);
assert.equal(lowAlphaCleanup.before.total, 1, "an aesthetic audit may explicitly select alpha 1 fringe");
assert.equal(lowAlphaCleanup.after.total, 0, "alpha 1 fringe must be cleanable without touching geometry");
assert.equal(
  lowAlphaCleanup.data[edgeChromaOffset + 3],
  1,
  "low-alpha cleanup must preserve the selected pixel's alpha",
);

async function writePoseFixture(filePath, {
  width = 768,
  height = 832,
  emptyIndex = -1,
  outlierIndex = -1,
  edgeIndex = -1,
} = {}) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < 16; index += 1) {
    if (index === emptyIndex) continue;
    const cellLeft = (index % 4) * 192;
    const cellTop = Math.floor(index / 4) * 208;
    const outlier = index === outlierIndex;
    const touchesEdge = index === edgeIndex;
    const left = cellLeft + (touchesEdge ? 0 : outlier ? 4 : 56);
    const top = cellTop + (outlier ? 4 : 80);
    const frameWidth = outlier ? 20 : 80;
    const frameHeight = outlier ? 20 : 100;
    for (let y = top; y < Math.min(height, top + frameHeight); y += 1) {
      for (let x = left; x < Math.min(width, left + frameWidth); x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 30;
        pixels[offset + 1] = 40;
        pixels[offset + 2] = 70;
        pixels[offset + 3] = 255;
      }
    }
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

function passingBlindReport() {
  const reviewers = ["reviewer-a", "reviewer-b", "reviewer-c"].map((id, index) => ({
    id,
    file: `C:\\qa\\${id}.json`,
    sha256: String(index + 1).repeat(64),
  }));
  return {
    schema: "codex-pet-direction-blind-review/v2",
    reviewPolicy: "unanimous-three-reviewers",
    atlas: { file: "C:\\qa\\atlas.webp", sha256: "A".repeat(64) },
    blindSheet: { file: "C:\\qa\\blind.png", sha256: "B".repeat(64) },
    reviewers,
    ok: true,
    errors: [],
    warnings: [],
    reviewRequired: false,
    unconfirmed: [],
    pairs: BLIND_DIRECTION_PAIRS.map((pair) => ({
      pair: pair.pair,
      axis: pair.axis,
      gate: pair.gate,
      A: {
        source_direction: pair.A.sourceDirection,
        expected: pair.A.expected,
        observed: pair.A.expected,
        pass: true,
        votes: reviewers.map((reviewer) => ({
          reviewer: reviewer.id,
          observed: pair.A.expected,
          confidence: "high",
        })),
      },
      B: {
        source_direction: pair.B.sourceDirection,
        expected: pair.B.expected,
        observed: pair.B.expected,
        pass: true,
        votes: reviewers.map((reviewer) => ({
          reviewer: reviewer.id,
          observed: pair.B.expected,
          confidence: "high",
        })),
      },
    })),
  };
}

const passing = passingBlindReport();
assert.equal(
  blindDirectionReportPasses(passing, { atlasSha256: "A".repeat(64) }),
  true,
  "complete unanimous zero-warning report should pass",
);

const lowercaseHashes = structuredClone(passing);
lowercaseHashes.atlas.sha256 = lowercaseHashes.atlas.sha256.toLowerCase();
lowercaseHashes.blindSheet.sha256 = lowercaseHashes.blindSheet.sha256.toLowerCase();
lowercaseHashes.reviewers.forEach((reviewer) => {
  reviewer.sha256 = reviewer.sha256.toLowerCase();
});
assert.equal(
  blindDirectionReportPasses(lowercaseHashes, { atlasSha256: "A".repeat(64) }),
  true,
  "SHA-256 comparisons should be case-insensitive",
);

const warned = structuredClone(passing);
warned.warnings.push("ambiguous direction");
assert.equal(blindDirectionReportPasses(warned), false, "warnings must fail closed");

const truncated = structuredClone(passing);
truncated.pairs.pop();
assert.equal(blindDirectionReportPasses(truncated), false, "all 14 direction pairs are required");

const duplicated = structuredClone(passing);
duplicated.pairs[13] = structuredClone(duplicated.pairs[0]);
assert.equal(blindDirectionReportPasses(duplicated), false, "pair identifiers must be unique");

const ambiguous = structuredClone(passing);
ambiguous.pairs[6].B.observed = "ambiguous";
ambiguous.pairs[6].B.pass = false;
ambiguous.pairs[6].B.votes[2].observed = "ambiguous";
assert.equal(blindDirectionReportPasses(ambiguous), false, "ambiguous observations must fail");

const missingReviewer = structuredClone(passing);
missingReviewer.reviewers.pop();
assert.equal(blindDirectionReportPasses(missingReviewer), false, "three reviewer artifacts are required");

const aliases = structuredClone(passing);
aliases.reviewers[0].id = "Alice";
aliases.reviewers[1].id = "alice";
aliases.reviewers[2].id = "ALICE";
assert.equal(blindDirectionReportPasses(aliases), false, "reviewer IDs are unique without case aliases");

const malformedReviewer = structuredClone(passing);
malformedReviewer.reviewers[0].id = 42;
assert.doesNotThrow(() => blindDirectionReportPasses(malformedReviewer));
assert.equal(blindDirectionReportPasses(malformedReviewer), false, "malformed reviewer types fail closed");

const splitVote = structuredClone(passing);
splitVote.pairs[6].B.votes[2].observed = "ambiguous";
assert.equal(blindDirectionReportPasses(splitVote), false, "every reviewer vote must match");

const lowConfidence = structuredClone(passing);
lowConfidence.pairs[6].B.votes[2].confidence = "low";
assert.equal(blindDirectionReportPasses(lowConfidence), false, "low-confidence votes must not pass");

assert.equal(
  blindDirectionReportPasses(passing, { atlasSha256: "C".repeat(64) }),
  false,
  "the blind report must be bound to the selected atlas",
);

const directionContinuity = {
  schema: "codex-pet-direction-continuity/v2",
  atlas: { file: "C:\\qa\\atlas.webp", sha256: "A".repeat(64) },
  ok: true,
  errors: [],
  warnings: [],
  reviewRequired: false,
  labels: [...DIRECTION_LABELS],
  medianChangedPixels: 100,
  pairs: DIRECTION_LABELS.map((from, index) => ({
    from,
    to: DIRECTION_LABELS[(index + 1) % DIRECTION_LABELS.length],
    iou: 0.95,
    center: 1,
    baseline: 0,
    areaRatio: 1,
    colorChange: 0.1,
    changedPixels: 100,
    localOutlierRatio: 1,
  })),
};
assert.equal(
  directionContinuityReportPasses(directionContinuity, "a".repeat(64)),
  true,
  "complete direction-continuity structure should pass",
);
const nullDirections = structuredClone(directionContinuity);
nullDirections.pairs = Array.from({ length: 16 }, () => null);
assert.equal(
  directionContinuityReportPasses(nullDirections, "A".repeat(64)),
  false,
  "null direction pairs must fail closed",
);

const directionSemantics = {
  schema: "codex-pet-direction-semantics/v2",
  atlas: { file: "C:\\qa\\atlas.webp", sha256: "A".repeat(64) },
  ok: true,
  errors: [],
  warnings: [],
  directions: DIRECTION_LABELS.map((direction) => ({ direction, verdict: "pass" })),
};
assert.equal(
  directionSemanticsReportPasses(directionSemantics, "a".repeat(64)),
  true,
  "complete direction-semantics structure should pass",
);
directionSemantics.directions[7].verdict = "fail";
assert.equal(
  directionSemanticsReportPasses(directionSemantics, "A".repeat(64)),
  false,
  "every direction-semantic verdict is required",
);

const relabeled = structuredClone(passing);
relabeled.pairs[0].A.source_direction = "090";
assert.equal(blindDirectionReportPasses(relabeled), false, "source directions must match the fixed blind set");

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-pet-quality-gate-"));
try {
  const guardedRoot = path.join(temporaryRoot, "guarded-run");
  const guardedQaRoot = path.join(guardedRoot, "qa");
  await fs.mkdir(guardedQaRoot, { recursive: true });
  const normalOutput = path.join(guardedQaRoot, "normal.json");
  let prepared = await prepareAtomicOutputs(guardedRoot, [normalOutput]);
  await atomicWritePrepared([...prepared.values()][0], "first\n");
  prepared = await prepareAtomicOutputs(guardedRoot, [normalOutput]);
  await atomicWritePrepared([...prepared.values()][0], "second\n");
  assert.equal(await fs.readFile(normalOutput, "utf8"), "second\n", "atomic replacement should work");

  const outsideFile = path.join(temporaryRoot, "outside.txt");
  const hijackedOutput = path.join(guardedQaRoot, "hijacked.json");
  await fs.writeFile(outsideFile, "do not overwrite\n");
  let fileSymlinkCreated = false;
  try {
    await fs.symlink(outsideFile, hijackedOutput, "file");
    fileSymlinkCreated = true;
  } catch (error) {
    const safeSkip =
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOSYS", "UNKNOWN"].includes(error?.code);
    if (!safeSkip) throw error;
    console.warn(`File-symlink hijack regression safely skipped: ${error.code}`);
  }
  if (fileSymlinkCreated) {
    await assert.rejects(
      prepareAtomicOutputs(guardedRoot, [hijackedOutput]),
      /regular file|link or special entry/,
      "a symlinked QA output must be rejected before writing",
    );
    assert.equal(
      await fs.readFile(outsideFile, "utf8"),
      "do not overwrite\n",
      "symlink rejection must leave the external target untouched",
    );
  }

  const outsideDirectory = path.join(temporaryRoot, "outside-qa");
  const linkedParent = path.join(guardedRoot, "linked-qa");
  await fs.mkdir(outsideDirectory);
  let parentLinkCreated = false;
  try {
    await fs.symlink(
      outsideDirectory,
      linkedParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    parentLinkCreated = true;
  } catch (error) {
    const safeSkip =
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOSYS", "UNKNOWN"].includes(error?.code);
    if (!safeSkip) throw error;
    console.warn(`Parent-link hijack regression safely skipped: ${error.code}`);
  }
  if (parentLinkCreated) {
    await assert.rejects(
      prepareAtomicOutputs(guardedRoot, [path.join(linkedParent, "escaped.json")]),
      /real directory|escaped the run directory/,
      "a linked QA output parent must be rejected before writing",
    );
    assert.deepEqual(
      await fs.readdir(outsideDirectory),
      [],
      "parent-link rejection must not create an external output",
    );
  }

  const generatedProject = path.join(temporaryRoot, "generated-project");
  const generatedLocalRoot = path.join(
    generatedProject,
    ".local-assets",
    "placeholder",
    "codex-pet",
  );
  const generatedPublicRoot = path.join(generatedProject, "public", "local");
  await fs.mkdir(path.join(generatedProject, ".local-assets", "placeholder"), { recursive: true });
  await fs.mkdir(path.join(generatedProject, "public"), { recursive: true });
  const generatedNames = ["spritesheet.webp", "spritesheet.png", "pet.json", "desktop-poses.png"];
  let generatedLocalPlan = await preflightSafeOutputTree({
    anchorPath: generatedProject,
    rootPath: generatedLocalRoot,
    outputPaths: generatedNames.map((name) => path.join(generatedLocalRoot, name)),
    label: "Test local generated assets",
  });
  let generatedPublicPlan = await preflightSafeOutputTree({
    anchorPath: generatedProject,
    rootPath: generatedPublicRoot,
    outputPaths: generatedNames.map((name) => path.join(generatedPublicRoot, name)),
    label: "Test public generated assets",
  });
  generatedLocalPlan = await materializeSafeOutputTree(generatedLocalPlan);
  generatedPublicPlan = await materializeSafeOutputTree(generatedPublicPlan);

  const localWebp = safeOutputFrom(generatedLocalPlan, path.join(generatedLocalRoot, "spritesheet.webp"));
  const localManifest = safeOutputFrom(generatedLocalPlan, path.join(generatedLocalRoot, "pet.json"));
  const publicWebp = safeOutputFrom(generatedPublicPlan, path.join(generatedPublicRoot, "spritesheet.webp"));
  const publicManifest = safeOutputFrom(generatedPublicPlan, path.join(generatedPublicRoot, "pet.json"));
  await atomicReplaceSafeOutputs([
    { output: localWebp, contents: "old-local-atlas\n" },
    { output: localManifest, contents: "old-local-manifest\n" },
    { output: publicWebp, contents: "old-public-atlas\n" },
    { output: publicManifest, contents: "old-public-manifest\n" },
  ]);
  assert.equal(await fs.readFile(localWebp.targetPath, "utf8"), "old-local-atlas\n");
  assert.equal(await fs.readFile(publicWebp.targetPath, "utf8"), "old-public-atlas\n");

  await assert.rejects(
    atomicReplaceSafeOutputs([
      { output: localWebp, contents: "must-not-commit\n" },
      { output: publicWebp, contents: { invalid: "not writable file contents" } },
    ]),
    /data.*string|Buffer|TypedArray|DataView/i,
    "a staging failure must occur before any fixed generated target is replaced",
  );
  assert.equal(
    await fs.readFile(localWebp.targetPath, "utf8"),
    "old-local-atlas\n",
    "a later staging failure must preserve an earlier target",
  );
  assert.equal(
    await fs.readFile(publicWebp.targetPath, "utf8"),
    "old-public-atlas\n",
    "the failing target must preserve its old contents",
  );
  assert.deepEqual(
    (await fs.readdir(generatedLocalRoot)).filter((name) => name.startsWith(".")),
    [],
    "failed atomic staging must not leave sibling temporary files",
  );
  assert.deepEqual(
    (await fs.readdir(generatedPublicRoot)).filter((name) => name.startsWith(".")),
    [],
    "failed atomic staging must clean every output tree",
  );

  const optionalPose = safeOutputFrom(
    generatedPublicPlan,
    path.join(generatedPublicRoot, "desktop-poses.png"),
  );
  await atomicReplaceSafeOutputs([{ output: optionalPose, contents: "stale pose\n" }]);
  await removeSafeOutputs([optionalPose]);
  await assert.rejects(fs.access(optionalPose.targetPath), { code: "ENOENT" });

  const targetAttackProject = path.join(temporaryRoot, "target-attack-project");
  const targetAttackPublicRoot = path.join(targetAttackProject, "public", "local");
  const targetAttackLocalRoot = path.join(
    targetAttackProject,
    ".local-assets",
    "placeholder",
    "codex-pet",
  );
  await fs.mkdir(targetAttackPublicRoot, { recursive: true });
  await fs.mkdir(targetAttackLocalRoot, { recursive: true });
  const externalTargetSentinel = path.join(temporaryRoot, "external-target-sentinel.txt");
  const untouchedLocalTarget = path.join(targetAttackLocalRoot, "spritesheet.webp");
  await fs.writeFile(externalTargetSentinel, "external sentinel\n");
  await fs.writeFile(untouchedLocalTarget, "existing local output\n");
  const hijackedPublicTarget = path.join(targetAttackPublicRoot, "spritesheet.webp");
  let generatedTargetLinkCreated = false;
  try {
    await fs.symlink(externalTargetSentinel, hijackedPublicTarget, "file");
    generatedTargetLinkCreated = true;
  } catch (error) {
    const safeSkip =
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOSYS", "UNKNOWN"].includes(error?.code);
    if (!safeSkip) throw error;
    console.warn(`Generated-target symlink regression safely skipped: ${error.code}`);
  }
  if (generatedTargetLinkCreated) {
    await assert.rejects(
      preflightSafeOutputTree({
        anchorPath: targetAttackProject,
        rootPath: targetAttackPublicRoot,
        outputPaths: generatedNames.map((name) => path.join(targetAttackPublicRoot, name)),
        label: "Target attack public assets",
      }),
      /symlink, junction, or reparse point/,
      "a fixed generated target symlink must fail during the read-only preflight",
    );
    assert.equal(await fs.readFile(externalTargetSentinel, "utf8"), "external sentinel\n");
    assert.equal(
      await fs.readFile(untouchedLocalTarget, "utf8"),
      "existing local output\n",
      "a public target attack must be rejected before another output is replaced or deleted",
    );
  }

  const junctionAttackProject = path.join(temporaryRoot, "junction-attack-project");
  const junctionLocalParent = path.join(junctionAttackProject, ".local-assets");
  const junctionPublicParent = path.join(junctionAttackProject, "public");
  const outsideLocalTree = path.join(temporaryRoot, "outside-local-tree");
  const outsidePublicTree = path.join(temporaryRoot, "outside-public-tree");
  await fs.mkdir(junctionLocalParent, { recursive: true });
  await fs.mkdir(junctionPublicParent, { recursive: true });
  await fs.mkdir(path.join(outsideLocalTree, "codex-pet"), { recursive: true });
  await fs.mkdir(outsidePublicTree, { recursive: true });
  const outsideLocalSentinel = path.join(outsideLocalTree, "sentinel.txt");
  const outsidePublicSentinel = path.join(outsidePublicTree, "sentinel.txt");
  await fs.writeFile(outsideLocalSentinel, "outside local sentinel\n");
  await fs.writeFile(outsidePublicSentinel, "outside public sentinel\n");
  const linkedLocalComponent = path.join(junctionLocalParent, "placeholder");
  const linkedPublicRoot = path.join(junctionPublicParent, "local");
  let generatedJunctionsCreated = false;
  try {
    await fs.symlink(
      outsideLocalTree,
      linkedLocalComponent,
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.symlink(
      outsidePublicTree,
      linkedPublicRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    generatedJunctionsCreated = true;
  } catch (error) {
    const safeSkip =
      process.platform === "win32" &&
      ["EPERM", "EACCES", "ENOSYS", "UNKNOWN"].includes(error?.code);
    if (!safeSkip) throw error;
    console.warn(`Generated-output junction regression safely skipped: ${error.code}`);
  }
  if (generatedJunctionsCreated) {
    const attackedLocalRoot = path.join(linkedLocalComponent, "codex-pet");
    await assert.rejects(
      preflightSafeOutputTree({
        anchorPath: junctionAttackProject,
        rootPath: attackedLocalRoot,
        outputPaths: generatedNames.map((name) => path.join(attackedLocalRoot, name)),
        label: "Junction attack local assets",
      }),
      /symlink, junction, or reparse point|resolved through a junction/,
      "a junction in the local codex-pet path chain must fail before writing",
    );
    await assert.rejects(
      preflightSafeOutputTree({
        anchorPath: junctionAttackProject,
        rootPath: linkedPublicRoot,
        outputPaths: generatedNames.map((name) => path.join(linkedPublicRoot, name)),
        label: "Junction attack public assets",
      }),
      /symlink, junction, or reparse point|resolved through a junction/,
      "a junction used as public/local must fail before writing",
    );
    assert.equal(await fs.readFile(outsideLocalSentinel, "utf8"), "outside local sentinel\n");
    assert.equal(await fs.readFile(outsidePublicSentinel, "utf8"), "outside public sentinel\n");
    assert.deepEqual(
      await fs.readdir(path.join(outsideLocalTree, "codex-pet")),
      [],
      "local junction rejection must not create an escaped generated file",
    );
    assert.deepEqual(
      (await fs.readdir(outsidePublicTree)).sort(),
      ["sentinel.txt"],
      "public junction rejection must not modify the external directory",
    );
  }

  const validPosePath = path.join(temporaryRoot, "desktop-poses-valid.png");
  await writePoseFixture(validPosePath);
  const validPose = await inspectDesktopPoseAtlas(validPosePath);
  assert.deepEqual(validPose.errors, [], "a complete 768x832 4x4 pose atlas should pass structure checks");
  assert.equal(validPose.frames.length, 16, "all 16 desktop pose cells must be decoded");
  const stablePoseAudit = auditDesktopActionPlaybacks(
    desktopPoseActionPlaybacks(validPose.frames[0], validPose.frames),
  );
  assert.deepEqual(stablePoseAudit.errors, [], "stable runtime pose sequences should pass transitions");

  const edgePosePath = path.join(temporaryRoot, "desktop-poses-edge-contact.png");
  await writePoseFixture(edgePosePath, { edgeIndex: 13 });
  const edgePose = await inspectDesktopPoseAtlas(edgePosePath);
  assert.ok(
    edgePose.errors.some((error) => error.includes("frame 13 must keep at least 4px transparent margin")),
    "every desktop pose cell must retain a transparent safety margin instead of touching its boundary",
  );

  const wrongSizePosePath = path.join(temporaryRoot, "desktop-poses-wrong-size.png");
  await writePoseFixture(wrongSizePosePath, { width: 767 });
  const wrongSizePose = await inspectDesktopPoseAtlas(wrongSizePosePath);
  assert.ok(
    wrongSizePose.errors.some((error) => error.includes("must be 768x832")),
    "a desktop pose atlas with the wrong dimensions must fail",
  );

  const emptyPosePath = path.join(temporaryRoot, "desktop-poses-empty-cell.png");
  await writePoseFixture(emptyPosePath, { emptyIndex: 14 });
  const emptyPose = await inspectDesktopPoseAtlas(emptyPosePath);
  assert.ok(
    emptyPose.errors.some((error) => error.includes("frame 14 is empty")),
    "every one of the 16 desktop pose cells must be non-empty",
  );

  const outlierPosePath = path.join(temporaryRoot, "desktop-poses-transition-outlier.png");
  await writePoseFixture(outlierPosePath, { outlierIndex: 14 });
  const outlierPose = await inspectDesktopPoseAtlas(outlierPosePath);
  assert.deepEqual(outlierPose.errors, [], "an outlier fixture should still be structurally complete");
  const outlierPoseAudit = auditDesktopActionPlaybacks(
    desktopPoseActionPlaybacks(outlierPose.frames[0], outlierPose.frames),
  );
  assert.ok(
    outlierPoseAudit.errors.some((error) => error.startsWith("desktop rolling:")),
    "the runtime rolling sequence must reject an obvious pose transition",
  );

  const atlasPath = path.join(temporaryRoot, "atlas.webp");
  const sheetPath = path.join(temporaryRoot, "blind.png");
  const outputPath = path.join(temporaryRoot, "combined.json");
  await sharp({
    create: { width: 1536, height: 2288, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .webp({ lossless: true, exact: true })
    .toFile(atlasPath);
  const atlasSha256 = createHash("sha256")
    .update(await fs.readFile(atlasPath))
    .digest("hex")
    .toUpperCase();
  const blindSheet = await renderBlindDirectionSheet(atlasPath);
  await fs.writeFile(sheetPath, blindSheet);
  const blindSheetSha256 = createHash("sha256").update(blindSheet).digest("hex").toUpperCase();

  const reviewerPaths = [];
  for (const reviewer of ["reviewer-a", "reviewer-b", "reviewer-c"]) {
    const reviewerPath = path.join(temporaryRoot, `${reviewer}.json`);
    const verdict = {
      schema: BLIND_VERDICT_SCHEMA,
      reviewer,
      atlasSha256,
      blindSheetSha256,
      attestation: { blindSheetOnly: true, answerKeySeen: false, independent: true },
      pairs: BLIND_DIRECTION_PAIRS.map((pair) => ({
        pair: pair.pair,
        axis: pair.axis,
        A: { observed: pair.A.expected, confidence: "high" },
        B: { observed: pair.B.expected, confidence: "high" },
      })),
    };
    await fs.writeFile(reviewerPath, `${JSON.stringify(verdict, null, 2)}\n`);
    reviewerPaths.push(reviewerPath);
  }

  const compilerArguments = [
    "scripts/compile-blind-direction-review.mjs",
    "--atlas",
    atlasPath,
    "--sheet",
    sheetPath,
    ...reviewerPaths.flatMap((reviewer) => ["--reviewer", reviewer]),
    "--output",
    outputPath,
  ];
  execFileSync(process.execPath, compilerArguments, { stdio: "pipe" });
  const compiled = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(
    blindDirectionReportPasses(compiled, { atlasSha256: compiled.atlas.sha256 }),
    true,
    "compiler output should satisfy the strict gate",
  );

  const firstReviewer = await fs.readFile(reviewerPaths[0]);
  await fs.rm(reviewerPaths[0]);
  assert.throws(
    () => execFileSync(process.execPath, compilerArguments, { stdio: "pipe" }),
    "missing evidence must fail compilation",
  );
  const invalidated = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(invalidated.ok, false, "fatal input errors must invalidate an older passing output");
  await fs.writeFile(reviewerPaths[0], firstReviewer);
  execFileSync(process.execPath, compilerArguments, { stdio: "pipe" });

  const replayed = JSON.parse(await fs.readFile(reviewerPaths[1], "utf8"));
  replayed.blindSheetSha256 = "C".repeat(64);
  await fs.writeFile(reviewerPaths[1], `${JSON.stringify(replayed, null, 2)}\n`);
  assert.throws(
    () => execFileSync(process.execPath, compilerArguments, { stdio: "pipe" }),
    "verdicts bound to another blind sheet must be rejected",
  );
  replayed.blindSheetSha256 = blindSheetSha256;
  await fs.writeFile(reviewerPaths[1], `${JSON.stringify(replayed, null, 2)}\n`);
  execFileSync(process.execPath, compilerArguments, { stdio: "pipe" });

  const divided = JSON.parse(await fs.readFile(reviewerPaths[2], "utf8"));
  divided.pairs[6].B = { observed: "ambiguous", confidence: "high" };
  await fs.writeFile(reviewerPaths[2], `${JSON.stringify(divided, null, 2)}\n`);
  assert.throws(
    () => execFileSync(process.execPath, compilerArguments, { stdio: "pipe" }),
    "compiler must reject a single dissenting or ambiguous vote",
  );
  const rejected = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(blindDirectionReportPasses(rejected), false, "failed compiler output must stay rejected");
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Quality-gate self-tests passed.");
