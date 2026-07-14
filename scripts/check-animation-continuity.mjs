import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const inputPath = path.resolve(process.argv[2] ?? path.join(projectRoot, "public", "local", "spritesheet.png"));
let placeholderProfile = false;
try {
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(inputPath), "pet.json"), "utf8"));
  placeholderProfile = manifest.id === "codex-penguin-placeholder";
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_WIDTH = CELL_WIDTH * 8;
const ATLAS_HEIGHT = CELL_HEIGHT * 11;
const ALPHA_THRESHOLD = 8;
const rows = [
  { name: "idle", frames: 6, cyclic: true, maxCenter: 8, minIou: 0.72, maxBaseline: 6 },
  { name: "running-right", frames: 8, cyclic: true, maxCenter: 15, minIou: 0.42, maxBaseline: 10 },
  { name: "running-left", frames: 8, cyclic: true, maxCenter: 15, minIou: 0.42, maxBaseline: 10 },
  { name: "waving", frames: 4, cyclic: true, maxCenter: 12, minIou: 0.5, maxBaseline: 8 },
  { name: "jumping", frames: 5, cyclic: true, maxCenter: 25, minIou: 0.5, maxBaseline: 25, maxAreaRatio: 1.1 },
  { name: "failed", frames: 8, cyclic: true, maxCenter: 23, minIou: 0.5, maxBaseline: 10, maxAreaRatio: 1.3 },
  { name: "waiting", frames: 6, cyclic: true, maxCenter: 15, minIou: 0.42, maxBaseline: 12 },
  { name: "active-work", frames: 6, cyclic: true, maxCenter: 15, minIou: 0.42, maxBaseline: 12 },
  { name: "review", frames: 6, cyclic: true, maxCenter: 18, minIou: 0.36, maxBaseline: 18 },
  {
    name: "look-000-157.5",
    frames: 8,
    cyclic: false,
    maxCenter: 20,
    minIou: 0.32,
    maxBaseline: 14,
    maxAreaRatio: 1.13,
    minColorChange: placeholderProfile ? undefined : 0.03,
  },
  {
    name: "look-180-337.5",
    frames: 8,
    cyclic: false,
    maxCenter: 20,
    minIou: 0.32,
    maxBaseline: 14,
    maxAreaRatio: 1.13,
    minColorChange: placeholderProfile ? undefined : 0.03,
  },
];

const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
if (info.width !== ATLAS_WIDTH || info.height !== ATLAS_HEIGHT) {
  throw new Error(`Expected ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, got ${info.width}x${info.height}: ${inputPath}`);
}

