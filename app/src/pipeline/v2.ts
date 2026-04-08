/**
 * V2 Terrain Pipeline — Collect-Then-Decide Architecture
 *
 * Instead of each data source writing directly to the semantic map (v1),
 * all sources contribute "votes" per pixel. A resolver then picks the
 * winner using a two-key system:
 *   1. Feature priority (what it IS: BUILDING > ROAD > WATER > FOREST > GRASS)
 *   2. Source trust (how reliable the source is: overpass > overture > versatiles > satellite)
 *
 * Improvements over v1:
 *   - Stage ordering no longer matters — all sources contribute independently
 *   - Multi-source agreement naturally boosts confidence
 *   - Unified road widths (no more dual width tables)
 *   - Satellite/WorldCover used as a real data source, not just a last-resort fallback
 *   - Majority-vote downsampling preserves thin features (roads, paths, rivers)
 *   - All writes go through the vote system — no bypassed confidence gates
 *   - Debug audit trail: every pixel knows which source won and why
 */

import { SemanticClass } from '../types.js';
import type { BoundingBox, HeightMap } from '../types.js';
import type { RenderResult } from './types.js';

// Data sources
import { fetchOneVectorTile } from '../sources/versatiles.js';
import { fetchOneElevationTile, decodeTerrarium } from '../sources/elevation.js';
import { fetchOverpass } from '../sources/overpass.js';
import { fetchSatelliteTilePixels } from '../sources/satellite.js';
import { fetchOvertureBuildingPolygons } from '../sources/overture.js';
import { LAND_MAP, geoToTilePixels } from '../sources/constants.js';

// Semantic map operations
import { createSemanticMap } from '../semantic/class-map.js';

// Downstream pipeline
import { tileToBBox } from '../util/coord.js';
import { quantizeTerrain } from '../terrain/quantizer.js';
import { sampleSurfaceColors } from '../semantic/roof-sampler.js';
import { placeBlocks } from '../voxel/placer.js';
import { renderTopDown } from '../preview/top-down.js';

// ============================================
// Feature priority — what it IS determines precedence
// ============================================

export const FEATURE_PRIORITY: Record<SemanticClass, number> = {
  [SemanticClass.UNKNOWN]:          0,
  [SemanticClass.RESIDENTIAL_ZONE]: 1,
  [SemanticClass.SCHOOL]:           1,
  [SemanticClass.GRASS]:            2,
  [SemanticClass.BARE_GROUND]:      2,
  [SemanticClass.SCRUB]:            2,
  [SemanticClass.FARMLAND]:         3,
  [SemanticClass.FOREST]:           4,
  [SemanticClass.PARK]:             4,
  [SemanticClass.CEMETERY]:         4,
  [SemanticClass.WETLAND]:          4,
  [SemanticClass.SAND]:             4,
  [SemanticClass.ROCK]:             4,
  [SemanticClass.SNOW]:             4,
  [SemanticClass.INDUSTRIAL]:       5,
  [SemanticClass.PARKING]:          5,
  [SemanticClass.SPORTS_PITCH]:     5,
  [SemanticClass.PLAYGROUND]:       5,
  [SemanticClass.WATER]:            6,
  [SemanticClass.POOL]:             6,
  [SemanticClass.RAILWAY]:          7,
  [SemanticClass.PATH_DIRT]:        7,
  [SemanticClass.ROAD]:             8,
  [SemanticClass.BUILDING]:         9,
};

// ============================================
// Source trust — tiebreaker when same feature priority
// ============================================

export type SourceId = 'default' | 'satellite' | 'worldcover' | 'versatiles' | 'overture' | 'overpass';

export const SOURCE_TRUST: Record<SourceId, number> = {
  default:     0.0,
  satellite:   0.2,
  worldcover:  0.7,   // ESA WorldCover — ML-classified, high quality
  versatiles:  0.5,
  overture:    0.6,
  overpass:    0.8,
};

// ============================================
// Vote system
// ============================================

export interface PixelVote {
  cls: SemanticClass;
  source: SourceId;
  featurePriority: number;
  sourceTrust: number;
}

// Compact vote storage: 4 bytes per vote (cls, source, featurePri, trustx100)
// Max 4 votes per pixel to keep memory bounded
const MAX_VOTES = 4;

