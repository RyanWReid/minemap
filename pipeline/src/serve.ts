import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { PMTiles } from 'pmtiles';
import { SemanticClass } from './types.js';
import { tileToBBox, tileToLatLng, latlngToTile } from './util/coord.js';
import { createSemanticMap, fillPolygon, drawLine } from './semantic/class-map.js';
import { BLOCKS } from './palette/block-types.js';
import { selectBiome, BIOME_PALETTES, pickBuildingStyle } from './palette/biome-rules.js';
import { quantizeTerrain } from './terrain/quantizer.js';
import { placeBlocks } from './voxel/placer.js';
import { renderTopDown } from './preview/top-down.js';
import type { BoundingBox, HeightMap } from './types.js';

const app = express();
const PORT = 3001;
const CACHE_DIR = resolve('tile-cache');
mkdirSync(CACHE_DIR, { recursive: true });

// ============================================
// Direct single-tile fetchers (no bbox routing)
// ============================================

async function fetchOneVectorTile(z: number, x: number, y: number): Promise<VectorTile | null> {
  const PbfClass = (Pbf as any).default || Pbf;
  const url = `https://tiles.versatiles.org/tiles/osm/${z}/${x}/${y}.pbf`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 20) return null;
  return new VectorTile(new PbfClass(new Uint8Array(buf)));
}

async function fetchOneElevationTile(z: number, x: number, y: number): Promise<{data: Uint8ClampedArray, width: number} | null> {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const img = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, img.width, img.height);
  return { data: imgData.data, width: img.width };
}

function decodeTerrarium(data: Uint8ClampedArray, x: number, y: number, w: number): number {
  const px = Math.min(Math.max(0, Math.floor(x)), w - 1);
  const py = Math.min(Math.max(0, Math.floor(y)), w - 1);
  const i = (py * w + px) * 4;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}

// ============================================
// Overture Maps: Microsoft Building Footprints via PMTiles
// ============================================

const OVERTURE_URL = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-03-18.0/buildings.pmtiles';
const overtureTiles = new PMTiles(OVERTURE_URL);

async function fetchOvertureBuildings(bbox: BoundingBox, extent: number): Promise<number[][]> {
  const PbfClass = (Pbf as any).default || Pbf;
  const zoom = 14; // max zoom in Overture PMTiles
  const allPolygons: number[][][] = [];

  // Get tiles covering this bbox
  const n = Math.pow(2, zoom);
  const minX = Math.floor(((bbox.west + 180) / 360) * n);
  const maxX = Math.floor(((bbox.east + 180) / 360) * n);
  const minY = Math.floor((1 - Math.log(Math.tan(bbox.north * Math.PI / 180) + 1 / Math.cos(bbox.north * Math.PI / 180)) / Math.PI) / 2 * n);
  const maxY = Math.floor((1 - Math.log(Math.tan(bbox.south * Math.PI / 180) + 1 / Math.cos(bbox.south * Math.PI / 180)) / Math.PI) / 2 * n);

  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      try {
        const result = await overtureTiles.getZxy(zoom, tx, ty);
        if (!result?.data) continue;

        const tile = new VectorTile(new PbfClass(new Uint8Array(result.data)));
        const layer = tile.layers['building'];
        if (!layer) continue;

        for (let i = 0; i < layer.length; i++) {
          const feature = layer.feature(i);
          if (feature.type !== 3) continue; // polygons only

          // Convert tile coords to our semantic map coords
          const geom = feature.loadGeometry();
          for (const ring of geom) {
            const points: number[][] = [];
            for (const pt of ring) {
              // Tile-local coords (0-4096) -> lat/lng -> semantic map coords
              const lng = (tx + pt.x / 4096) / n * 360 - 180;
              const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + pt.y / 4096) / n)));
              const lat = latRad * 180 / Math.PI;

              const px = ((lng - bbox.west) / (bbox.east - bbox.west)) * extent;
              const py = ((bbox.north - lat) / (bbox.north - bbox.south)) * extent;
              points.push([px, py]);
            }
            allPolygons.push(points);
          }
        }
      } catch {
        // Individual tile fetch failure is ok
      }
    }
  }

  return allPolygons.flat() as any; // return as array of polygon point arrays
}

