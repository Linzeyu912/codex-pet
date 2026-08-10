import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export const CODEX_ATLAS_GEOMETRY = Object.freeze({
  columns: 8,
  rows: 11,
  cellWidth: 192,
  cellHeight: 208,
});

// Numeric thresholds match Codex's validate_atlas.py defaults. The key is the
// cyan source color this project passes explicitly as `--chroma-key #00FFFF`.
export const DEFAULT_CHROMA_FRINGE_OPTIONS = Object.freeze({
  chromaKey: Object.freeze([0, 255, 255]),
  distanceThreshold: 96,
  edgeRadius: 2,
  alphaMinimum: 16,
  ...CODEX_ATLAS_GEOMETRY,
});

// Some image tools store a cyan matte in low-alpha edge pixels rather than the
// exact #00FFFF chroma key.  The official validator cannot identify that
// premultiplied spill by colour distance alone, so keep a second, deliberately
// narrow detector for the rendered blue halo.
export const DEFAULT_BLUE_HALO_OPTIONS = Object.freeze({
  edgeRadius: 2,
  sampleRadius: 14,
  ...CODEX_ATLAS_GEOMETRY,
});

const MAX_SAMPLE_RADIUS = 16;
const COMPARISON_SCALE = 4;
const COMPARISON_CELL_LIMIT = 6;

export function parseHexColor(value) {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`Invalid chroma key ${value}; expected #RRGGBB.`);
  }
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

export function colorDistance(red, green, blue, key) {
  return Math.hypot(red - key[0], green - key[1], blue - key[2]);
}

function normalizedOptions(options = {}) {
  const merged = { ...DEFAULT_CHROMA_FRINGE_OPTIONS, ...options };
  const integerFields = ["columns", "rows", "cellWidth", "cellHeight", "edgeRadius", "alphaMinimum"];
  for (const field of integerFields) {
    if (!Number.isInteger(merged[field]) || merged[field] < (field === "edgeRadius" ? 0 : 1)) {
      throw new Error(`${field} must be a ${field === "edgeRadius" ? "non-negative" : "positive"} integer.`);
    }
  }
  if (merged.alphaMinimum > 255) throw new Error("alphaMinimum must not exceed 255.");
  if (!Number.isFinite(merged.distanceThreshold) || merged.distanceThreshold < 0) {
    throw new Error("distanceThreshold must be a non-negative finite number.");
  }
  if (!Array.isArray(merged.chromaKey) || merged.chromaKey.length !== 3 ||
      merged.chromaKey.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("chromaKey must contain three integer RGB channels from 0 through 255.");
  }
  return merged;
}

function validateRaw(data, metadata, options) {
  const { width, height, channels = 4 } = metadata;
  if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
    throw new Error("RGBA input must be a Buffer or Uint8Array.");
  }
  if (channels !== 4) throw new Error(`Expected four RGBA channels, got ${channels}.`);
  if (width !== options.columns * options.cellWidth || height !== options.rows * options.cellHeight) {
    throw new Error(
      `Expected ${options.columns * options.cellWidth}x${options.rows * options.cellHeight}, got ${width}x${height}.`,
    );
  }
  if (data.length !== width * height * 4) {
    throw new Error(`RGBA byte length does not match ${width}x${height}.`);
  }
}

function normalizedBlueHaloOptions(options = {}) {
  const merged = { ...DEFAULT_BLUE_HALO_OPTIONS, ...options };
  for (const field of ["columns", "rows", "cellWidth", "cellHeight", "edgeRadius", "sampleRadius"]) {
    if (!Number.isInteger(merged[field]) || merged[field] < (field === "edgeRadius" ? 0 : 1)) {
      throw new Error(`${field} must be a ${field === "edgeRadius" ? "non-negative" : "positive"} integer.`);
    }
  }
  return merged;
}

