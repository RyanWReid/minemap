import { createCanvas, loadImage } from 'canvas';
import type { BoundingBox, TileCoord, StageResult } from '../types.js';
import { bboxToTiles } from '../util/coord.js';
import { savePNG } from '../util/image.js';

export interface SatelliteData {
  pixels: Uint8ClampedArray;  // RGBA pixel data
  width: number;
  height: number;
  bounds: BoundingBox;
  tileZoom: number;
}

const TILE_SIZE = 256;

/** Fetch a single satellite raster tile (Esri World Imagery — free, no key) */
async function fetchSatelliteTile(tile: TileCoord): Promise<Buffer> {
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${tile.z}/${tile.y}/${tile.x}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Satellite tile fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Fetch and stitch satellite imagery for a bounding box */
export async function ingestSatellite(
  bbox: BoundingBox,
  zoom: number = 15,
  outputDir?: string,
): Promise<StageResult<SatelliteData>> {
  const start = Date.now();
  const tiles = bboxToTiles(bbox, zoom);

  // Calculate grid dimensions
  const minX = Math.min(...tiles.map((t) => t.x));
  const maxX = Math.max(...tiles.map((t) => t.x));
  const minY = Math.min(...tiles.map((t) => t.y));
  const maxY = Math.max(...tiles.map((t) => t.y));

  const gridW = maxX - minX + 1;
  const gridH = maxY - minY + 1;
  const totalW = gridW * TILE_SIZE;
  const totalH = gridH * TILE_SIZE;

  console.log(`  Fetching ${tiles.length} satellite tiles (${gridW}x${gridH} grid)...`);

  // Fetch all tiles in parallel (batched to avoid overwhelming the server)
  const canvas = createCanvas(totalW, totalH);
  const ctx = canvas.getContext('2d');

  const batchSize = 8;
  for (let i = 0; i < tiles.length; i += batchSize) {
    const batch = tiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (tile) => {
        const buf = await fetchSatelliteTile(tile);
        const img = await loadImage(buf);
        return { tile, img };
      }),
    );

    for (const { tile, img } of results) {
      const px = (tile.x - minX) * TILE_SIZE;
      const py = (tile.y - minY) * TILE_SIZE;
      ctx.drawImage(img, px, py);
    }
  }

  const imageData = ctx.getImageData(0, 0, totalW, totalH);

  const debugOutputs: StageResult<SatelliteData>['debugOutputs'] = [];
  if (outputDir) {
    const path = `${outputDir}/01-ingest/satellite.png`;
    savePNG(canvas, path);
    debugOutputs.push({ name: 'satellite', path, description: 'Stitched satellite imagery' });
  }

  return {
    data: {
      pixels: imageData.data,
      width: totalW,
      height: totalH,
      bounds: bbox,
      tileZoom: zoom,
    },
    metadata: {
      stage: 'ingest-satellite',
      durationMs: Date.now() - start,
      timestamp: Date.now(),
    },
    debugOutputs,
  };
}
