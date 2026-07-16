export function analyzeComponents(alpha, {
  cellWidth,
  cellHeight,
  componentAlphaThreshold = 8,
}) {
  const labels = new Int32Array(alpha.length);
  const queue = new Int32Array(alpha.length);
  const components = [];
  let componentId = 0;

  for (let start = 0; start < alpha.length; start += 1) {
    if (alpha[start] <= componentAlphaThreshold || labels[start] !== 0) continue;
    componentId += 1;
    let head = 0;
    let tail = 0;
    let minX = cellWidth;
    let minY = cellHeight;
    let maxX = -1;
    let maxY = -1;
    let maxAlpha = 0;
    const pixels = [];
    queue[tail++] = start;
    labels[start] = componentId;
    while (head < tail) {
      const current = queue[head++];
      const x = current % cellWidth;
      const y = Math.floor(current / cellWidth);
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
          if (nextX < 0 || nextY < 0 || nextX >= cellWidth || nextY >= cellHeight) continue;
          const next = nextY * cellWidth + nextX;
          if (alpha[next] <= componentAlphaThreshold || labels[next] !== 0) continue;
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
    let distance = Math.max(cellWidth, cellHeight);
    for (const pixel of component.pixels) {
      const x = pixel % cellWidth;
      const y = Math.floor(pixel / cellWidth);
      const maxRadius = Math.min(distance - 1, Math.max(cellWidth, cellHeight));
      for (let radius = 1; radius <= maxRadius; radius += 1) {
        let found = false;
        for (let dy = -radius; dy <= radius && !found; dy += 1) {
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
            const nextX = x + dx;
            const nextY = y + dy;
            if (nextX < 0 || nextY < 0 || nextX >= cellWidth || nextY >= cellHeight) continue;
            if (mainMask[nextY * cellWidth + nextX]) {
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

export function readAtlasFrame(data, {
  atlasWidth,
  cellWidth,
  cellHeight,
  row,
  column,
  alphaThreshold = 8,
  componentAlphaThreshold = 8,
}) {
  const alpha = new Uint8Array(cellWidth * cellHeight);
  const premultipliedRgb = new Uint8Array(cellWidth * cellHeight * 3);
  let minX = cellWidth;
  let minY = cellHeight;
  let maxX = -1;
  let maxY = -1;
  let area = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < cellHeight; y += 1) {
    for (let x = 0; x < cellWidth; x += 1) {
      const atlasX = column * cellWidth + x;
      const atlasY = row * cellHeight + y;
      const sourceOffset = (atlasY * atlasWidth + atlasX) * 4 + 3;
      const value = data[sourceOffset];
      const index = y * cellWidth + x;
      alpha[index] = value;
      premultipliedRgb[index * 3] = Math.round((data[sourceOffset - 3] * value) / 255);
      premultipliedRgb[index * 3 + 1] = Math.round((data[sourceOffset - 2] * value) / 255);
      premultipliedRgb[index * 3 + 2] = Math.round((data[sourceOffset - 1] * value) / 255);
      if (value <= alphaThreshold) continue;
      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const componentAnalysis = analyzeComponents(alpha, {
    cellWidth,
    cellHeight,
    componentAlphaThreshold,
  });
  if (area === 0) {
    return {
      alpha,
      premultipliedRgb,
      area: 0,
      centerX: 0,
      centerY: 0,
      baseline: -1,
      componentAnalysis,
    };
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

export function compareFrames(first, second, { alphaThreshold = 8 } = {}) {
  let intersection = 0;
  let union = 0;
  let colorDifference = 0;
  let changedPixels = 0;
  for (let index = 0; index < first.alpha.length; index += 1) {
    const a = first.alpha[index] > alphaThreshold;
    const b = second.alpha[index] > alphaThreshold;
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