function isBlueHaloPixel(red, green, blue, alpha) {
  if (alpha === 0 || green < 70 || blue < 70) return false;
  // This captures the turquoise matte, including its premultiplied variants,
  // including the slightly bluer/greener edge remnants produced by lossless
  // WebP decoding. The penguin's intended navy outline is substantially more
  // blue-dominant than this range and remains untouched.
  return red * 1.5 < Math.min(green, blue) && blue / green >= 0.45 && blue / green <= 2.1;
}

function transparentOffsets(data, width, row, column, x, y, settings) {
  const offsets = [];
  for (let dy = -settings.edgeRadius; dy <= settings.edgeRadius; dy += 1) {
    for (let dx = -settings.edgeRadius; dx <= settings.edgeRadius; dx += 1) {
      const nearbyX = x + dx;
      const nearbyY = y + dy;
      if (nearbyX < 0 || nearbyY < 0 || nearbyX >= settings.cellWidth ||
          nearbyY >= settings.cellHeight) continue;
      const offset = (
        (row * settings.cellHeight + nearbyY) * width +
        column * settings.cellWidth + nearbyX
      ) * 4;
      if (data[offset + 3] === 0) offsets.push([nearbyX, nearbyY]);
    }
  }
  return offsets;
}

function blueHaloInteriorSample(data, width, row, column, x, y, settings) {
  const transparent = transparentOffsets(data, width, row, column, x, y, settings);

  let inwardX = 0;
  let inwardY = 0;
  for (const [transparentX, transparentY] of transparent) {
    inwardX += x - transparentX;
    inwardY += y - transparentY;
  }
  const inwardLength = Math.hypot(inwardX, inwardY);
  if (inwardLength > 0) {
    inwardX /= inwardLength;
    inwardY /= inwardLength;
  }

  const candidates = [];
  for (let radius = 1; radius <= settings.sampleRadius; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const sampleX = x + dx;
        const sampleY = y + dy;
        if (sampleX < 0 || sampleY < 0 || sampleX >= settings.cellWidth || sampleY >= settings.cellHeight) {
          continue;
        }
        const offset = (
          (row * settings.cellHeight + sampleY) * width +
          column * settings.cellWidth + sampleX
        ) * 4;
        const alpha = data[offset + 3];
        if (alpha < 96 || isBlueHaloPixel(data[offset], data[offset + 1], data[offset + 2], alpha)) continue;
        const distance = Math.hypot(dx, dy);
        const alignment = inwardLength > 0 ? (dx * inwardX + dy * inwardY) / distance : 0;
        if (inwardLength > 0 && alignment < -0.15) continue;
        candidates.push({
          offset,
          score: distance * 100 - alignment * 14 - Math.min(alpha, 255) / 255,
        });
      }
    }
    if (candidates.length > 0) break;
  }
  candidates.sort((left, right) => left.score - right.score || left.offset - right.offset);
  return candidates[0]?.offset ?? null;
}

/**
 * Replace visible, premultiplied cyan matte pixels with a nearby interior
 * palette colour. Alpha and geometry stay exactly unchanged.
 */
