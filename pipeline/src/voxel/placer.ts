import type { SemanticMap, HeightMap, VoxelWorld, StageResult } from '../types.js';
import { SemanticClass, CHUNK_SIZE_XZ } from '../types.js';
import { COLUMN_RULES } from '../palette/block-types.js';
import { createWorld, setWorldBlock, getChunkForBlock } from './chunk.js';
import { getClass } from '../semantic/class-map.js';
import { selectBiome, BIOME_PALETTES, pickBuildingStyle, pickWallBlock, type BiomeType } from '../palette/biome-rules.js';
import type { SurfaceColorMap } from '../semantic/roof-sampler.js';

/**
 * Place blocks into a VoxelWorld based on a SemanticMap + HeightMap.
 * Optionally uses satellite-sampled surface colors for realistic block matching.
 */
export function placeBlocks(
  semanticMap: SemanticMap,
  heightMap: HeightMap,
  outputDir?: string,
  surfaceColors?: SurfaceColorMap,
): StageResult<VoxelWorld> {
  const start = Date.now();

  // Determine biome from the center of the map
  const midLat = (semanticMap.bounds.north + semanticMap.bounds.south) / 2;
  const midElev = heightMap.elevation[Math.floor(heightMap.elevation.length / 2)] || 0;
  const biome = selectBiome(midLat, midElev);
  const biomePalette = BIOME_PALETTES[biome];
  console.log(`  Biome: ${biome} (lat=${midLat.toFixed(2)}, elev=${midElev.toFixed(0)}m)`);

  // Determine world size in blocks
  const width = Math.min(semanticMap.width, heightMap.width);
  const depth = Math.min(semanticMap.height, heightMap.height);

  // Scale factors if maps are different resolutions
  const hScaleX = heightMap.width / width;
  const hScaleY = heightMap.height / depth;

  const seaLevel = heightMap.seaLevel;
  const world = createWorld(width, depth, seaLevel);
  world.bounds = semanticMap.bounds;

  console.log(`  Placing blocks for ${width}x${depth} world (${Math.ceil(width / 16)}x${Math.ceil(depth / 16)} chunks)...`);

  const treePositions: Array<{ x: number; z: number; height: number }> = [];

  for (let z = 0; z < depth; z++) {
    for (let x = 0; x < width; x++) {
      const cls = getClass(semanticMap, x, z);
      const rule = COLUMN_RULES[cls] ?? COLUMN_RULES[SemanticClass.UNKNOWN];

      // Get height
      const hx = Math.floor(x * hScaleX);
      const hz = Math.floor(z * hScaleY);
      const surfaceY = heightMap.quantized[hz * heightMap.width + hx] || seaLevel;

      // Only place the top few layers — underground is never visible in top-down view.
      // For .schem export, underground would need a full fill pass separately.
      // Place just surface - 1 (subsurface peek) for shading depth
      if (surfaceY > 1) {
        setWorldBlock(world, x, surfaceY - 1, z, rule.subsurface);
      }

      // Place surface block with texture variation for natural areas
      if (surfaceY > 0) {
        const colorIdx = z * width + x;
        const surfaceOverride = surfaceColors?.blockOverrides[colorIdx];
        if (surfaceOverride && !rule.extrude && !rule.fillToSeaLevel) {
          setWorldBlock(world, x, surfaceY, z, surfaceOverride);
        } else {
          let surfaceBlock = rule.surface;

          // Subtle forest undergrowth only (not on open grass/parks)
          if (cls === SemanticClass.FOREST) {
            const texHash = ((x * 48271) ^ (z * 93461)) & 0xFFFF;
            if (texHash < 300) surfaceBlock = 'minecraft:podzol';
            else if (texHash < 500) surfaceBlock = 'minecraft:moss_block';
          }

          setWorldBlock(world, x, surfaceY, z, surfaceBlock);
        }
      }

      // Water: fill from surface to sea level
      if (rule.fillToSeaLevel && surfaceY < seaLevel) {
        for (let y = surfaceY + 1; y <= seaLevel; y++) {
          setWorldBlock(world, x, y, z, 'minecraft:water');
        }
      }

      // Buildings: extrude upward using satellite-sampled roof colors
      if (rule.extrude) {
        const bx = Math.floor(x / 4) * 4;
        const bz = Math.floor(z / 4) * 4;
        const buildingHash = ((bx * 73856093) ^ (bz * 19349663)) & 0xFFFF;
        const style = pickBuildingStyle(biome, buildingHash);
        const buildingHeight = style.minHeight + (buildingHash % (style.maxHeight - style.minHeight + 1));

        // Use satellite color for walls if available
        const colorIdx = z * width + x;
        const satBlock = surfaceColors?.blockOverrides[colorIdx];
        const wallBlock = satBlock || pickWallBlock(style, buildingHash);

        const isEdge = (
          x === 0 || z === 0 || x === width - 1 || z === depth - 1 ||
          getClass(semanticMap, x - 1, z) !== SemanticClass.BUILDING ||
          getClass(semanticMap, x + 1, z) !== SemanticClass.BUILDING ||
          getClass(semanticMap, x, z - 1) !== SemanticClass.BUILDING ||
          getClass(semanticMap, x, z + 1) !== SemanticClass.BUILDING
        );

        for (let y = surfaceY + 1; y <= surfaceY + buildingHeight; y++) {
          if (isEdge) {
            setWorldBlock(world, x, y, z, wallBlock);
          } else {
            setWorldBlock(world, x, y, z, style.floor);
          }
        }

        // Roof — satellite color or biome default
        setWorldBlock(world, x, surfaceY + buildingHeight + 1, z, satBlock || style.roof);
      }

      // Collect tree positions for later
      if (rule.trees === true || rule.trees === 'sparse') {
        const hash = ((x * 73856093) ^ (z * 19349663)) & 0xFFFF;
        const threshold = rule.trees === 'sparse' ? 500 : 2000;
        if (hash < threshold) {
          treePositions.push({ x, z, height: surfaceY });
        }
      }
    }
  }

  // Place trees (simple Minecraft oak tree: 1 log + leaf canopy)
  console.log(`  Placing ${treePositions.length} trees...`);
  for (const { x, z, height: surfaceY } of treePositions) {
    // Check we're not too close to edge
    if (x < 3 || z < 3 || x >= width - 3 || z >= depth - 3) continue;

    const logBlock = biomePalette.vegetation.treeLog;
    const leafBlock = biomePalette.vegetation.treeLeaves;
    const trunkHeight = 4 + (((x * 13 + z * 7) & 0xFF) % 3);

    for (let y = surfaceY + 1; y <= surfaceY + trunkHeight; y++) {
      setWorldBlock(world, x, y, z, logBlock);
    }

    const canopyBase = surfaceY + trunkHeight - 1;

    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
        setWorldBlock(world, x + dx, canopyBase, z + dz, leafBlock);
        setWorldBlock(world, x + dx, canopyBase + 1, z + dz, leafBlock);
      }
    }

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        setWorldBlock(world, x + dx, canopyBase + 2, z + dz, leafBlock);
      }
    }

    setWorldBlock(world, x, canopyBase + 3, z, leafBlock);
    setWorldBlock(world, x + 1, canopyBase + 3, z, leafBlock);
    setWorldBlock(world, x - 1, canopyBase + 3, z, leafBlock);
    setWorldBlock(world, x, canopyBase + 3, z + 1, leafBlock);
    setWorldBlock(world, x, canopyBase + 3, z - 1, leafBlock);
  }

  // ============================================
  // Visual enrichment passes
  // ============================================

  // 2. Sidewalks — thin light-gray border along roads adjacent to non-road
  let sidewalkCount = 0;
  for (let z = 1; z < depth - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      const cls = getClass(semanticMap, x, z);
      if (cls === SemanticClass.ROAD || cls === SemanticClass.WATER || cls === SemanticClass.BUILDING) continue;

      // Check if adjacent to road
      const adjRoad = (
        getClass(semanticMap, x - 1, z) === SemanticClass.ROAD ||
        getClass(semanticMap, x + 1, z) === SemanticClass.ROAD ||
        getClass(semanticMap, x, z - 1) === SemanticClass.ROAD ||
        getClass(semanticMap, x, z + 1) === SemanticClass.ROAD
      );
      if (!adjRoad) continue;

      const hx = Math.floor(x * hScaleX);
      const hz = Math.floor(z * hScaleY);
      const surfaceY = heightMap.quantized[hz * heightMap.width + hx] || seaLevel;
      setWorldBlock(world, x, surfaceY, z, 'minecraft:smooth_stone');
      sidewalkCount++;
    }
  }
  console.log(`  Sidewalks: ${sidewalkCount}`);

  // 4. Water detail — darker shoreline border, lily pads on small ponds
  let waterDetailCount = 0;
  for (let z = 1; z < depth - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      if (getClass(semanticMap, x, z) !== SemanticClass.WATER) continue;

      const hx = Math.floor(x * hScaleX);
      const hz = Math.floor(z * hScaleY);
      const surfaceY = heightMap.quantized[hz * heightMap.width + hx] || seaLevel;
      const waterY = Math.max(surfaceY, seaLevel);

      // Shoreline detection — water cell adjacent to land
      const adjLand = (
        getClass(semanticMap, x - 1, z) !== SemanticClass.WATER ||
        getClass(semanticMap, x + 1, z) !== SemanticClass.WATER ||
        getClass(semanticMap, x, z - 1) !== SemanticClass.WATER ||
        getClass(semanticMap, x, z + 1) !== SemanticClass.WATER
      );

      if (adjLand) {
        // Darker water at shore
        setWorldBlock(world, x, waterY, z, 'minecraft:blue_ice' as any);
        waterDetailCount++;
      }

      // Lily pads on calm water (not shoreline, random scatter)
      if (!adjLand) {
        const hash = ((x * 48271) ^ (z * 93461)) & 0xFFFF;
        if (hash < 200) {
          setWorldBlock(world, x, waterY + 1, z, 'minecraft:lily_pad');
          waterDetailCount++;
        }
      }
    }
  }
  console.log(`  Water details: ${waterDetailCount}`);

  // 5. Beach/shore gradient — disabled (was adding unwanted sand around rivers/lakes)

  console.log(`  World has ${world.chunks.size} chunks`);

  return {
    data: world,
    metadata: { stage: 'placer', durationMs: Date.now() - start, timestamp: Date.now() },
    debugOutputs: [],
  };
}
