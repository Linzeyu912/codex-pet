import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  blindDirectionReportPasses,
  blindVerdictsMatchReport,
  directionContinuityReportPasses,
  directionSemanticsReportPasses,
} from "./lib/atlas-quality.mjs";
import { renderBlindDirectionSheet } from "./lib/blind-sheet.mjs";
import { readAtlasFrame } from "./lib/frame-analysis.mjs";
import { POSE_ATLAS_CELL_MARGIN } from "./lib/pose-atlas-quality.mjs";
import { auditChromaFringeFile, removeBlueHaloRgba } from "./remove-chroma-fringe.mjs";
import {
  atomicReplaceSafeOutputs,
  materializeSafeOutputTree,
  preflightSafeOutputTree,
  realFileWithin,
  removeSafeOutputs,
  safeOutputFrom,
} from "./lib/project-utils.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const projectRoot = path.resolve(scriptDir, "..");

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 11;
const ATLAS_WIDTH = CELL_WIDTH * ATLAS_COLUMNS;
const ATLAS_HEIGHT = CELL_HEIGHT * ATLAS_ROWS;
const BASE_WIDTH = 160;
const BASE_HEIGHT = 154;
const BASELINE_Y = 188;
const CHARACTER_UPRIGHT_HEIGHT = 181;
const CHARACTER_POSE_LONG_SIDE = 181;
// Hover-jump frames preserve the idle silhouette while moving vertically;
// failed/lying frames rotate the body and remain excluded from upright scaling.
const MAIN_ATLAS_UPRIGHT_FRAME_COUNTS = Object.freeze([7, 8, 8, 4, 5, 0, 6, 6, 6, 8, 8]);
const POSE_TARGET_AREA_RATIOS = Object.freeze([
  0.82, 0.82, 0.86, 0.84,
  0.82, 0.82, 0.86, 0.84,
  0.86, 0.86, 0.86, 0.82,
  0.72, 0.78, 0.85, 0.86,
]);
const STRICT_CHROMA_FRINGE_OPTIONS = Object.freeze({
  distanceThreshold: 160,
  alphaMinimum: 1,
});

const classicRoot = path.join(projectRoot, ".local-assets", "qq-penguin");
const classicSourcePath = path.join(classicRoot, "pixel-base.png");
const classicPoseSheetPath = path.join(classicRoot, "poses", "pose-sheet-v1.png");
const coherentRunRoot = path.join(classicRoot, "coherent-v2-run");
const coherentAtlasPath = path.join(coherentRunRoot, "final", "spritesheet-extended.webp");
const coherentValidationPath = path.join(coherentRunRoot, "final", "validation-extended.json");
const coherentRunSummaryPath = path.join(coherentRunRoot, "qa", "run-summary.json");
const placeholderSourcePath = path.join(projectRoot, "public", "placeholder.svg");
const publicRoot = path.join(projectRoot, "public", "local");

const classicManifest = {
  id: "qq-penguin",
  displayName: "QQ Penguin",
  description: "A local classic red-scarf pixel penguin companion.",
  spriteVersionNumber: 2,
  spritesheetPath: "spritesheet.webp",
};

const placeholderManifest = {
  id: "codex-penguin-placeholder",
  displayName: "Codex Penguin Placeholder",
  description: "A rights-safe geometric placeholder pet.",
  spriteVersionNumber: 2,
  spritesheetPath: "spritesheet.webp",
};

