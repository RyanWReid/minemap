import { SemanticClass } from '../types.js';

// ============================================
// Road classification and widths
// ============================================

export const ROAD_KINDS = new Set([
  'motorway','trunk','primary','secondary','tertiary','residential','living_street',
  'service','unclassified','pedestrian','footway','path','cycleway','track','steps',
  'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link',
]);

/** Road widths used by VersaTiles vector tile processing */
export const ROAD_WIDTHS: Record<string, number> = {
  motorway:48, trunk:40, primary:32, secondary:24, tertiary:20,
  residential:16, living_street:14, service:12, unclassified:14,
  pedestrian:12, footway:8, path:6, cycleway:8, track:10, steps:6,
};

/** Road widths used by Overpass highway processing */
export const HIGHWAY_WIDTHS: Record<string, number> = {
  motorway:60, trunk:50, primary:40, secondary:30, tertiary:25,
  residential:20, living_street:18, service:15, unclassified:18,
  pedestrian:15, footway:10, path:8, cycleway:10, track:12, steps:8,
};

/** Highway tag -> SemanticClass mapping */
export const HIGHWAY_CLASS: Record<string, SemanticClass> = {};
['motorway','trunk','primary','secondary','tertiary','residential','living_street',
 'service','unclassified','pedestrian','footway','path','cycleway','track','steps',
 'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link'].forEach(k => HIGHWAY_CLASS[k] = SemanticClass.ROAD);

// ============================================
// Land/site classification
// ============================================

export const LAND_MAP: Record<string, SemanticClass> = {
  forest: SemanticClass.FOREST,
  wood: SemanticClass.FOREST,
  nature_reserve: SemanticClass.FOREST,
  grass: SemanticClass.GRASS,
  meadow: SemanticClass.GRASS,
  village_green: SemanticClass.GRASS,
  park: SemanticClass.PARK,
  garden: SemanticClass.PARK,
  recreation_ground: SemanticClass.PARK,
  farmland: SemanticClass.FARMLAND,
  farmyard: SemanticClass.FARMLAND,
  sand: SemanticClass.SAND,
  beach: SemanticClass.SAND,
  bare_rock: SemanticClass.ROCK,
  wetland: SemanticClass.WETLAND,
  scrub: SemanticClass.SCRUB,
  cemetery: SemanticClass.CEMETERY,
  residential: SemanticClass.RESIDENTIAL_ZONE,
  commercial: SemanticClass.INDUSTRIAL,
  industrial: SemanticClass.INDUSTRIAL,
};

// ============================================
// Geo conversion
// ============================================

/** Convert lat/lng geometry to tile pixel coordinates */
export function geoToTilePixels(
  geom: Array<{lat:number,lon:number}>,
  bbox: {north:number,south:number,east:number,west:number},
  extent: number,
): number[][] {
  return geom.map(p => [
    ((p.lon - bbox.west) / (bbox.east - bbox.west)) * extent,
    ((bbox.north - p.lat) / (bbox.north - bbox.south)) * extent,
  ]);
}
