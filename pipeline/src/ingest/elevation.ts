import { createCanvas, loadImage } from 'canvas';
import type { BoundingBox, HeightMap, TileCoord, StageResult } from '../types.js';
import { bboxToTiles } from '../util/coord.js';
import { savePNG, renderColorGrid } from '../util/image.js';

const TILE_SIZE = 256;

/** Decode Terrarium elevation: elevation = (R * 256 + G + B / 256) - 32768 */
function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Fetch a single elevation tile from AWS Terrain Tiles */
async function fetchElevationTile(tile: TileCoord): Promise<Buffer> {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${tile.z}/${tile.x}/${tile.y}.png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Elevation tile fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch and stitch elevation data for a bounding box */
export async function ingestElevation(
  bbox: BoundingBox,
  zoom: number = 14,
  seaLevel: number = 64,
  outputDir?: string,
): Promise<StageResult<HeightMap>> {
  const start = Date.now();
  const tiles = bboxToTiles(bbox, zoom);

  const minX = Math.min(...tiles.map((t) => t.x));
  const maxX = Math.max(...tiles.map((t) => t.x));
  const minY = Math.min(...tiles.map((t) => t.y));
  const maxY = Math.max(...tiles.map((t) => t.y));

  const gridW = maxX - minX + 1;
  const gridH = maxY - minY + 1;
  const totalW = gridW * TILE_SIZE;
  const totalH = gridH * TILE_SIZE;

  console.log(`  Fetching ${tiles.length} elevation tiles...`);

  // Fetch and stitch
  const canvas = createCanvas(totalW, totalH);
  const ctx = canvas.getContext('2d');

  const batchSize = 8;
  for (let i = 0; i < tiles.length; i += batchSize) {
    const batch = tiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (tile) => {
        const buf = await fetchElevationTile(tile);
        const img = await loadImage(buf);
        return { tile, img };
      }),
    );

    for (const { tile, img } of results) {
      ctx.drawImage(img, (tile.x - minX) * TILE_SIZE, (tile.y - minY) * TILE_SIZE);
    }
  }

  const imageData = ctx.getImageData(0, 0, totalW, totalH);

  // Decode all pixels to elevation in meters
  const elevation = new Float32Array(totalW * totalH);
  let minElev = Infinity;
  let maxElev = -Infinity;

  for (let i = 0; i < totalW * totalH; i++) {
    const r = imageData.data[i * 4];
    const g = imageData.data[i * 4 + 1];
    const b = imageData.data[i * 4 + 2];
    const elev = decodeTerrarium(r, g, b);
    elevation[i] = elev;
    if (elev < minElev) minElev = elev;
    if (elev > maxElev) maxElev = elev;
  }

  console.log(`  Elevation range: ${minElev.toFixed(1)}m - ${maxElev.toFixed(1)}m`);

  // Quantize to Minecraft block heights
  // Map the elevation range to seaLevel ± range
  const quantized = new Uint8Array(totalW * totalH);
  const elevRange = maxElev - minElev;
  const blockRange = Math.min(128, Math.max(20, Math.ceil(elevRange))); // cap vertical range

  for (let i = 0; i < elevation.length; i++) {
    const normalized = (elevation[i] - minElev) / (elevRange || 1);
    const blockY = Math.floor(seaLevel - blockRange / 2 + normalized * blockRange);
    quantized[i] = Math.min(255, Math.max(1, blockY)); // clamp to valid range
  }

  // Calculate meters per pixel at this zoom
  const midLat = (bbox.north + bbox.south) / 2;
  const resolution = (156543.04 * Math.cos((midLat * Math.PI) / 180)) / Math.pow(2, zoom);

  const heightMap: HeightMap = {
    width: totalW,
    height: totalH,
    elevation,
    quantized,
    seaLevel,
    resolution,
    origin: { lat: bbox.north, lng: bbox.west },
    bounds: bbox,
  };

  const debugOutputs: StageResult<HeightMap>['debugOutputs'] = [];
  if (outputDir) {
    // Grayscale heightmap visualization
    const debugCanvas = renderColorGrid(totalW, totalH, (x, y) => {
      const v = quantized[y * totalW + x];
      return [v, v, v];
    });
    const path = `${outputDir}/01-ingest/elevation.png`;
    savePNG(debugCanvas, path);
    debugOutputs.push({ name: 'elevation', path, description: `Heightmap (${minElev.toFixed(0)}m - ${maxElev.toFixed(0)}m)` });
  }

  return {
    data: heightMap,
    metadata: { stage: 'ingest-elevation', durationMs: Date.now() - start, timestamp: Date.now() },
    debugOutputs,
  };
}