async function resolveSource() {
  if (process.env.CODEX_PET_FORCE_PLACEHOLDER !== "1") {
    try {
      await fs.access(classicSourcePath);
      return {
        sourcePath: classicSourcePath,
        outputRoot: path.join(classicRoot, "codex-pet"),
        manifest: classicManifest,
        usedPlaceholder: false,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // Fall through to the rights-safe placeholder only when the classic source is absent.
    }
  }
  await fs.access(placeholderSourcePath);
  return {
    sourcePath: placeholderSourcePath,
    outputRoot: path.join(projectRoot, ".local-assets", "placeholder", "codex-pet"),
    manifest: placeholderManifest,
    usedPlaceholder: true,
  };
}

async function resolveValidatedCoherentAtlas() {
  try {
    await fs.access(coherentAtlasPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  for (const evidencePath of [coherentValidationPath, coherentRunSummaryPath]) {
    try {
      await fs.access(evidencePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`The coherent atlas exists but required QA evidence is missing: ${evidencePath}`);
      }
      throw error;
    }
  }
  await realFileWithin(coherentRunRoot, coherentAtlasPath, "Final atlas");
  await realFileWithin(coherentRunRoot, coherentValidationPath, "Official validation");
  await realFileWithin(coherentRunRoot, coherentRunSummaryPath, "Authoritative QA summary");

  const chromaAudit = await auditChromaFringeFile(
    coherentAtlasPath,
    STRICT_CHROMA_FRINGE_OPTIONS,
  );
  if (chromaAudit.total !== 0) {
    throw new Error(
      `The coherent V2 atlas still has ${chromaAudit.total} visible cyan edge-fringe pixels.`,
    );
  }

  const validation = JSON.parse(await fs.readFile(coherentValidationPath, "utf8"));
  const runSummary = JSON.parse(await fs.readFile(coherentRunSummaryPath, "utf8"));
  const atlasStats = await fs.stat(coherentAtlasPath);
  const validationStats = await fs.stat(coherentValidationPath);
  const validationFile = path.resolve(validation.file ?? "").toLocaleLowerCase();
  const expectedFile = path.resolve(coherentAtlasPath).toLocaleLowerCase();
  const validationErrors = Array.isArray(validation.errors) ? validation.errors : ["missing errors array"];
  const validationWarnings = Array.isArray(validation.warnings) ? validation.warnings : ["missing warnings array"];
  if (
    validation.ok !== true ||
    validationFile !== expectedFile ||
    validation.sprite_version_number !== 2 ||
    validation.width !== ATLAS_WIDTH ||
    validation.height !== ATLAS_HEIGHT ||
    validationErrors.length > 0 ||
    validationWarnings.length > 0 ||
    validationStats.mtimeMs < atlasStats.mtimeMs
  ) {
    throw new Error(`The coherent V2 atlas exists but its validation did not pass: ${coherentValidationPath}`);
  }

  const atlasSha256 = createHash("sha256")
    .update(await fs.readFile(coherentAtlasPath))
    .digest("hex")
    .toUpperCase();
  const requiredGates = [
    "officialValidation",
    "chromaClean",
    "continuity",
    "blindDirections",
    "directionSemantics",
    "directionContinuity",
    "finalReview",
  ];
  if (
    runSummary.schema !== "codex-pet-authoritative-run/v2" ||
    runSummary.ok !== true ||
    path.resolve(runSummary.atlas?.file ?? "").toLocaleLowerCase() !== expectedFile ||
    runSummary.atlas?.sha256?.toUpperCase() !== atlasSha256 ||
    requiredGates.some((gate) => runSummary.qualityGates?.[gate] !== true)
  ) {
    throw new Error(`The coherent atlas has no passing authoritative QA run: ${coherentRunSummaryPath}`);
  }
  const summaryStats = await fs.stat(coherentRunSummaryPath);
  if (summaryStats.mtimeMs < atlasStats.mtimeMs) {
    throw new Error(`The authoritative QA run is stale: ${coherentRunSummaryPath}`);
  }
  const requiredArtifacts = [
    "officialValidation",
    "continuity",
    "blindDirections",
    "directionSemantics",
    "directionContinuity",
    "finalReview",
  ];
  const expectedArtifactPaths = {
    officialValidation: coherentValidationPath,
    continuity: path.join(coherentRunRoot, "qa", "continuity-audit-v2.json"),
    blindDirections: path.join(coherentRunRoot, "qa", "direction-blind-validation.json"),
    directionSemantics: path.join(coherentRunRoot, "qa", "direction-semantics.json"),
    directionContinuity: path.join(coherentRunRoot, "qa", "look-continuity.json"),
    finalReview: path.join(coherentRunRoot, "qa", "final-frame-review.json"),
  };
  for (const name of requiredArtifacts) {
    const artifact = runSummary.artifacts?.[name];
    const artifactPath = path.resolve(artifact?.file ?? "");
    const expectedArtifactPath = path.resolve(expectedArtifactPaths[name]);
    if (artifactPath.toLocaleLowerCase() !== expectedArtifactPath.toLocaleLowerCase()) {
      throw new Error(`The authoritative QA artifact path is not canonical (${name}): ${artifactPath}`);
    }
    let artifactStats;
    try {
      await realFileWithin(coherentRunRoot, artifactPath, `${name} QA artifact`);
      artifactStats = await fs.stat(artifactPath);
    } catch {
      throw new Error(`The authoritative QA artifact is missing (${name}): ${artifactPath}`);
    }
    const artifactSha256 = createHash("sha256")
      .update(await fs.readFile(artifactPath))
      .digest("hex")
      .toUpperCase();
    if (
      artifactSha256 !== artifact.sha256?.toUpperCase() ||
      artifactStats.mtimeMs < atlasStats.mtimeMs ||
      summaryStats.mtimeMs < artifactStats.mtimeMs
    ) {
      throw new Error(`The authoritative QA artifact is stale or was replaced (${name}): ${artifactPath}`);
    }
  }

  const directionContinuityReport = JSON.parse(
    await fs.readFile(expectedArtifactPaths.directionContinuity, "utf8"),
  );
  if (!directionContinuityReportPasses(directionContinuityReport, atlasSha256)) {
    throw new Error("The direction-continuity report is incomplete or not bound to the final atlas.");
  }
  const directionSemanticsReport = JSON.parse(
    await fs.readFile(expectedArtifactPaths.directionSemantics, "utf8"),
  );
  if (!directionSemanticsReportPasses(directionSemanticsReport, atlasSha256)) {
    throw new Error("The direction-semantics report is incomplete or not bound to the final atlas.");
  }

  const blindReportPath = path.resolve(runSummary.artifacts.blindDirections.file);
  const blindReport = JSON.parse(await fs.readFile(blindReportPath, "utf8"));
  if (
    !blindDirectionReportPasses(blindReport, { atlasSha256 }) ||
    path.resolve(blindReport.atlas?.file ?? "").toLocaleLowerCase() !== expectedFile
  ) {
    throw new Error(`The direction blind-review report did not pass the strict gate: ${blindReportPath}`);
  }
  const deterministicBlindSheetSha256 = createHash("sha256")
    .update(await renderBlindDirectionSheet(coherentAtlasPath))
    .digest("hex")
    .toUpperCase();
  if (deterministicBlindSheetSha256 !== blindReport.blindSheet.sha256.toUpperCase()) {
    throw new Error("The reviewed blind sheet was not deterministically generated from the final atlas.");
  }
  const realEvidencePaths = [];
  const reviewerVerdicts = [];
  for (const evidence of [blindReport.blindSheet, ...blindReport.reviewers]) {
    const evidencePath = await realFileWithin(coherentRunRoot, evidence.file, "Blind-review evidence");
    realEvidencePaths.push(evidencePath.toLocaleLowerCase());
    const evidenceSha256 = createHash("sha256")
      .update(await fs.readFile(evidencePath))
      .digest("hex")
      .toUpperCase();
    if (evidenceSha256 !== evidence.sha256.toUpperCase()) {
      throw new Error(`Blind-review evidence was replaced after review: ${evidencePath}`);
    }
    if (evidence !== blindReport.blindSheet) {
      reviewerVerdicts.push(JSON.parse(await fs.readFile(evidencePath, "utf8")));
    }
  }
  if (new Set(realEvidencePaths).size !== realEvidencePaths.length) {
    throw new Error("Blind-review evidence paths are not unique after realpath resolution.");
  }
  if (!blindVerdictsMatchReport(blindReport, reviewerVerdicts)) {
    throw new Error("The compiled blind report does not match the three raw reviewer verdicts.");
  }

  const metadata = await sharp(coherentAtlasPath).metadata();
  if (metadata.width !== ATLAS_WIDTH || metadata.height !== ATLAS_HEIGHT) {
    throw new Error(
      `The coherent V2 atlas must be ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, got ${metadata.width}x${metadata.height}.`,
    );
  }

  return coherentAtlasPath;
}

function pixelOffset(x, y, width) {
  return (y * width + x) * 4;
}

function clearPixel(buffer, offset) {
  buffer[offset] = 0;
  buffer[offset + 1] = 0;
  buffer[offset + 2] = 0;
  buffer[offset + 3] = 0;
}

function isGreenKey(r, g, b) {
  return g > 70 && g - r > 38 && g - b > 38 && g > r * 1.16 && g > b * 1.16;
}

async function cleanSourceAndFindSubject(inputPath) {
  const { data: original, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const data = Buffer.from(original);
  const pixelCount = info.width * info.height;

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 4;
    const alpha = data[offset + 3];
    if (alpha < 128 || isGreenKey(data[offset], data[offset + 1], data[offset + 2])) {
      clearPixel(data, offset);
    } else {
      data[offset + 3] = 255;
    }
  }

  const labels = new Int32Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let componentId = 0;
  let largestId = 0;
  let largestCount = 0;
  let largestBounds = null;

  for (let start = 0; start < pixelCount; start += 1) {
    if (data[start * 4 + 3] === 0 || labels[start] !== 0) continue;

    componentId += 1;
    let head = 0;
    let tail = 0;
    let count = 0;
    let minX = info.width;
    let minY = info.height;
    let maxX = 0;
    let maxY = 0;
    queue[tail++] = start;
    labels[start] = componentId;

    while (head < tail) {
      const current = queue[head++];
      const x = current % info.width;
      const y = Math.floor(current / info.width);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbours = [
        x > 0 ? current - 1 : -1,
        x + 1 < info.width ? current + 1 : -1,
        y > 0 ? current - info.width : -1,
        y + 1 < info.height ? current + info.width : -1,
      ];
      for (const next of neighbours) {
        if (next < 0 || labels[next] !== 0 || data[next * 4 + 3] === 0) continue;
        labels[next] = componentId;
        queue[tail++] = next;
      }
    }

    if (count > largestCount) {
      largestId = componentId;
      largestCount = count;
      largestBounds = { minX, minY, maxX, maxY };
    }
  }

  if (!largestBounds || largestCount === 0) {
    throw new Error("No opaque penguin subject was found after chroma cleanup.");
  }

  for (let index = 0; index < pixelCount; index += 1) {
    if (labels[index] !== largestId) clearPixel(data, index * 4);
  }

  return { data, width: info.width, height: info.height, bounds: largestBounds };
}

async function normalizeBase(inputPath) {
  const cleaned = await cleanSourceAndFindSubject(inputPath);
  const cropWidth = cleaned.bounds.maxX - cleaned.bounds.minX + 1;
  const cropHeight = cleaned.bounds.maxY - cleaned.bounds.minY + 1;

  const reduced = await sharp(cleaned.data, {
    raw: { width: cleaned.width, height: cleaned.height, channels: 4 },
  })
    .extract({
      left: cleaned.bounds.minX,
      top: cleaned.bounds.minY,
      width: cropWidth,
      height: cropHeight,
    })
    .resize(80, 77, { fit: "fill", kernel: sharp.kernel.nearest })
    .png({ palette: true, colours: 24, dither: 0 })
    .toBuffer();

  const { data, info } = await sharp(reduced)
    .resize(BASE_WIDTH, BASE_HEIGHT, { fit: "fill", kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const normalized = Buffer.from(data);
  for (let offset = 0; offset < normalized.length; offset += 4) {
    if (normalized[offset + 3] === 0) clearPixel(normalized, offset);
  }
  return { data: normalized, width: info.width, height: info.height };
}

async function normalizePoseCell(sheetData, sheetWidth, sheetHeight, cell) {
  const { data: extracted, info } = await sharp(sheetData, {
    raw: { width: sheetWidth, height: sheetHeight, channels: 4 },
  })
    .extract(cell)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cleaned = Buffer.from(extracted);
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = pixelOffset(x, y, info.width);
      const alpha = cleaned[offset + 3];
      if (alpha < 128 || isGreenKey(cleaned[offset], cleaned[offset + 1], cleaned[offset + 2])) {
        clearPixel(cleaned, offset);
        continue;
      }
      cleaned[offset + 3] = 255;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error("A pose-sheet cell did not contain a visible penguin.");
  }

  const cropWidth = maxX - minX + 1;
  const cropHeight = maxY - minY + 1;
  const scale = Math.min(BASE_WIDTH / cropWidth, BASE_HEIGHT / cropHeight);
  const targetWidth = Math.max(2, Math.round((cropWidth * scale) / 2) * 2);
  const targetHeight = Math.max(2, Math.round((cropHeight * scale) / 2) * 2);
  const quantized = await sharp(cleaned, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .extract({ left: minX, top: minY, width: cropWidth, height: cropHeight })
    .resize(targetWidth, targetHeight, { fit: "fill", kernel: sharp.kernel.nearest })
    .png({ palette: true, colours: 28, dither: 0 })
    .toBuffer();
  const { data, info: poseInfo } = await sharp(quantized)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const normalized = Buffer.from(data);
  for (let offset = 0; offset < normalized.length; offset += 4) {
    if (normalized[offset + 3] === 0) clearPixel(normalized, offset);
  }
  return { data: normalized, width: poseInfo.width, height: poseInfo.height };
}

async function loadPoseFrames(inputPath) {
  try {
    await fs.access(inputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const poses = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      const left = Math.round((column * info.width) / 4);
      const top = Math.round((row * info.height) / 4);
      const right = Math.round(((column + 1) * info.width) / 4);
      const bottom = Math.round(((row + 1) * info.height) / 4);
      poses.push(
        await normalizePoseCell(data, info.width, info.height, {
          left,
          top,
          width: right - left,
          height: bottom - top,
        }),
      );
    }
  }
  return poses;
}

function inspectRawPoseFrame(frame) {
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = frame.width;
  let minY = frame.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const offset = pixelOffset(x, y, frame.width);
      if (frame.data[offset + 3] <= 8) continue;
      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (area === 0) throw new Error("A normalized pose frame is empty.");
  return {
    area,
    centerX: sumX / area,
    centerY: sumY / area,
    left: minX,
    top: minY,
    right: maxX,
    baseline: maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

async function loadPoseReferenceMetrics(inputPath) {
  if (!inputPath) return null;
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== ATLAS_WIDTH || info.height !== ATLAS_HEIGHT) {
    throw new Error(`Pose reference atlas must be ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, got ${info.width}x${info.height}.`);
  }
  const idle = readAtlasFrame(data, {
    atlasWidth: ATLAS_WIDTH,
    cellWidth: CELL_WIDTH,
    cellHeight: CELL_HEIGHT,
    row: 0,
    column: 0,
  });
  if (idle.area === 0) throw new Error(`Pose reference atlas has an empty idle frame: ${inputPath}`);
  return { file: inputPath, ...idle };
}

async function scalePoseFrameToReference(frame, index, reference) {
  const source = inspectRawPoseFrame(frame);
  const desiredArea = reference.area * POSE_TARGET_AREA_RATIOS[index];
  const desiredAreaScale = desiredArea / source.area;
  let scaleX = Math.sqrt(desiredAreaScale);
  let scaleY = scaleX;
  const maxWidth = Math.min(
    CELL_WIDTH - POSE_ATLAS_CELL_MARGIN * 2,
    Math.max(BASE_WIDTH, Math.round(reference.width * 1.03)),
  );
  const maxHeight = Math.min(CELL_HEIGHT - POSE_ATLAS_CELL_MARGIN * 2, reference.height);

  if (source.width * scaleX > maxWidth) {
    scaleX = maxWidth / source.width;
    scaleY = desiredAreaScale / scaleX;
  }
  if (source.height * scaleY > maxHeight) {
    scaleY = maxHeight / source.height;
    scaleX = desiredAreaScale / scaleY;
  }
  scaleX = Math.min(scaleX, maxWidth / source.width);
  scaleY = Math.min(scaleY, maxHeight / source.height);

  const targetWidth = Math.max(2, Math.round(frame.width * scaleX));
  const targetHeight = Math.max(2, Math.round(frame.height * scaleY));
  const { data, info } = await sharp(frame.data, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .resize(targetWidth, targetHeight, { fit: "fill", kernel: sharp.kernel.nearest })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scaled = { data: Buffer.from(data), width: info.width, height: info.height };
  for (let offset = 0; offset < scaled.data.length; offset += 4) {
    if (scaled.data[offset + 3] === 0) clearPixel(scaled.data, offset);
  }
  return scaled;
}

async function buildDesktopPoseAtlas(poseFrames, referenceAtlasPath = null) {
  if (!Array.isArray(poseFrames) || poseFrames.length !== 16) {
    throw new Error(`desktop-poses.png requires exactly 16 normalized poses, got ${poseFrames?.length ?? 0}.`);
  }
  const reference = await loadPoseReferenceMetrics(referenceAtlasPath);
  const normalizedPoseFrames = reference
    ? await Promise.all(poseFrames.map((frame, index) => scalePoseFrameToReference(frame, index, reference)))
    : poseFrames;
  const width = CELL_WIDTH * 4;
  const height = CELL_HEIGHT * 4;
  const atlas = Buffer.alloc(width * height * 4);
  const expectedBaseline = reference?.baseline ?? BASELINE_Y - 1;
  for (let index = 0; index < normalizedPoseFrames.length; index += 1) {
    const source = normalizedPoseFrames[index];
    const sourceMetrics = inspectRawPoseFrame(source);
    const defaultFrame = makeFrame(null, { source });
    const minLeft = POSE_ATLAS_CELL_MARGIN - sourceMetrics.left;
    const maxLeft = CELL_WIDTH - 1 - POSE_ATLAS_CELL_MARGIN - sourceMetrics.right;
    const alignedLeft = reference
      ? Math.max(minLeft, Math.min(maxLeft, Math.round(reference.centerX - sourceMetrics.centerX)))
      : defaultFrame.left;
    const alignedTop = reference ? expectedBaseline - sourceMetrics.baseline : defaultFrame.top;
    const frame = { ...source, left: alignedLeft, top: alignedTop };
    if (
      frame.left + sourceMetrics.left < POSE_ATLAS_CELL_MARGIN ||
      frame.top + sourceMetrics.top < POSE_ATLAS_CELL_MARGIN ||
      frame.left + sourceMetrics.right > CELL_WIDTH - 1 - POSE_ATLAS_CELL_MARGIN ||
      frame.top + sourceMetrics.baseline > CELL_HEIGHT - 1 - POSE_ATLAS_CELL_MARGIN
    ) {
      throw new Error(`desktop-poses.png pose ${index} cannot preserve the required ${POSE_ATLAS_CELL_MARGIN}px cell margin.`);
    }
    let occupied = 0;
    let maxOccupiedY = -1;
    for (let y = 0; y < frame.height; y += 1) {
      const targetY = Math.floor(index / 4) * CELL_HEIGHT + frame.top + y;
      for (let x = 0; x < frame.width; x += 1) {
        const from = pixelOffset(x, y, frame.width);
        if (frame.data[from + 3] === 0) continue;
        occupied += 1;
        maxOccupiedY = Math.max(maxOccupiedY, frame.top + y);
        const targetX = (index % 4) * CELL_WIDTH + frame.left + x;
        frame.data.copy(atlas, pixelOffset(targetX, targetY, width), from, from + 4);
      }
    }
    if (occupied === 0) throw new Error(`desktop-poses.png pose ${index} is empty.`);
    if (maxOccupiedY !== expectedBaseline) {
      throw new Error(
        `desktop-poses.png pose ${index} must end at y=${expectedBaseline}, got y=${maxOccupiedY}.`,
      );
    }
  }
  const stabilized = normalizeAtlasFrameExtents(atlas, width, {
    columns: 4,
    rows: 4,
    frameCounts: [4, 4, 4, 4],
    metric: "long-side",
    targetExtent: CHARACTER_POSE_LONG_SIDE,
  });
  const desktopPoses = await sharp(stabilized.data, { raw: { width, height, channels: 4 } })
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
  const metadata = await sharp(desktopPoses).metadata();
  if (metadata.width !== width || metadata.height !== height) {
    throw new Error(`desktop-poses.png must be ${width}x${height}, got ${metadata.width}x${metadata.height}.`);
  }
  return desktopPoses;
}

function resizeNearest(source, sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const output = Buffer.alloc(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / targetWidth));
      const from = pixelOffset(sourceX, sourceY, sourceWidth);
      const to = pixelOffset(x, y, targetWidth);
      source.copy(output, to, from, from + 4);
    }
  }
  return output;
}

function extractRawRegion(source, sourceWidth, left, top, width, height) {
  const output = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = pixelOffset(left, top + y, sourceWidth);
    source.copy(output, y * width * 4, sourceStart, sourceStart + width * 4);
  }
  return output;
}

function clearRemoteLowAlphaPixels(data, width, height) {
  const source = Buffer.from(data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = pixelOffset(x, y, width);
      const alpha = source[offset + 3];
      if (alpha === 0 || alpha > 16) continue;
      let nearVisibleBody = false;
      for (let dy = -2; dy <= 2 && !nearVisibleBody; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nearbyX = x + dx;
          const nearbyY = y + dy;
          if (nearbyX < 0 || nearbyY < 0 || nearbyX >= width || nearbyY >= height) continue;
          if (source[pixelOffset(nearbyX, nearbyY, width) + 3] > 32) {
            nearVisibleBody = true;
            break;
          }
        }
      }
      if (!nearVisibleBody) clearPixel(data, offset);
    }
  }
}