// Wrapper that returns polygon arrays properly
async function fetchOvertureBuildingPolygons(bbox: BoundingBox, extent: number): Promise<number[][][]> {
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

// ============================================
// OSM kind classification
// ============================================

const ROAD_KINDS = new Set(['motorway','trunk','primary','secondary','tertiary','residential','living_street','service','unclassified','pedestrian','footway','path','cycleway','track','steps','motorway_link','trunk_link','primary_link','secondary_link','tertiary_link']);
const ROAD_WIDTHS: Record<string, number> = { motorway:48, trunk:40, primary:32, secondary:24, tertiary:20, residential:16, living_street:14, service:12, unclassified:14, pedestrian:12, footway:8, path:6, cycleway:8, track:10, steps:6 };
const LAND_MAP: Record<string, SemanticClass> = { forest:SemanticClass.FOREST, wood:SemanticClass.FOREST, nature_reserve:SemanticClass.FOREST, grass:SemanticClass.GRASS, meadow:SemanticClass.GRASS, village_green:SemanticClass.GRASS, park:SemanticClass.PARK, garden:SemanticClass.PARK, recreation_ground:SemanticClass.PARK, farmland:SemanticClass.FARMLAND, farmyard:SemanticClass.FARMLAND, sand:SemanticClass.SAND, beach:SemanticClass.SAND, bare_rock:SemanticClass.ROCK, wetland:SemanticClass.WETLAND, scrub:SemanticClass.SCRUB, cemetery:SemanticClass.CEMETERY, residential:SemanticClass.RESIDENTIAL_ZONE, commercial:SemanticClass.INDUSTRIAL, industrial:SemanticClass.INDUSTRIAL };

// ============================================
// Render a z14 parent tile at 1024x1024, cache it,
// then slice out the correct 256x256 sub-tile for z15/z16.
// This guarantees perfect tile alignment.
// ============================================

// ============================================
// Overpass API: get ALL buildings + roads for an area
// ============================================

interface OverpassResult {
  buildings: OverpassElement[];
  roads: OverpassElement[];
  trees: Array<{lat:number,lon:number}>;
}

interface OverpassElement {
  type: string;
  geometry?: Array<{lat:number,lon:number}>;
  lat?: number;
  lon?: number;
  tags: Record<string,string>;
}

const OVERPASS_CACHE = resolve('overpass-cache');
mkdirSync(OVERPASS_CACHE, { recursive: true });

async function fetchOverpass(south: number, west: number, north: number, east: number): Promise<OverpassResult> {
  // Check disk cache first
  const cacheKey = `${south.toFixed(4)}_${west.toFixed(4)}_${north.toFixed(4)}_${east.toFixed(4)}`;
  const cachePath = join(OVERPASS_CACHE, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      console.log(`  Overpass: cached (${cached.buildings.length} buildings, ${cached.roads.length} roads)`);
      return cached;
    } catch {}
  }
  const bbox = `${south},${west},${north},${east}`;
  // Query 1: Buildings + roads + surface info
  const q1 = `[out:json][timeout:25][bbox:${bbox}];(way["building"];way["highway"];);out geom;`;
  // Query 2: Everything else — land, water, leisure, amenities, trees
  const q2 = `[out:json][timeout:25][bbox:${bbox}];(way["natural"];way["waterway"];way["leisure"];way["landuse"];way["amenity"~"parking|school|hospital"];way["barrier"~"fence|wall|hedge"];node["natural"="tree"];node["natural"="tree_row"];);out geom;`;

  const url1 = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q1)}`;
  const url2 = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q2)}`;

  try {
    // Fetch queries sequentially to avoid Overpass rate limits
    const fetchJSON = async (url: string) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (res.status === 429 || res.status === 504) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          if (!res.ok) return null;
          const text = await res.text();
          if (text.startsWith('<')) return null; // XML error response
          return JSON.parse(text);
        } catch { continue; }
      }
      return null;
    };

    const [d1, d2] = await Promise.all([fetchJSON(url1), fetchJSON(url2)]);

    const buildings: OverpassElement[] = [];
    const roads: OverpassElement[] = [];
    const trees: Array<{lat:number,lon:number}> = [];

    const allElements: any[] = [];
    if (d1) allElements.push(...(d1.elements || []));
    if (d2) allElements.push(...(d2.elements || []));

    for (const e of allElements) {
      if (!e.tags) continue;
      if (e.type === 'node' && e.tags.natural === 'tree' && e.lat && e.lon) {
        trees.push({ lat: e.lat, lon: e.lon });
        continue;
      }
      if (!e.geometry || e.geometry.length < 2) continue;
      if (e.tags.building) {
        buildings.push(e);
      } else {
        roads.push(e);
      }
    }

    const result = { buildings, roads, trees };
    // Save to disk cache
    try { writeFileSync(cachePath, JSON.stringify(result)); } catch {}
    return result;
  } catch {
    console.log('  Overpass failed, using VersaTiles only');
    return { buildings: [], roads: [], trees: [] };
  }
}

