/**
 * V1 Terrain Pipeline
 *
 * Original stage-based pipeline with sequential overwrite confidence system.
 * Each data source writes directly to the semantic map with a priority score.
 *
 * Stage order:
 *   0. Default fill (GRASS at 0.1)
 *   1. VersaTiles vector tiles (z14)
 *   2. Overpass data (roads, nature, land use)
 *   3. Overpass buildings (priority 0.95)
 *   4. Overture buildings (gap-fill at 0.9)
 *   5. Individual trees (7x7 circles)
 *   6. Satellite ground refinement (confidence <= 0.15 only)
 *   7. Downsample 4096 -> 1024 (nearest neighbor)
 *   8. Roof/road color sampling
 */

import { SemanticClass } from '../types.js';
import type { BoundingBox, HeightMap } from '../types.js';
import type { RenderResult } from './types.js';

// Data sources
import { fetchOneVectorTile } from '../sources/versatiles.js';
import { fetchOneElevationTile, decodeTerrarium } from '../sources/elevation.js';
import { fetchOverpass } from '../sources/overpass.js';
import { fetchSatelliteTilePixels, refineGroundFromSatellite } from '../sources/satellite.js';
import { fetchOvertureBuildingPolygons } from '../sources/overture.js';
import { ROAD_WIDTHS, HIGHWAY_WIDTHS, LAND_MAP, geoToTilePixels } from '../sources/constants.js';

// Semantic map operations
import { createSemanticMap, fillPolygon, drawLine } from '../semantic/class-map.js';

// Downstream pipeline
import { tileToBBox } from '../util/coord.js';
import { quantizeTerrain } from '../terrain/quantizer.js';
import { sampleSurfaceColors } from '../semantic/roof-sampler.js';
import { placeBlocks } from '../voxel/placer.js';
import { renderTopDown } from '../preview/top-down.js';

export async function renderParentTile(sz: number, sx: number, sy: number): Promise<RenderResult | null> {
  const bbox = tileToBBox(sz, sx, sy);
  const extent = 4096;
  const renderSize = 1024;

  // Fetch all data sources in parallel
  let [vt, elevTile, overpass, satTile] = await Promise.all([
    fetchOneVectorTile(sz, sx, sy),
    fetchOneElevationTile(sz, sx, sy),
    fetchOverpass(bbox.south, bbox.west, bbox.north, bbox.east),
    fetchSatelliteTilePixels(sz, sx, sy),
  ]);

  // Check completeness — all critical data sources must succeed
  let hasOverpassData = overpass.primaryQuerySucceeded;
  let hasElevation = elevTile !== null;
  let hasSatellite = satTile !== null;

  // Retry once if missing critical data
  if (!hasOverpassData || !hasElevation || !hasSatellite) {
    const missing = [];
    if (!hasOverpassData) missing.push('overpass');
    if (!hasElevation) missing.push('elevation');
    if (!hasSatellite) missing.push('satellite');
    console.log(`  Incomplete data (missing: ${missing.join(', ')}), retrying in 3s...`);
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

  // No Overpass data after retry — refuse to render incomplete tile
  if (!hasOverpassData) {
    console.log(`  SKIPPED: Overpass primary query failed after retry — returning 503`);
    return null;
  }

  const complete = hasOverpassData && hasElevation && hasSatellite;

  console.log(`  Overpass: ${overpass.buildings.length} buildings, ${overpass.roads.length} roads`);

  // Build semantic map at full vector tile resolution
  const semMap = createSemanticMap(extent, extent, bbox, 1);
  semMap.sources.add('vector');
  for (let i = 0; i < semMap.data.length; i++) {
    semMap.data[i] = SemanticClass.GRASS;
    semMap.confidence[i] = 0.1;
  }

  // Stage 1: VersaTiles vector tiles
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

  // Stage 2: Overpass data — land cover, water, roads
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
    // Leisure
    else if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve') { cls = SemanticClass.PARK; priority = 0.45; }
    else if (t.leisure === 'swimming_pool') { cls = SemanticClass.POOL; priority = 0.8; }
    else if (t.leisure === 'pitch') {
      cls = SemanticClass.SPORTS_PITCH; priority = 0.6;
      if (t.surface === 'grass' || t.sport === 'soccer' || t.sport === 'baseball') cls = SemanticClass.PARK;
    }
    else if (t.leisure === 'playground') { cls = SemanticClass.PLAYGROUND; priority = 0.55; }
    else if (t.leisure === 'golf_course') { cls = SemanticClass.PARK; priority = 0.45; }
    // Amenities
    else if (t.amenity === 'parking') { cls = SemanticClass.PARKING; priority = 0.6; }
    else if (t.amenity === 'school') { cls = SemanticClass.SCHOOL; priority = 0.2; }
    // Railway
    else if (t.railway) { cls = SemanticClass.RAILWAY; width = 12; priority = 0.75; }
    // Dirt paths
    else if (t.highway === 'path' || t.highway === 'track' || t.highway === 'bridleway') {
      cls = SemanticClass.PATH_DIRT;
      width = HIGHWAY_WIDTHS[t.highway] ?? 8;
      priority = 0.7;
    }
    // Paved paths
    else if (t.highway === 'cycleway' || t.highway === 'footway' || t.highway === 'pedestrian' || t.highway === 'steps') {
      cls = SemanticClass.PARKING;
      width = HIGHWAY_WIDTHS[t.highway] ?? 10;
      priority = 0.75;
    }
    // Roads
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

  // Stage 3: Buildings from Overpass (highest priority)
  for (const building of overpass.buildings) {
    if (!building.geometry || building.geometry.length < 3) continue;
    const points = geoToTilePixels(building.geometry, bbox, extent);
    fillPolygon(semMap, points, SemanticClass.BUILDING, 0.95, 'vector');
  }

  // Stage 4: Overture Maps buildings (gap-fill)
  const overturePolygons = await fetchOvertureBuildingPolygons(bbox, extent, sz, sx, sy);
  console.log(`  Overture direct: ${overturePolygons.length} polygons`);
  let overtureNew = 0;
  for (const polygon of overturePolygons) {
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

  // Stage 5: Individual trees from OSM
  console.log(`  Individual trees: ${overpass.trees.length}`);
  for (const tree of overpass.trees) {
    const px = ((tree.lon - bbox.west) / (bbox.east - bbox.west)) * extent;
    const py = ((bbox.north - tree.lat) / (bbox.north - bbox.south)) * extent;
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

  // Stage 6: Satellite ground refinement
  if (satTile) {
    const refined = refineGroundFromSatellite(semMap, satTile.data, satTile.width, satTile.height);
    console.log(`  Satellite ground refinement: ${refined} cells reclassified`);
  }

  // Stage 7: Downsample 4096 -> 1024 (nearest neighbor)
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

  // Stage 8: Downstream rendering
  const terrainResult = quantizeTerrain(heightMap, { seaLevel });

  let surfaceColors = undefined;
  if (satTile) {
    const satData = {
      pixels: satTile.data,
      width: satTile.width,
      height: satTile.height,
      bounds: bbox,
      tileZoom: sz,
    };
    surfaceColors = sampleSurfaceColors(satData, workingMap);
  }

  const worldResult = placeBlocks(workingMap, terrainResult.data, undefined, surfaceColors);
  const pipelineResult = renderTopDown(worldResult.data, '') as any;

  return { buffer: pipelineResult.buffer!, complete };
}