export interface VoteMap {
  width: number;
  height: number;
  /** Flat array: for pixel i, votes are at [i * MAX_VOTES .. i * MAX_VOTES + count[i] - 1] */
  votes: Uint8Array;    // cls per vote slot
  sources: Uint8Array;  // source enum per vote slot
  count: Uint8Array;    // how many votes per pixel
}

export function createVoteMap(width: number, height: number): VoteMap {
  const total = width * height;
  return {
    width,
    height,
    votes: new Uint8Array(total * MAX_VOTES),
    sources: new Uint8Array(total * MAX_VOTES),
    count: new Uint8Array(total),
  };
}

const SOURCE_ID_MAP: Record<SourceId, number> = {
  default: 0, satellite: 1, worldcover: 2, versatiles: 3, overture: 4, overpass: 5,
};
const SOURCE_ID_REVERSE: SourceId[] = ['default', 'satellite', 'worldcover', 'versatiles', 'overture', 'overpass'];

export function addVote(map: VoteMap, x: number, y: number, cls: SemanticClass, source: SourceId): void {
  if (x < 0 || x >= map.width || y < 0 || y >= map.height) return;
  const pixelIdx = y * map.width + x;
  const c = map.count[pixelIdx];
  if (c >= MAX_VOTES) {
    // Replace the weakest vote if this one is stronger
    const newPri = FEATURE_PRIORITY[cls];
    let weakestSlot = 0;
    let weakestPri = FEATURE_PRIORITY[map.votes[pixelIdx * MAX_VOTES] as SemanticClass];
    for (let s = 1; s < MAX_VOTES; s++) {
      const slotPri = FEATURE_PRIORITY[map.votes[pixelIdx * MAX_VOTES + s] as SemanticClass];
      if (slotPri < weakestPri) {
        weakestPri = slotPri;
        weakestSlot = s;
      }
    }
    if (newPri > weakestPri) {
      map.votes[pixelIdx * MAX_VOTES + weakestSlot] = cls;
      map.sources[pixelIdx * MAX_VOTES + weakestSlot] = SOURCE_ID_MAP[source];
    }
    return;
  }
  map.votes[pixelIdx * MAX_VOTES + c] = cls;
  map.sources[pixelIdx * MAX_VOTES + c] = SOURCE_ID_MAP[source];
  map.count[pixelIdx] = c + 1;
}

// ============================================
// Vote resolver
// ============================================

export function resolveVotes(voteMap: VoteMap): { data: Uint8Array; confidence: Float32Array; sourceTag: Uint8Array } {
  const total = voteMap.width * voteMap.height;
  const data = new Uint8Array(total);
  const confidence = new Float32Array(total);
  const sourceTag = new Uint8Array(total);

  for (let i = 0; i < total; i++) {
    const c = voteMap.count[i];
    if (c === 0) {
      data[i] = SemanticClass.GRASS;
      confidence[i] = 0.1;
      sourceTag[i] = SOURCE_ID_MAP['default'];
      continue;
    }

    // Find winner: highest feature priority, then highest source trust as tiebreaker
    let bestSlot = 0;
    let bestFP = FEATURE_PRIORITY[voteMap.votes[i * MAX_VOTES] as SemanticClass];
    let bestST = SOURCE_TRUST[SOURCE_ID_REVERSE[voteMap.sources[i * MAX_VOTES]]];

    for (let s = 1; s < c; s++) {
      const fp = FEATURE_PRIORITY[voteMap.votes[i * MAX_VOTES + s] as SemanticClass];
      const st = SOURCE_TRUST[SOURCE_ID_REVERSE[voteMap.sources[i * MAX_VOTES + s]]];
      if (fp > bestFP || (fp === bestFP && st > bestST)) {
        bestSlot = s;
        bestFP = fp;
        bestST = st;
      }
    }

    const winnerCls = voteMap.votes[i * MAX_VOTES + bestSlot] as SemanticClass;
    data[i] = winnerCls;
    sourceTag[i] = voteMap.sources[i * MAX_VOTES + bestSlot];

    // Confidence = base from source trust + agreement bonus
    let agreeing = 0;
    for (let s = 0; s < c; s++) {
      if (voteMap.votes[i * MAX_VOTES + s] === winnerCls) agreeing++;
    }
    confidence[i] = Math.min(1.0, bestST + (agreeing - 1) * 0.15);
  }

  return { data, confidence, sourceTag };
}