/** Convert lat/lng geometry to tile pixel coordinates */
function geoToTilePixels(
  geom: Array<{lat:number,lon:number}>,
  bbox: {north:number,south:number,east:number,west:number},
  extent: number,
): number[][] {
  return geom.map(p => [
    ((p.lon - bbox.west) / (bbox.east - bbox.west)) * extent,
    ((bbox.north - p.lat) / (bbox.north - bbox.south)) * extent,
  ]);
}

const HIGHWAY_CLASS: Record<string, SemanticClass> = {};
// All highway types -> ROAD
['motorway','trunk','primary','secondary','tertiary','residential','living_street',
 'service','unclassified','pedestrian','footway','path','cycleway','track','steps',
 'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link'].forEach(k => HIGHWAY_CLASS[k] = SemanticClass.ROAD);

const HIGHWAY_WIDTHS: Record<string, number> = {
  motorway:60, trunk:50, primary:40, secondary:30, tertiary:25,
  residential:20, living_street:18, service:15, unclassified:18,
  pedestrian:15, footway:10, path:8, cycleway:10, track:12, steps:8,
};

const parentCache = new Map<string, Buffer>();

async function renderParentTile(sz: number, sx: number, sy: number): Promise<Buffer> {
  const parentKey = `parent_${sz}_${sx}_${sy}`;
  if (parentCache.has(parentKey)) return parentCache.get(parentKey)!;

  const bbox = tileToBBox(sz, sx, sy);
  const extent = 4096;
  const renderSize = 1024;

  // Fetch VersaTiles (base layers) + elevation + Overpass (complete buildings/roads) in parallel
  const [vt, elevTile, overpass] = await Promise.all([
    fetchOneVectorTile(sz, sx, sy),
    fetchOneElevationTile(sz, sx, sy),
    fetchOverpass(bbox.south, bbox.west, bbox.north, bbox.east),
  ]);

  console.log(`  Overpass: ${overpass.buildings.length} buildings, ${overpass.roads.length} roads`);

  // Build semantic map at full vector tile resolution
  const semMap = createSemanticMap(extent, extent, bbox, 1);
  semMap.sources.add('vector');
  for (let i = 0; i < semMap.data.length; i++) {
    semMap.data[i] = SemanticClass.GRASS;
    semMap.confidence[i] = 0.1;
  }

  if (vt) {
    const layerOrder = [
      { name: 'ocean', cls: SemanticClass.WATER },
      { name: 'land', cls: null as SemanticClass | null },
      { name: 'sites', cls: null as SemanticClass | null },
      { name: 'water_polygons', cls: SemanticClass.WATER },
      { name: 'street_polygons', cls: SemanticClass.ROAD },
      { name: 'streets', cls: null as SemanticClass | null },
      { name: 'buildings', cls: SemanticClass.BUILDING },
    ];

    for (const { name, cls: defaultCls } of layerOrder) {
      const layer = vt.layers[name];
      if (!layer) continue;

      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const props = f.properties as Record<string, any>;
        const kind = (props.kind as string) || '';

        if (name === 'streets' && props.tunnel) continue;
        if (name === 'streets' && (props.rail || kind === 'rail' || kind === 'subway' || kind === 'tram')) continue;

        let cls = defaultCls;
        let width = 0;

        if (name === 'streets') {
          const isDirt = kind === 'path' || kind === 'track' || kind === 'bridleway';
          const isPaved = kind === 'cycleway' || kind === 'footway' || kind === 'pedestrian' || kind === 'steps';
          cls = isDirt ? SemanticClass.PATH_DIRT : isPaved ? SemanticClass.PARKING : SemanticClass.ROAD;
          width = ROAD_WIDTHS[kind] ?? 14;
        } else if (name === 'land' || name === 'sites') {
          cls = LAND_MAP[kind] ?? null;
          if (!cls) continue;
        }
        if (!cls) continue;

        const geom = f.loadGeometry();
        const points: number[][] = [];
        for (const ring of geom) {
          for (const pt of ring) points.push([pt.x, pt.y]);
        }

        const priority = cls === SemanticClass.BUILDING ? 0.9 : cls === SemanticClass.ROAD ? 0.8 : cls === SemanticClass.WATER ? 0.6 : 0.3;

        if (f.type === 3) {
          fillPolygon(semMap, points, cls, priority, 'vector');
        } else if (f.type === 2 && width > 0) {
          drawLine(semMap, points, cls, width, priority, 'vector');
        }
      }
    }
  }

  // Overlay Overpass data — complete coverage from OSM
  // Process in priority order: land cover < water < roads < buildings

  for (const element of overpass.roads) {
    if (!element.geometry || element.geometry.length < 2) continue;
    const t = element.tags;

    let cls: SemanticClass | null = null;
    let width = 0;
    let priority = 0.4;

    // Natural features
    if (t.natural === 'water') { cls = SemanticClass.WATER; priority = 0.7; }
    else if (t.natural === 'beach' || t.natural === 'sand') { cls = SemanticClass.SAND; priority = 0.7; }
    else if (t.natural === 'wood' || t.natural === 'scrub') { cls = SemanticClass.FOREST; priority = 0.45; }
    else if (t.natural === 'grassland') { cls = SemanticClass.GRASS; priority = 0.4; }
    else if (t.natural === 'bare_rock' || t.natural === 'cliff' || t.natural === 'scree') { cls = SemanticClass.ROCK; priority = 0.5; }
    else if (t.natural === 'wetland') { cls = SemanticClass.WETLAND; priority = 0.5; }
    // Waterways
    else if (t.waterway) { cls = SemanticClass.WATER; width = t.waterway === 'river' ? 30 : 15; priority = 0.7; }
    // Land use
    else if (t.landuse === 'forest' || t.landuse === 'orchard') { cls = SemanticClass.FOREST; priority = 0.45; }
    else if (t.landuse === 'meadow' || t.landuse === 'grass' || t.landuse === 'village_green') { cls = SemanticClass.GRASS; priority = 0.4; }
    else if (t.landuse === 'farmland' || t.landuse === 'farmyard') { cls = SemanticClass.FARMLAND; priority = 0.45; }
    else if (t.landuse === 'cemetery') { cls = SemanticClass.CEMETERY; priority = 0.45; }
    else if (t.landuse === 'residential') { cls = SemanticClass.RESIDENTIAL_ZONE; priority = 0.2; }
    else if (t.landuse === 'commercial' || t.landuse === 'retail') { cls = SemanticClass.INDUSTRIAL; priority = 0.3; }
    else if (t.landuse === 'industrial') { cls = SemanticClass.INDUSTRIAL; priority = 0.3; }
    else if (t.landuse === 'construction' || t.landuse === 'brownfield') { cls = SemanticClass.BARE_GROUND; priority = 0.35; }
    // Leisure — detailed classification
    else if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve') { cls = SemanticClass.PARK; priority = 0.45; }
    else if (t.leisure === 'swimming_pool') { cls = SemanticClass.POOL; priority = 0.8; }
    else if (t.leisure === 'pitch') {
      // Sports surface: grass, clay, sand, asphalt etc.
      cls = SemanticClass.SPORTS_PITCH; priority = 0.6;
      if (t.surface === 'grass' || t.sport === 'soccer' || t.sport === 'baseball') cls = SemanticClass.PARK; // grass pitch
    }
    else if (t.leisure === 'playground') { cls = SemanticClass.PLAYGROUND; priority = 0.55; }
    else if (t.leisure === 'golf_course') { cls = SemanticClass.PARK; priority = 0.45; }
    // Amenities
    else if (t.amenity === 'parking') { cls = SemanticClass.PARKING; priority = 0.6; }
    else if (t.amenity === 'school') { cls = SemanticClass.SCHOOL; priority = 0.5; }
    // Railway
    else if (t.railway) { cls = SemanticClass.RAILWAY; width = 12; priority = 0.75; }
    // Green dashed on OSM = bridleway/path/track = dirt paths
    else if (t.highway === 'path' || t.highway === 'track' || t.highway === 'bridleway') {
      cls = SemanticClass.PATH_DIRT;
      width = HIGHWAY_WIDTHS[t.highway] ?? 8;
      priority = 0.7;
    }
    // Blue dashed on OSM = cycleway + footway/pedestrian/steps = paved concrete
    else if (t.highway === 'cycleway' || t.highway === 'footway' || t.highway === 'pedestrian' || t.highway === 'steps') {
      cls = SemanticClass.PARKING; // smooth_stone = light gray paved/concrete
      width = HIGHWAY_WIDTHS[t.highway] ?? 10;
      priority = 0.75;
    }
    // Roads (highest non-building priority)
    else if (t.highway) {
      cls = SemanticClass.ROAD;
      width = HIGHWAY_WIDTHS[t.highway] ?? 18;
      priority = 0.85;
    }

    if (!cls) continue;
    const points = geoToTilePixels(element.geometry, bbox, extent);

    const first = element.geometry[0];
    const last = element.geometry[element.geometry.length - 1];
    const isClosed = Math.abs(first.lat - last.lat) < 0.00001 && Math.abs(first.lon - last.lon) < 0.00001;

    if (isClosed && width === 0) {
      fillPolygon(semMap, points, cls, priority, 'vector');
    } else {
      drawLine(semMap, points, cls, width || 15, priority, 'vector');
    }
  }

  // Buildings from Overpass (highest priority)
  for (const building of overpass.buildings) {
    if (!building.geometry || building.geometry.length < 3) continue;
    const points = geoToTilePixels(building.geometry, bbox, extent);
    fillPolygon(semMap, points, SemanticClass.BUILDING, 0.95, 'vector');
  }

  // Overture Maps: Microsoft AI building footprints (fills OSM gaps)
  // Fetch the exact same z14 tile we're rendering
  const overturePolygons: number[][][] = [];
  try {
    const PbfClass2 = (Pbf as any).default || Pbf;
    const otResult = await overtureTiles.getZxy(sz, sx, sy);
    if (otResult?.data) {
      const otTile = new VectorTile(new PbfClass2(new Uint8Array(otResult.data)));
      const otLayer = otTile.layers['building'];
      if (otLayer) {
        const n = Math.pow(2, sz);
        for (let i = 0; i < otLayer.length; i++) {
          const f = otLayer.feature(i);
          if (f.type !== 3) continue;
          const geom = f.loadGeometry();
          for (const ring of geom) {
            const points: number[][] = [];
            for (const pt of ring) {
              // Tile-local MVT coords (0-4096) map directly to our semantic map (also 0-4096)
              points.push([pt.x, pt.y]);
            }
            if (points.length >= 3) overturePolygons.push(points);
          }
        }
      }
    }
  } catch {}
  console.log(`  Overture direct: ${overturePolygons.length} polygons`);
  let overtureNew = 0;
  for (const polygon of overturePolygons) {
    // Only fill if the area isn't already marked as BUILDING by OSM
    // Check center point
    let cx = 0, cy = 0;
    for (const [px, py] of polygon) { cx += px; cy += py; }
    cx /= polygon.length; cy /= polygon.length;
    const ci = Math.floor(cy) * extent + Math.floor(cx);
    if (ci >= 0 && ci < semMap.data.length && semMap.data[ci] !== SemanticClass.BUILDING) {
      fillPolygon(semMap, polygon, SemanticClass.BUILDING, 0.9, 'vector');
      overtureNew++;
    }
  }
  console.log(`  Overture: ${overturePolygons.length} footprints (${overtureNew} new)`);

  // Individual trees from OSM (mark cells as FOREST for tree placement)
  console.log(`  Individual trees: ${overpass.trees.length}`);
  for (const tree of overpass.trees) {
    const px = ((tree.lon - bbox.west) / (bbox.east - bbox.west)) * extent;
    const py = ((bbox.north - tree.lat) / (bbox.north - bbox.south)) * extent;
    // Mark a small area as forest so the placer puts a tree there
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx*dx + dy*dy > 12) continue;
        const x = Math.floor(px + dx);
        const y = Math.floor(py + dy);
        if (x >= 0 && x < extent && y >= 0 && y < extent) {
          const idx = y * extent + x;
          if (semMap.data[idx] === SemanticClass.GRASS || semMap.data[idx] === SemanticClass.PARK) {
            semMap.data[idx] = SemanticClass.FOREST;
            semMap.confidence[idx] = 0.5;
          }
        }
      }
    }
  }

  // Downsample: 4096 -> 1024
  const scaleDown = extent / renderSize;
  const newData = new Uint8Array(renderSize * renderSize);
  const newConf = new Float32Array(renderSize * renderSize);
  for (let ny = 0; ny < renderSize; ny++) {
    for (let nx = 0; nx < renderSize; nx++) {
      const srcIdx = Math.min(ny * scaleDown, extent - 1) * extent + Math.min(nx * scaleDown, extent - 1);
      newData[ny * renderSize + nx] = semMap.data[srcIdx];
      newConf[ny * renderSize + nx] = semMap.confidence[srcIdx];
    }
  }
  const workingMap = { ...semMap, width: renderSize, height: renderSize, data: newData, confidence: newConf };

  // Build heightmap at render resolution
  const elevation = new Float32Array(renderSize * renderSize);
  if (elevTile) {
    for (let py = 0; py < renderSize; py++) {
      for (let px = 0; px < renderSize; px++) {
        elevation[py * renderSize + px] = decodeTerrarium(elevTile.data, (px / renderSize) * elevTile.width, (py / renderSize) * elevTile.width, elevTile.width);
      }
    }
  }
  let minE = Infinity, maxE = -Infinity;
  for (const e of elevation) { if (e < minE) minE = e; if (e > maxE) maxE = e; }
  const clampedMin = Math.max(minE, -10);
  const range = maxE - clampedMin || 1;
  const blockRange = Math.min(60, Math.max(10, Math.ceil(range)));
  const seaLevel = 64;
  const baseY = Math.max(5, seaLevel - Math.floor(blockRange * 0.3));
  const quantized = new Uint8Array(renderSize * renderSize);
  for (let i = 0; i < elevation.length; i++) {
    quantized[i] = Math.min(255, Math.max(1, Math.floor(baseY + (Math.max(clampedMin, elevation[i]) - clampedMin) / range * blockRange)));
  }

  const heightMap: HeightMap = {
    width: renderSize, height: renderSize, elevation, quantized, seaLevel,
    resolution: 1, origin: { lat: bbox.north, lng: bbox.west }, bounds: bbox,
  };

  // Use the EXACT pipeline code that produced the approved output
  const terrainResult = quantizeTerrain(heightMap, { seaLevel });
  const worldResult = placeBlocks(workingMap, terrainResult.data);
  const pipelineResult = renderTopDown(worldResult.data, '');

  const result = pipelineResult.buffer!;
  parentCache.set(parentKey, result);
  if (parentCache.size > 50) {
    const first = parentCache.keys().next().value;
    if (first) parentCache.delete(first);
  }

  return result;
}

