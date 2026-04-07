import type { BoundingBox, GeoPoint, TileCoord } from '../types.js';

/** Convert lat/lng to tile coordinates at a given zoom level */
export function latlngToTile(lat: number, lng: number, zoom: number): TileCoord {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { z: zoom, x, y };
}

/** Convert tile coordinates to the lat/lng of the tile's NW corner */
export function tileToLatLng(z: number, x: number, y: number): GeoPoint {
  const n = Math.pow(2, z);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lat, lng };
}

/** Get the bounding box of a tile */
export function tileToBBox(z: number, x: number, y: number): BoundingBox {
  const nw = tileToLatLng(z, x, y);
  const se = tileToLatLng(z, x + 1, y + 1);
  return { north: nw.lat, south: se.lat, east: se.lng, west: nw.lng };
}

/** Get all tile coordinates that cover a bounding box at a given zoom */
export function bboxToTiles(bbox: BoundingBox, zoom: number): TileCoord[] {
  const tl = latlngToTile(bbox.north, bbox.west, zoom);
  const br = latlngToTile(bbox.south, bbox.east, zoom);
  const tiles: TileCoord[] = [];
  for (let y = tl.y; y <= br.y; y++) {
    for (let x = tl.x; x <= br.x; x++) {
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

/** Meters per pixel at a given zoom level and latitude */
export function metersPerPixel(lat: number, zoom: number): number {
  return (156543.04 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/** Convert a bounding box to dimensions in meters */
export function bboxToMeters(bbox: BoundingBox): { width: number; height: number } {
  const midLat = (bbox.north + bbox.south) / 2;
  const latM = 111320; // meters per degree latitude (approximate)
  const lngM = 111320 * Math.cos((midLat * Math.PI) / 180);
  return {
    width: Math.abs(bbox.east - bbox.west) * lngM,
    height: Math.abs(bbox.north - bbox.south) * latM,
  };
}

/** Map a lat/lng point to pixel coordinates within a bounding box */
export function geoToPixel(
  point: GeoPoint,
  bbox: BoundingBox,
  width: number,
  height: number,
): { x: number; y: number } {
  const x = ((point.lng - bbox.west) / (bbox.east - bbox.west)) * width;
  const y = ((bbox.north - point.lat) / (bbox.north - bbox.south)) * height;
  return { x: Math.floor(x), y: Math.floor(y) };
}