function normalizeRawFrameExtent(frame, { metric, targetExtent }) {
  const before = inspectRawPoseFrame(frame);
  const beforeExtent = metric === "height" ? before.height : Math.max(before.width, before.height);
  if (beforeExtent === targetExtent) {
    return { frame: { ...frame, data: Buffer.from(frame.data) }, before, after: before, changed: false };
  }

  const scale = targetExtent / beforeExtent;
  const padding = 2;
  const cropLeft = Math.max(0, before.left - padding);
  const cropTop = Math.max(0, before.top - padding);
  const cropRight = Math.min(frame.width - 1, before.right + padding);
  const cropBottom = Math.min(frame.height - 1, before.baseline + padding);
  const cropWidth = cropRight - cropLeft + 1;
  const cropHeight = cropBottom - cropTop + 1;
  const crop = extractRawRegion(frame.data, frame.width, cropLeft, cropTop, cropWidth, cropHeight);
  const targetWidth = Math.max(1, Math.round(cropWidth * scale));
  const resizedHeight = Math.max(1, Math.round(cropHeight * scale));
  const scaled = {
    data: resizeNearest(crop, cropWidth, cropHeight, targetWidth, resizedHeight),
    width: targetWidth,
    height: resizedHeight,
  };
  const scaledMetrics = inspectRawPoseFrame(scaled);
  const originalCenterX = (before.left + before.right) / 2;
  const scaledCenterX = (scaledMetrics.left + scaledMetrics.right) / 2;
  const targetLeft = Math.round(originalCenterX - scaledCenterX);
  const targetTop = before.baseline - scaledMetrics.baseline;
  if (
    targetLeft < 0 ||
    targetTop < 0 ||
    targetLeft + scaled.width > frame.width ||
    targetTop + scaled.height > frame.height
  ) {
    throw new Error(
      `Cannot normalize ${before.width}x${before.height} frame to ${targetExtent}px by ${metric} without clipping ` +
      `(placement ${targetLeft},${targetTop} ${scaled.width}x${scaled.height} in ${frame.width}x${frame.height}).`,
    );
  }

  const output = Buffer.alloc(frame.width * frame.height * 4);
  for (let y = 0; y < scaled.height; y += 1) {
    const sourceStart = y * scaled.width * 4;
    const destinationStart = pixelOffset(targetLeft, targetTop + y, frame.width);
    scaled.data.copy(output, destinationStart, sourceStart, sourceStart + scaled.width * 4);
  }
  clearRemoteLowAlphaPixels(output, frame.width, frame.height);
  const normalized = { data: output, width: frame.width, height: frame.height };
  const after = inspectRawPoseFrame(normalized);
  return { frame: normalized, before, after, changed: true };
}

