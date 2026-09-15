import sharp from "sharp";

export const CELL_WIDTH = 192;
export const CELL_HEIGHT = 208;
export const BASELINE = 187;
export const isGreen = (r, g, b) => g > 65 && g > r * 1.35 && g > b * 1.35;
export const isRed = (r, g, b, a) => a > 0 && r > 150 && g < r * 0.24 && b < r * 0.24;

export function bounds(data, width, height) {
  let left = width, top = height, right = -1, bottom = -1, area = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!data[(y * width + x) * 4 + 3]) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); area++;
  }
  if (!area) throw new Error("Empty character frame");
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1, area };
}

export async function readSourceCells(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cells = [];
  for (let index = 0; index < 16; index++) {
    const column = index % 4, row = Math.floor(index / 4);
    const left = Math.round(column * info.width / 4), top = Math.round(row * info.height / 4);
    const width = Math.round((column + 1) * info.width / 4) - left;
    const height = Math.round((row + 1) * info.height / 4) - top;
    const cell = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const from = ((top + y) * info.width + left + x) * 4, to = (y * width + x) * 4;
      if (data[from + 3] < 128 || isGreen(data[from], data[from + 1], data[from + 2])) continue;
      cell.set([data[from], data[from + 1], data[from + 2], 255], to);
    }
    const box = bounds(cell, width, height);
    const cropped = await sharp(cell, { raw: { width, height, channels: 4 } })
      .extract({ left: box.left, top: box.top, width: box.width, height: box.height }).raw().toBuffer();
    cells.push({ data: cropped, width: box.width, height: box.height });
  }
  return cells;
}

export async function loadCharacter(input) {
  const source = await readSourceCells(input);
  const scale = Math.min(170 / Math.max(...source.slice(0, 12).map((p) => p.height)),
    180 / Math.max(...source.map((p) => p.width)), 182 / Math.max(...source.map((p) => p.height)));
  const poses = await Promise.all(source.map(async (pose) => {
    const width = Math.round(pose.width * scale), height = Math.round(pose.height * scale);
    const data = await sharp(pose.data, { raw: { width: pose.width, height: pose.height, channels: 4 } })
      .resize(width, height, { fit: "fill", kernel: "nearest" }).raw().toBuffer();
    return { data, width, height };
  }));
  return { poses, scale, sourceMetrics: source.map(({ width, height }) => ({ width, height })) };
}

export function eyeMasks(pose) {
  const { data, width, height } = pose;
  const visited = new Uint8Array(width * height), regions = [];
  const white = (index) => data[index * 4 + 3] && data[index * 4] > 205 && data[index * 4 + 1] > 205 && data[index * 4 + 2] > 205;
  const limit = Math.floor(height * 0.43);
  for (let y = 0; y < limit; y++) for (let x = 0; x < width; x++) {
    const start = y * width + x;
    if (visited[start] || !white(start)) continue;
    const queue = [start]; visited[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const i = queue[cursor], px = i % width, py = Math.floor(i / width);
      for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= limit) continue;
        const next = ny * width + nx;
        if (!visited[next] && white(next)) { visited[next] = 1; queue.push(next); }
      }
    }
    if (queue.length < 25) continue;
    const mask = new Set(), rowBounds = new Map();
    for (const i of queue) {
      const py = Math.floor(i / width), px = i % width, row = rowBounds.get(py) ?? [width, -1];
      row[0] = Math.min(row[0], px); row[1] = Math.max(row[1], px); rowBounds.set(py, row);
    }
    for (const [py, [left, right]] of rowBounds) for (let px = left; px <= right; px++) mask.add(py * width + px);
    regions.push({ mask, top: Math.min(...rowBounds.keys()), bottom: Math.max(...rowBounds.keys()) });
  }
  if (regions.length !== 2) throw new Error(`Expected two white eye regions, found ${regions.length}`);
  return regions;
}

export function animateEyes(pose, spec) {
  const data = Buffer.from(pose.data), regions = eyeMasks(pose);
  for (const { mask, top, bottom } of regions) {
    if (spec.blink) {
      const cutoff = spec.blink === "half" ? Math.round((top + bottom) / 2) : bottom;
      for (const i of mask) if (Math.floor(i / pose.width) <= cutoff) data.set([24, 24, 24, 255], i * 4);
    } else {
      const [dx, dy] = spec.look, pupil = [];
      for (const i of mask) if (pose.data[i * 4] < 130) pupil.push(i);
      for (const i of mask) data.set([250, 250, 250, 255], i * 4);
      for (const i of pupil) {
        const x = i % pose.width + dx, y = Math.floor(i / pose.width) + dy;
        const next = y * pose.width + x;
        if (x >= 0 && x < pose.width && mask.has(next)) data.set([14, 14, 14, 255], next * 4);
      }
    }
  }
  return { ...pose, data };
}

export function placeFrame(pose, dy = 0) {
  const output = Buffer.alloc(CELL_WIDTH * CELL_HEIGHT * 4);
  const visible = bounds(pose.data, pose.width, pose.height);
  const left = Math.round((CELL_WIDTH - pose.width) / 2), top = BASELINE - visible.bottom + dy;
  if (left < 4 || top < 4 || left + pose.width > CELL_WIDTH - 4 || top + pose.height > CELL_HEIGHT - 4) throw new Error("Pose would clip the frame");
  for (let y = 0; y < pose.height; y++) pose.data.copy(output, ((top + y) * CELL_WIDTH + left) * 4, y * pose.width * 4, (y + 1) * pose.width * 4);
  return output;
}

export function buildAtlas(rows, columns, rowCount) {
  const width = columns * CELL_WIDTH, output = Buffer.alloc(width * rowCount * CELL_HEIGHT * 4);
  rows.forEach((row, ry) => row.forEach((frame, cx) => {
    for (let y = 0; y < CELL_HEIGHT; y++) frame.copy(output, ((ry * CELL_HEIGHT + y) * width + cx * CELL_WIDTH) * 4, y * CELL_WIDTH * 4, (y + 1) * CELL_WIDTH * 4);
  }));
  return output;
}

const p = (pose, extra = {}) => ({ pose, ...extra });
const gaze = Array.from({ length: 16 }, (_, i) => p(9, { look: [Math.round(Math.sin(i * Math.PI / 8) * 3), Math.round(-Math.cos(i * Math.PI / 8) * 3)] }));
export const MAIN_ROWS = [
  [p(9), p(9), p(9, { blink: "half" }), p(9, { blink: "full" }), p(9), p(9), p(9)],
  [4, 5, 6, 7, 4, 5, 6, 7].map((i) => p(i)),
  [0, 1, 2, 3, 0, 1, 2, 3].map((i) => p(i)),
  [p(9), p(8), p(8), p(9)],
  [0, -7, -14, -7, 0].map((dy) => p(9, { dy })),
  [p(9), p(12, { dy: -8 }), p(12), p(13, { dy: -12 }), p(13), p(12), p(15), p(9)],
  [p(9), p(9), p(9, { blink: "half" }), p(9), p(9), p(9, { blink: "full" })],
  [0, -2, 0, -2, 0, 0].map((dy) => p(9, { dy })),
  [-2, 0, 2, 2, 0, -2].map((dx) => p(9, { look: [dx, 0] })),
  gaze.slice(0, 8), gaze.slice(8),
];