export function removeBlueHaloRgba(data, metadata, options = {}) {
  const settings = normalizedBlueHaloOptions(options);
  validateRaw(data, metadata, settings);
  const output = Buffer.from(data);
  const { width } = metadata;
  let candidates = 0;
  let changedPixels = 0;
  let unresolvedPixels = 0;

  for (let row = 0; row < settings.rows; row += 1) {
    for (let column = 0; column < settings.columns; column += 1) {
      for (let y = 0; y < settings.cellHeight; y += 1) {
        for (let x = 0; x < settings.cellWidth; x += 1) {
          const pixel = (row * settings.cellHeight + y) * width + column * settings.cellWidth + x;
          const offset = pixel * 4;
          if (!isBlueHaloPixel(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) continue;
          const sampleOffset = blueHaloInteriorSample(data, width, row, column, x, y, settings);
          if (sampleOffset === null) continue;
          candidates += 1;
          output[offset] = data[sampleOffset];
          output[offset + 1] = data[sampleOffset + 1];
          output[offset + 2] = data[sampleOffset + 2];
          changedPixels += 1;
        }
      }
    }
  }

  for (let row = 0; row < settings.rows; row += 1) {
    for (let column = 0; column < settings.columns; column += 1) {
      for (let y = 0; y < settings.cellHeight; y += 1) {
        for (let x = 0; x < settings.cellWidth; x += 1) {
          const pixel = (row * settings.cellHeight + y) * width + column * settings.cellWidth + x;
          const offset = pixel * 4;
          if (isBlueHaloPixel(output[offset], output[offset + 1], output[offset + 2], output[offset + 3])) {
            unresolvedPixels += 1;
          }
        }
      }
    }
  }

  return { data: output, candidates, changedPixels, unresolvedPixels, options: settings };
}

/**
 * Audit the exact edge-chroma condition used by Codex's validate_atlas.py.
 * Max-filter dilation is evaluated independently inside every atlas cell.
 */
export function auditChromaFringeRgba(data, metadata, options = {}) {
  const settings = normalizedOptions(options);
  validateRaw(data, metadata, settings);
  const { width } = metadata;
  const mask = new Uint8Array(settings.columns * settings.rows * settings.cellWidth * settings.cellHeight);
  const cells = [];
  let total = 0;

  for (let row = 0; row < settings.rows; row += 1) {
    for (let column = 0; column < settings.columns; column += 1) {
      let count = 0;
      for (let y = 0; y < settings.cellHeight; y += 1) {
        for (let x = 0; x < settings.cellWidth; x += 1) {
          const atlasX = column * settings.cellWidth + x;
          const atlasY = row * settings.cellHeight + y;
          const atlasPixel = atlasY * width + atlasX;
          const offset = atlasPixel * 4;
          if (data[offset + 3] < settings.alphaMinimum) continue;
          if (colorDistance(data[offset], data[offset + 1], data[offset + 2], settings.chromaKey) >
              settings.distanceThreshold) continue;

          let nearbyTransparency = false;
          for (let dy = -settings.edgeRadius; dy <= settings.edgeRadius && !nearbyTransparency; dy += 1) {
            for (let dx = -settings.edgeRadius; dx <= settings.edgeRadius; dx += 1) {
              const nearbyX = x + dx;
              const nearbyY = y + dy;
              // PIL's MaxFilter extends the cell edge; it does not inspect the adjacent atlas cell.
              if (nearbyX < 0 || nearbyY < 0 || nearbyX >= settings.cellWidth ||
                  nearbyY >= settings.cellHeight) continue;
              const nearbyOffset = (
                (row * settings.cellHeight + nearbyY) * width +
                column * settings.cellWidth + nearbyX
              ) * 4;
              if (data[nearbyOffset + 3] === 0) {
                nearbyTransparency = true;
                break;
              }
            }
          }
          if (!nearbyTransparency) continue;
          mask[atlasPixel] = 1;
          count += 1;
          total += 1;
        }
      }
      cells.push({ row, column, count });
    }
  }

  return { total, cells, mask, options: settings };
}

export async function auditChromaFringeFile(filePath, options = {}) {
  const decoded = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const audit = auditChromaFringeRgba(decoded.data, decoded.info, options);
  return { ...audit, width: decoded.info.width, height: decoded.info.height };
}

function isCleanSample(data, offset, settings, sampleDistanceThreshold, minimumSampleAlpha) {
  return data[offset + 3] >= minimumSampleAlpha &&
    colorDistance(data[offset], data[offset + 1], data[offset + 2], settings.chromaKey) >
      sampleDistanceThreshold;
}

function transparentNeighbors(data, width, row, column, x, y, settings) {
  const neighbors = [];
  for (let dy = -settings.edgeRadius; dy <= settings.edgeRadius; dy += 1) {
    for (let dx = -settings.edgeRadius; dx <= settings.edgeRadius; dx += 1) {
      const nearbyX = x + dx;
      const nearbyY = y + dy;
      if (nearbyX < 0 || nearbyY < 0 || nearbyX >= settings.cellWidth ||
          nearbyY >= settings.cellHeight) continue;
      const offset = (
        (row * settings.cellHeight + nearbyY) * width +
        column * settings.cellWidth + nearbyX
      ) * 4;
      if (data[offset + 3] === 0) neighbors.push([nearbyX, nearbyY]);
    }
  }
  return neighbors;
}

function interiorDepth(data, width, row, column, x, y, settings) {
  for (let radius = 1; radius <= 4; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const nearbyX = x + dx;
        const nearbyY = y + dy;
        if (nearbyX < 0 || nearbyY < 0 || nearbyX >= settings.cellWidth ||
            nearbyY >= settings.cellHeight) continue;
        const offset = (
          (row * settings.cellHeight + nearbyY) * width +
          column * settings.cellWidth + nearbyX
        ) * 4;
        if (data[offset + 3] === 0) return radius - 1;
      }
    }
  }
  return 4;
}

