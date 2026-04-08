import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { PMTiles } from 'pmtiles';
import type { BoundingBox } from '../types.js';

const OVERTURE_URL = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-03-18.0/buildings.pmtiles';
export const overtureTiles = new PMTiles(OVERTURE_URL);

/** Fetch Overture building footprints as polygon arrays for a given tile */
export async function fetchOvertureBuildingPolygons(bbox: BoundingBox, extent: number, tileZ: number, tileX: number, tileY: number): Promise<number[][][]> {
  const PbfClass = (Pbf as any).default || Pbf;
  const allPolygons: number[][][] = [];

  try {
    const otResult = await overtureTiles.getZxy(tileZ, tileX, tileY);
    if (!otResult?.data) return allPolygons;

    const otTile = new VectorTile(new PbfClass(new Uint8Array(otResult.data)));
    const otLayer = otTile.layers['building'];
    if (!otLayer) return allPolygons;

    for (let i = 0; i < otLayer.length; i++) {
      const f = otLayer.feature(i);
      if (f.type !== 3) continue;
      const geom = f.loadGeometry();
      for (const ring of geom) {
        const points: number[][] = [];
        for (const pt of ring) {
          // Tile-local MVT coords (0-4096) map directly to semantic map (also 0-4096)
          points.push([pt.x, pt.y]);
        }
        if (points.length >= 3) allPolygons.push(points);
      }
    }
  } catch {}

  return allPolygons;
}

/** Fetch Overture buildings with geo-coordinate conversion for arbitrary zoom/bbox */
export async function fetchOvertureBuildingsGeoBbox(bbox: BoundingBox, extent: number): Promise<number[][][]> {
  const PbfClass = (Pbf as any).default || Pbf;
  const zoom = 15;
  const allPolygons: number[][][] = [];

  const n = Math.pow(2, zoom);
  const minX = Math.floor(((bbox.west + 180) / 360) * n);
  const maxX = Math.floor(((bbox.east + 180) / 360) * n);
  const minY = Math.floor((1 - Math.log(Math.tan(bbox.north * Math.PI / 180) + 1 / Math.cos(bbox.north * Math.PI / 180)) / Math.PI) / 2 * n);
  const maxY = Math.floor((1 - Math.log(Math.tan(bbox.south * Math.PI / 180) + 1 / Math.cos(bbox.south * Math.PI / 180)) / Math.PI) / 2 * n);

  const tilePromises = [];
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      tilePromises.push((async () => {
        try {
          const result = await overtureTiles.getZxy(zoom, tx, ty);
          if (!result?.data) return;
          const tile = new VectorTile(new PbfClass(new Uint8Array(result.data)));
          const layer = tile.layers['building'];
          if (!layer) return;

          for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            if (feature.type !== 3) continue;
            const geom = feature.loadGeometry();
            for (const ring of geom) {
              const points: number[][] = [];
              for (const pt of ring) {
                const lng = (tx + pt.x / 4096) / n * 360 - 180;
                const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + pt.y / 4096) / n)));
                const lat = latRad * 180 / Math.PI;
                const px = ((lng - bbox.west) / (bbox.east - bbox.west)) * extent;
                const py = ((bbox.north - lat) / (bbox.north - bbox.south)) * extent;
                points.push([px, py]);
              }
              if (points.length >= 3) allPolygons.push(points);
            }
          }
        } catch {}
      })());
    }
  }

  await Promise.all(tilePromises);
  return allPolygons;
}
