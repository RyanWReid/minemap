import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import type { BoundingBox, OSMFeature, SemanticClass, TileCoord, StageResult } from '../types.js';
import { SemanticClass as SC } from '../types.js';
import { bboxToTiles } from '../util/coord.js';

export interface OSMData {
  features: OSMFeature[];
  bounds: BoundingBox;
  tileZoom: number;
  tileExtent: number;         // vector tile coordinate extent (typically 4096)
  tileGridWidth: number;      // tiles across X
  tileGridHeight: number;     // tiles across Y
  tileOriginX: number;        // minimum tile X
  tileOriginY: number;        // minimum tile Y
}

/** Fetch a single vector tile from VersaTiles */
async function fetchVectorTile(tile: TileCoord): Promise<VectorTile | null> {
  const PbfClass = (Pbf as any).default || Pbf;
  const url = `https://tiles.versatiles.org/tiles/osm/${tile.z}/${tile.x}/${tile.y}.pbf`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 20) return null;
  return new VectorTile(new PbfClass(new Uint8Array(buf)));
}

/** Map VersaTiles 'kind' property to SemanticClass */
function classifyStreetKind(kind: string): SemanticClass {
  const roadKinds = new Set([
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
    'residential', 'living_street', 'service', 'unclassified',
    'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
    'pedestrian', 'footway', 'path', 'cycleway', 'track', 'steps',
  ]);
  if (roadKinds.has(kind)) return SC.ROAD;
  if (kind === 'rail' || kind === 'subway' || kind === 'tram' || kind === 'light_rail') return SC.RAILWAY;
  return SC.ROAD;
}

function classifyLandKind(kind: string): SemanticClass {
  const map: Record<string, SemanticClass> = {
    forest: SC.FOREST, wood: SC.FOREST, nature_reserve: SC.FOREST,
    grass: SC.GRASS, meadow: SC.GRASS, village_green: SC.GRASS,
    park: SC.PARK, garden: SC.PARK, recreation_ground: SC.PARK,
    farmland: SC.FARMLAND, farmyard: SC.FARMLAND, orchard: SC.FARMLAND,
    sand: SC.SAND, beach: SC.SAND,
    bare_rock: SC.ROCK, scree: SC.ROCK, cliff: SC.ROCK,
    wetland: SC.WETLAND, scrub: SC.SCRUB, heath: SC.SCRUB,
    glacier: SC.SNOW,
    residential: SC.RESIDENTIAL_ZONE, commercial: SC.INDUSTRIAL,
    industrial: SC.INDUSTRIAL, retail: SC.INDUSTRIAL,
    cemetery: SC.CEMETERY, military: SC.INDUSTRIAL,
    railway: SC.RAILWAY, quarry: SC.ROCK,
    parking: SC.PARKING,
  };
  return map[kind] ?? SC.UNKNOWN;
}

/** Road width in blocks based on kind */
function roadWidth(kind: string): number {
  // Widths in vector tile units (extent=4096 per tile).
  // These need to be wide enough to survive 8x downscaling.
  // A z14 tile covers ~2.4km, so 4096 units / 2400m ≈ 1.7 units/meter.
  // A 4-lane road is ~14m wide → ~24 units. Scale accordingly.
  const widths: Record<string, number> = {
    motorway: 48, trunk: 40, primary: 32, secondary: 24, tertiary: 20,
    residential: 16, living_street: 14, service: 12, unclassified: 14,
    pedestrian: 12, footway: 8, path: 6, cycleway: 8, track: 10, steps: 6,
  };
  return widths[kind] ?? 14;
}