function normalizeAtlasFrameExtents(atlas, atlasWidth, {
  columns,
  rows,
  frameCounts,
  metric,
  targetExtent,
}) {
  if (frameCounts.length !== rows) throw new Error(`Expected ${rows} frame-count entries, got ${frameCounts.length}.`);
  const output = Buffer.from(atlas);
  const beforeExtents = [];
  const afterExtents = [];
  let changedFrames = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < frameCounts[row]; column += 1) {
      if (column >= columns) throw new Error(`Frame count ${frameCounts[row]} exceeds ${columns} columns on row ${row}.`);
      const cellLeft = column * CELL_WIDTH;
      const cellTop = row * CELL_HEIGHT;
      const cell = extractRawRegion(atlas, atlasWidth, cellLeft, cellTop, CELL_WIDTH, CELL_HEIGHT);
      const normalized = normalizeRawFrameExtent(
        { data: cell, width: CELL_WIDTH, height: CELL_HEIGHT },
        { metric, targetExtent },
      );
      beforeExtents.push(
        metric === "height" ? normalized.before.height : Math.max(normalized.before.width, normalized.before.height),
      );
      afterExtents.push(
        metric === "height" ? normalized.after.height : Math.max(normalized.after.width, normalized.after.height),
      );
      if (normalized.changed) changedFrames += 1;
      for (let y = 0; y < CELL_HEIGHT; y += 1) {
        const sourceStart = y * CELL_WIDTH * 4;
        const destinationStart = pixelOffset(cellLeft, cellTop + y, atlasWidth);
        normalized.frame.data.copy(output, destinationStart, sourceStart, sourceStart + CELL_WIDTH * 4);
      }
    }
  }
  return {
    data: output,
    changedFrames,
    beforeMin: Math.min(...beforeExtents),
    beforeMax: Math.max(...beforeExtents),
    afterMin: Math.min(...afterExtents),
    afterMax: Math.max(...afterExtents),
    metric,
    targetExtent,
  };
}

function flipHorizontal(source, width, height) {
  const output = Buffer.alloc(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = pixelOffset(x, y, width);
      const to = pixelOffset(width - 1 - x, y, width);
      source.copy(output, to, from, from + 4);
    }
  }
  return output;
}