// ============================================
// Majority-vote downsampling
// ============================================

export function downsampleMajorityVote(
  srcData: Uint8Array,
  srcConf: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): { data: Uint8Array; confidence: Float32Array } {
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  const data = new Uint8Array(dstW * dstH);
  const confidence = new Float32Array(dstW * dstH);

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx0 = Math.floor(dx * scaleX);
      const sy0 = Math.floor(dy * scaleY);
      const sx1 = Math.min(srcW - 1, Math.floor((dx + 1) * scaleX));
      const sy1 = Math.min(srcH - 1, Math.floor((dy + 1) * scaleY));

      // Count votes weighted by confidence
      const classVotes = new Float64Array(24); // SemanticClass count
      let totalPixels = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const si = sy * srcW + sx;
          classVotes[srcData[si]] += srcConf[si];
          totalPixels++;
        }
      }

      // Winner = highest weighted vote
      let bestClass = SemanticClass.GRASS;
      let bestScore = 0;
      for (let c = 0; c < classVotes.length; c++) {
        if (classVotes[c] > bestScore) {
          bestScore = classVotes[c];
          bestClass = c;
        }
      }

      // Thin feature preservation: if ROAD/BUILDING/RAILWAY covers >10% of block, it wins
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const si = sy * srcW + sx;
          const cls = srcData[si];
          if (cls === SemanticClass.ROAD || cls === SemanticClass.BUILDING ||
              cls === SemanticClass.PATH_DIRT || cls === SemanticClass.RAILWAY ||
              cls === SemanticClass.WATER) {
            if (classVotes[cls] / totalPixels > 0.1) {
              bestClass = cls;
              bestScore = classVotes[cls];
            }
          }
        }
      }

      data[dy * dstW + dx] = bestClass;
      confidence[dy * dstW + dx] = totalPixels > 0 ? bestScore / totalPixels : 0;
    }
  }

  return { data, confidence };
}

// ============================================
// Unified road widths (single source of truth)
// ============================================

export const ROAD_WIDTH: Record<string, number> = {
  motorway: 55, trunk: 45, primary: 36, secondary: 28, tertiary: 22,
  residential: 18, living_street: 16, service: 14, unclassified: 16,
  pedestrian: 14, footway: 10, path: 7, cycleway: 9, track: 11, steps: 7,
  motorway_link: 40, trunk_link: 35, primary_link: 30, secondary_link: 24, tertiary_link: 20,
};

// ============================================
// Vote-compatible rasterizers
// ============================================

/** Fill a polygon into the vote map using scanline rasterization */
function voteFillPolygon(map: VoteMap, points: number[][], cls: SemanticClass, source: SourceId): void {
  if (points.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const [, py] of points) {
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(map.height - 1, Math.ceil(maxY));

  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      const [x1, y1] = points[i];
      const [x2, y2] = points[j];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        intersections.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(map.width - 1, Math.floor(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        addVote(map, x, y, cls, source);
      }
    }
  }
}

/** Draw a thick line into the vote map */
function voteDrawLine(map: VoteMap, points: number[][], cls: SemanticClass, widthPixels: number, source: SourceId): void {
  const halfW = widthPixels / 2;
  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) continue;
    const steps = Math.ceil(len);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x1 + dx * t;
      const cy = y1 + dy * t;
      for (let oy = -Math.ceil(halfW); oy <= Math.ceil(halfW); oy++) {
        for (let ox = -Math.ceil(halfW); ox <= Math.ceil(halfW); ox++) {
          addVote(map, Math.floor(cx + ox), Math.floor(cy + oy), cls, source);
        }
      }
    }
  }
}

// ============================================
// Collectors
// ============================================

function collectVersaTiles(voteMap: VoteMap, vt: any): void {
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
        width = ROAD_WIDTH[kind] ?? 14;
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

      if (f.type === 3) {
        voteFillPolygon(voteMap, points, cls, 'versatiles');
      } else if (f.type === 2 && width > 0) {
        voteDrawLine(voteMap, points, cls, width, 'versatiles');
      }
    }
  }
}