function chooseInteriorSample(data, width, row, column, x, y, targetAlpha, settings) {
  const transparent = transparentNeighbors(data, width, row, column, x, y, settings);
  let inwardX = 0;
  let inwardY = 0;
  for (const [transparentX, transparentY] of transparent) {
    inwardX += x - transparentX;
    inwardY += y - transparentY;
  }
  const inwardLength = Math.hypot(inwardX, inwardY);
  if (inwardLength > 0) {
    inwardX /= inwardLength;
    inwardY /= inwardLength;
  }

  // Sampling farther than the official 96 threshold avoids replacing cyan with a
  // merely borderline teal. Requiring a substantially opaque source also prevents
  // hidden low-alpha RGB garbage from being copied into the outline. The selected
  // RGB always comes from the same sprite cell.
  const sampleDistanceThreshold = Math.max(144, settings.distanceThreshold + 48);
  const minimumSampleAlpha = Math.max(128, Math.min(targetAlpha, 224));
  let best = null;
  for (let radius = 1; radius <= MAX_SAMPLE_RADIUS; radius += 1) {
    const candidates = [];
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const sampleX = x + dx;
        const sampleY = y + dy;
        if (sampleX < 0 || sampleY < 0 || sampleX >= settings.cellWidth ||
            sampleY >= settings.cellHeight) continue;
        const offset = (
          (row * settings.cellHeight + sampleY) * width +
          column * settings.cellWidth + sampleX
        ) * 4;
        if (!isCleanSample(
          data,
          offset,
          settings,
          sampleDistanceThreshold,
          minimumSampleAlpha,
        )) continue;
        const distance = Math.hypot(dx, dy);
        const alignment = inwardLength > 0 ? (dx * inwardX + dy * inwardY) / distance : 0;
        if (inwardLength > 0 && alignment < -0.2) continue;
        const depth = interiorDepth(data, width, row, column, sampleX, sampleY, settings);
        const sampleAlpha = data[offset + 3];
        const alphaPenalty = Math.max(0, targetAlpha - sampleAlpha) / 255;
        const score = distance * 10 - alignment * 4 - depth * 0.75 + alphaPenalty * 2;
        candidates.push({ offset, score, alignment, depth, sampleAlpha, sampleX, sampleY });
      }
    }
    candidates.sort((left, right) =>
      left.score - right.score ||
      right.alignment - left.alignment ||
      right.depth - left.depth ||
      right.sampleAlpha - left.sampleAlpha ||
      left.sampleY - right.sampleY ||
      left.sampleX - right.sampleX,
    );
    if (candidates.length > 0) {
      best = candidates[0];
      break;
    }
  }
  if (!best) {
    throw new Error(`No uncontaminated inward sample found for row ${row}, column ${column}, x ${x}, y ${y}.`);
  }
  return best.offset;
}

