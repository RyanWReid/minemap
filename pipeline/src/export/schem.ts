import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { gzipSync } from 'zlib';
import type { VoxelWorld, VoxelChunk, StageResult } from '../types.js';
import { CHUNK_SIZE_XZ, CHUNK_HEIGHT } from '../types.js';

/**
 * Export a VoxelWorld to Sponge Schematic v2 (.schem) format.
 *
 * Format spec: https://github.com/SpongePowered/Schematic-Specification
 *
 * The .schem format is:
 * - GZipped NBT compound
 * - Contains: Width, Height, Length, Palette (string->varint), BlockData (varint array)
 * - Block index: (y * length + z) * width + x
 */
export function exportSchem(
  world: VoxelWorld,
  outputPath: string,
): StageResult<string> {
  const start = Date.now();

  // Calculate world dimensions
  let minCX = Infinity, maxCX = -Infinity;
  let minCZ = Infinity, maxCZ = -Infinity;
  let maxY = 0;

  for (const [key, chunk] of world.chunks) {
    const [cx, cz] = key.split(',').map(Number);
    if (cx < minCX) minCX = cx;
    if (cx > maxCX) maxCX = cx;
    if (cz < minCZ) minCZ = cz;
    if (cz > maxCZ) maxCZ = cz;
    if (chunk.maxY > maxY) maxY = chunk.maxY;
  }

  const width = (maxCX - minCX + 1) * CHUNK_SIZE_XZ;
  const length = (maxCZ - minCZ + 1) * CHUNK_SIZE_XZ;
  const height = Math.min(maxY + 2, CHUNK_HEIGHT); // +2 for headroom

  console.log(`  Exporting .schem: ${width}x${height}x${length} (${width * height * length} blocks)`);

  // Build global palette: block ID string -> palette index
  const paletteMap = new Map<string, number>();
  paletteMap.set('minecraft:air', 0);
  let nextPaletteIdx = 1;

  // Collect all block data
  // Schem index: (y * length + z) * width + x
  const blockData: number[] = new Array(width * height * length).fill(0); // 0 = air

  for (const [key, chunk] of world.chunks) {
    const [cx, cz] = key.split(',').map(Number);
    const baseX = (cx - minCX) * CHUNK_SIZE_XZ;
    const baseZ = (cz - minCZ) * CHUNK_SIZE_XZ;

    for (let ly = 0; ly < Math.min(chunk.maxY + 1, height); ly++) {
      for (let lz = 0; lz < CHUNK_SIZE_XZ; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE_XZ; lx++) {
          const chunkIdx = lx + lz * CHUNK_SIZE_XZ + ly * CHUNK_SIZE_XZ * CHUNK_SIZE_XZ;
          const palIdx = chunk.blocks[chunkIdx];
          const block = chunk.palette[palIdx];
          if (!block || block.id === 'minecraft:air') continue;

          const blockId = block.id;

          // Get or create global palette entry
          if (!paletteMap.has(blockId)) {
            paletteMap.set(blockId, nextPaletteIdx++);
          }

          const wx = baseX + lx;
          const wz = baseZ + lz;
          const schemIdx = (ly * length + wz) * width + wx;
          blockData[schemIdx] = paletteMap.get(blockId)!;
        }
      }
    }
  }

  // Encode block data as varints
  const varintData = encodeVarints(blockData);

  // Build NBT structure
  const nbtData = buildSchemNBT(width, height, length, paletteMap, varintData);

  // GZip and write
  mkdirSync(dirname(outputPath), { recursive: true });
  const compressed = gzipSync(nbtData);
  writeFileSync(outputPath, compressed);

  const sizeMB = (compressed.length / 1024 / 1024).toFixed(2);
  console.log(`  Saved: ${outputPath} (${sizeMB} MB, palette: ${paletteMap.size} blocks)`);

  return {
    data: outputPath,
    metadata: { stage: 'export-schem', durationMs: Date.now() - start, timestamp: Date.now() },
    debugOutputs: [{ name: 'schem', path: outputPath, description: `Sponge Schematic (${width}x${height}x${length})` }],
  };
}

/** Encode an array of integers as varints */
function encodeVarints(data: number[]): Buffer {
  const bytes: number[] = [];
  for (const value of data) {
    let v = value;
    while (v & ~0x7F) {
      bytes.push((v & 0x7F) | 0x80);
      v >>>= 7;
    }
    bytes.push(v & 0x7F);
  }
  return Buffer.from(bytes);
}

/**
 * Build raw NBT binary for Sponge Schematic v2.
 * Hand-rolled to avoid prismarine-nbt quirks with large data.
 */
function buildSchemNBT(
  width: number,
  height: number,
  length: number,
  palette: Map<string, number>,
  blockData: Buffer,
): Buffer {
  const parts: Buffer[] = [];

  // NBT root compound tag (tag type 10, name "Schematic")
  parts.push(Buffer.from([10])); // TAG_Compound
  parts.push(writeNBTString('Schematic'));

  // Version: int (TAG_Int = 3)
  parts.push(writeNBTInt('Version', 2));

  // DataVersion: int (1.20.4 = 3700)
  parts.push(writeNBTInt('DataVersion', 3700));

  // Width: short (TAG_Short = 2)
  parts.push(writeNBTShort('Width', width));

  // Height: short
  parts.push(writeNBTShort('Height', height));

  // Length: short
  parts.push(writeNBTShort('Length', length));

  // Palette: compound
  parts.push(Buffer.from([10])); // TAG_Compound
  parts.push(writeNBTString('Palette'));
  for (const [blockId, idx] of palette) {
    parts.push(writeNBTInt(blockId, idx));
  }
  parts.push(Buffer.from([0])); // End Palette compound

  // PaletteMax: int
  parts.push(writeNBTInt('PaletteMax', palette.size));

  // BlockData: byte array (TAG_ByteArray = 7)
  parts.push(Buffer.from([7])); // TAG_ByteArray
  parts.push(writeNBTString('BlockData'));
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32BE(blockData.length);
  parts.push(lenBuf);
  parts.push(blockData);

  // Metadata: compound (empty)
  parts.push(Buffer.from([10])); // TAG_Compound
  parts.push(writeNBTString('Metadata'));
  parts.push(Buffer.from([0])); // End

  // End root compound
  parts.push(Buffer.from([0]));

  return Buffer.concat(parts);
}

function writeNBTString(str: string): Buffer {
  const strBuf = Buffer.from(str, 'utf8');
  const lenBuf = Buffer.alloc(2);
  lenBuf.writeUInt16BE(strBuf.length);
  return Buffer.concat([lenBuf, strBuf]);
}

function writeNBTInt(name: string, value: number): Buffer {
  const parts = [Buffer.from([3])]; // TAG_Int
  parts.push(writeNBTString(name));
  const valBuf = Buffer.alloc(4);
  valBuf.writeInt32BE(value);
  parts.push(valBuf);
  return Buffer.concat(parts);
}

function writeNBTShort(name: string, value: number): Buffer {
  const parts = [Buffer.from([2])]; // TAG_Short
  parts.push(writeNBTString(name));
  const valBuf = Buffer.alloc(2);
  valBuf.writeInt16BE(value);
  parts.push(valBuf);
  return Buffer.concat(parts);
}