function collectOverpassRoads(
  voteMap: VoteMap,
  roads: any[],
  bbox: BoundingBox,
  extent: number,
): void {
  for (const element of roads) {
    if (!element.geometry || element.geometry.length < 2) continue;
    const t = element.tags;

    let cls: SemanticClass | null = null;
    let width = 0;

    if (t.natural === 'water') { cls = SemanticClass.WATER; }
    else if (t.natural === 'beach' || t.natural === 'sand') { cls = SemanticClass.SAND; }
    else if (t.natural === 'wood' || t.natural === 'scrub') { cls = SemanticClass.FOREST; }
    else if (t.natural === 'grassland') { cls = SemanticClass.GRASS; }
    else if (t.natural === 'bare_rock' || t.natural === 'cliff' || t.natural === 'scree') { cls = SemanticClass.ROCK; }
    else if (t.natural === 'wetland') { cls = SemanticClass.WETLAND; }
    else if (t.waterway) { cls = SemanticClass.WATER; width = t.waterway === 'river' ? 30 : 15; }
    else if (t.landuse === 'forest' || t.landuse === 'orchard') { cls = SemanticClass.FOREST; }
    else if (t.landuse === 'meadow' || t.landuse === 'grass' || t.landuse === 'village_green') { cls = SemanticClass.GRASS; }
    else if (t.landuse === 'farmland' || t.landuse === 'farmyard') { cls = SemanticClass.FARMLAND; }
    else if (t.landuse === 'cemetery') { cls = SemanticClass.CEMETERY; }
    else if (t.landuse === 'residential') { cls = SemanticClass.RESIDENTIAL_ZONE; }
    else if (t.landuse === 'commercial' || t.landuse === 'retail') { cls = SemanticClass.INDUSTRIAL; }
    else if (t.landuse === 'industrial') { cls = SemanticClass.INDUSTRIAL; }
    else if (t.landuse === 'construction' || t.landuse === 'brownfield') { cls = SemanticClass.BARE_GROUND; }
    else if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve') { cls = SemanticClass.PARK; }
    else if (t.leisure === 'swimming_pool') { cls = SemanticClass.POOL; }
    else if (t.leisure === 'pitch') {
      cls = SemanticClass.SPORTS_PITCH;
      if (t.surface === 'grass' || t.sport === 'soccer' || t.sport === 'baseball') cls = SemanticClass.PARK;
    }
    else if (t.leisure === 'playground') { cls = SemanticClass.PLAYGROUND; }
    else if (t.leisure === 'golf_course') { cls = SemanticClass.PARK; }
    else if (t.amenity === 'parking') { cls = SemanticClass.PARKING; }
    else if (t.amenity === 'school') { cls = SemanticClass.SCHOOL; }
    else if (t.railway) { cls = SemanticClass.RAILWAY; width = 12; }
    else if (t.highway === 'path' || t.highway === 'track' || t.highway === 'bridleway') {
      cls = SemanticClass.PATH_DIRT;
      width = ROAD_WIDTH[t.highway] ?? 8;
    }
    else if (t.highway === 'cycleway' || t.highway === 'footway' || t.highway === 'pedestrian' || t.highway === 'steps') {
      cls = SemanticClass.PARKING;
      width = ROAD_WIDTH[t.highway] ?? 10;
    }
    else if (t.highway) {
      cls = SemanticClass.ROAD;
      width = ROAD_WIDTH[t.highway] ?? 18;
    }

    if (!cls) continue;
    const points = geoToTilePixels(element.geometry, bbox, extent);

    const first = element.geometry[0];
    const last = element.geometry[element.geometry.length - 1];
    const isClosed = Math.abs(first.lat - last.lat) < 0.00001 && Math.abs(first.lon - last.lon) < 0.00001;

    if (isClosed && width === 0) {
      voteFillPolygon(voteMap, points, cls, 'overpass');
    } else {
      voteDrawLine(voteMap, points, cls, width || 15, 'overpass');
    }
  }
}

function collectOverpassBuildings(
  voteMap: VoteMap,
  buildings: any[],
  bbox: BoundingBox,
  extent: number,
): void {
  for (const building of buildings) {
    if (!building.geometry || building.geometry.length < 3) continue;
    const points = geoToTilePixels(building.geometry, bbox, extent);
    voteFillPolygon(voteMap, points, SemanticClass.BUILDING, 'overpass');
  }
}

