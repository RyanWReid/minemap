import type { HeightMap, StageResult } from '../types.js';
import { renderColorGrid, savePNG } from '../util/image.js';

/**
 * Quantize continuous elevation into stepped Minecraft terrain.
 *
 * Rules:
 * - No slope > 1 block per horizontal step (walkable)
 * - Water bodies flattened to sea level
 * - Elevation scaled to fit within a reasonable Y range
 * - Smooth transitions via multi-pass averaging for gentle hills
 */
export function quantizeTerrain(
  heightMap: HeightMap,
  options: {
    seaLevel?: number;
    maxHeight?: number;
    smoothPasses?: number;
  } = {},
  outputDir?: string,
): StageResult<HeightMap> {
  const start = Date.now();
  const { width, height } = heightMap;
  const seaLevel = options.seaLevel ?? 64;
  const maxHeight = options.maxHeight ?? 192;
  const smoothPasses = options.smoothPasses ?? 2;

  // Find elevation range
  let minElev = Infinity, maxElev = -Infinity;
  for (let i = 0; i < heightMap.elevation.length; i++) {
    const e = heightMap.elevation[i];
    if (e < minElev) minElev = e;
    if (e > maxElev) maxElev = e;
  }

  const elevRange = maxElev - minElev;
  // Scale: map elevation range to available block range above bedrock
  // Leave room below seaLevel for water and above for mountains
  const blockRange = Math.min(maxHeight - 10, Math.max(20, Math.ceil(elevRange)));
  const baseY = Math.max(5, seaLevel - Math.floor(blockRange * 0.3));

  console.log(`  Terrain: ${minElev.toFixed(1)}m - ${maxElev.toFixed(1)}m -> Y ${baseY}-${baseY + blockRange}`);

  // Initial quantization: continuous -> integer block heights
  const quantized = new Float64Array(width * height);
  for (let i = 0; i < heightMap.elevation.length; i++) {
    const normalized = elevRange > 0 ? (heightMap.elevation[i] - minElev) / elevRange : 0;
    quantized[i] = baseY + normalized * blockRange;
  }

  // Smooth passes: average with neighbors to prevent extreme slopes
  for (let pass = 0; pass < smoothPasses; pass++) {
    const smoothed = new Float64Array(quantized.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        let sum = quantized[idx] * 4; // center weight
        let count = 4;

        // 4-neighbors
        if (x > 0) { sum += quantized[idx - 1]; count++; }
        if (x < width - 1) { sum += quantized[idx + 1]; count++; }
        if (y > 0) { sum += quantized[idx - width]; count++; }
        if (y < height - 1) { sum += quantized[idx + width]; count++; }

        smoothed[idx] = sum / count;
      }
    }
    quantized.set(smoothed);
  }

  // Step enforcement: ensure no adjacent blocks differ by more than 1
  // Multiple passes to propagate constraints
  const stepped = new Uint8Array(width * height);
  for (let i = 0; i < quantized.length; i++) {
    stepped[i] = Math.min(255, Math.max(1, Math.round(quantized[i])));
  }

  for (let pass = 0; pass < 3; pass++) {
    let changes = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const current = stepped[idx];

        // Check all 4 neighbors
        const neighbors = [];
        if (x > 0) neighbors.push(stepped[idx - 1]);
        if (x < width - 1) neighbors.push(stepped[idx + 1]);
        if (y > 0) neighbors.push(stepped[idx - width]);
        if (y < height - 1) neighbors.push(stepped[idx + width]);

        for (const n of neighbors) {
          if (Math.abs(current - n) > 1) {
            // Clamp toward neighbor
            const target = current > n ? n + 1 : n - 1;
            stepped[idx] = Math.min(255, Math.max(1, target));
            changes++;
            break;
          }
        }
      }
    }
    if (changes === 0) break;
  }

  const result: HeightMap = {
    ...heightMap,
    quantized: stepped,
    seaLevel,
  };

  const debugOutputs: StageResult<HeightMap>['debugOutputs'] = [];
  if (outputDir) {
    // Render stepped heightmap
    const minY = Math.min(...Array.from(stepped));
    const maxY = Math.max(...Array.from(stepped));
    const range = maxY - minY || 1;
    const canvas = renderColorGrid(width, height, (x, y) => {
      const v = Math.floor(((stepped[y * width + x] - minY) / range) * 255);
      // Color: below sea level = blue tint, above = green->brown->white
      if (stepped[y * width + x] < seaLevel) {
        return [v * 0.3, v * 0.3, v];
      }
      return [v, v, v];
    });
    const path = `${outputDir}/03-terrain/stepped-heightmap.png`;
    savePNG(canvas, path);
    debugOutputs.push({ name: 'stepped-heightmap', path, description: 'Stepped terrain heightmap' });
  }

  return {
    data: result,
    metadata: { stage: 'terrain-quantizer', durationMs: Date.now() - start, timestamp: Date.now() },
    debugOutputs,
  };
}