function readFrame(row, column) {
  const alpha = new Uint8Array(CELL_WIDTH * CELL_HEIGHT);
  const premultipliedRgb = new Uint8Array(CELL_WIDTH * CELL_HEIGHT * 3);
  let minX = CELL_WIDTH;
  let minY = CELL_HEIGHT;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < CELL_HEIGHT; y += 1) {
    for (let x = 0; x < CELL_WIDTH; x += 1) {
      const atlasX = column * CELL_WIDTH + x;
      const atlasY = row * CELL_HEIGHT + y;
      const sourceOffset = (atlasY * ATLAS_WIDTH + atlasX) * 4 + 3;
      const value = data[sourceOffset];
      const index = y * CELL_WIDTH + x;
      alpha[index] = value;
      premultipliedRgb[index * 3] = Math.round((data[sourceOffset - 3] * value) / 255);
      premultipliedRgb[index * 3 + 1] = Math.round((data[sourceOffset - 2] * value) / 255);
      premultipliedRgb[index * 3 + 2] = Math.round((data[sourceOffset - 1] * value) / 255);
      if (value <= ALPHA_THRESHOLD) continue;
      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (area === 0) return { alpha, premultipliedRgb, area: 0, centerX: 0, centerY: 0, baseline: -1 };
  return {
    alpha,
    premultipliedRgb,
    area,
    centerX: sumX / area,
    centerY: sumY / area,
    baseline: maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function compare(first, second) {
  let intersection = 0;
  let union = 0;
  let colorDifference = 0;
  for (let index = 0; index < first.alpha.length; index += 1) {
    const a = first.alpha[index] > ALPHA_THRESHOLD;
    const b = second.alpha[index] > ALPHA_THRESHOLD;
    if (a && b) intersection += 1;
    if (a || b) {
      union += 1;
      const colorOffset = index * 3;
      colorDifference += Math.abs(first.premultipliedRgb[colorOffset] - second.premultipliedRgb[colorOffset]);
      colorDifference += Math.abs(first.premultipliedRgb[colorOffset + 1] - second.premultipliedRgb[colorOffset + 1]);
      colorDifference += Math.abs(first.premultipliedRgb[colorOffset + 2] - second.premultipliedRgb[colorOffset + 2]);
    }
  }
  return {
    iou: union === 0 ? 1 : intersection / union,
    center: Math.hypot(first.centerX - second.centerX, first.centerY - second.centerY),
    baseline: Math.abs(first.baseline - second.baseline),
    areaRatio: Math.max(first.area, second.area) / Math.max(1, Math.min(first.area, second.area)),
    colorChange: union === 0 ? 0 : colorDifference / (union * 3 * 255),
  };
}

const errors = [];
const summaries = [];
const frameRows = [];

for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
  const definition = rows[rowIndex];
  const frames = Array.from({ length: definition.frames }, (_, column) => readFrame(rowIndex, column));
  frameRows.push(frames);
  frames.forEach((frame, column) => {
    if (frame.area === 0) errors.push(`${definition.name}: frame ${column} is empty`);
  });
  for (let column = definition.frames; column < 8; column += 1) {
    const unusedFrame = readFrame(rowIndex, column);
    if (rowIndex === 0 && column === 6) {
      if (unusedFrame.area === 0) errors.push("idle: required neutral QA frame 6 is empty");
    } else if (unusedFrame.area !== 0) {
      errors.push(`${definition.name}: unused frame ${column} is not transparent`);
    }
  }

  const pairs = [];
  for (let index = 0; index < frames.length - 1; index += 1) pairs.push(compare(frames[index], frames[index + 1]));
  if (definition.cyclic) pairs.push(compare(frames.at(-1), frames[0]));
  const maxCenter = Math.max(...pairs.map((pair) => pair.center));
  const minIou = Math.min(...pairs.map((pair) => pair.iou));
  const maxBaseline = Math.max(...pairs.map((pair) => pair.baseline));
  const maxAreaRatio = Math.max(...pairs.map((pair) => pair.areaRatio));
  const minColorChange = Math.min(...pairs.map((pair) => pair.colorChange));
  summaries.push({ name: definition.name, maxCenter, minIou, maxBaseline, maxAreaRatio, minColorChange });

  if (maxCenter > definition.maxCenter) {
    errors.push(`${definition.name}: center jump ${maxCenter.toFixed(1)}px exceeds ${definition.maxCenter}px`);
  }
  if (minIou < definition.minIou) {
    errors.push(`${definition.name}: minimum alpha IoU ${(minIou * 100).toFixed(1)}% is below ${(definition.minIou * 100).toFixed(0)}%`);
  }
  if (maxBaseline > definition.maxBaseline) {
    errors.push(`${definition.name}: baseline jump ${maxBaseline}px exceeds ${definition.maxBaseline}px`);
  }
  if (definition.maxAreaRatio && maxAreaRatio > definition.maxAreaRatio) {
    errors.push(
      `${definition.name}: adjacent area ratio ${maxAreaRatio.toFixed(3)} exceeds ${definition.maxAreaRatio.toFixed(2)}`,
    );
  }
  if (definition.minColorChange && minColorChange < definition.minColorChange) {
    errors.push(
      `${definition.name}: adjacent premultiplied RGB change ${minColorChange.toFixed(4)} is below ${definition.minColorChange.toFixed(4)}`,
    );
  }
}

for (const [label, first, second] of [
  ["look 157.5 -> 180", frameRows[9][7], frameRows[10][0]],
  ["look 337.5 -> 000", frameRows[10][7], frameRows[9][0]],
]) {
  const transition = compare(first, second);
  if (transition.center > 20 || transition.iou < 0.3 || transition.baseline > 14 || transition.areaRatio > 1.13) {
    errors.push(
      `${label}: center ${transition.center.toFixed(1)}px, IoU ${(transition.iou * 100).toFixed(1)}%, baseline ${transition.baseline}px, area ratio ${transition.areaRatio.toFixed(3)}`,
    );
  }
}

const jumpFrames = frameRows[4];
const jumpY = jumpFrames.map((frame) => frame.centerY);
const jumpX = jumpFrames.map((frame) => frame.centerX);
const jumpRisesThenFalls = jumpY[0] > jumpY[1] && jumpY[1] > jumpY[2] && jumpY[2] < jumpY[3] && jumpY[3] < jumpY[4];
if (!jumpRisesThenFalls) {
  errors.push(`jumping: expected a single rise/apex/fall arc, got y=[${jumpY.map((value) => value.toFixed(1)).join(", ")}]`);
}
const outerStepMismatch = Math.abs((jumpY[0] - jumpY[1]) - (jumpY[4] - jumpY[3]));
const innerStepMismatch = Math.abs((jumpY[1] - jumpY[2]) - (jumpY[3] - jumpY[2]));
if (outerStepMismatch > 6 || innerStepMismatch > 6) {
  errors.push(
    `jumping: asymmetric vertical arc (outer mismatch ${outerStepMismatch.toFixed(1)}px, inner mismatch ${innerStepMismatch.toFixed(1)}px)`,
  );
}
const horizontalDrift = Math.max(...jumpX) - Math.min(...jumpX);
if (horizontalDrift > 6) {
  errors.push(`jumping: horizontal drift ${horizontalDrift.toFixed(1)}px exceeds 6px`);
}
const jumpLanding = compare(jumpFrames[4], jumpFrames[0]);
if (jumpLanding.center > 3 || jumpLanding.iou < 0.85 || jumpLanding.baseline > 3) {
  errors.push(
    `jumping: landing loop does not settle to takeoff (center ${jumpLanding.center.toFixed(1)}px, IoU ${(jumpLanding.iou * 100).toFixed(1)}%, baseline ${jumpLanding.baseline}px)`,
  );
}

const idleBoundaryFrame = frameRows[0][0];
const desktopActionPaths = [
  { name: "waving", frames: frameRows[3] },
  { name: "jumping", frames: frameRows[4] },
  { name: "failed", frames: frameRows[5] },
  { name: "looking", frames: [...frameRows[9], ...frameRows[10]] },
  { name: "rolling", frames: frameRows[5] },
  { name: "lying", frames: [0, 1, 2, 3, 4, 4, 4, 3, 2, 1, 0].map((column) => frameRows[5][column]) },
  { name: "mischief", frames: [0, 1, 2, 3, 2, 1, 0].map((column) => frameRows[5][column]) },
];
const desktopActionSummaries = [];
for (const action of desktopActionPaths) {
  const playback = [idleBoundaryFrame, ...action.frames, idleBoundaryFrame];
  const transitions = playback.slice(0, -1).map((frame, index) => compare(frame, playback[index + 1]));
  const summary = {
    action: action.name,
    maxCenter: Math.max(...transitions.map((transition) => transition.center)),
    minIou: Math.min(...transitions.map((transition) => transition.iou)),
    maxBaseline: Math.max(...transitions.map((transition) => transition.baseline)),
    maxAreaRatio: Math.max(...transitions.map((transition) => transition.areaRatio)),
  };
  desktopActionSummaries.push(summary);
  const maxDesktopBaseline = placeholderProfile ? 16 : 12;
  if (
    summary.maxCenter > 23 ||
    summary.minIou < 0.45 ||
    summary.maxBaseline > maxDesktopBaseline ||
    summary.maxAreaRatio > 1.3
  ) {
    errors.push(
      `desktop ${action.name}: transition center ${summary.maxCenter.toFixed(1)}px, IoU ${(summary.minIou * 100).toFixed(1)}%, baseline ${summary.maxBaseline}px, area ratio ${summary.maxAreaRatio.toFixed(3)}`,
    );
  }
}

console.table(
  summaries.map((row) => ({
    row: row.name,
    "max center jump": `${row.maxCenter.toFixed(1)}px`,
    "min alpha IoU": `${(row.minIou * 100).toFixed(1)}%`,
    "max baseline jump": `${row.maxBaseline}px`,
    "max area ratio": row.maxAreaRatio.toFixed(3),
    "min color change": row.minColorChange.toFixed(4),
  })),
);
console.log(`Continuity profile: ${placeholderProfile ? "public placeholder (structure + loop safety)" : "coherent pet (strict)"}`);
console.table(
  desktopActionSummaries.map((action) => ({
    action: action.action,
    "max transition": `${action.maxCenter.toFixed(1)}px`,
    "min alpha IoU": `${(action.minIou * 100).toFixed(1)}%`,
    "max baseline jump": `${action.maxBaseline}px`,
    "max area ratio": action.maxAreaRatio.toFixed(3),
  })),
);

if (errors.length > 0) {
  console.error("Animation continuity check failed:");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Animation continuity check passed: ${inputPath}`);
}