function shearRows(source, width, height, amount) {
  if (!amount) return Buffer.from(source);
  const output = Buffer.alloc(source.length);
  for (let y = 0; y < height; y += 1) {
    const ratio = 1 - y / Math.max(1, height - 1);
    const shift = Math.round(amount * ratio);
    for (let x = 0; x < width; x += 1) {
      const targetX = x + shift;
      if (targetX < 0 || targetX >= width) continue;
      const from = pixelOffset(x, y, width);
      const to = pixelOffset(targetX, y, width);
      source.copy(output, to, from, from + 4);
    }
  }
  return output;
}

function isEyeInk(r, g, b, a) {
  return a > 0 && r < 70 && g < 70 && b < 80;
}

function movePupils(source, width, height, dx, dy) {
  if (!dx && !dy) return Buffer.from(source);
  const output = Buffer.from(source);
  const eyeRegions = [
    { left: 55, right: 80, top: 24, bottom: 57 },
    { left: 83, right: 109, top: 24, bottom: 57 },
  ];

  for (const region of eyeRegions) {
    const pupilPixels = [];
    for (let y = region.top; y <= region.bottom && y < height; y += 1) {
      for (let x = region.left; x <= region.right && x < width; x += 1) {
        const offset = pixelOffset(x, y, width);
        if (!isEyeInk(output[offset], output[offset + 1], output[offset + 2], output[offset + 3])) continue;
        pupilPixels.push({ x, y, rgba: Buffer.from(output.subarray(offset, offset + 4)) });
        output[offset] = 248;
        output[offset + 1] = 248;
        output[offset + 2] = 248;
        output[offset + 3] = 255;
      }
    }
    for (const pixel of pupilPixels) {
      const x = Math.max(region.left, Math.min(region.right, pixel.x + dx));
      const y = Math.max(region.top, Math.min(region.bottom, pixel.y + dy));
      const offset = pixelOffset(x, y, width);
      output.set(pixel.rgba, offset);
    }
  }
  return output;
}

function blink(source, width, height, half = false) {
  const output = Buffer.from(source);
  const body = [16, 24, 53, 255];
  const regions = [
    { left: 52, right: 80 },
    { left: 82, right: 110 },
  ];
  for (const region of regions) {
    const top = half ? 24 : 22;
    const bottom = half ? 39 : 57;
    for (let y = top; y <= bottom && y < height; y += 1) {
      for (let x = region.left; x <= region.right && x < width; x += 1) {
        const offset = pixelOffset(x, y, width);
        if (output[offset + 3] > 0) output.set(body, offset);
      }
    }
    if (!half) {
      for (let x = region.left + 6; x <= region.right - 6; x += 1) {
        for (let y = 42; y <= 44; y += 1) {
          const offset = pixelOffset(x, y, width);
          output.set([248, 248, 248, 255], offset);
        }
      }
    }
  }
  return output;
}

function raiseRightWing(source, width, height, angleDegrees) {
  if (!angleDegrees) return Buffer.from(source);
  const output = Buffer.from(source);
  const wingPixels = [];
  const pivotX = 128;
  const pivotY = 65;

  for (let y = 48; y < Math.min(120, height); y += 1) {
    for (let x = 126; x < width; x += 1) {
      const offset = pixelOffset(x, y, width);
      const r = output[offset];
      const g = output[offset + 1];
      const b = output[offset + 2];
      const a = output[offset + 3];
      if (a === 0 || r > 80 || g > 90 || b > 125) continue;
      wingPixels.push({ x, y, rgba: Buffer.from(output.subarray(offset, offset + 4)) });
      if (x > 131) clearPixel(output, offset);
    }
  }

  const angle = (angleDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (const pixel of wingPixels) {
    const relativeX = pixel.x - pivotX;
    const relativeY = pixel.y - pivotY;
    const x = pivotX + Math.round(relativeX * cos - relativeY * sin);
    const y = pivotY + Math.round(relativeX * sin + relativeY * cos);
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    output.set(pixel.rgba, pixelOffset(x, y, width));
  }
  return output;
}

function makeFrame(base, spec = {}) {
  const source = spec.source ?? base;
  let data = Buffer.from(source.data);
  let width = source.width;
  let height = source.height;

  if (spec.pupilDx || spec.pupilDy) {
    data = movePupils(data, width, height, spec.pupilDx ?? 0, spec.pupilDy ?? 0);
  }
  if (spec.blink) data = blink(data, width, height, false);
  if (spec.halfBlink) data = blink(data, width, height, true);
  if (spec.wingAngle) data = raiseRightWing(data, width, height, spec.wingAngle);
  if (spec.flip) data = flipHorizontal(data, width, height);

  const scaleX = spec.scaleX ?? 1;
  const scaleY = spec.scaleY ?? 1;
  const targetWidth = Math.max(2, Math.round((width * scaleX) / 2) * 2);
  const targetHeight = Math.max(2, Math.round((height * scaleY) / 2) * 2);
  if (targetWidth !== width || targetHeight !== height) {
    data = resizeNearest(data, width, height, targetWidth, targetHeight);
    width = targetWidth;
    height = targetHeight;
  }
  if (spec.shear) data = shearRows(data, width, height, spec.shear);

  return {
    data,
    width,
    height,
    left: Math.round((CELL_WIDTH - width) / 2) + (spec.dx ?? 0),
    top: BASELINE_Y - height + (spec.dy ?? 0),
  };
}

function compositeFrame(atlas, frame, column, row) {
  const cellLeft = column * CELL_WIDTH;
  const cellTop = row * CELL_HEIGHT;
  for (let y = 0; y < frame.height; y += 1) {
    const atlasY = cellTop + frame.top + y;
    if (atlasY < cellTop || atlasY >= cellTop + CELL_HEIGHT) continue;
    for (let x = 0; x < frame.width; x += 1) {
      const atlasX = cellLeft + frame.left + x;
      if (atlasX < cellLeft || atlasX >= cellLeft + CELL_WIDTH) continue;
      const from = pixelOffset(x, y, frame.width);
      if (frame.data[from + 3] === 0) continue;
      const to = pixelOffset(atlasX, atlasY, ATLAS_WIDTH);
      frame.data.copy(atlas, to, from, from + 4);
    }
  }
}

function isScarfPanelTint(red, green, blue, alpha) {
  // Covers the pale, red-tinted anti-aliasing around the panel as well as its
  // opaque red core.  The range is restricted to the chest in the caller, so
  // it cannot affect the orange beak or feet.
  return alpha > 0 && red > green + 8 && red > blue + 8;
}

function isWarmOrNeutralScarfEdge(red, green, blue, alpha) {
  // The source panel has a one-to-two-pixel pale pink anti-aliased fringe.
  // Restrict the expanded cleanup to warm/neutral pixels so the navy body
  // outline beside the hidden panel cannot be erased.
  return alpha > 0 && red >= green && red >= blue;
}

/**
 * The front panel is attached to the penguin's anatomical right chest (the
 * viewer's left in the front-facing pose). It is visible while the penguin
 * runs left, but the penguin's body hides it while running right. Both
 * directions retain just one loose tail behind the body.
 */
function nearestBellyWhitePixel(source, cellLeft, cellTop, width, x, y) {
  // The hidden panel sits directly over the white belly. A neutral-white
  // sample on its row is a guard: collar pixels never receive this treatment.
  for (let distance = 1; distance <= 72; distance += 1) {
    for (const sampleX of [x + distance, x - distance]) {
      if (sampleX < 0 || sampleX >= CELL_WIDTH) continue;
      const sampleOffset = pixelOffset(cellLeft + sampleX, cellTop + y, width);
      const red = source[sampleOffset];
      const green = source[sampleOffset + 1];
      const blue = source[sampleOffset + 2];
      if (source[sampleOffset + 3] > 0
        && red >= 220
        && green >= 220
        && blue >= 220
        && Math.max(red, green, blue) - Math.min(red, green, blue) <= 8) return sampleOffset;
    }
  }
  return null;
}

function occludeRunningRightScarfPanel(atlas, width) {
  const source = Buffer.from(atlas);
  const output = Buffer.from(atlas);
  let occludedPixels = 0;
  const row = 1;

  for (let column = 0; column < ATLAS_COLUMNS; column += 1) {
    const cellLeft = column * CELL_WIDTH;
    const cellTop = row * CELL_HEIGHT;
    const panelMask = new Uint8Array(CELL_WIDTH * CELL_HEIGHT);
    // A white-belly donor is required, which naturally preserves the collar
    // above the chest panel.  The loose rear tail is safely left of x=65.
    for (let y = 112; y <= 166; y += 1) {
      for (let x = 65; x <= 155; x += 1) {
        const destination = pixelOffset(cellLeft + x, cellTop + y, width);
        if (!isScarfPanelTint(
          source[destination],
          source[destination + 1],
          source[destination + 2],
          source[destination + 3],
        )) continue;
        const donor = nearestBellyWhitePixel(source, cellLeft, cellTop, width, x, y);
        if (donor === null) continue;
        panelMask[y * CELL_WIDTH + x] = 1;
      }
    }

    // Expand from the opaque panel core to include its pale pink fringe. This
    // prevents the hidden right-running panel from surviving as a faint line
    // on the white belly while keeping the horizontal collar and rear tail.
    for (let y = 110; y <= 168; y += 1) {
      for (let x = 63; x <= 157; x += 1) {
        let nearPanel = false;
        for (let dy = -2; dy <= 2 && !nearPanel; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const nearbyX = x + dx;
            const nearbyY = y + dy;
            if (nearbyX < 0 || nearbyY < 0 || nearbyX >= CELL_WIDTH || nearbyY >= CELL_HEIGHT) continue;
            if (panelMask[nearbyY * CELL_WIDTH + nearbyX] === 1) {
              nearPanel = true;
              break;
            }
          }
        }
        if (!nearPanel) continue;

        const destination = pixelOffset(cellLeft + x, cellTop + y, width);
        if (!isWarmOrNeutralScarfEdge(
          source[destination],
          source[destination + 1],
          source[destination + 2],
          source[destination + 3],
        )) continue;
        const donor = nearestBellyWhitePixel(source, cellLeft, cellTop, width, x, y);
        if (donor === null) continue;
        const changed = output[destination] !== 255
          || output[destination + 1] !== 255
          || output[destination + 2] !== 255
          || output[destination + 3] !== source[donor + 3];
        output[destination] = 255;
        output[destination + 1] = 255;
        output[destination + 2] = 255;
        output[destination + 3] = source[donor + 3];
        if (changed) occludedPixels += 1;
      }
    }
  }

  return { data: output, occludedPixels };
}

