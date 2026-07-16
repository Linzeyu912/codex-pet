import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const COLUMNS = 8;
const ROWS = 11;
const LOOK_ROW = 9;
const FRAME_COUNT = 16;
const ALPHA_FLOOR = 15;

const args = process.argv.slice(2);
const input = args.find((value) => !value.startsWith("--"));
const outputIndex = args.indexOf("--output-dir");
const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : null;
const atlasOutputIndex = args.indexOf("--atlas-output");
const atlasOutput = atlasOutputIndex >= 0 ? args[atlasOutputIndex + 1] : null;

if (!input || !outputDir) {
  console.error("Usage: node scripts/smooth-look-alpha.mjs <extended-atlas> --output-dir <directory>");
  process.exit(2);
}

const atlasPath = path.resolve(input);
const resolvedOutputDir = path.resolve(outputDir);
const { data, info } = await sharp(atlasPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
if (info.width !== CELL_WIDTH * COLUMNS || info.height !== CELL_HEIGHT * ROWS || info.channels !== 4) {
  throw new Error(`Expected a 1536x2288 RGBA atlas, got ${info.width}x${info.height} with ${info.channels} channels.`);
}

function extractCell(index) {
  const row = LOOK_ROW + Math.floor(index / COLUMNS);
  const column = index % COLUMNS;
  const cell = Buffer.alloc(CELL_WIDTH * CELL_HEIGHT * 4);
  for (let y = 0; y < CELL_HEIGHT; y += 1) {
    const sourceStart = (((row * CELL_HEIGHT + y) * info.width) + column * CELL_WIDTH) * 4;
    const targetStart = y * CELL_WIDTH * 4;
    data.copy(cell, targetStart, sourceStart, sourceStart + CELL_WIDTH * 4);
  }
  return cell;
}

function alphaBounds(cell) {
  let minX = CELL_WIDTH;
  let minY = CELL_HEIGHT;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < CELL_HEIGHT; y += 1) {
    for (let x = 0; x < CELL_WIDTH; x += 1) {
      if (cell[(y * CELL_WIDTH + x) * 4 + 3] <= ALPHA_FLOOR) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) throw new Error("Look cell is empty.");
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function scaleAtBaseline(cell, scaleX, scaleY = scaleX) {
  if (scaleX === 1 && scaleY === 1) return cell;
  const bounds = alphaBounds(cell);
  const resizedWidth = Math.round(bounds.width * scaleX);
  const resizedHeight = Math.round(bounds.height * scaleY);
  const content = await sharp(cell, { raw: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 4 } })
    .extract({ left: bounds.minX, top: bounds.minY, width: bounds.width, height: bounds.height })
    .resize(resizedWidth, resizedHeight, { kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const left = Math.round((CELL_WIDTH - resizedWidth) / 2);
  const top = bounds.maxY - resizedHeight + 1;
  if (left < 2 || top < 2 || left + resizedWidth > CELL_WIDTH - 2 || top + resizedHeight > CELL_HEIGHT - 2) {
    throw new Error(`Scale ${scaleX}x${scaleY} would move a look frame outside the safe cell margin.`);
  }
  const output = Buffer.alloc(CELL_WIDTH * CELL_HEIGHT * 4);
  for (let y = 0; y < resizedHeight; y += 1) {
    const sourceStart = y * resizedWidth * 4;
    const targetStart = ((top + y) * CELL_WIDTH + left) * 4;
    content.data.copy(output, targetStart, sourceStart, sourceStart + resizedWidth * 4);
  }
  return output;
}

const cells = Array.from({ length: FRAME_COUNT }, (_, index) => extractCell(index));
const row9Scales = [1, 1, 1, 1, 1, 1.02, 1.06, 1.1];
for (let index = 0; index < row9Scales.length; index += 1) {
  cells[index] = await scaleAtBaseline(cells[index], row9Scales[index]);
}
cells[8] = await scaleAtBaseline(cells[8], 1, 0.978);

const protectedEntries = new Set([0, 8]);
function cleanCell(cell) {
  const output = Buffer.from(cell);
  for (let offset = 0; offset < output.length; offset += 4) {
    if (output[offset + 3] > ALPHA_FLOOR) continue;
    output.fill(0, offset, offset + 4);
  }
  return output;
}

function medianPass(inputCells) {
  return inputCells.map((current, index) => {
    if (protectedEntries.has(index)) return cleanCell(current);
    const previous = inputCells[(index - 1 + FRAME_COUNT) % FRAME_COUNT];
    const next = inputCells[(index + 1) % FRAME_COUNT];
    const output = Buffer.alloc(current.length);
    for (let offset = 0; offset < current.length; offset += 4) {
      const alphas = [previous[offset + 3], current[offset + 3], next[offset + 3]].sort((a, b) => a - b);
      const alpha = alphas[1];
      if (alpha <= ALPHA_FLOOR) continue;
      let colorSource = current;
      if (current[offset + 3] <= ALPHA_FLOOR) {
        colorSource = previous[offset + 3] >= next[offset + 3] ? previous : next;
      }
      output[offset] = colorSource[offset];
      output[offset + 1] = colorSource[offset + 1];
      output[offset + 2] = colorSource[offset + 2];
      output[offset + 3] = alpha;
    }
    return output;
  });
}

const smoothingPasses = 1;
let smoothed = cells.map(cleanCell);
for (let pass = 0; pass < smoothingPasses; pass += 1) smoothed = medianPass(smoothed);

function alphaDiff(first, second) {
  let count = 0;
  for (let offset = 3; offset < first.length; offset += 4) {
    if (Math.abs(first[offset] - second[offset]) > 16) count += 1;
  }
  return count;
}

function visibleNeighbours(cell, pixelOffset) {
  const pixel = (pixelOffset - 3) / 4;
  const x = pixel % CELL_WIDTH;
  const y = Math.floor(pixel / CELL_WIDTH);
  let count = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if ((dx === 0 && dy === 0) || x + dx < 0 || x + dx >= CELL_WIDTH || y + dy < 0 || y + dy >= CELL_HEIGHT) continue;
      if (cell[((y + dy) * CELL_WIDTH + x + dx) * 4 + 3] > ALPHA_FLOOR) count += 1;
    }
  }
  return count;
}

function balanceIncomingTransition(targetIndex, targetRatio = 1.38) {
  const previousIndex = (targetIndex - 1 + FRAME_COUNT) % FRAME_COUNT;
  const beforeIndex = (targetIndex - 2 + FRAME_COUNT) % FRAME_COUNT;
  const nextIndex = (targetIndex + 1) % FRAME_COUNT;
  const previous = smoothed[previousIndex];
  const target = smoothed[targetIndex];
  const before = smoothed[beforeIndex];
  const next = smoothed[nextIndex];
  const incoming = alphaDiff(previous, target);
  const beforeDiff = alphaDiff(before, previous);
  const outgoing = alphaDiff(target, next);
  const required = Math.max(
    0,
    Math.ceil((incoming - (targetRatio * (beforeDiff + outgoing)) / 2) / (1 + targetRatio / 2)),
  );
  if (required === 0) return { targetIndex, changed: 0, beforeDiff, incoming, outgoing };

  const targetBounds = alphaBounds(target);
  const candidates = [];
  for (let offset = 3; offset < target.length; offset += 4) {
    const previousAlpha = previous[offset];
    const targetAlpha = target[offset];
    const nextAlpha = next[offset];
    if (Math.abs(previousAlpha - targetAlpha) <= 16) continue;
    if (Math.abs(targetAlpha - nextAlpha) > 16) continue;
    if (Math.abs(previousAlpha - nextAlpha) <= 16) continue;
    const desiredVisible = previousAlpha > ALPHA_FLOOR;
    const pixel = (offset - 3) / 4;
    const x = pixel % CELL_WIDTH;
    const y = Math.floor(pixel / CELL_WIDTH);
    if (
      desiredVisible &&
      (x < targetBounds.minX || x > targetBounds.maxX || y < targetBounds.minY || y > targetBounds.maxY)
    ) {
      continue;
    }
    const neighbours = visibleNeighbours(target, offset);
    candidates.push({
      offset,
      desiredVisible,
      score: desiredVisible ? -neighbours : neighbours,
      strength: Math.abs(previousAlpha - targetAlpha),
    });
  }
  candidates.sort((a, b) => a.score - b.score || b.strength - a.strength || a.offset - b.offset);
  if (candidates.length < required) {
    throw new Error(`Only ${candidates.length} safe boundary pixels are available for direction ${targetIndex}; ${required} required.`);
  }
  for (const { offset } of candidates.slice(0, required)) {
    target[offset - 3] = previous[offset - 3];
    target[offset - 2] = previous[offset - 2];
    target[offset - 1] = previous[offset - 1];
    target[offset] = previous[offset];
  }
  return {
    targetIndex,
    changed: required,
    beforeDiff,
    incoming,
    outgoing,
    balancedIncoming: alphaDiff(previous, target),
    balancedOutgoing: alphaDiff(target, next),
  };
}

const transitionBalances = [4, 8, 15].map((index) => balanceIncomingTransition(index));

function premultipliedDifference(first, second, offset) {
  let difference = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const firstValue = Math.round((first[offset + channel] * first[offset + 3]) / 255);
    const secondValue = Math.round((second[offset + channel] * second[offset + 3]) / 255);
    difference += Math.abs(firstValue - secondValue);
  }
  return difference;
}

