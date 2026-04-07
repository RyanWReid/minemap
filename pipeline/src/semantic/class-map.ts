import { createCanvas } from 'canvas';
import type { BoundingBox, GeoPoint, SemanticMap, SemanticSource } from '../types.js';
import { SemanticClass, SEMANTIC_CLASS_COLORS } from '../types.js';
import { savePNG } from '../util/image.js';

/** Create an empty SemanticMap filled with UNKNOWN */
export function createSemanticMap(
  width: number,
  height: number,
  bounds: BoundingBox,
  resolution: number,
): SemanticMap {
  return {
    width,
    height,
    data: new Uint8Array(width * height).fill(SemanticClass.UNKNOWN),
    resolution,
    origin: { lat: bounds.north, lng: bounds.west },
    bounds,
    confidence: new Float32Array(width * height).fill(0),
    sources: new Set<SemanticSource>(),
  };
}

/** Get the class at a pixel position */
export function getClass(map: SemanticMap, x: number, y: number): SemanticClass {
  if (x < 0 || x >= map.width || y < 0 || y >= map.height) return SemanticClass.UNKNOWN;
  return map.data[y * map.width + x];
}

/** Set the class at a pixel position (only if confidence is higher) */
export function setClass(
  map: SemanticMap,
  x: number,
  y: number,
  cls: SemanticClass,
  confidence: number,
  source: SemanticSource,
): void {
  if (x < 0 || x >= map.width || y < 0 || y >= map.height) return;
  const idx = y * map.width + x;

  // Only overwrite if higher confidence
  if (confidence >= map.confidence[idx]) {
    map.data[idx] = cls;
    map.confidence[idx] = confidence;
    map.sources.add(source);
  }
}

/** Fill a polygon in the semantic map using scanline rasterization */
export function fillPolygon(
  map: SemanticMap,
  points: number[][],
  cls: SemanticClass,
  confidence: number,
  source: SemanticSource,
): void {
  if (points.length < 3) return;

  // Get bounding box of the polygon
  let minY = Infinity, maxY = -Infinity;
  for (const [, py] of points) {
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(map.height - 1, Math.ceil(maxY));

  // Scanline fill
  for (let y = minY; y <= maxY; y++) {
    const intersections: number[] = [];

    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      const [x1, y1] = points[i];
      const [x2, y2] = points[j];

      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const x = x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
        intersections.push(x);
      }
    }

    intersections.sort((a, b) => a - b);

    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(map.width - 1, Math.floor(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        setClass(map, x, y, cls, confidence, source);
      }
    }
  }
}

/** Draw a thick line in the semantic map (for roads) */
export function drawLine(
  map: SemanticMap,
  points: number[][],
  cls: SemanticClass,
  widthPixels: number,
  confidence: number,
  source: SemanticSource,
): void {
  const halfW = widthPixels / 2;

  for (let i = 0; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];

    // Bresenham-ish with width
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.5) continue;

    const steps = Math.ceil(len);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = x1 + dx * t;
      const cy = y1 + dy * t;

      // Fill a square around the center point
      for (let oy = -Math.ceil(halfW); oy <= Math.ceil(halfW); oy++) {
        for (let ox = -Math.ceil(halfW); ox <= Math.ceil(halfW); ox++) {
          setClass(map, Math.floor(cx + ox), Math.floor(cy + oy), cls, confidence, source);
        }
      }
    }
  }
}

/** Render semantic map as a color-coded debug image */
export function renderSemanticDebug(map: SemanticMap, path: string): void {
  const canvas = createCanvas(map.width, map.height);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(map.width, map.height);
  const pixels = imageData.data;

  for (let i = 0; i < map.width * map.height; i++) {
    const cls = map.data[i] as SemanticClass;
    const [r, g, b] = SEMANTIC_CLASS_COLORS[cls] ?? [128, 128, 128];
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  savePNG(canvas, path);
}

/** Count cells per class */
export function classDistribution(map: SemanticMap): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < map.data.length; i++) {
    const cls = SemanticClass[map.data[i]] || 'UNKNOWN';
    counts[cls] = (counts[cls] || 0) + 1;
  }
  return counts;
}
