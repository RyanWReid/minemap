import type { BlockType, VoxelChunk, VoxelWorld } from '../types.js';
import { CHUNK_SIZE_XZ, CHUNK_HEIGHT } from '../types.js';
import { BLOCKS } from '../palette/block-types.js';

/** Create an empty chunk filled with air */
export function createChunk(cx: number, cz: number): VoxelChunk {
  const size = CHUNK_SIZE_XZ * CHUNK_SIZE_XZ * CHUNK_HEIGHT;
  return {
    cx,
    cz,
    blocks: new Uint16Array(size), // 0 = first palette entry (air)
    palette: [BLOCKS.air],
    maxY: 0,
  };
}

/** Get block index within a chunk for local coords (x, y, z) */
export function blockIndex(x: number, y: number, z: number): number {
  return x + z * CHUNK_SIZE_XZ + y * CHUNK_SIZE_XZ * CHUNK_SIZE_XZ;
}

const _warnedBlocks = new Set<string>();

/** Get or create a palette entry for a block ID, returns palette index */
function getPaletteIndex(chunk: VoxelChunk, blockId: string): number {
  for (let i = 0; i < chunk.palette.length; i++) {
    if (chunk.palette[i].id === blockId) return i;
  }
  // Add to palette
  const blockDef = Object.values(BLOCKS).find((b) => b.id === blockId);
  if (!blockDef) {
    // Missing block — warn so we can add it to BLOCKS
    if (!_warnedBlocks.has(blockId)) {
      console.warn(`  WARNING: Block "${blockId}" not in BLOCKS table, using gray fallback`);
      _warnedBlocks.add(blockId);
    }
    chunk.palette.push({
      id: blockId,
      name: blockId,
      mapColor: [200, 0, 200], // magenta = obvious missing block
      category: 'terrain',
    });
  } else {
    chunk.palette.push(blockDef);
  }
  return chunk.palette.length - 1;
}

/** Set a block in a chunk using local coordinates */
export function setBlock(
  chunk: VoxelChunk,
  localX: number,
  localY: number,
  localZ: number,
  blockId: string,
): void {
  if (
    localX < 0 || localX >= CHUNK_SIZE_XZ ||
    localZ < 0 || localZ >= CHUNK_SIZE_XZ ||
    localY < 0 || localY >= CHUNK_HEIGHT
  ) return;

  const idx = blockIndex(localX, localY, localZ);
  const paletteIdx = getPaletteIndex(chunk, blockId);
  chunk.blocks[idx] = paletteIdx;

  if (localY > chunk.maxY) chunk.maxY = localY;
}

/** Get the block ID at local coordinates */
export function getBlock(chunk: VoxelChunk, localX: number, localY: number, localZ: number): string {
  if (
    localX < 0 || localX >= CHUNK_SIZE_XZ ||
    localZ < 0 || localZ >= CHUNK_SIZE_XZ ||
    localY < 0 || localY >= CHUNK_HEIGHT
  ) return 'minecraft:air';

  const idx = blockIndex(localX, localY, localZ);
  const paletteIdx = chunk.blocks[idx];
  return chunk.palette[paletteIdx]?.id ?? 'minecraft:air';
}

/** Get the map color of the highest non-air block in a column */
export function getTopBlockColor(
  chunk: VoxelChunk,
  localX: number,
  localZ: number,
): [number, number, number] {
  for (let y = chunk.maxY; y >= 0; y--) {
    const idx = blockIndex(localX, y, localZ);
    const paletteIdx = chunk.blocks[idx];
    const block = chunk.palette[paletteIdx];
    if (block && block.id !== 'minecraft:air') {
      return block.mapColor;
    }
  }
  return [0, 0, 0];
}

// ============================================
// VoxelWorld helpers
// ============================================

/** Create an empty world */
export function createWorld(blockWidth: number, blockDepth: number, seaLevel: number = 64): VoxelWorld {
  return {
    chunks: new Map(),
    bounds: { north: 0, south: 0, east: 0, west: 0 },
    blockWidth,
    blockDepth,
    seaLevel,
    globalPalette: Object.values(BLOCKS),
  };
}

/** Get or create a chunk for world-space block coordinates */
export function getChunkForBlock(world: VoxelWorld, worldX: number, worldZ: number): VoxelChunk {
  const cx = Math.floor(worldX / CHUNK_SIZE_XZ);
  const cz = Math.floor(worldZ / CHUNK_SIZE_XZ);
  const key = `${cx},${cz}`;

  let chunk = world.chunks.get(key);
  if (!chunk) {
    chunk = createChunk(cx, cz);
    world.chunks.set(key, chunk);
  }
  return chunk;
}

/** Set a block at world coordinates */
export function setWorldBlock(world: VoxelWorld, worldX: number, worldY: number, worldZ: number, blockId: string): void {
  const chunk = getChunkForBlock(world, worldX, worldZ);
  const localX = ((worldX % CHUNK_SIZE_XZ) + CHUNK_SIZE_XZ) % CHUNK_SIZE_XZ;
  const localZ = ((worldZ % CHUNK_SIZE_XZ) + CHUNK_SIZE_XZ) % CHUNK_SIZE_XZ;
  setBlock(chunk, localX, worldY, localZ, blockId);
}