/** Extract features from a single vector tile */
function extractFeatures(
  vt: VectorTile,
  tile: TileCoord,
  tileOriginX: number,
  tileOriginY: number,
): OSMFeature[] {
  const features: OSMFeature[] = [];
  const extent = 4096;

  // Helper: convert tile-local coords to global pixel coords across the stitched grid
  const offsetX = (tile.x - tileOriginX) * extent;
  const offsetY = (tile.y - tileOriginY) * extent;

  function extractGeom(feature: any): number[][] {
    const geom = feature.loadGeometry();
    const coords: number[][] = [];
    for (const ring of geom) {
      for (const pt of ring) {
        coords.push([pt.x + offsetX, pt.y + offsetY]);
      }
    }
    return coords;
  }

  // Buildings
  const buildings = vt.layers['buildings'];
  if (buildings) {
    for (let i = 0; i < buildings.length; i++) {
      const f = buildings.feature(i);
      if (f.type !== 3) continue;
      features.push({
        type: 'polygon',
        semanticClass: SC.BUILDING,
        geometry: extractGeom(f),
        properties: f.properties,
        height: 10, // default 10 blocks
      });
    }
  }

  // Streets
  const streets = vt.layers['streets'];
  if (streets) {
    for (let i = 0; i < streets.length; i++) {
      const f = streets.feature(i);
      if (f.type !== 2) continue;
      const props = f.properties;
      if (props.tunnel) continue;
      const kind = (props.kind as string) || '';
      const isRail = props.rail || kind === 'rail' || kind === 'subway';
      features.push({
        type: 'line',
        semanticClass: isRail ? SC.RAILWAY : classifyStreetKind(kind),
        geometry: extractGeom(f),
        properties: props,
        width: isRail ? 2 : roadWidth(kind),
      });
    }
  }

  // Water
  for (const layerName of ['water_polygons', 'ocean']) {
    const layer = vt.layers[layerName];
    if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== 3) continue;
      features.push({
        type: 'polygon',
        semanticClass: SC.WATER,
        geometry: extractGeom(f),
        properties: f.properties,
      });
    }
  }

  // Land use / land cover
  const land = vt.layers['land'];
  if (land) {
    for (let i = 0; i < land.length; i++) {
      const f = land.feature(i);
      if (f.type !== 3) continue;
      const kind = (f.properties.kind as string) || '';
      const cls = classifyLandKind(kind);
      if (cls === SC.UNKNOWN) continue;
      features.push({
        type: 'polygon',
        semanticClass: cls,
        geometry: extractGeom(f),
        properties: f.properties,
      });
    }
  }

  // Sites
  const sites = vt.layers['sites'];
  if (sites) {
    for (let i = 0; i < sites.length; i++) {
      const f = sites.feature(i);
      if (f.type !== 3) continue;
      const kind = (f.properties.kind as string) || '';
      const cls = classifyLandKind(kind);
      if (cls === SC.UNKNOWN) continue;
      features.push({
        type: 'polygon',
        semanticClass: cls,
        geometry: extractGeom(f),
        properties: f.properties,
      });
    }
  }

  return features;
}

/** Fetch and parse all OSM vector data for a bounding box */
export async function ingestOSM(
  bbox: BoundingBox,
  zoom: number = 14,
  outputDir?: string,
): Promise<StageResult<OSMData>> {
  const start = Date.now();
  const tiles = bboxToTiles(bbox, zoom);

  const minTileX = Math.min(...tiles.map((t) => t.x));
  const maxTileX = Math.max(...tiles.map((t) => t.x));
  const minTileY = Math.min(...tiles.map((t) => t.y));
  const maxTileY = Math.max(...tiles.map((t) => t.y));

  console.log(`  Fetching ${tiles.length} vector tiles...`);

  const allFeatures: OSMFeature[] = [];

  const batchSize = 4;
  for (let i = 0; i < tiles.length; i += batchSize) {
    const batch = tiles.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (tile) => {
        const vt = await fetchVectorTile(tile);
        return { tile, vt };
      }),
    );

    for (const { tile, vt } of results) {
      if (!vt) continue;
      allFeatures.push(...extractFeatures(vt, tile, minTileX, minTileY));
    }
  }

  console.log(`  Extracted ${allFeatures.length} features`);

  const data: OSMData = {
    features: allFeatures,
    bounds: bbox,
    tileZoom: zoom,
    tileExtent: 4096,
    tileGridWidth: maxTileX - minTileX + 1,
    tileGridHeight: maxTileY - minTileY + 1,
    tileOriginX: minTileX,
    tileOriginY: minTileY,
  };

  return {
    data,
    metadata: { stage: 'ingest-osm', durationMs: Date.now() - start, timestamp: Date.now() },
    debugOutputs: [],
  };
}