function auditRightChestScarf(atlas, width) {
  const panelCounts = new Map();
  for (const row of [1, 2]) {
    const counts = [];
    for (let column = 0; column < ATLAS_COLUMNS; column += 1) {
      const cellLeft = column * CELL_WIDTH;
      const cellTop = row * CELL_HEIGHT;
      let collarBottom = 0;
      for (let y = 70; y < 150; y += 1) {
        let redPixels = 0;
        for (let x = 60; x <= 160; x += 1) {
          const offset = pixelOffset(cellLeft + x, cellTop + y, width);
          if (isScarfPanelTint(
            atlas[offset],
            atlas[offset + 1],
            atlas[offset + 2],
            atlas[offset + 3],
          ) && atlas[offset + 1] < 100) redPixels += 1;
        }
        if (redPixels >= 40) collarBottom = y;
      }

      let panelPixels = 0;
      for (let y = collarBottom + 2; y <= 160; y += 1) {
        for (let x = 65; x <= 130; x += 1) {
          const offset = pixelOffset(cellLeft + x, cellTop + y, width);
          if (isScarfPanelTint(
            atlas[offset],
            atlas[offset + 1],
            atlas[offset + 2],
            atlas[offset + 3],
          ) && atlas[offset + 1] < 100) panelPixels += 1;
        }
      }
      counts.push(panelPixels);
    }
    panelCounts.set(row, counts);
  }

  const hiddenRightRunning = panelCounts.get(1);
  const visibleLeftRunning = panelCounts.get(2);
  const maxHiddenPanelPixels = Math.max(...hiddenRightRunning);
  const minVisiblePanelPixels = Math.min(...visibleLeftRunning);
  if (maxHiddenPanelPixels > 8) {
    throw new Error(
      `Right-running frames retain ${maxHiddenPanelPixels} right-chest panel pixels; expected at most 8.`,
    );
  }
  if (minVisiblePanelPixels < 400) {
    throw new Error(
      `Left-running frames retain only ${minVisiblePanelPixels} right-chest panel pixels; expected at least 400.`,
    );
  }
  return { hiddenRightRunning, visibleLeftRunning, maxHiddenPanelPixels, minVisiblePanelPixels };
}

function stabilizeHoverJumpFrames(atlas, width) {
  // Codex's desktop renderer switches to row 4 on pointer enter. Reuse the
  // canonical idle pose at five vertical offsets so hover remains a jump, but
  // the character (and especially its head) never changes scale.
  const sourceFrame = extractRawRegion(atlas, width, 0, 0, CELL_WIDTH, CELL_HEIGHT);
  const sourceMetrics = inspectRawPoseFrame({ data: sourceFrame, width: CELL_WIDTH, height: CELL_HEIGHT });
  const offsetsY = [0, -7, -14, -7, 0];
  const output = Buffer.from(atlas);
  const centersY = [];
  const heights = [];

  for (let column = 0; column < offsetsY.length; column += 1) {
    const cellLeft = column * CELL_WIDTH;
    const cellTop = 4 * CELL_HEIGHT;
    for (let y = 0; y < CELL_HEIGHT; y += 1) {
      output.fill(0, pixelOffset(cellLeft, cellTop + y, width), pixelOffset(cellLeft + CELL_WIDTH, cellTop + y, width));
    }

    const offsetY = offsetsY[column];
    for (let y = 0; y < CELL_HEIGHT; y += 1) {
      const targetY = y + offsetY;
      if (targetY < 0 || targetY >= CELL_HEIGHT) continue;
      const sourceStart = y * CELL_WIDTH * 4;
      const destinationStart = pixelOffset(cellLeft, cellTop + targetY, width);
      sourceFrame.copy(output, destinationStart, sourceStart, sourceStart + CELL_WIDTH * 4);
    }

    const renderedFrame = extractRawRegion(output, width, cellLeft, cellTop, CELL_WIDTH, CELL_HEIGHT);
    const metrics = inspectRawPoseFrame({ data: renderedFrame, width: CELL_WIDTH, height: CELL_HEIGHT });
    if (metrics.width !== sourceMetrics.width || metrics.height !== sourceMetrics.height) {
      throw new Error(
        `Hover jump frame ${column} changed the canonical ${sourceMetrics.width}x${sourceMetrics.height}px scale ` +
        `to ${metrics.width}x${metrics.height}px.`,
      );
    }
    centersY.push(metrics.centerY);
    heights.push(metrics.height);
  }

  const risesThenFalls = centersY[0] > centersY[1]
    && centersY[1] > centersY[2]
    && centersY[2] < centersY[3]
    && centersY[3] < centersY[4];
  if (!risesThenFalls || centersY[0] !== centersY[4] || centersY[1] !== centersY[3]) {
    throw new Error(`Hover jump must preserve a symmetric vertical arc, got y=[${centersY.join(", ")}].`);
  }
  return {
    data: output,
    offsetsY,
    centersY,
    minHeight: Math.min(...heights),
    maxHeight: Math.max(...heights),
  };
}

