import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

export async function fetchOneVectorTile(z: number, x: number, y: number): Promise<VectorTile | null> {
  try {
    const PbfClass = (Pbf as any).default || Pbf;
    const url = `https://tiles.versatiles.org/tiles/osm/${z}/${x}/${y}.pbf`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 20) return null;
    return new VectorTile(new PbfClass(new Uint8Array(buf)));
  } catch (e) {
    console.warn(`  VersaTiles fetch failed: ${(e as Error).message}`);
    return null;
  }
}