// In-flight parent renders to avoid duplicate work
const parentInFlight = new Map<string, Promise<Buffer>>();

/**
 * Render a z14 parent and pre-slice ALL 16 z16 sub-tiles into cache.
 * This way, when you pan, adjacent tiles are already ready.
 */
async function renderAndCacheParent(parentZ: number, parentX: number, parentY: number): Promise<void> {
  const parentKey = `p_${parentZ}_${parentX}_${parentY}`;

  // Already rendering this parent? Wait for it.
  if (parentInFlight.has(parentKey)) {
    await parentInFlight.get(parentKey);
    return;
  }

  const promise = (async () => {
    const start = Date.now();
    const parentPNG = await renderParentTile(parentZ, parentX, parentY);
    const parentImg = await loadImage(parentPNG);
    const parentW = parentImg.width;

    // Slice into z16 tiles (4x4 = 16 tiles)
    const factor = 4; // z16 - z14 = 2, 2^2 = 4
    const subSize = parentW / factor;

    for (let sy = 0; sy < factor; sy++) {
      for (let sx = 0; sx < factor; sx++) {
        const tileX = parentX * factor + sx;
        const tileY = parentY * factor + sy;
        const key = `16_${tileX}_${tileY}`;
        const diskPath = join(CACHE_DIR, `${key}.png`);

        if (!existsSync(diskPath)) {
          const canvas = createCanvas(256, 256);
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(parentImg, sx * subSize, sy * subSize, subSize, subSize, 0, 0, 256, 256);
          const buf = canvas.toBuffer('image/png');
          writeFileSync(diskPath, buf);
          memCache.set(key, buf);
        }
      }
    }

    console.log(`  Parent ${parentZ}/${parentX}/${parentY} -> 16 tiles in ${Date.now() - start}ms`);
  })();

  parentInFlight.set(parentKey, promise);
  try { await promise; } finally { parentInFlight.delete(parentKey); }
}