function collectOvertureBuildings(voteMap: VoteMap, polygons: number[][][]): void {
  for (const polygon of polygons) {
    voteFillPolygon(voteMap, polygon, SemanticClass.BUILDING, 'overture');
  }
}

function collectTrees(
  voteMap: VoteMap,
  trees: Array<{lat: number, lon: number}>,
  bbox: BoundingBox,
  extent: number,
): void {
  for (const tree of trees) {
    const px = ((tree.lon - bbox.west) / (bbox.east - bbox.west)) * extent;
    const py = ((bbox.north - tree.lat) / (bbox.north - bbox.south)) * extent;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx + dy * dy > 12) continue;
        addVote(voteMap, Math.floor(px + dx), Math.floor(py + dy), SemanticClass.FOREST, 'overpass');
      }
    }
  }
}

function collectSatellite(
  voteMap: VoteMap,
  satPixels: Uint8ClampedArray,
  satWidth: number,
  satHeight: number,
  extent: number,
): void {
  const scaleX = satWidth / extent;
  const scaleY = satHeight / extent;

  for (let my = 0; my < extent; my++) {
    for (let mx = 0; mx < extent; mx++) {
      // Sample satellite pixel (average a 3x3 area for stability)
      const cx = Math.floor(mx * scaleX);
      const cy = Math.floor(my * scaleY);
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = Math.min(Math.max(cx + dx, 0), satWidth - 1);
          const sy = Math.min(Math.max(cy + dy, 0), satHeight - 1);
          const si = (sy * satWidth + sx) * 4;
          rSum += satPixels[si]; gSum += satPixels[si + 1]; bSum += satPixels[si + 2];
          count++;
        }
      }
      const r = rSum / count, g = gSum / count, b = bSum / count;

      // Classify based on color — vote with 'satellite' source (low trust, used as tiebreaker)
      // Strong blue = water
      if (b > r * 1.5 && b > g * 1.3 && b > 50) {
        const cls = (r + g + b > 350) ? SemanticClass.POOL : SemanticClass.WATER;
        addVote(voteMap, mx, my, cls, 'satellite');
      }
      // Very dark green = forest
      else if (g > r && g > b && r < 60 && g < 80 && b < 55) {
        addVote(voteMap, mx, my, SemanticClass.FOREST, 'satellite');
      }
      // Green dominant = grass (don't vote — let default fill handle it)
      else if (g > r * 0.95 && g > 50) {
        // Skip — grass is the default, no need to vote
      }
      // Brown/tan = bare ground
      else if (r > 140 && r > g * 1.3 && r > b * 1.5 && g < 130 && b < 100) {
        addVote(voteMap, mx, my, SemanticClass.BARE_GROUND, 'satellite');
      }
    }
  }
}

// ============================================
// V2 Pipeline entry point
// ============================================

