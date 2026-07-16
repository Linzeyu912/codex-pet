import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { compareFrames, readAtlasFrame } from "./frame-analysis.mjs";

export const POSE_ATLAS_COLUMNS = 4;
export const POSE_ATLAS_ROWS = 4;
export const POSE_ATLAS_FRAME_COUNT = POSE_ATLAS_COLUMNS * POSE_ATLAS_ROWS;
export const POSE_ATLAS_WIDTH = 768;
export const POSE_ATLAS_HEIGHT = 832;
export const POSE_ATLAS_CELL_MARGIN = 4;

export const POSE_ACTION_INDICES = Object.freeze({
  mischief: [9, 8, 9, 10, 11, 10, 9],
  lying: [10, 11, 13, 12, 13, 13, 13, 12, 13, 11, 15],
  rolling: [10, 11, 13, 12, 13, 14, 13, 12, 13, 11, 15],
});

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;

export async function inspectDesktopPoseAtlas(filePath) {
  const resolvedPath = path.resolve(filePath);
  const bytes = await fs.readFile(resolvedPath);
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const errors = [];
  if (info.width !== POSE_ATLAS_WIDTH || info.height !== POSE_ATLAS_HEIGHT) {
    errors.push(
      `desktop pose atlas must be ${POSE_ATLAS_WIDTH}x${POSE_ATLAS_HEIGHT} (4x4 cells), got ${info.width}x${info.height}`,
    );
  }

  const frames = [];
  if (errors.length === 0) {
    for (let index = 0; index < POSE_ATLAS_FRAME_COUNT; index += 1) {
      const frame = readAtlasFrame(data, {
        atlasWidth: POSE_ATLAS_WIDTH,
        cellWidth: CELL_WIDTH,
        cellHeight: CELL_HEIGHT,
        row: Math.floor(index / POSE_ATLAS_COLUMNS),
        column: index % POSE_ATLAS_COLUMNS,
      });
      frames.push(frame);
      if (frame.area === 0) {
        errors.push(`desktop pose atlas frame ${index} is empty`);
      } else if (
        frame.left < POSE_ATLAS_CELL_MARGIN ||
        frame.top < POSE_ATLAS_CELL_MARGIN ||
        frame.right > CELL_WIDTH - 1 - POSE_ATLAS_CELL_MARGIN ||
        frame.baseline > CELL_HEIGHT - 1 - POSE_ATLAS_CELL_MARGIN
      ) {
        errors.push(
          `desktop pose atlas frame ${index} must keep at least ${POSE_ATLAS_CELL_MARGIN}px transparent margin on every edge; bbox=[${frame.left},${frame.top},${frame.right},${frame.baseline}]`,
        );
      }
    }
  }

  return {
    file: resolvedPath,
    sha256: createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    width: info.width,
    height: info.height,
    columns: POSE_ATLAS_COLUMNS,
    rows: POSE_ATLAS_ROWS,
    frameCount: frames.length,
    frames,
    errors,
  };
}

export function desktopPoseActionPlaybacks(idleFrame, poseFrames) {
  return Object.entries(POSE_ACTION_INDICES).map(([name, indices]) => ({
    name,
    playback: [idleFrame, ...indices.map((index) => poseFrames[index]), idleFrame],
  }));
}

export function auditDesktopActionPlaybacks(actionPlaybacks, {
  maxCenter = 23,
  minIou = 0.45,
  maxBaseline = 12,
  maxAreaRatio = 1.3,
} = {}) {
  const summaries = [];
  const errors = [];
  for (const action of actionPlaybacks) {
    const transitions = action.playback
      .slice(0, -1)
      .map((frame, index) => compareFrames(frame, action.playback[index + 1]));
    const summary = {
      action: action.name,
      maxCenter: Math.max(...transitions.map((transition) => transition.center)),
      minIou: Math.min(...transitions.map((transition) => transition.iou)),
      maxBaseline: Math.max(...transitions.map((transition) => transition.baseline)),
      maxAreaRatio: Math.max(...transitions.map((transition) => transition.areaRatio)),
    };
    summaries.push(summary);
    if (
      summary.maxCenter > maxCenter ||
      summary.minIou < minIou ||
      summary.maxBaseline > maxBaseline ||
      summary.maxAreaRatio > maxAreaRatio
    ) {
      errors.push(
        `desktop ${action.name}: transition center ${summary.maxCenter.toFixed(1)}px, IoU ${(summary.minIou * 100).toFixed(1)}%, baseline ${summary.maxBaseline}px, area ratio ${summary.maxAreaRatio.toFixed(3)}`,
      );
    }
  }
  return { summaries, errors };
}