// ============================================
// Server with caching
// ============================================

const memCache = new Map<string, Buffer>();

app.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const z = parseInt(req.params.z);
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);

  if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 16) {
    return res.status(400).send('');
  }

  const key = `${z}_${x}_${y}`;

  // Memory cache
  if (memCache.has(key)) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(memCache.get(key));
  }

  // Disk cache
  const diskPath = join(CACHE_DIR, `${key}.png`);
  if (existsSync(diskPath)) {
    const buf = readFileSync(diskPath);
    memCache.set(key, buf);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(buf);
  }

  try {
    if (z === 16) {
      // Render parent z14 tile and pre-cache all 16 z16 sub-tiles
      const parentX = Math.floor(x / 4);
      const parentY = Math.floor(y / 4);
      await renderAndCacheParent(14, parentX, parentY);

      // Now it should be cached
      if (existsSync(diskPath)) {
        const buf = readFileSync(diskPath);
        memCache.set(key, buf);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buf);
      }
    }

    // Fallback: render directly for z14 or below
    const start = Date.now();
    const png = await renderParentTile(z, x, y);
    console.log(`  ${z}/${x}/${y} rendered in ${Date.now() - start}ms`);

    writeFileSync(diskPath, png);
    memCache.set(key, png);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (err) {
    console.error(`Error ${z}/${x}/${y}:`, err);
    res.status(500).send('');
  }
});

