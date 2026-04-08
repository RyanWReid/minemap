import type { SatelliteData } from '../ingest/satellite.js';
import type { SemanticMap } from '../types.js';
import { SemanticClass } from '../types.js';
import { rgbToOklab, oklabDistSq } from '../util/color.js';

/**
 * Sample real roof/surface colors from satellite imagery for building blocks.
 *
 * For each building cell in the semantic map, sample the corresponding satellite pixel
 * and find the nearest Minecraft block color. This gives buildings their real-world
 * appearance — brown roofs stay brown, white buildings stay white, etc.
 */

// Minecraft block colors we match against for roofs/surfaces
const ROOF_PALETTE: Array<{
  blockId: string;
  color: [number, number, number];
  oklab: [number, number, number];
}> = [
  { blockId: 'minecraft:stone_bricks',      color: [112, 112, 112] },
  { blockId: 'minecraft:bricks',            color: [153, 51, 51] },
  { blockId: 'minecraft:quartz_block',      color: [255, 252, 245] },
  { blockId: 'minecraft:white_concrete',    color: [230, 230, 230] },
  { blockId: 'minecraft:light_gray_concrete', color: [153, 153, 153] },
  { blockId: 'minecraft:gray_concrete',     color: [76, 76, 76] },
  { blockId: 'minecraft:terracotta',        color: [152, 94, 67] },
  { blockId: 'minecraft:white_terracotta',  color: [209, 178, 161] },
  { blockId: 'minecraft:orange_terracotta', color: [162, 84, 38] },
  { blockId: 'minecraft:red_terracotta',    color: [143, 61, 47] },
  { blockId: 'minecraft:brown_terracotta',  color: [77, 51, 36] },
  { blockId: 'minecraft:cyan_terracotta',   color: [86, 91, 91] },
  { blockId: 'minecraft:sandstone',         color: [213, 201, 140] },
  { blockId: 'minecraft:smooth_sandstone',  color: [213, 201, 140] },
  { blockId: 'minecraft:oak_planks',        color: [143, 119, 72] },
  { blockId: 'minecraft:spruce_planks',     color: [115, 85, 48] },
  { blockId: 'minecraft:dark_oak_planks',   color: [60, 46, 26] },
  { blockId: 'minecraft:cobblestone',       color: [112, 112, 112] },
  { blockId: 'minecraft:smooth_stone',      color: [160, 160, 160] },
  { blockId: 'minecraft:black_concrete',    color: [25, 25, 25] },
  { blockId: 'minecraft:polished_andesite', color: [130, 130, 130] },
].map(b => ({
  ...b,
  oklab: rgbToOklab(b.color[0], b.color[1], b.color[2]),
}));

// Also do roads — match real road color
const ROAD_PALETTE: Array<{
  blockId: string;
  color: [number, number, number];
  oklab: [number, number, number];
}> = [
  { blockId: 'minecraft:gray_concrete',     color: [76, 76, 76] },
  { blockId: 'minecraft:light_gray_concrete', color: [153, 153, 153] },
  { blockId: 'minecraft:black_concrete',    color: [25, 25, 25] },
  { blockId: 'minecraft:smooth_stone',      color: [160, 160, 160] },
  { blockId: 'minecraft:cobblestone',       color: [112, 112, 112] },
  { blockId: 'minecraft:gravel',            color: [112, 112, 112] },
].map(b => ({
  ...b,
  oklab: rgbToOklab(b.color[0], b.color[1], b.color[2]),
}));

// Ground cover matching
const GROUND_PALETTE: Array<{
  blockId: string;
  color: [number, number, number];
  oklab: [number, number, number];
}> = [
  { blockId: 'minecraft:grass_block',  color: [127, 178, 56] },
  { blockId: 'minecraft:dirt',         color: [151, 109, 77] },
  { blockId: 'minecraft:coarse_dirt',  color: [151, 109, 77] },
  { blockId: 'minecraft:podzol',       color: [112, 70, 35] },
  { blockId: 'minecraft:sand',         color: [247, 233, 163] },
  { blockId: 'minecraft:gravel',       color: [112, 112, 112] },
  { blockId: 'minecraft:moss_block',   color: [80, 120, 50] },
  { blockId: 'minecraft:mud',          color: [100, 90, 75] },
].map(b => ({
  ...b,
  oklab: rgbToOklab(b.color[0], b.color[1], b.color[2]),
}));

function findNearestBlock(
  r: number, g: number, b: number,
  palette: typeof ROOF_PALETTE,
): string {
  const target = rgbToOklab(r, g, b);
  let bestDist = Infinity;
  let bestBlock = palette[0].blockId;

  for (const entry of palette) {
    const dist = oklabDistSq(target, entry.oklab);
    if (dist < bestDist) {
      bestDist = dist;
      bestBlock = entry.blockId;
    }
  }

  return bestBlock;
}

export interface SurfaceColorMap {
  width: number;
  height: number;
  /** Per-cell override block ID (null = use default from column rules) */
  blockOverrides: (string | null)[];
}

/**
 * Find connected building components via flood-fill, then assign
 * ONE average satellite color per building for a clean block look.
 */
export function sampleSurfaceColors(
  satellite: SatelliteData,
  semanticMap: SemanticMap,
): SurfaceColorMap {
  const { width, height } = semanticMap;
  const overrides: (string | null)[] = new Array(width * height).fill(null);

  const scaleX = satellite.width / width;
  const scaleY = satellite.height / height;

  // Step 1: Label connected building components
  const labels = new Int32Array(width * height); // 0 = unlabeled
  let nextLabel = 1;
  const buildingCells: Map<number, number[]> = new Map(); // label -> [idx, idx, ...]

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (semanticMap.data[idx] !== SemanticClass.BUILDING || labels[idx] !== 0) continue;

      // Flood-fill this building
      const label = nextLabel++;
      const cells: number[] = [];
      const stack = [idx];
      labels[idx] = label;

      while (stack.length > 0) {
        const ci = stack.pop()!;
        cells.push(ci);
        const cx = ci % width;
        const cy = (ci - cx) / width;

        // 4-connected neighbors
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const ni = ny * width + nx;
          if (labels[ni] !== 0 || semanticMap.data[ni] !== SemanticClass.BUILDING) continue;
          labels[ni] = label;
          stack.push(ni);
        }
      }

      buildingCells.set(label, cells);
    }
  }

  // Step 2: For each building, compute average satellite color and assign ONE block
  // Skip huge components (>3000 cells) — they're usually compound boundaries, not real roofs
  const MAX_BUILDING_CELLS = 3000;
  let buildingCount = 0;
  for (const [, cells] of buildingCells) {
    if (cells.length > MAX_BUILDING_CELLS) continue; // too big, use biome default
    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    for (const idx of cells) {
      const x = idx % width;
      const y = (idx - x) / width;
      const sx = Math.floor(x * scaleX);
      const sy = Math.floor(y * scaleY);
      const si = (Math.min(sy, satellite.height - 1) * satellite.width + Math.min(sx, satellite.width - 1)) * 4;
      rSum += satellite.pixels[si];
      gSum += satellite.pixels[si + 1];
      bSum += satellite.pixels[si + 2];
      count++;
    }

    const block = findNearestBlock(
      Math.floor(rSum / count),
      Math.floor(gSum / count),
      Math.floor(bSum / count),
      ROOF_PALETTE,
    );

    // Apply single color to every cell of this building
    for (const idx of cells) {
      overrides[idx] = block;
    }
    buildingCount++;
  }

  console.log(`  Roof sampler: ${buildingCount} buildings, ${nextLabel - 1} components`);

  return { width, height, blockOverrides: overrides };
}
