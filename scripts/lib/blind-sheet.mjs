import sharp from "sharp";
import { BLIND_DIRECTION_PAIRS } from "./atlas-quality.mjs";

export const BLIND_SHEET_WIDTH = 384;
export const BLIND_SHEET_HEADER_HEIGHT = 28;
export const BLIND_SHEET_ROW_HEIGHT = 236;
export const BLIND_SHEET_HEIGHT = BLIND_SHEET_ROW_HEIGHT * BLIND_DIRECTION_PAIRS.length;

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_WIDTH = 1536;
const ATLAS_HEIGHT = 2288;

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function directionCell(direction) {
  const index = Math.round(Number.parseFloat(direction) / 22.5) % 16;
  return {
    left: (index % 8) * CELL_WIDTH,
    top: (9 + Math.floor(index / 8)) * CELL_HEIGHT,
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
  };
}

function headerSvg(pair, pairNumber) {
  const title = pair.axis === "horizontal" ? "Horizontal" : "Vertical";
  const left = escapeXml(`${title} pair ${pairNumber} A`);
  const right = escapeXml(`${title} pair ${pairNumber} B`);
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${BLIND_SHEET_WIDTH}" height="${BLIND_SHEET_HEADER_HEIGHT}">
      <rect width="100%" height="100%" fill="#f2f2f2"/>
      <text x="4" y="18" font-family="Arial, sans-serif" font-size="12" fill="#111">${left}</text>
      <text x="196" y="18" font-family="Arial, sans-serif" font-size="12" fill="#111">${right}</text>
    </svg>
  `);
}

export async function renderBlindDirectionSheet(atlasInput) {
  const atlas = sharp(atlasInput, { animated: false });
  const metadata = await atlas.metadata();
  if (metadata.width !== ATLAS_WIDTH || metadata.height !== ATLAS_HEIGHT) {
    throw new Error(
      `Blind-sheet source atlas must be ${ATLAS_WIDTH}x${ATLAS_HEIGHT}, got ${metadata.width}x${metadata.height}.`,
    );
  }

  const composites = [];
  for (let index = 0; index < BLIND_DIRECTION_PAIRS.length; index += 1) {
    const pair = BLIND_DIRECTION_PAIRS[index];
    const rowTop = index * BLIND_SHEET_ROW_HEIGHT;
    composites.push({ input: headerSvg(pair, (index % 7) + 1), left: 0, top: rowTop });
    for (const [side, left] of [["A", 0], ["B", CELL_WIDTH]]) {
      const frame = await atlas
        .clone()
        .extract(directionCell(pair[side].sourceDirection))
        .flatten({ background: "#ffffff" })
        .png({ palette: false, compressionLevel: 9 })
        .toBuffer();
      composites.push({ input: frame, left, top: rowTop + BLIND_SHEET_HEADER_HEIGHT });
    }
  }

  return sharp({
    create: {
      width: BLIND_SHEET_WIDTH,
      height: BLIND_SHEET_HEIGHT,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(composites)
    .png({ palette: false, compressionLevel: 9 })
    .toBuffer();
}