// Viewer
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Minecraft Map</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    @font-face {
      font-family: 'Minecraft';
      src: url('https://cdn.jsdelivr.net/gh/South-Paw/typeface-minecraft@master/fonts/minecraft.woff2') format('woff2');
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Minecraft', monospace; background: #1a1a1a; }
    #map { width: 100vw; height: 100vh; }
    .leaflet-tile { image-rendering: pixelated !important; }

    #controls {
      position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
      z-index: 1000; display: flex; gap: 0;
    }
    .ctrl-btn {
      font-family: 'Minecraft', monospace; font-size: 12px;
      padding: 8px 14px; border: 3px solid #555;
      background: #6b6b6b; color: #aaa; cursor: pointer;
      box-shadow: inset 2px 2px 0 #888, inset -2px -2px 0 #444;
    }
    .ctrl-btn:not(:last-child) { border-right: none; }
    .ctrl-btn.active {
      background: #4a8c3f; color: #fff;
      box-shadow: inset -2px -2px 0 #6ab35e, inset 2px 2px 0 #2d6324;
    }
    .ctrl-btn:hover:not(.active) { background: #888; }

    #search-container {
      position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
      z-index: 1000; display: flex; gap: 0;
    }
    #search-input {
      font-family: 'Minecraft', monospace; font-size: 13px;
      padding: 8px 14px; width: 320px; border: 3px solid #555; border-right: none;
      background: #c6c6c6; color: #3f3f3f; outline: none;
      box-shadow: inset 2px 2px 0 #8b8b8b, inset -2px -2px 0 #fff;
    }
    #search-input::placeholder { color: #7a7a7a; }
    #search-btn {
      font-family: 'Minecraft', monospace; font-size: 13px;
      padding: 8px 14px; border: 3px solid #555;
      background: #8b8b8b; color: #fff; cursor: pointer;
      box-shadow: inset 2px 2px 0 #aaa, inset -2px -2px 0 #555;
    }

    #coords {
      position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
      z-index: 1000; font-family: 'Minecraft', monospace; font-size: 12px;
      color: #fff; background: rgba(0,0,0,0.7); padding: 6px 14px; border: 2px solid #555;
    }
    .leaflet-control-zoom a {
      font-family: 'Minecraft', monospace !important;
      background: #8b8b8b !important; border: 2px solid #555 !important;
      color: #fff !important;
    }
    .leaflet-control-attribution {
      font-family: 'Minecraft', monospace !important; font-size: 10px !important;
      background: rgba(0,0,0,0.6) !important; color: #aaa !important;
    }

    .player-marker {
      image-rendering: pixelated;
      transition: transform 0.3s ease;
    }
    #locate-btn {
      position: absolute; bottom: 48px; right: 10px; z-index: 1000;
      width: 34px; height: 34px; border: 2px solid #555;
      background: #6b6b6b; cursor: pointer; display: flex;
      align-items: center; justify-content: center;
      box-shadow: inset 2px 2px 0 #888, inset -2px -2px 0 #444;
    }
    #locate-btn:hover { background: #888; }
    #locate-btn.active { background: #4a8c3f; }
    #locate-btn svg { width: 18px; height: 18px; }
  </style>
