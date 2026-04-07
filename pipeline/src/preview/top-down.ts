import { createCanvas } from 'canvas';
import type { VoxelWorld, StageResult } from '../types.js';
import { CHUNK_SIZE_XZ } from '../types.js';
import { getTopBlockColor } from '../voxel/chunk.js';
import { savePNG } from '../util/image.js';

/**
 * Render a top-down preview of the voxel world.
 * Shows the color of the highest non-air block in each column,
 * with Minecraft-style north-shading for depth.
 */
export function renderTopDown(
  world: VoxelWorld,
  outputPath: string,
): StageResult<string> {
  const start = Date.now();
  const w = world.blockWidth;
  const d = world.blockDepth;

  console.log(`  Rendering top-down preview (${w}x${d})...`);

  const canvas = createCanvas(w, d);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(w, d);
  const pixels = imageData.data;

  // First pass: collect top block colors and heights
  const colorGrid = new Uint8Array(w * d * 3);
  const heightGrid = new Uint8Array(w * d);

  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / CHUNK_SIZE_XZ);
      const cz = Math.floor(z / CHUNK_SIZE_XZ);
      const chunk = world.chunks.get(`${cx},${cz}`);

      let color: [number, number, number] = [127, 178, 56]; // default grass
      let topY = world.seaLevel;

      if (chunk) {
        const localX = x % CHUNK_SIZE_XZ;
        const localZ = z % CHUNK_SIZE_XZ;
        color = getTopBlockColor(chunk, localX, localZ);

        // Find top Y for shading
        for (let y = chunk.maxY; y >= 0; y--) {
          const idx = localX + localZ * CHUNK_SIZE_XZ + y * CHUNK_SIZE_XZ * CHUNK_SIZE_XZ;
          if (chunk.blocks[idx] !== 0) {
            topY = y;
            break;
          }
        }
      }

      const gi = (z * w + x) * 3;
      colorGrid[gi] = color[0];
      colorGrid[gi + 1] = color[1];
      colorGrid[gi + 2] = color[2];
      heightGrid[z * w + x] = topY;
    }
  }

  // Second pass: apply Minecraft-style north-shading
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const gi = (z * w + x) * 3;
      let r = colorGrid[gi];
      let g = colorGrid[gi + 1];
      let b = colorGrid[gi + 2];

      // Compare height with northern neighbor
      const thisY = heightGrid[z * w + x];
      const northY = z > 0 ? heightGrid[(z - 1) * w + x] : thisY;

      const diff = thisY - northY;
      let shade: number;
      if (diff > 0) {
        shade = 1.1; // higher = bright
      } else if (diff < 0) {
        shade = 0.75; // lower = dark
      } else {
        shade = 0.92; // same = slightly darkened
      }

      r = Math.min(255, Math.floor(r * shade));
      g = Math.min(255, Math.floor(g * shade));
      b = Math.min(255, Math.floor(b * shade));

      const pi = (z * w + x) * 4;
      pixels[pi] = r;
      pixels[pi + 1] = g;
      pixels[pi + 2] = b;
      pixels[pi + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  savePNG(canvas, outputPath);
  console.log(`  Saved: ${outputPath}`);

  return {
    data: outputPath,
    metadata: { stage: 'top-down-preview', durationMs: Date.now() - start, timestamp: Date.now() },
    debugOutputs: [{ name: 'top-down', path: outputPath, description: 'Top-down voxel world preview' }],
  };
}