export async function repairCoherentAtlas(inputPath) {
  const decoded = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const scarf = occludeRunningRightScarfPanel(decoded.data, decoded.info.width);
  const scarfAudit = auditRightChestScarf(scarf.data, decoded.info.width);
  const blueHalo = removeBlueHaloRgba(scarf.data, decoded.info);
  const hoverJump = stabilizeHoverJumpFrames(blueHalo.data, decoded.info.width);
  const stabilized = normalizeAtlasFrameExtents(hoverJump.data, decoded.info.width, {
    columns: ATLAS_COLUMNS,
    rows: ATLAS_ROWS,
    frameCounts: MAIN_ATLAS_UPRIGHT_FRAME_COUNTS,
    metric: "height",
    targetExtent: CHARACTER_UPRIGHT_HEIGHT,
  });
  return {
    data: stabilized.data,
    info: decoded.info,
    scarfPanelPixelsOccluded: scarf.occludedPixels,
    scarfMaxHiddenPanelPixels: scarfAudit.maxHiddenPanelPixels,
    scarfMinVisiblePanelPixels: scarfAudit.minVisiblePanelPixels,
    hoverJumpOffsetsY: hoverJump.offsetsY,
    hoverJumpCentersY: hoverJump.centersY,
    hoverJumpMinHeight: hoverJump.minHeight,
    hoverJumpMaxHeight: hoverJump.maxHeight,
    blueHaloPixelsRecolored: blueHalo.changedPixels,
    blueHaloPixelsOutsideSafeEdge: blueHalo.unresolvedPixels,
    scaleChangedFrames: stabilized.changedFrames,
    scaleBeforeMin: stabilized.beforeMin,
    scaleBeforeMax: stabilized.beforeMax,
    scaleAfterMin: stabilized.afterMin,
    scaleAfterMax: stabilized.afterMax,
  };
}

function createFrameRows(poseFrames = null) {
  const fallbackRunningRight = [
    { shear: 2, dy: 0 },
    { shear: 4, dx: 2, dy: 2, scaleY: 0.97 },
    { shear: 5, dx: 4, dy: -2, scaleY: 1.02 },
    { shear: 3, dx: 2, dy: 0 },
    { shear: 2, dy: 0 },
    { shear: 4, dx: 2, dy: 2, scaleY: 0.97 },
    { shear: 5, dx: 4, dy: -2, scaleY: 1.02 },
    { shear: 3, dx: 2, dy: 0 },
  ];
  const fallbackRunningLeft = fallbackRunningRight.map((frame) => ({
    ...frame,
    flip: true,
    dx: -(frame.dx ?? 0),
    shear: -(frame.shear ?? 0),
  }));
  const idle = poseFrames
    ? [{}, { halfBlink: true }, { source: poseFrames[9] }, { source: poseFrames[10] }, {}, { blink: true }]
    : [
        {},
        { scaleY: 0.99 },
        { scaleX: 1.01, scaleY: 0.975 },
        { scaleY: 0.99 },
        {},
        { blink: true },
      ];
  const runningRight = poseFrames
    ? [4, 5, 6, 7, 4, 5, 6, 7].map((index) => ({ source: poseFrames[index] }))
    : fallbackRunningRight;
  const runningLeft = poseFrames
    ? [0, 1, 2, 3, 0, 1, 2, 3].map((index) => ({ source: poseFrames[index] }))
    : fallbackRunningLeft;
  const waving = [
    {},
    { wingAngle: -40, dy: -2 },
    { wingAngle: -88, dy: -5 },
    { wingAngle: -40, dy: -2 },
  ];
  const jumping = poseFrames
    ? [
        { source: poseFrames[11] },
        { dy: -10, scaleX: 1.01, scaleY: 1.01 },
        { dy: -28, scaleX: 0.98, scaleY: 1.03 },
        { dy: -10, scaleX: 1.01, scaleY: 1.01 },
        { source: poseFrames[15] },
      ]
    : [
        { dy: 4, scaleX: 1.06, scaleY: 0.94 },
        { dy: -10, scaleX: 1.01, scaleY: 1.01 },
        { dy: -24, scaleX: 0.98, scaleY: 1.03 },
        { dy: -10, scaleX: 1.01, scaleY: 1.01 },
        { dy: 4, scaleX: 1.06, scaleY: 0.94 },
      ];
  const failed = poseFrames
    ? [12, 13, 14, 13, 12, 13, 14, 15].map((index) => ({ source: poseFrames[index] }))
    : [0, -2, 2, -2, 0, 2, -2, 0].map((dx, index) => ({
        dx,
        dy: [2, 3, 4, 5, 6, 5, 4, 3][index],
        scaleY: 0.97,
        halfBlink: true,
      }));
  const waiting = poseFrames
    ? [8, 9, 8, 10, 11, 10].map((index) => ({ source: poseFrames[index] }))
    : [
        { pupilDx: -2 },
        {},
        { pupilDx: 2 },
        {},
        { dy: -2, scaleY: 1.01 },
        { blink: true },
      ];
  const working = poseFrames
    ? [4, 5, 6, 7, 6, 5].map((index) => ({ source: poseFrames[index] }))
    : [
        { pupilDy: 2 },
        { pupilDy: 2, dy: -2 },
        { pupilDy: 2 },
        { pupilDy: 2, dy: -2 },
        { pupilDy: 2 },
        { pupilDy: 2 },
      ];
  const review = poseFrames
    ? [9, 8, 10, 9, 10, 8].map((index) => ({ source: poseFrames[index] }))
    : [-2, 0, 2, 2, 0, -2].map((pupilDx, index) => ({
        pupilDx,
        pupilDy: index === 2 || index === 3 ? 1 : 0,
        dy: index === 2 || index === 3 ? 2 : 0,
      }));
  const lookAngles = Array.from({ length: 16 }, (_, index) => index * 22.5);
  const looks = lookAngles.map((degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return {
      pupilDx: Math.round(Math.sin(radians) * 4),
      pupilDy: Math.round(-Math.cos(radians) * 3),
    };
  });

  return [
    idle,
    runningRight,
    runningLeft,
    waving,
    jumping,
    failed,
    waiting,
    working,
    review,
    looks.slice(0, 8),
    looks.slice(8, 16),
  ];
}