</head>
<body>
  <div id="controls">
    <button class="ctrl-btn active" id="btn-mc" onclick="setView('mc')">Minecraft</button>
    <button class="ctrl-btn" id="btn-sat" onclick="setView('sat')">Satellite</button>
    <button class="ctrl-btn" id="btn-roads" onclick="setView('roads')">Roads</button>
  </div>

  <div id="search-container">
    <input type="text" id="search-input" placeholder="Search any place..." />
    <button id="search-btn" onclick="doSearch()">Go</button>
  </div>

  <div id="map"></div>
  <div id="coords">X: 0, Z: 0</div>

  <button id="locate-btn" onclick="toggleLocate()" title="Show my location">
    <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5">
      <circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>
    </svg>
  </button>

  <script>
    const map = L.map('map', {
      center: [40.767, -73.975],
      zoom: 16,
      minZoom: 2,
      maxZoom: 18,
    });

    const mcLayer = L.tileLayer('/tiles/{z}/{x}/{y}.png?v=${Date.now()}', {
      maxNativeZoom: 16,
      maxZoom: 18,
      attribution: 'Minecraft Map | &copy; OSM',
    });

    const satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: '&copy; Esri',
    });

    const roadsLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OSM',
    });

    let activeLayer = mcLayer;
    mcLayer.addTo(map);

    function setView(mode) {
      map.removeLayer(activeLayer);
      document.querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));

      if (mode === 'mc') {
        activeLayer = mcLayer;
        document.getElementById('btn-mc').classList.add('active');
        document.getElementById('map').style.imageRendering = 'pixelated';
      } else if (mode === 'sat') {
        activeLayer = satLayer;
        document.getElementById('btn-sat').classList.add('active');
        document.getElementById('map').style.imageRendering = 'auto';
      } else {
        activeLayer = roadsLayer;
        document.getElementById('btn-roads').classList.add('active');
        document.getElementById('map').style.imageRendering = 'auto';
      }
      activeLayer.addTo(map);
    }

    map.on('mousemove', e => {
      const mcX = Math.floor(e.latlng.lng * 1000);
      const mcZ = Math.floor(-e.latlng.lat * 1000);
      document.getElementById('coords').textContent =
        'X: ' + mcX + '  Z: ' + mcZ + '  (' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4) + ')';
    });

    document.getElementById('search-input').addEventListener('keypress', e => {
      if (e.key === 'Enter') doSearch();
    });

    async function doSearch() {
      const q = document.getElementById('search-input').value.trim();
      if (!q) return;
      const coordMatch = q.match(/^(-?\\d+\\.?\\d*)\\s*,\\s*(-?\\d+\\.?\\d*)$/);
      if (coordMatch) {
        map.setView([parseFloat(coordMatch[1]), parseFloat(coordMatch[2])], 16);
        return;
      }
      try {
        const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(q) + '&limit=1',
          { headers: { 'User-Agent': 'MinecraftMap/1.0' } });
        const data = await res.json();
        if (data.length > 0) map.setView([parseFloat(data[0].lat), parseFloat(data[0].lon)], 16);
      } catch(e) { console.error('Search failed', e); }
    }

    // ---- Player location marker ----
    function makePlayerIcon() {
      // Pixel art location pin: 7x8 grid, each cell = 3px = 21x24 total
      const px = 3;
      const cols = 7, rows_n = 8;
      const w = cols * px, h = rows_n * px;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');

      // 0=transparent, 1=black outline, 2=white fill, 3=light gray
      // Teardrop/pin shape: pointed tip at top, round body
      const rows = [
        [0,0,0,1,0,0,0],
        [0,0,1,2,1,0,0],
        [0,1,2,2,2,1,0],
        [1,2,2,2,2,2,1],
        [1,2,2,3,2,2,1],
        [1,2,2,2,2,2,1],
        [0,1,2,2,2,1,0],
        [0,0,1,1,1,0,0],
      ];
      const colors = ['rgba(0,0,0,0)', '#111', '#f0f0f0', '#b0b0b0'];

      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < rows[y].length; x++) {
          if (rows[y][x] === 0) continue;
          ctx.fillStyle = colors[rows[y][x]];
          ctx.fillRect(x * px, y * px, px, px);
        }
      }
      return c.toDataURL();
    }

    let playerMarker = null;
    let watchId = null;
    let heading = 0;
    let locateActive = false;

    function toggleLocate() {
      const btn = document.getElementById('locate-btn');
      if (locateActive) {
        // Turn off
        locateActive = false;
        btn.classList.remove('active');
        if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
        if (playerMarker) { map.removeLayer(playerMarker); playerMarker = null; }
        window.removeEventListener('deviceorientation', onOrientation);
        window.removeEventListener('deviceorientationabsolute', onOrientation);
        return;
      }

      if (!navigator.geolocation) { alert('Geolocation not available'); return; }

      locateActive = true;
      btn.classList.add('active');

      const iconUrl = makePlayerIcon();
      const playerIcon = L.icon({
        iconUrl: iconUrl,
        iconSize: [21, 24],
        iconAnchor: [10, 12],
        className: 'player-marker',
      });

      watchId = navigator.geolocation.watchPosition(
        pos => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          if (pos.coords.heading && pos.coords.heading > 0) heading = pos.coords.heading;

          if (!playerMarker) {
            playerMarker = L.marker([lat, lng], { icon: playerIcon, zIndexOffset: 9999 }).addTo(map);
            map.setView([lat, lng], 16);
          } else {
            playerMarker.setLatLng([lat, lng]);
          }
          updateMarkerRotation();
        },
        err => { console.error('Geolocation error:', err); alert('Could not get location'); locateActive = false; btn.classList.remove('active'); },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
      );

      // Device orientation for compass heading
      if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', onOrientation);
      } else if ('ondeviceorientation' in window) {
        window.addEventListener('deviceorientation', onOrientation);
      }
    }

    function onOrientation(e) {
      let h = null;
      if (e.webkitCompassHeading !== undefined) {
        h = e.webkitCompassHeading; // iOS
      } else if (e.alpha !== null) {
        h = (360 - e.alpha) % 360; // Android
      }
      if (h !== null) { heading = h; updateMarkerRotation(); }
    }

    function updateMarkerRotation() {
      if (!playerMarker) return;
      const el = playerMarker.getElement();
      if (el) el.style.transform = el.style.transform.replace(/rotate\\([^)]*\\)/, '') + ' rotate(' + heading + 'deg)';
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`\n  Minecraft Map: http://localhost:${PORT}`);
  console.log(`  Uses the same pipeline that produced the approved output.`);
  console.log(`  First tile load ~2-3s, then cached.\n`);
});
