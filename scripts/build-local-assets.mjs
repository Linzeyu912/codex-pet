import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

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

const classicRoot = path.join(projectRoot, ".local-assets", "qq-penguin");
const classicSourcePath = path.join(classicRoot, "pixel-base.png");
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
    } catch {
      // Fall through to the rights-safe placeholder.
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
  let data = Buffer.from(base.data);
  let width = base.width;
  let height = base.height;

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

function createFrameRows() {
  const idle = [
    {},
    { scaleY: 0.99 },
    { scaleX: 1.01, scaleY: 0.975 },
    { scaleY: 0.99 },
    {},
    { blink: true },
  ];
  const runningRight = [
    { shear: 2, dy: 0 },
    { shear: 4, dx: 2, dy: 2, scaleY: 0.97 },
    { shear: 5, dx: 4, dy: -2, scaleY: 1.02 },
    { shear: 3, dx: 2, dy: 0 },
    { shear: 2, dy: 0 },
    { shear: 4, dx: 2, dy: 2, scaleY: 0.97 },
    { shear: 5, dx: 4, dy: -2, scaleY: 1.02 },
    { shear: 3, dx: 2, dy: 0 },
  ];
  const runningLeft = runningRight.map((frame) => ({
    ...frame,
    flip: true,
    dx: -(frame.dx ?? 0),
    shear: -(frame.shear ?? 0),
  }));
  const waving = [
    {},
    { wingAngle: -28, dy: -2 },
    { wingAngle: -62, dy: -4 },
    { wingAngle: -28, dy: -2 },
  ];
  const jumping = [
    { dy: 4, scaleX: 1.06, scaleY: 0.94 },
    { dy: -10, scaleX: 1.01, scaleY: 1.01 },
    { dy: -24, scaleX: 0.98, scaleY: 1.03 },
    { dy: -10, scaleX: 1.01, scaleY: 1.01 },
    { dy: 4, scaleX: 1.06, scaleY: 0.94 },
  ];
  const failed = [0, -2, 2, -2, 0, 2, -2, 0].map((dx, index) => ({
    dx,
    dy: [2, 3, 4, 5, 6, 5, 4, 3][index],
    scaleY: 0.97,
    halfBlink: true,
  }));
  const waiting = [
    { pupilDx: -2 },
    {},
    { pupilDx: 2 },
    {},
    { dy: -2, scaleY: 1.01 },
    { blink: true },
  ];
  const working = [
    { pupilDy: 2 },
    { pupilDy: 2, dy: -2 },
    { pupilDy: 2 },
    { pupilDy: 2, dy: -2 },
    { pupilDy: 2 },
    { pupilDy: 2 },
  ];
  const review = [-2, 0, 2, 2, 0, -2].map((pupilDx, index) => ({
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
  const { sourcePath, outputRoot, manifest, usedPlaceholder } = await resolveSource();
  if (usedPlaceholder) {
    console.log("No local classic-penguin source found; building the rights-safe placeholder pet.");
  }

  await fs.mkdir(outputRoot, { recursive: true });
  const base = await normalizeBase(sourcePath);
  const normalizedPath = path.join(outputRoot, "pixel-base-normalized.png");
  await sharp(base.data, { raw: { width: base.width, height: base.height, channels: 4 } })
    .png({ palette: true, colours: 24, dither: 0 })
    .toFile(normalizedPath);

  const atlas = Buffer.alloc(ATLAS_WIDTH * ATLAS_HEIGHT * 4);
  const rows = createFrameRows();
  rows.forEach((rowFrames, row) => {
    rowFrames.forEach((spec, column) => compositeFrame(atlas, makeFrame(base, spec), column, row));
  });

  // Current official V2 validator requires a neutral QA frame in row 0, column 6.
  compositeFrame(atlas, makeFrame(base), 6, 0);

  const spritesheetPath = path.join(outputRoot, manifest.spritesheetPath);
  const atlasImage = sharp(atlas, {
    raw: { width: ATLAS_WIDTH, height: ATLAS_HEIGHT, channels: 4 },
  });
  await atlasImage
    .clone()
    .webp({ lossless: true, quality: 100, alphaQuality: 100 })
    .toFile(spritesheetPath);
  const pngSpritesheetPath = path.join(outputRoot, "spritesheet.png");
  await atlasImage.clone().png({ palette: false, compressionLevel: 9 }).toFile(pngSpritesheetPath);
  await fs.writeFile(path.join(outputRoot, "pet.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (copyToPublic) {
    await fs.mkdir(publicRoot, { recursive: true });
    await fs.copyFile(spritesheetPath, path.join(publicRoot, "spritesheet.webp"));
    await fs.copyFile(pngSpritesheetPath, path.join(publicRoot, "spritesheet.png"));
  }

  console.log(`Built Codex Pet V2 atlas: ${spritesheetPath}`);
  return {
    built: true,
    sourcePath,
    outputRoot,
    spritesheetPath,
    pngSpritesheetPath,
    normalizedPath,
    petId: manifest.id,
    usedPlaceholder,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await buildLocalAssets();
}
