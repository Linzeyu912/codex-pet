import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  auditDesktopActionPlaybacks,
  desktopPoseActionPlaybacks,
  inspectDesktopPoseAtlas,
} from "./lib/pose-atlas-quality.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const cliArgs = process.argv.slice(2);
let reportPath = null;
let explicitPoseAtlasPath = null;
const positionalInputs = [];
for (let index = 0; index < cliArgs.length; index += 1) {
  const argument = cliArgs[index];
  if (argument === "--report" || argument === "--pose-atlas") {
    const value = cliArgs[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path.`);
    if (argument === "--report") reportPath = path.resolve(value);
    else explicitPoseAtlasPath = path.resolve(value);
    index += 1;
  } else if (argument.startsWith("--")) {
    throw new Error(`Unknown option: ${argument}`);
  } else {
    positionalInputs.push(argument);
  }
}
if (positionalInputs.length > 1) throw new Error("Only one spritesheet path may be provided.");
const inputPath = path.resolve(
  positionalInputs[0] ?? path.join(projectRoot, "public", "local", "spritesheet.png"),
);
const automaticPoseAtlasPath = path.join(path.dirname(inputPath), "desktop-poses.png");
let poseAtlasPath = explicitPoseAtlasPath ?? automaticPoseAtlasPath;
try {
  await fs.access(poseAtlasPath);
} catch (error) {
  if (explicitPoseAtlasPath || error?.code !== "ENOENT") throw error;
  poseAtlasPath = null;
}
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
const COMPONENT_ALPHA_THRESHOLD = 8;
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
const UPRIGHT_ROW_INDICES = new Set([0, 1, 2, 3, 4, 6, 7, 8, 9, 10]);
const UPRIGHT_HEIGHT_RATIO_LIMIT = 1.015;
const POSE_LONG_SIDE_RATIO_LIMIT = 1.015;

const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
if (info.width !== ATLAS_WIDTH || info.height !== ATLAS_HEIGHT) {
  throw new Error(`Expected ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, got ${info.width}x${info.height}: ${inputPath}`);
}

function analyzeComponents(alpha) {
  const labels = new Int32Array(alpha.length);
  const queue = new Int32Array(alpha.length);
  const components = [];
  let componentId = 0;

  for (let start = 0; start < alpha.length; start += 1) {
    if (alpha[start] <= COMPONENT_ALPHA_THRESHOLD || labels[start] !== 0) continue;
    componentId += 1;
    let head = 0;
    let tail = 0;
    let minX = CELL_WIDTH;
    let minY = CELL_HEIGHT;
    let maxX = -1;
    let maxY = -1;
    let maxAlpha = 0;
    const pixels = [];
    queue[tail++] = start;
    labels[start] = componentId;
    while (head < tail) {
      const current = queue[head++];
      const x = current % CELL_WIDTH;
      const y = Math.floor(current / CELL_WIDTH);
      pixels.push(current);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxAlpha = Math.max(maxAlpha, alpha[current]);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextY < 0 || nextX >= CELL_WIDTH || nextY >= CELL_HEIGHT) continue;
          const next = nextY * CELL_WIDTH + nextX;
          if (alpha[next] <= COMPONENT_ALPHA_THRESHOLD || labels[next] !== 0) continue;
          labels[next] = componentId;
          queue[tail++] = next;
        }
      }
    }
    components.push({ area: pixels.length, minX, minY, maxX, maxY, maxAlpha, pixels });
  }

  components.sort((first, second) => second.area - first.area);
  const main = components[0];
  if (!main) return { main: null, detached: [] };
  const mainMask = new Uint8Array(alpha.length);
  main.pixels.forEach((pixel) => {
    mainMask[pixel] = 1;
  });
  const detached = components.slice(1).map((component) => {
    let distance = Math.max(CELL_WIDTH, CELL_HEIGHT);
    for (const pixel of component.pixels) {
      const x = pixel % CELL_WIDTH;
      const y = Math.floor(pixel / CELL_WIDTH);
      const maxRadius = Math.min(distance - 1, Math.max(CELL_WIDTH, CELL_HEIGHT));
      for (let radius = 1; radius <= maxRadius; radius += 1) {
        let found = false;
        for (let dy = -radius; dy <= radius && !found; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const nextX = x + dx;
            const nextY = y + dy;
            if (nextX < 0 || nextY < 0 || nextX >= CELL_WIDTH || nextY >= CELL_HEIGHT) continue;
            if (mainMask[nextY * CELL_WIDTH + nextX]) {
              distance = radius;
              found = true;
              break;
            }
          }
        }
        if (found) break;
      }
    }
    const nearGround = component.minY >= main.maxY - 28;
    const plausibleFoot = component.area >= 16 && nearGround && distance <= 5;
    return {
      area: component.area,
      bbox: [component.minX, component.minY, component.maxX, component.maxY],
      maxAlpha: component.maxAlpha,
      distanceFromMain: distance,
      plausibleFoot,
    };
  });
  return {
    main: { area: main.area, bbox: [main.minX, main.minY, main.maxX, main.maxY], maxAlpha: main.maxAlpha },
    detached,
  };
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

  const componentAnalysis = analyzeComponents(alpha);
  if (area === 0) {
    return { alpha, premultipliedRgb, area: 0, centerX: 0, centerY: 0, baseline: -1, componentAnalysis };
  }
  return {
    alpha,
    premultipliedRgb,
    area,
    centerX: sumX / area,
    centerY: sumY / area,
    baseline: maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    top: minY,
    left: minX,
    right: maxX,
    componentAnalysis,
  };
}

function compare(first, second) {
  let intersection = 0;
  let union = 0;
  let colorDifference = 0;
  let changedPixels = 0;
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
      if (
        Math.abs(first.premultipliedRgb[colorOffset] - second.premultipliedRgb[colorOffset]) +
          Math.abs(first.premultipliedRgb[colorOffset + 1] - second.premultipliedRgb[colorOffset + 1]) +
          Math.abs(first.premultipliedRgb[colorOffset + 2] - second.premultipliedRgb[colorOffset + 2]) >=
        24
      ) {
        changedPixels += 1;
      }
    }
  }
  return {
    iou: union === 0 ? 1 : intersection / union,
    center: Math.hypot(first.centerX - second.centerX, first.centerY - second.centerY),
    baseline: Math.abs(first.baseline - second.baseline),
    areaRatio: Math.max(first.area, second.area) / Math.max(1, Math.min(first.area, second.area)),
    colorChange: union === 0 ? 0 : colorDifference / (union * 3 * 255),
    changedPixels,
  };
}

function translatedPixelMismatches(reference, candidate, offsetY) {
  let mismatches = 0;
  for (let y = 0; y < CELL_HEIGHT; y += 1) {
    const referenceY = y - offsetY;
    for (let x = 0; x < CELL_WIDTH; x += 1) {
      const candidateIndex = y * CELL_WIDTH + x;
      const referenceIndex = referenceY >= 0 && referenceY < CELL_HEIGHT
        ? referenceY * CELL_WIDTH + x
        : -1;
      const expectedAlpha = referenceIndex >= 0 ? reference.alpha[referenceIndex] : 0;
      if (candidate.alpha[candidateIndex] !== expectedAlpha) {
        mismatches += 1;
        continue;
      }
      const candidateColor = candidateIndex * 3;
      const referenceColor = referenceIndex * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        const expected = referenceIndex >= 0 ? reference.premultipliedRgb[referenceColor + channel] : 0;
        if (candidate.premultipliedRgb[candidateColor + channel] !== expected) {
          mismatches += 1;
          break;
        }
      }
    }
  }
  return mismatches;
}

const errors = [];
const warnings = [];
const summaries = [];
const frameRows = [];
const componentFindings = [];
let desktopPoseInspection = null;
let desktopPoseScaleConsistency = null;
if (poseAtlasPath) {
  desktopPoseInspection = await inspectDesktopPoseAtlas(poseAtlasPath);
  errors.push(...desktopPoseInspection.errors);
  const poseFrames = desktopPoseInspection.frames.filter((frame) => frame.area > 0);
  if (poseFrames.length > 0) {
    const extents = poseFrames.map((frame) => Math.max(frame.width, frame.height));
    const minLongSide = Math.min(...extents);
    const maxLongSide = Math.max(...extents);
    const ratio = maxLongSide / Math.max(1, minLongSide);
    desktopPoseScaleConsistency = {
      metric: "visible silhouette long side for rotating poses",
      minLongSide,
      maxLongSide,
      ratio,
      limit: POSE_LONG_SIDE_RATIO_LIMIT,
    };
    if (!placeholderProfile && ratio > POSE_LONG_SIDE_RATIO_LIMIT) {
      errors.push(
        `desktop pose character scale ratio ${ratio.toFixed(3)} exceeds ${POSE_LONG_SIDE_RATIO_LIMIT.toFixed(3)} (${minLongSide}-${maxLongSide}px)`,
      );
    }
  }
}

for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
  const definition = rows[rowIndex];
  const frames = Array.from({ length: definition.frames }, (_, column) => readFrame(rowIndex, column));
  frameRows.push(frames);
  frames.forEach((frame, column) => {
    if (frame.area === 0) errors.push(`${definition.name}: frame ${column} is empty`);
    for (const component of frame.componentAnalysis.detached) {
      const finding = {
        row: rowIndex,
        column,
        state: definition.name,
        ...component,
      };
      const directionSinglePixel = rowIndex >= 9 && component.area <= 4;
      const remoteOrVisible = component.area >= 8 || component.distanceFromMain > 2;
      finding.rejected = !component.plausibleFoot && (directionSinglePixel || remoteOrVisible);
      finding.reason = directionSinglePixel ? "isolated-direction-pixel" : remoteOrVisible ? "detached-fragment" : "near-edge-antialias";
      componentFindings.push(finding);
    }
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
  const minHeight = Math.min(...frames.map((frame) => frame.height));
  const maxHeight = Math.max(...frames.map((frame) => frame.height));
  const heightRatio = maxHeight / Math.max(1, minHeight);
  summaries.push({
    name: definition.name,
    maxCenter,
    minIou,
    maxBaseline,
    maxAreaRatio,
    minColorChange,
    minHeight,
    maxHeight,
    heightRatio,
  });

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
  if (!placeholderProfile && UPRIGHT_ROW_INDICES.has(rowIndex) && heightRatio > UPRIGHT_HEIGHT_RATIO_LIMIT) {
    errors.push(
      `${definition.name}: upright height ratio ${heightRatio.toFixed(3)} exceeds ${UPRIGHT_HEIGHT_RATIO_LIMIT.toFixed(3)} (${minHeight}-${maxHeight}px)`,
    );
  }
}

const uprightFrames = [...UPRIGHT_ROW_INDICES].flatMap((rowIndex) => frameRows[rowIndex]);
const uprightHeightMin = Math.min(...uprightFrames.map((frame) => frame.height));
const uprightHeightMax = Math.max(...uprightFrames.map((frame) => frame.height));
const uprightHeightRatio = uprightHeightMax / Math.max(1, uprightHeightMin);
const scaleConsistency = {
  metric: "visible silhouette height for upright poses",
  minHeight: uprightHeightMin,
  maxHeight: uprightHeightMax,
  ratio: uprightHeightRatio,
  limit: UPRIGHT_HEIGHT_RATIO_LIMIT,
  excludedRows: ["failed"],
};
if (!placeholderProfile && uprightHeightRatio > UPRIGHT_HEIGHT_RATIO_LIMIT) {
  errors.push(
    `upright character scale ratio ${uprightHeightRatio.toFixed(3)} exceeds ${UPRIGHT_HEIGHT_RATIO_LIMIT.toFixed(3)} (${uprightHeightMin}-${uprightHeightMax}px)`,
  );
}

const rejectedComponents = componentFindings.filter((component) => component.rejected);
const rejectedComponentsByFrame = new Map();
for (const component of rejectedComponents) {
  const key = `${component.row}:${component.column}:${component.state}`;
  const values = rejectedComponentsByFrame.get(key) ?? [];
  values.push(component);
  rejectedComponentsByFrame.set(key, values);
}
for (const [key, components] of rejectedComponentsByFrame) {
  const [, column, state] = key.split(":");
  const largest = components.reduce((first, second) => (second.area > first.area ? second : first));
  errors.push(
    `${state}: frame ${column} has ${components.length} rejected detached component(s); largest area=${largest.area}, bbox=[${largest.bbox.join(
      ",",
    )}], alpha=${largest.maxAlpha}, distance=${largest.distanceFromMain}px, reason=${largest.reason}`,
  );
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

function ratio(first, second) {
  return Math.max(first, second) / Math.max(1, Math.min(first, second));
}

const idleReference = frameRows[0][0];
const crossStateDefinitions = [
  ["waving", 3, 0],
  ["failed", 5, 0],
  ["waiting", 6, 0],
  ["active-work", 7, 0],
  ["review", 8, 0],
  ["look-up", 9, 0],
  ["look-down", 10, 0],
];
const crossStateSummaries = crossStateDefinitions.map(([state, row, column]) => {
  const frame = frameRows[row][column];
  const summary = {
    state,
    row,
    column,
    centerXDelta: Math.abs(frame.centerX - idleReference.centerX),
    massCenterYDelta: Math.abs(frame.centerY - idleReference.centerY),
    topDelta: Math.abs(frame.top - idleReference.top),
    baselineDelta: Math.abs(frame.baseline - idleReference.baseline),
    widthRatio: ratio(frame.width, idleReference.width),
    heightRatio: ratio(frame.height, idleReference.height),
    areaRatio: ratio(frame.area, idleReference.area),
  };
  const failedChecks = [];
  if (summary.centerXDelta > 8) failedChecks.push(`center-x ${summary.centerXDelta.toFixed(1)}px > 8px`);
  if (summary.massCenterYDelta > 8) failedChecks.push(`mass-center-y ${summary.massCenterYDelta.toFixed(1)}px > 8px`);
  if (summary.topDelta > 8) failedChecks.push(`top ${summary.topDelta}px > 8px`);
  if (summary.baselineDelta > 8) failedChecks.push(`baseline ${summary.baselineDelta}px > 8px`);
  // Directional perspective may narrow the silhouette even when character
  // height (the scale metric for upright poses) is stable.
  if (summary.widthRatio > 1.11) failedChecks.push(`width ratio ${summary.widthRatio.toFixed(3)} > 1.110`);
  if (summary.heightRatio > 1.07) failedChecks.push(`height ratio ${summary.heightRatio.toFixed(3)} > 1.070`);
  if (summary.areaRatio > 1.08) failedChecks.push(`area ratio ${summary.areaRatio.toFixed(3)} > 1.080`);
  summary.failedChecks = failedChecks;
  if (failedChecks.length > 0) {
    errors.push(`${state}: entry frame does not share idle silhouette landmarks (${failedChecks.join("; ")})`);
  }
  return summary;
});

const directionFrames = [...frameRows[9], ...frameRows[10]];
const directionLabels = Array.from({ length: 16 }, (_, index) => {
  const value = index * 22.5;
  return Number.isInteger(value) ? String(value).padStart(3, "0") : String(value).padStart(5, "0");
});
const directionPairs = directionFrames.map((frame, index) => {
  const nextIndex = (index + 1) % directionFrames.length;
  return {
    from: directionLabels[index],
    to: directionLabels[nextIndex],
    ...compare(frame, directionFrames[nextIndex]),
  };
});
const sortedDirectionChanges = directionPairs.map((pair) => pair.changedPixels).sort((first, second) => first - second);
const directionMedianChange =
  (sortedDirectionChanges[7] + sortedDirectionChanges[8]) / 2;
for (let index = 0; index < directionPairs.length; index += 1) {
  const pair = directionPairs[index];
  const previous = directionPairs[(index + directionPairs.length - 1) % directionPairs.length].changedPixels;
  const next = directionPairs[(index + 1) % directionPairs.length].changedPixels;
  const neighbourAverage = (previous + next) / 2;
  pair.localOutlierRatio = pair.changedPixels / Math.max(1, neighbourAverage);
  if (pair.localOutlierRatio > 2 && pair.changedPixels > directionMedianChange * 1.5) {
    errors.push(
      `look ${pair.from} -> ${pair.to}: local visual-change outlier ${pair.changedPixels}px is ${pair.localOutlierRatio.toFixed(
        2,
      )}x its neighbours`,
    );
  } else if (pair.localOutlierRatio > 1.6) {
    warnings.push(
      `look ${pair.from} -> ${pair.to}: local visual-change outlier ${pair.changedPixels}px is ${pair.localOutlierRatio.toFixed(
        2,
      )}x its neighbours`,
    );
  }
}

function placeholderGazeCentroid(frame) {
  const boxes = [
    [70, 92, 58, 88],
    [102, 124, 58, 88],
  ];
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (const [left, right, top, bottom] of boxes) {
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const index = y * CELL_WIDTH + x;
        if (frame.alpha[index] < 192) continue;
        const offset = index * 3;
        const red = frame.premultipliedRgb[offset];
        const green = frame.premultipliedRgb[offset + 1];
        const blue = frame.premultipliedRgb[offset + 2];
        if (red > 90 || green > 90 || blue > 100) continue;
        count += 1;
        sumX += x;
        sumY += y;
      }
    }
  }
  return count === 0 ? null : { x: sumX / count, y: sumY / count, pixels: count };
}

let placeholderDirectionSemantics = null;
if (placeholderProfile) {
  const gazes = directionFrames.map(placeholderGazeCentroid);
  if (gazes.some((gaze) => !gaze)) {
    errors.push("placeholder directions: could not locate the high-contrast pupil feature in every direction frame");
  } else {
    const rightLeftDelta = gazes[4].x - gazes[12].x;
    const downUpDelta = gazes[8].y - gazes[0].y;
    const center = {
      x: (gazes[4].x + gazes[12].x) / 2,
      y: (gazes[0].y + gazes[8].y) / 2,
    };
    const angularErrors = gazes.map((gaze, index) => {
      const observed = (Math.atan2(gaze.x - center.x, -(gaze.y - center.y)) * 180) / Math.PI;
      const normalizedObserved = (observed + 360) % 360;
      const expected = index * 22.5;
      return Math.abs(((normalizedObserved - expected + 540) % 360) - 180);
    });
    placeholderDirectionSemantics = {
      method: "pupil-feature-centroid",
      gazes,
      rightLeftDelta,
      downUpDelta,
      angularErrors,
      maxAngularError: Math.max(...angularErrors),
    };
    if (rightLeftDelta < 4) {
      errors.push(`placeholder directions: right/left pupil landmark separation ${rightLeftDelta.toFixed(1)}px is below 4px`);
    }
    if (downUpDelta < 3) {
      errors.push(`placeholder directions: down/up pupil landmark separation ${downUpDelta.toFixed(1)}px is below 3px`);
    }
    if (placeholderDirectionSemantics.maxAngularError > 35) {
      errors.push(
        `placeholder directions: pupil landmark order deviates by up to ${placeholderDirectionSemantics.maxAngularError.toFixed(
          1,
        )} degrees`,
      );
    }
  }
}

const idleBoundaryFrame = frameRows[0][0];
const jumpFrames = frameRows[4];
const hoverJumpOffsetsY = [0, -7, -14, -7, 0];
const hoverJumpPixelMismatches = jumpFrames.map((frame, index) =>
  translatedPixelMismatches(idleBoundaryFrame, frame, hoverJumpOffsetsY[index]),
);
if (!placeholderProfile && hoverJumpPixelMismatches.some((count) => count !== 0)) {
  errors.push(
    `jumping: hover frames must be exact translated idle copies, got mismatches=[${hoverJumpPixelMismatches.join(", ")}]`,
  );
}
const hoverJumpAudit = {
  rendererTrigger: "pointer-enter -> jumping row 4",
  reference: { state: "idle", row: 0, column: 0 },
  offsetsY: hoverJumpOffsetsY,
  pixelMismatches: hoverJumpPixelMismatches,
  exactTranslatedIdleCopies: hoverJumpPixelMismatches.every((count) => count === 0),
};
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

const withIdleBoundary = (name, frames) => ({
  name,
  playback: [idleBoundaryFrame, ...frames, idleBoundaryFrame],
});
const desktopActionPlaybacks = [
  withIdleBoundary("waving", frameRows[3]),
  withIdleBoundary("jumping", frameRows[4]),
  withIdleBoundary("failed", frameRows[5]),
  withIdleBoundary("looking", [...frameRows[9], ...frameRows[10]]),
];
const validPoseFrames =
  desktopPoseInspection?.errors.length === 0 && desktopPoseInspection.frames.length === 16;
if (validPoseFrames) {
  desktopActionPlaybacks.push(
    ...desktopPoseActionPlaybacks(idleBoundaryFrame, desktopPoseInspection.frames),
  );
} else {
  desktopActionPlaybacks.push(
    withIdleBoundary("rolling", frameRows[5]),
    withIdleBoundary(
      "lying",
      [0, 1, 2, 3, 4, 4, 4, 3, 2, 1, 0].map((column) => frameRows[5][column]),
    ),
    withIdleBoundary(
      "mischief",
      [0, 1, 2, 3, 2, 1, 0].map((column) => frameRows[5][column]),
    ),
  );
}
const desktopActionAudit = auditDesktopActionPlaybacks(desktopActionPlaybacks, {
  maxCenter: 23,
  minIou: 0.45,
  maxBaseline: placeholderProfile ? 16 : 12,
  maxAreaRatio: 1.3,
});
const desktopActionSummaries = desktopActionAudit.summaries;
errors.push(...desktopActionAudit.errors);

console.table(
  summaries.map((row) => ({
    row: row.name,
    "max center jump": `${row.maxCenter.toFixed(1)}px`,
    "min alpha IoU": `${(row.minIou * 100).toFixed(1)}%`,
    "max baseline jump": `${row.maxBaseline}px`,
    "max area ratio": row.maxAreaRatio.toFixed(3),
    "height range": `${row.minHeight}-${row.maxHeight}px`,
    "height ratio": row.heightRatio.toFixed(3),
    "min color change": row.minColorChange.toFixed(4),
  })),
);
console.log(`Continuity profile: ${placeholderProfile ? "public placeholder (structure + loop safety)" : "coherent pet (strict)"}`);
console.log(
  `Upright character height: ${scaleConsistency.minHeight}-${scaleConsistency.maxHeight}px ` +
  `(ratio ${scaleConsistency.ratio.toFixed(3)}, limit ${scaleConsistency.limit.toFixed(3)})`,
);
if (desktopPoseScaleConsistency) {
  console.log(
    `Rotating-pose character long side: ${desktopPoseScaleConsistency.minLongSide}-${desktopPoseScaleConsistency.maxLongSide}px ` +
    `(ratio ${desktopPoseScaleConsistency.ratio.toFixed(3)}, limit ${desktopPoseScaleConsistency.limit.toFixed(3)})`,
  );
}
console.table(
  crossStateSummaries.map((state) => ({
    state: state.state,
    "center x": `${state.centerXDelta.toFixed(1)}px`,
    top: `${state.topDelta}px`,
    baseline: `${state.baselineDelta}px`,
    width: state.widthRatio.toFixed(3),
    height: state.heightRatio.toFixed(3),
    area: state.areaRatio.toFixed(3),
  })),
);
console.table(
  desktopActionSummaries.map((action) => ({
    action: action.action,
    "max transition": `${action.maxCenter.toFixed(1)}px`,
    "min alpha IoU": `${(action.minIou * 100).toFixed(1)}%`,
    "max baseline jump": `${action.maxBaseline}px`,
    "max area ratio": action.maxAreaRatio.toFixed(3),
  })),
);

const inputBytes = await fs.readFile(inputPath);
const auditReport = {
  schema: "codex-pet-continuity-audit/v2",
  generatedAt: new Date().toISOString(),
  ok: errors.length === 0,
  profile: placeholderProfile ? "public-placeholder" : "coherent-pet-strict",
  atlas: {
    file: inputPath,
    width: info.width,
    height: info.height,
    sha256: createHash("sha256").update(inputBytes).digest("hex").toUpperCase(),
  },
  errors,
  warnings,
  rows: summaries,
  scaleConsistency,
  components: {
    thresholdAlpha: COMPONENT_ALPHA_THRESHOLD,
    detached: componentFindings,
    rejected: rejectedComponents,
  },
  sharedLandmarks: {
    reference: { state: "idle", row: 0, column: 0 },
    description: "Silhouette top, mass centre, ground baseline, width, height and occupied area are geometric proxies for shared character landmarks.",
    states: crossStateSummaries,
  },
  hoverResponse: hoverJumpAudit,
  directions: {
    labels: directionLabels,
    medianChangedPixels: directionMedianChange,
    pairs: directionPairs,
    placeholderSemantics: placeholderDirectionSemantics,
  },
  desktopPoseAtlas: desktopPoseInspection
    ? {
        used: true,
        valid: validPoseFrames,
        file: desktopPoseInspection.file,
        sha256: desktopPoseInspection.sha256,
        width: desktopPoseInspection.width,
        height: desktopPoseInspection.height,
        columns: desktopPoseInspection.columns,
        rows: desktopPoseInspection.rows,
        frameCount: desktopPoseInspection.frameCount,
        nonEmptyFrames: desktopPoseInspection.frames.filter((frame) => frame.area > 0).length,
        scaleConsistency: desktopPoseScaleConsistency,
      }
    : { used: false },
  desktopActions: desktopActionSummaries,
};

if (reportPath) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(auditReport, null, 2)}\n`, "utf8");
  console.log(`Wrote continuity audit: ${reportPath}`);
}

warnings.forEach((warning) => console.warn(`Animation continuity warning: ${warning}`));

if (errors.length > 0) {
  console.error("Animation continuity check failed:");
  errors.forEach((error) => console.error(`- ${error}`));
  process.exitCode = 1;
} else {
  console.log(`Animation continuity check passed: ${inputPath}`);
}