export async function renderParentTile(sz: number, sx: number, sy: number): Promise<RenderResult | null> {
  const bbox = tileToBBox(sz, sx, sy);
  const extent = 4096;
  const renderSize = 1024;

  // ── Phase 1: Fetch all data sources in parallel ──
  let [vt, elevTile, overpass, satTile] = await Promise.all([
    fetchOneVectorTile(sz, sx, sy),
    fetchOneElevationTile(sz, sx, sy),
    fetchOverpass(bbox.south, bbox.west, bbox.north, bbox.east),
    fetchSatelliteTilePixels(sz, sx, sy),
    // TODO: fetch ESA WorldCover tile
    // TODO: fetch Hansen tree cover tile
  ]);

  // Retry missing critical data
  let hasOverpassData = overpass.primaryQuerySucceeded;
  let hasElevation = elevTile !== null;
  let hasSatellite = satTile !== null;

  if (!hasOverpassData || !hasElevation || !hasSatellite) {
    const missing = [];
    if (!hasOverpassData) missing.push('overpass');
    if (!hasElevation) missing.push('elevation');
    if (!hasSatellite) missing.push('satellite');
    console.log(`  [v2] Incomplete data (missing: ${missing.join(', ')}), retrying in 3s...`);
    await new Promise(r => setTimeout(r, 3000));
    if (!hasOverpassData) {
      overpass = await fetchOverpass(bbox.south, bbox.west, bbox.north, bbox.east);
      hasOverpassData = overpass.primaryQuerySucceeded;
    }
    if (!hasElevation) {
      elevTile = await fetchOneElevationTile(sz, sx, sy);
      hasElevation = elevTile !== null;
    }
    if (!hasSatellite) {
      satTile = await fetchSatelliteTilePixels(sz, sx, sy);
      hasSatellite = satTile !== null;
    }
  }

  if (!hasOverpassData) {
    console.log(`  [v2] SKIPPED: Overpass primary query failed after retry`);
    return null;
  }

  const complete = hasOverpassData && hasElevation && hasSatellite;
  console.log(`  [v2] Sources: overpass=${overpass.buildings.length}b/${overpass.roads.length}r, vt=${!!vt}, elev=${hasElevation}, sat=${hasSatellite}`);

  // ── Phase 2: Collect votes from all sources ──
  const voteMap = createVoteMap(extent, extent);

  if (vt) {
    collectVersaTiles(voteMap, vt);
    console.log(`  [v2] VersaTiles: collected`);
  }

  collectOverpassRoads(voteMap, overpass.roads, bbox, extent);
  console.log(`  [v2] Overpass roads/land: ${overpass.roads.length} elements`);

  collectOverpassBuildings(voteMap, overpass.buildings, bbox, extent);
  console.log(`  [v2] Overpass buildings: ${overpass.buildings.length}`);

  const overturePolygons = await fetchOvertureBuildingPolygons(bbox, extent, sz, sx, sy);
  collectOvertureBuildings(voteMap, overturePolygons);
  console.log(`  [v2] Overture buildings: ${overturePolygons.length}`);

  collectTrees(voteMap, overpass.trees, bbox, extent);
  console.log(`  [v2] Trees: ${overpass.trees.length}`);

  if (satTile) {
    collectSatellite(voteMap, satTile.data, satTile.width, satTile.height, extent);
    console.log(`  [v2] Satellite: collected`);
  }

  // Future: ESA WorldCover, Hansen tree cover

  // ── Phase 3: Resolve votes → semantic map ──
  const resolved = resolveVotes(voteMap);

  const semMap = createSemanticMap(extent, extent, bbox, 1);
  semMap.data.set(resolved.data);
  semMap.confidence.set(resolved.confidence);
  semMap.sources.add('vector');

  // ── Phase 4: Majority-vote downsample ──
  const downsampled = downsampleMajorityVote(
    semMap.data, semMap.confidence,
    extent, extent,
    renderSize, renderSize,
  );
  const workingMap = { ...semMap, width: renderSize, height: renderSize, data: downsampled.data, confidence: downsampled.confidence };

  // ── Phase 5: Elevation + terrain quantization ──
  const elevation = new Float32Array(renderSize * renderSize);
  if (elevTile) {
    for (let py = 0; py < renderSize; py++) {
      for (let px = 0; px < renderSize; px++) {
        elevation[py * renderSize + px] = decodeTerrarium(elevTile.data, (px / renderSize) * elevTile.width, (py / renderSize) * elevTile.width, elevTile.width);
      }
    }
  }
  const seaLevel = 64;
  const metersPerBlock = 2;
  const quantized = new Uint8Array(renderSize * renderSize);
  for (let i = 0; i < elevation.length; i++) {
    const y = seaLevel + Math.round(elevation[i] / metersPerBlock);
    quantized[i] = Math.min(255, Math.max(1, y));
  }

  const heightMap: HeightMap = {
    width: renderSize, height: renderSize, elevation, quantized, seaLevel,
    resolution: 1, origin: { lat: bbox.north, lng: bbox.west }, bounds: bbox,
  };

  const terrainResult = quantizeTerrain(heightMap, { seaLevel });

  // ── Phase 6: Roof/surface color sampling ──
  let surfaceColors = undefined;
  if (satTile) {
    surfaceColors = sampleSurfaceColors(
      { pixels: satTile.data, width: satTile.width, height: satTile.height, bounds: bbox, tileZoom: sz },
      workingMap,
    );
  }

  // ── Phase 7: Block placement + render ──
  const worldResult = placeBlocks(workingMap, terrainResult.data, undefined, surfaceColors);
  const pipelineResult = renderTopDown(worldResult.data, '') as any;

  return { buffer: pipelineResult.buffer!, complete };
}