function visualDiff(first, second) {
  let count = 0;
  for (let offset = 0; offset < first.length; offset += 4) {
    if (premultipliedDifference(first, second, offset) >= 24) count += 1;
  }
  return count;
}

function colorFamily(cell, offset) {
  const red = cell[offset];
  const green = cell[offset + 1];
  const blue = cell[offset + 2];
  if (red < 100 && green < 100 && blue < 120) return "dark";
  if (red > 175 && green > 170 && blue > 160) return "light";
  if (red > 150 && red > green * 1.5 && red > blue * 1.5) return "red";
  if (red > 150 && green > 60 && green < 190 && blue < 100) return "orange";
  return "other";
}

function balanceIncomingColor(targetIndex, targetRatio = 1.5965) {
  const previousIndex = (targetIndex - 1 + FRAME_COUNT) % FRAME_COUNT;
  const beforeIndex = (targetIndex - 2 + FRAME_COUNT) % FRAME_COUNT;
  const nextIndex = (targetIndex + 1) % FRAME_COUNT;
  const previous = smoothed[previousIndex];
  const target = smoothed[targetIndex];
  const before = smoothed[beforeIndex];
  const next = smoothed[nextIndex];
  const incoming = visualDiff(previous, target);
  const beforeDiff = visualDiff(before, previous);
  const outgoing = visualDiff(target, next);
  const required = Math.max(
    0,
    Math.ceil((incoming - (targetRatio * (beforeDiff + outgoing)) / 2) / (1 + targetRatio / 2)),
  );
  if (required === 0) return { targetIndex, changed: 0, beforeDiff, incoming, outgoing };

  const candidates = [];
  for (let offset = 0; offset < target.length; offset += 4) {
    if (previous[offset + 3] < 240 || target[offset + 3] < 240 || next[offset + 3] < 240) continue;
    const family = colorFamily(target, offset);
    if (family === "other" || colorFamily(previous, offset) !== family) continue;
    const previousToTarget = premultipliedDifference(previous, target, offset);
    const targetToNext = premultipliedDifference(target, next, offset);
    if (previousToTarget < 24 || targetToNext >= 24) continue;
    const replacement = Buffer.from(target.subarray(offset, offset + 4));
    replacement[0] = previous[offset];
    replacement[1] = previous[offset + 1];
    replacement[2] = previous[offset + 2];
    if (premultipliedDifference(previous, replacement, 0) >= 24) continue;
    if (premultipliedDifference(replacement, next.subarray(offset, offset + 4), 0) < 24) continue;
    candidates.push({
      offset,
      score: visibleNeighbours(target, offset + 3),
      strength: previousToTarget,
    });
  }
  candidates.sort((a, b) => a.score - b.score || a.strength - b.strength || a.offset - b.offset);
  if (candidates.length < required) {
    throw new Error(`Only ${candidates.length} safe colour pixels are available for direction ${targetIndex}; ${required} required.`);
  }
  for (const { offset } of candidates.slice(0, required)) {
    target[offset] = previous[offset];
    target[offset + 1] = previous[offset + 1];
    target[offset + 2] = previous[offset + 2];
  }
  return {
    targetIndex,
    changed: required,
    beforeDiff,
    incoming,
    outgoing,
    balancedIncoming: visualDiff(previous, target),
    balancedOutgoing: visualDiff(target, next),
  };
}