export async function buildLocalAssets({ copyToPublic = true } = {}) {
  const approvedCoherentAtlas =
    process.env.CODEX_PET_FORCE_PLACEHOLDER === "1" || process.env.CODEX_PET_FORCE_FALLBACK === "1"
      ? null
      : await resolveValidatedCoherentAtlas();
  const resolution = approvedCoherentAtlas
    ? {
        sourcePath: classicSourcePath,
        outputRoot: path.join(classicRoot, "codex-pet"),
        manifest: classicManifest,
        usedPlaceholder: false,
      }
    : await resolveSource();
  const { sourcePath, outputRoot, manifest, usedPlaceholder } = resolution;
  if (usedPlaceholder) {
    console.log("No local classic-penguin source found; building the rights-safe placeholder pet.");
  }

  const localPaths = {
    normalized: path.join(outputRoot, "pixel-base-normalized.png"),
    spritesheet: path.join(outputRoot, manifest.spritesheetPath),
    pngSpritesheet: path.join(outputRoot, "spritesheet.png"),
    manifest: path.join(outputRoot, "pet.json"),
    desktopPoses: path.join(outputRoot, "desktop-poses.png"),
  };
  const publicPaths = {
    spritesheet: path.join(publicRoot, "spritesheet.webp"),
    pngSpritesheet: path.join(publicRoot, "spritesheet.png"),
    manifest: path.join(publicRoot, "pet.json"),
    desktopPoses: path.join(publicRoot, "desktop-poses.png"),
  };

  // This is deliberately read-only. Every tree that may be mutated is checked
  // before the first directory creation, temporary write, replacement, or delete.
  const plannedTrees = await Promise.all([
    preflightSafeOutputTree({
      anchorPath: projectRoot,
      rootPath: outputRoot,
      outputPaths: Object.values(localPaths),
      label: "Local generated pet assets",
    }),
    ...(copyToPublic
      ? [
          preflightSafeOutputTree({
            anchorPath: projectRoot,
            rootPath: publicRoot,
            outputPaths: Object.values(publicPaths),
            label: "Public generated pet assets",
          }),
        ]
      : []),
  ]);

  let base = null;
  let normalizedBuffer = null;
  try {
    await fs.access(sourcePath);
    base = await normalizeBase(sourcePath);
    normalizedBuffer = await sharp(base.data, {
      raw: { width: base.width, height: base.height, channels: 4 },
    })
      .png({ palette: true, colours: 24, dither: 0 })
      .toBuffer();
  } catch (error) {
    if (!approvedCoherentAtlas || error?.code !== "ENOENT") throw error;
  }

  const poseFrames = usedPlaceholder ? null : await loadPoseFrames(classicPoseSheetPath);
  let poseReferenceAtlas = approvedCoherentAtlas;
  if (poseFrames && process.env.CODEX_PET_POSE_REFERENCE_ATLAS) {
    poseReferenceAtlas = path.resolve(projectRoot, process.env.CODEX_PET_POSE_REFERENCE_ATLAS);
    await realFileWithin(classicRoot, poseReferenceAtlas, "Desktop pose reference atlas");
  }
  const desktopPosesBuffer = poseFrames
    ? await buildDesktopPoseAtlas(poseFrames, poseReferenceAtlas)
    : null;
  let spritesheetBuffer;
  let pngSpritesheetBuffer;
  if (approvedCoherentAtlas) {
    const repaired = await repairCoherentAtlas(approvedCoherentAtlas);
    const repairedAtlas = sharp(repaired.data, { raw: repaired.info });
    [spritesheetBuffer, pngSpritesheetBuffer] = await Promise.all([
      repairedAtlas.clone().webp({ lossless: true, quality: 100, alphaQuality: 100, effort: 6, exact: true }).toBuffer(),
      repairedAtlas.clone().png({ palette: false, compressionLevel: 9 }).toBuffer(),
    ]);
    console.log(
      `Repaired local atlas: normalized ${repaired.scaleChangedFrames} upright frame heights from ${repaired.scaleBeforeMin}-${repaired.scaleBeforeMax}px to ${repaired.scaleAfterMin}-${repaired.scaleAfterMax}px; stabilized hover-jump frames at ${repaired.hoverJumpMinHeight}-${repaired.hoverJumpMaxHeight}px on y=[${repaired.hoverJumpCentersY.map((value) => value.toFixed(1)).join(",")}]; occluded ${repaired.scarfPanelPixelsOccluded} right-running right-chest scarf-panel pixels (hidden max ${repaired.scarfMaxHiddenPanelPixels}, visible opposite-direction min ${repaired.scarfMinVisiblePanelPixels}) and recolored ${repaired.blueHaloPixelsRecolored} blue-halo pixels; ${repaired.blueHaloPixelsOutsideSafeEdge} interior navy pixels were preserved.`,
    );
  } else {
    if (!base) throw new Error(`A source image is required for fallback atlas generation: ${sourcePath}`);
    if (poseFrames) {
      console.log(`Using 16 local side/back/playful pose frames: ${classicPoseSheetPath}`);
    }
    const atlas = Buffer.alloc(ATLAS_WIDTH * ATLAS_HEIGHT * 4);
    const rows = createFrameRows(poseFrames);
    rows.forEach((rowFrames, row) => {
      rowFrames.forEach((spec, column) => compositeFrame(atlas, makeFrame(base, spec), column, row));
    });

    // Current official V2 validator requires a neutral QA frame in row 0, column 6.
    compositeFrame(atlas, makeFrame(base), 6, 0);
    const atlasImage = sharp(atlas, {
      raw: { width: ATLAS_WIDTH, height: ATLAS_HEIGHT, channels: 4 },
    });
    [spritesheetBuffer, pngSpritesheetBuffer] = await Promise.all([
      atlasImage.clone().webp({ lossless: true, quality: 100, alphaQuality: 100 }).toBuffer(),
      atlasImage.clone().png({ palette: false, compressionLevel: 9 }).toBuffer(),
    ]);
  }

  const materializedTrees = [];
  for (const tree of plannedTrees) materializedTrees.push(await materializeSafeOutputTree(tree));
  const localTree = materializedTrees[0];
  const publicTree = copyToPublic ? materializedTrees[1] : null;
  const manifestContents = `${JSON.stringify(manifest, null, 2)}\n`;
  const replacements = [
    { output: safeOutputFrom(localTree, localPaths.spritesheet), contents: spritesheetBuffer },
    { output: safeOutputFrom(localTree, localPaths.pngSpritesheet), contents: pngSpritesheetBuffer },
    { output: safeOutputFrom(localTree, localPaths.manifest), contents: manifestContents },
  ];
  if (normalizedBuffer) {
    replacements.push({ output: safeOutputFrom(localTree, localPaths.normalized), contents: normalizedBuffer });
  }
  if (desktopPosesBuffer) {
    replacements.push({ output: safeOutputFrom(localTree, localPaths.desktopPoses), contents: desktopPosesBuffer });
  }
  if (publicTree) {
    replacements.push(
      { output: safeOutputFrom(publicTree, publicPaths.spritesheet), contents: spritesheetBuffer },
      { output: safeOutputFrom(publicTree, publicPaths.pngSpritesheet), contents: pngSpritesheetBuffer },
      { output: safeOutputFrom(publicTree, publicPaths.manifest), contents: manifestContents },
    );
    if (desktopPosesBuffer) {
      replacements.push({
        output: safeOutputFrom(publicTree, publicPaths.desktopPoses),
        contents: desktopPosesBuffer,
      });
    }
  }
  await atomicReplaceSafeOutputs(replacements);

  const staleOutputs = [];
  if (!normalizedBuffer) staleOutputs.push(safeOutputFrom(localTree, localPaths.normalized));
  if (!desktopPosesBuffer) {
    staleOutputs.push(safeOutputFrom(localTree, localPaths.desktopPoses));
    if (publicTree) staleOutputs.push(safeOutputFrom(publicTree, publicPaths.desktopPoses));
  }
  await removeSafeOutputs(staleOutputs);

  const normalizedPath = normalizedBuffer ? localPaths.normalized : null;
  const desktopPosesPath = desktopPosesBuffer ? localPaths.desktopPoses : null;
  if (approvedCoherentAtlas) {
    console.log(`Using validated coherent hatch-pet V2 atlas: ${approvedCoherentAtlas}`);
  } else {
    console.log(`Built Codex Pet V2 atlas: ${localPaths.spritesheet}`);
  }
  return {
    built: true,
    sourcePath,
    ...(approvedCoherentAtlas ? { atlasSourcePath: approvedCoherentAtlas } : {}),
    outputRoot,
    spritesheetPath: localPaths.spritesheet,
    pngSpritesheetPath: localPaths.pngSpritesheet,
    normalizedPath,
    petId: manifest.id,
    usedPlaceholder,
    usedCoherentAtlas: Boolean(approvedCoherentAtlas),
    desktopPosesPath,
    hasDesktopPoses: Boolean(desktopPosesPath),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await buildLocalAssets();
}
