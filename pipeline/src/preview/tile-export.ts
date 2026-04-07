import { createCanvas } from 'canvas';
import { mkdirSync, writeFileSync } from 'fs';
import type { VoxelWorld } from '../types.js';
import { CHUNK_SIZE_XZ } from '../types.js';
import { getTopBlockColor } from '../voxel/chunk.js';
import { savePNG } from '../util/image.js';

const MAP_TILE_SIZE = 256;

/**
 * Export the voxel world as a set of web map tiles at multiple zoom levels.
 * These tiles can be served directly by a static file server or our Express app.
 *
 * The world is treated as a flat 2D image (top-down view) and then sliced into
 * standard web map tiles (z/x/y.png) at various zoom levels.
 */
export function exportMapTiles(
  world: VoxelWorld,
  outputDir: string,
  baseZoom: number = 16,
): { tileDir: string; minZoom: number; maxZoom: number; centerX: number; centerY: number } {
  const w = world.blockWidth;
  const d = world.blockDepth;

  console.log(`  Generating map tiles from ${w}x${d} world...`);

  // First, render the full top-down image with Minecraft shading
  const fullCanvas = createCanvas(w, d);
  const fullCtx = fullCanvas.getContext('2d');
  const imageData = fullCtx.createImageData(w, d);
  const pixels = imageData.data;

  // Build color + height arrays for shading
  const heightGrid = new Uint8Array(w * d);

  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / CHUNK_SIZE_XZ);
      const cz = Math.floor(z / CHUNK_SIZE_XZ);
      const chunk = world.chunks.get(`${cx},${cz}`);

      let color: [number, number, number] = [127, 178, 56];
      let topY = world.seaLevel;

      if (chunk) {
        const lx = x % CHUNK_SIZE_XZ;
        const lz = z % CHUNK_SIZE_XZ;
        color = getTopBlockColor(chunk, lx, lz);
        for (let y = chunk.maxY; y >= 0; y--) {
          const idx = lx + lz * CHUNK_SIZE_XZ + y * CHUNK_SIZE_XZ * CHUNK_SIZE_XZ;
          if (chunk.blocks[idx] !== 0) { topY = y; break; }
        }
      }

      const pi = (z * w + x) * 4;
      // North-shading
      const northY = z > 0 ? heightGrid[(z - 1) * w + x] : topY;
      const diff = topY - northY;
      const shade = diff > 0 ? 1.1 : diff < 0 ? 0.75 : 0.92;

      pixels[pi] = Math.min(255, Math.floor(color[0] * shade));
      pixels[pi + 1] = Math.min(255, Math.floor(color[1] * shade));
      pixels[pi + 2] = Math.min(255, Math.floor(color[2] * shade));
      pixels[pi + 3] = 255;
      heightGrid[z * w + x] = topY;
    }
  }

  fullCtx.putImageData(imageData, 0, 0);

  // Now slice into tiles at multiple zoom levels
  // baseZoom = the zoom level where 1 pixel = 1 block
  const tileDir = `${outputDir}/tiles`;

  // Calculate how many tiles we need at base zoom
  const tilesAtBase = Math.ceil(Math.max(w, d) / MAP_TILE_SIZE);

  // Generate zoom levels from baseZoom down
  const minZoom = Math.max(0, baseZoom - 4);
  const maxZoom = baseZoom;

  for (let zoom = maxZoom; zoom >= minZoom; zoom--) {
    const scale = Math.pow(2, maxZoom - zoom);
    const scaledW = Math.ceil(w / scale);
    const scaledH = Math.ceil(d / scale);
    const numTilesX = Math.ceil(scaledW / MAP_TILE_SIZE);
    const numTilesY = Math.ceil(scaledH / MAP_TILE_SIZE);

    // Scale the full image down for this zoom level
    const scaledCanvas = createCanvas(scaledW, scaledH);
    const scaledCtx = scaledCanvas.getContext('2d');
    scaledCtx.imageSmoothingEnabled = false;
    scaledCtx.drawImage(fullCanvas, 0, 0, scaledW, scaledH);

    let tileCount = 0;
    for (let ty = 0; ty < numTilesY; ty++) {
      for (let tx = 0; tx < numTilesX; tx++) {
        const tileCanvas = createCanvas(MAP_TILE_SIZE, MAP_TILE_SIZE);
        const tileCtx = tileCanvas.getContext('2d');
        tileCtx.imageSmoothingEnabled = false;

        // Fill with black (for edge tiles that extend beyond the world)
        tileCtx.fillStyle = '#1a1a1a';
        tileCtx.fillRect(0, 0, MAP_TILE_SIZE, MAP_TILE_SIZE);

        // Copy the relevant portion from the scaled image
        const srcX = tx * MAP_TILE_SIZE;
        const srcY = ty * MAP_TILE_SIZE;
        const srcW = Math.min(MAP_TILE_SIZE, scaledW - srcX);
        const srcH = Math.min(MAP_TILE_SIZE, scaledH - srcY);

        if (srcW > 0 && srcH > 0) {
          tileCtx.drawImage(
            scaledCanvas,
            srcX, srcY, srcW, srcH,
            0, 0, srcW, srcH,
          );
        }

        const tilePath = `${tileDir}/${zoom}/${tx}/${ty}.png`;
        savePNG(tileCanvas, tilePath);
        tileCount++;
      }
    }

    console.log(`  z${zoom}: ${tileCount} tiles (${numTilesX}x${numTilesY})`);
  }

  // Also save metadata for the viewer
  const metadata = {
    minZoom,
    maxZoom,
    tileSize: MAP_TILE_SIZE,
    worldWidth: w,
    worldDepth: d,
    bounds: world.bounds,
    seaLevel: world.seaLevel,
  };

  mkdirSync(tileDir, { recursive: true });
  const metaPath = `${tileDir}/metadata.json`;
  writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
  console.log(`  Metadata: ${metaPath}`);

  return {
    tileDir,
    minZoom,
    maxZoom,
    centerX: Math.floor(w / 2 / MAP_TILE_SIZE),
    centerY: Math.floor(d / 2 / MAP_TILE_SIZE),
  };
}
