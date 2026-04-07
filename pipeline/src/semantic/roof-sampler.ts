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
 * Sample satellite imagery and create per-cell block overrides
 * for buildings, roads, and ground features.
 */
export function sampleSurfaceColors(
  satellite: SatelliteData,
  semanticMap: SemanticMap,
): SurfaceColorMap {
  const { width, height } = semanticMap;
  const overrides: (string | null)[] = new Array(width * height).fill(null);

  const scaleX = satellite.width / width;
  const scaleY = satellite.height / height;

  let buildingSamples = 0;
  let roadSamples = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cls = semanticMap.data[y * width + x];

      // Sample satellite pixel (average a small area for stability)
      const sx = Math.floor(x * scaleX);
      const sy = Math.floor(y * scaleY);

      // Average a 3x3 area in satellite space
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = Math.min(Math.max(0, sx + dx), satellite.width - 1);
          const py = Math.min(Math.max(0, sy + dy), satellite.height - 1);
          const si = (py * satellite.width + px) * 4;
          rSum += satellite.pixels[si];
          gSum += satellite.pixels[si + 1];
          bSum += satellite.pixels[si + 2];
          count++;
        }
      }

      const r = Math.floor(rSum / count);
      const g = Math.floor(gSum / count);
      const b = Math.floor(bSum / count);
      const idx = y * width + x;

      // Only sample satellite colors for buildings — their roofs have stable,
      // meaningful colors. Roads and ground should keep Minecraft defaults
      // because satellite can show seasonal variation (winter brown, shadows, etc.)
      if (cls === SemanticClass.BUILDING) {
        overrides[idx] = findNearestBlock(r, g, b, ROOF_PALETTE);
        buildingSamples++;
      }
    }
  }

  console.log(`  Sampled ${buildingSamples} building + ${roadSamples} road cells from satellite`);

  return { width, height, blockOverrides: overrides };
}