/** Replace only pixels selected by the configured fringe audit. */
export function removeChromaFringeRgba(data, metadata, options = {}) {
  const before = auditChromaFringeRgba(data, metadata, options);
  const settings = before.options;
  const output = Buffer.from(data);
  const { width } = metadata;
  let changedPixels = 0;
  const replacementColors = new Map();

  for (let row = 0; row < settings.rows; row += 1) {
    for (let column = 0; column < settings.columns; column += 1) {
      for (let y = 0; y < settings.cellHeight; y += 1) {
        for (let x = 0; x < settings.cellWidth; x += 1) {
          const atlasX = column * settings.cellWidth + x;
          const atlasY = row * settings.cellHeight + y;
          const pixel = atlasY * width + atlasX;
          if (before.mask[pixel] !== 1) continue;
          const offset = pixel * 4;
          const sampleOffset = chooseInteriorSample(
            data,
            width,
            row,
            column,
            x,
            y,
            data[offset + 3],
            settings,
          );
          output[offset] = data[sampleOffset];
          output[offset + 1] = data[sampleOffset + 1];
          output[offset + 2] = data[sampleOffset + 2];
          // Alpha is deliberately not touched.
          const color = `${output[offset]},${output[offset + 1]},${output[offset + 2]}`;
          replacementColors.set(color, (replacementColors.get(color) ?? 0) + 1);
          changedPixels += 1;
        }
      }
    }
  }

  // Codex also rejects hidden RGB residue. Clearing it is a no-op for a compliant
  // source; otherwise it affects transparent storage only, never visible geometry.
  let clearedTransparentRgbPixels = 0;
  for (let offset = 0; offset < output.length; offset += 4) {
    if (output[offset + 3] !== 0 || (!output[offset] && !output[offset + 1] && !output[offset + 2])) continue;
    output[offset] = 0;
    output[offset + 1] = 0;
    output[offset + 2] = 0;
    clearedTransparentRgbPixels += 1;
  }

  const after = auditChromaFringeRgba(output, metadata, settings);
  return {
    data: output,
    before,
    after,
    changedPixels,
    clearedTransparentRgbPixels,
    replacementColors: [...replacementColors.entries()]
      .map(([rgb, count]) => ({ rgb, count }))
      .sort((left, right) => right.count - left.count || left.rgb.localeCompare(right.rgb)),
  };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function alphaSha256(data) {
  const alpha = Buffer.alloc(data.length / 4);
  for (let offset = 3, index = 0; offset < data.length; offset += 4, index += 1) alpha[index] = data[offset];
  return sha256(alpha);
}

function rawChangeAudit(before, after, selectedFringeMask) {
  let alphaChangedPixels = 0;
  let visibleChangedOutsideSelectedFringeMask = 0;
  let transparentRgbChangedPixels = 0;
  let transparentRgbResiduePixels = 0;
  for (let offset = 0, pixel = 0; offset < before.length; offset += 4, pixel += 1) {
    if (before[offset + 3] !== after[offset + 3]) alphaChangedPixels += 1;
    const rgbChanged = before[offset] !== after[offset] ||
      before[offset + 1] !== after[offset + 1] ||
      before[offset + 2] !== after[offset + 2];
    if (rgbChanged && before[offset + 3] === 0) transparentRgbChangedPixels += 1;
    if (rgbChanged && before[offset + 3] > 0 && selectedFringeMask[pixel] !== 1) {
      visibleChangedOutsideSelectedFringeMask += 1;
    }
    if (after[offset + 3] === 0 && (after[offset] || after[offset + 1] || after[offset + 2])) {
      transparentRgbResiduePixels += 1;
    }
  }
  return {
    alphaChangedPixels,
    visibleChangedOutsideSelectedFringeMask,
    transparentRgbChangedPixels,
    transparentRgbResiduePixels,
  };
}

async function atomicWrite(targetPath, contents) {
  const resolved = path.resolve(targetPath);
  const requestedParent = path.dirname(resolved);
  await fs.mkdir(requestedParent, { recursive: true });
  const parentStats = await fs.lstat(requestedParent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error(`Output parent must be a real directory: ${requestedParent}`);
  }
  const realParent = await fs.realpath(requestedParent);
  const realTarget = path.join(realParent, path.basename(resolved));
  try {
    const stats = await fs.lstat(realTarget);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Output must be a regular file, not a link or special entry: ${realTarget}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(realParent, `.${path.basename(realTarget)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, contents, { flag: "wx" });
    await fs.rename(temporary, realTarget);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function comparisonCells(audit) {
  const bestByRow = new Map();
  for (const cell of audit.cells) {
    if (cell.count === 0) continue;
    const current = bestByRow.get(cell.row);
    if (!current || cell.count > current.count ||
        (cell.count === current.count && cell.column < current.column)) bestByRow.set(cell.row, cell);
  }
  return [...bestByRow.values()]
    .sort((left, right) => right.count - left.count || left.row - right.row)
    .slice(0, COMPARISON_CELL_LIMIT)
    .sort((left, right) => left.row - right.row);
}

async function checkerboard(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  const tile = 32;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = ((Math.floor(x / tile) + Math.floor(y / tile)) % 2 === 0) ? 238 : 210;
      const offset = (y * width + x) * 4;
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

async function renderComparison(beforeData, afterData, metadata, audit) {
  const settings = audit.options;
  const cells = comparisonCells(audit);
  const panelWidth = settings.cellWidth * COMPARISON_SCALE;
  const imageHeight = settings.cellHeight * COMPARISON_SCALE;
  const headerHeight = 40;
  const rowHeight = headerHeight + imageHeight;
  const canvasWidth = panelWidth * 2;
  const canvasHeight = rowHeight * cells.length;
  const background = await checkerboard(canvasWidth, canvasHeight);
  const composites = [];

  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    for (const [side, source] of [[0, beforeData], [1, afterData]]) {
      const frame = await sharp(source, { raw: metadata })
        .extract({
          left: cell.column * settings.cellWidth,
          top: cell.row * settings.cellHeight,
          width: settings.cellWidth,
          height: settings.cellHeight,
        })
        .resize(panelWidth, imageHeight, { kernel: "nearest" })
        .png()
        .toBuffer();
      composites.push({ input: frame, left: side * panelWidth, top: index * rowHeight + headerHeight });
    }
    const escapedLabel = `row ${cell.row} col ${cell.column} | ${cell.count} fringe pixels`;
    const header = Buffer.from(
      `<svg width="${canvasWidth}" height="${headerHeight}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#202124"/>` +
      `<text x="12" y="26" fill="#fff" font-family="Arial,sans-serif" font-size="18">BEFORE · ${escapedLabel}</text>` +
      `<text x="${panelWidth + 12}" y="26" fill="#fff" font-family="Arial,sans-serif" font-size="18">AFTER · ${escapedLabel}</text>` +
      `</svg>`,
    );
    composites.push({ input: header, left: 0, top: index * rowHeight });
  }
  return sharp(background, { raw: { width: canvasWidth, height: canvasHeight, channels: 4 } })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function parseArguments(argv) {
  const parsed = { outputs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
    if (argument === "--input") parsed.input = path.resolve(value);
    else if (argument === "--output") parsed.outputs.push(path.resolve(value));
    else if (argument === "--comparison") parsed.comparison = path.resolve(value);
    else if (argument === "--report") parsed.report = path.resolve(value);
    else if (argument === "--chroma-key") parsed.chromaKey = parseHexColor(value);
    else if (argument === "--distance-threshold") {
      parsed.distanceThreshold = Number(value);
      if (!Number.isFinite(parsed.distanceThreshold) || parsed.distanceThreshold < 0) {
        throw new Error("--distance-threshold must be a non-negative finite number.");
      }
    }
    else if (argument === "--alpha-minimum") {
      parsed.alphaMinimum = Number(value);
      if (!Number.isInteger(parsed.alphaMinimum) || parsed.alphaMinimum < 1 || parsed.alphaMinimum > 255) {
        throw new Error("--alpha-minimum must be an integer from 1 through 255.");
      }
    }
    else throw new Error(`Unknown option: ${argument}`);
    index += 1;
  }
  if (!parsed.input || parsed.outputs.length === 0) {
    throw new Error(
      "Usage: node scripts/remove-chroma-fringe.mjs --input <atlas> --output <clean.png|clean.webp> " +
      "[--output <second-format>] [--comparison <comparison.png>] [--report <report.json>] " +
      "[--chroma-key #RRGGBB] [--distance-threshold <number>] [--alpha-minimum <1-255>]",
    );
  }
  const allOutputs = [...parsed.outputs, parsed.comparison, parsed.report].filter(Boolean);
  const keys = allOutputs.map((entry) => process.platform === "win32" ? entry.toLowerCase() : entry);
  const inputKey = process.platform === "win32" ? parsed.input.toLowerCase() : parsed.input;
  if (keys.includes(inputKey)) throw new Error("Refusing to overwrite the input atlas.");
  if (new Set(keys).size !== keys.length) throw new Error("Output paths must be unique.");
  for (const output of parsed.outputs) {
    if (![".png", ".webp"].includes(path.extname(output).toLowerCase())) {
      throw new Error(`Atlas output must end in .png or .webp: ${output}`);
    }
  }
  if (parsed.comparison && path.extname(parsed.comparison).toLowerCase() !== ".png") {
    throw new Error("Comparison output must end in .png.");
  }
  if (parsed.report && path.extname(parsed.report).toLowerCase() !== ".json") {
    throw new Error("Report output must end in .json.");
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const inputStats = await fs.lstat(args.input);
  if (inputStats.isSymbolicLink() || !inputStats.isFile()) {
    throw new Error(`Input must be a regular file, not a link or special entry: ${args.input}`);
  }
  const inputBytes = await fs.readFile(args.input);
  const decoded = await sharp(inputBytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const options = {
    ...(args.chromaKey ? { chromaKey: args.chromaKey } : {}),
    ...(args.distanceThreshold === undefined ? {} : { distanceThreshold: args.distanceThreshold }),
    ...(args.alphaMinimum === undefined ? {} : { alphaMinimum: args.alphaMinimum }),
  };
  const cleaned = removeChromaFringeRgba(decoded.data, decoded.info, options);
  if (cleaned.before.total === 0) throw new Error("Input atlas has no edge chroma fringe to remove.");
  if (cleaned.after.total !== 0) throw new Error(`Cleanup left ${cleaned.after.total} fringe pixels.`);

  const encoded = new Map();
  const decodedOutputs = new Map();
  for (const output of args.outputs) {
    const extension = path.extname(output).toLowerCase();
    const pipeline = sharp(cleaned.data, { raw: decoded.info });
    const bytes = extension === ".png"
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer()
      : await pipeline.webp({ lossless: true, quality: 100, alphaQuality: 100, effort: 6, exact: true }).toBuffer();
    encoded.set(output, bytes);
    const decodedOutput = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const exact = decodedOutput.info.width === decoded.info.width &&
      decodedOutput.info.height === decoded.info.height &&
      decodedOutput.info.channels === 4 &&
      decodedOutput.data.equals(cleaned.data);
    if (!exact) throw new Error(`Encoded output does not decode to the exact cleaned RGBA pixels: ${output}`);
    decodedOutputs.set(output, { exact, rgbaSha256: sha256(decodedOutput.data) });
  }
  const comparison = args.comparison
    ? await renderComparison(decoded.data, cleaned.data, decoded.info, cleaned.before)
    : null;

  for (const [output, bytes] of encoded) await atomicWrite(output, bytes);
  if (args.comparison) await atomicWrite(args.comparison, comparison);

  const beforeAlphaSha256 = alphaSha256(decoded.data);
  const afterAlphaSha256 = alphaSha256(cleaned.data);
  const changes = rawChangeAudit(decoded.data, cleaned.data, cleaned.before.mask);
  const officialDefaultBefore = auditChromaFringeRgba(decoded.data, decoded.info);
  const officialDefaultAfter = auditChromaFringeRgba(cleaned.data, decoded.info);
  const report = {
    schema: "codex-pet-chroma-fringe-cleanup/v1",
    input: { file: args.input, sha256: sha256(inputBytes) },
    outputs: [...encoded].map(([file, bytes]) => ({
      file,
      sha256: sha256(bytes),
      decodedRgbaSha256: decodedOutputs.get(file).rgbaSha256,
      decodesExactly: decodedOutputs.get(file).exact,
    })),
    comparison: args.comparison ? { file: args.comparison, sha256: sha256(comparison), scale: COMPARISON_SCALE } : null,
    geometry: {
      width: decoded.info.width,
      height: decoded.info.height,
      columns: cleaned.before.options.columns,
      rows: cleaned.before.options.rows,
      cellWidth: cleaned.before.options.cellWidth,
      cellHeight: cleaned.before.options.cellHeight,
    },
    selectedAudit: {
      thresholds: {
        chromaKey: cleaned.before.options.chromaKey,
        distanceThreshold: cleaned.before.options.distanceThreshold,
        edgeRadius: cleaned.before.options.edgeRadius,
        alphaMinimum: cleaned.before.options.alphaMinimum,
      },
      beforeFringePixels: cleaned.before.total,
      afterFringePixels: cleaned.after.total,
    },
    officialDefaultAudit: {
      thresholds: {
        chromaKey: officialDefaultBefore.options.chromaKey,
        distanceThreshold: officialDefaultBefore.options.distanceThreshold,
        edgeRadius: officialDefaultBefore.options.edgeRadius,
        alphaMinimum: officialDefaultBefore.options.alphaMinimum,
      },
      beforeFringePixels: officialDefaultBefore.total,
      afterFringePixels: officialDefaultAfter.total,
    },
    changedVisiblePixels: cleaned.changedPixels,
    clearedTransparentRgbPixels: cleaned.clearedTransparentRgbPixels,
    invariants: {
      alphaUnchanged: beforeAlphaSha256 === afterAlphaSha256 && changes.alphaChangedPixels === 0,
      alphaSha256: afterAlphaSha256,
      dimensionsUnchanged: true,
      changedOnlySelectedFringeMask:
        cleaned.changedPixels === cleaned.before.total &&
        changes.visibleChangedOutsideSelectedFringeMask === 0,
      transparentRgbZero: changes.transparentRgbResiduePixels === 0,
      pngWebpDecodeIdentical:
        new Set([...decodedOutputs.values()].map((entry) => entry.rgbaSha256)).size === 1,
      alphaChangedPixels: changes.alphaChangedPixels,
      visibleChangedOutsideSelectedFringeMask: changes.visibleChangedOutsideSelectedFringeMask,
      transparentRgbChangedPixels: changes.transparentRgbChangedPixels,
      transparentRgbResiduePixels: changes.transparentRgbResiduePixels,
    },
    topReplacementColors: cleaned.replacementColors.slice(0, 20),
  };
  if (!report.invariants.alphaUnchanged || !report.invariants.changedOnlySelectedFringeMask ||
      !report.invariants.transparentRgbZero || !report.invariants.pngWebpDecodeIdentical) {
    throw new Error("Cleanup invariants failed.");
  }
  if (args.report) await atomicWrite(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isDirectRun = process.platform === "win32"
  ? invokedPath.toLowerCase() === modulePath.toLowerCase()
  : invokedPath === modulePath;
if (isDirectRun) await main();