const colorBalances = [15].map((index) => balanceIncomingColor(index));

await fs.mkdir(resolvedOutputDir, { recursive: true });
for (let index = 0; index < smoothed.length; index += 1) {
  await sharp(smoothed[index], { raw: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 4 } })
    .png({ palette: false, compressionLevel: 9 })
    .toFile(path.join(resolvedOutputDir, `${String(index).padStart(2, "0")}.png`));
}

let resolvedAtlasOutput = null;
if (atlasOutput) {
  resolvedAtlasOutput = path.resolve(atlasOutput);
  const extended = Buffer.from(data);
  for (let index = 0; index < smoothed.length; index += 1) {
    const row = LOOK_ROW + Math.floor(index / COLUMNS);
    const column = index % COLUMNS;
    for (let y = 0; y < CELL_HEIGHT; y += 1) {
      const sourceStart = y * CELL_WIDTH * 4;
      const targetStart = (((row * CELL_HEIGHT + y) * info.width) + column * CELL_WIDTH) * 4;
      smoothed[index].copy(extended, targetStart, sourceStart, sourceStart + CELL_WIDTH * 4);
    }
  }
  for (let offset = 0; offset < extended.length; offset += 4) {
    if (extended[offset + 3] !== 0) continue;
    extended.fill(0, offset, offset + 4);
  }
  await fs.mkdir(path.dirname(resolvedAtlasOutput), { recursive: true });
  await sharp(extended, { raw: info })
    .png({ palette: false, compressionLevel: 9 })
    .toFile(resolvedAtlasOutput);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      atlas: atlasPath,
      atlasOutput: resolvedAtlasOutput,
      outputDir: resolvedOutputDir,
      frames: smoothed.length,
      row9Scales,
      temporalFilter: "three-frame median alpha",
      smoothingPasses,
      protectedEntries: [...protectedEntries],
      transitionBalances,
      colorBalances,
      alphaFloor: ALPHA_FLOOR,
    },
    null,
    2,
  ),
);
