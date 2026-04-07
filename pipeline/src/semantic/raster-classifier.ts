import type { SatelliteData } from '../ingest/satellite.js';
import type { SemanticMap, StageResult } from '../types.js';
import { SemanticClass } from '../types.js';
import { setClass } from './class-map.js';
import { rgbDistSq } from '../util/color.js';

/**
 * Reference colors for rule-based satellite pixel classification.
 * These are approximate — the main pipeline should prefer OSM vector data.
 * This classifier only fills UNKNOWN cells as a fallback.
 */
const COLOR_RULES: Array<{
  class: SemanticClass;
  color: [number, number, number];
  threshold: number; // max RGB distance squared
}> = [
  // Water (dark blue/teal)
  { class: SemanticClass.WATER, color: [40, 60, 100], threshold: 3000 },
  { class: SemanticClass.WATER, color: [30, 50, 80], threshold: 2500 },
  { class: SemanticClass.WATER, color: [50, 80, 120], threshold: 3000 },

  // Dense vegetation / forest (dark green)
  { class: SemanticClass.FOREST, color: [30, 70, 30], threshold: 2500 },
  { class: SemanticClass.FOREST, color: [40, 80, 35], threshold: 2500 },
  { class: SemanticClass.FOREST, color: [20, 60, 20], threshold: 2000 },

  // Grass / light vegetation
  { class: SemanticClass.GRASS, color: [80, 120, 60], threshold: 3000 },
  { class: SemanticClass.GRASS, color: [100, 140, 70], threshold: 3000 },

  // Sand / bare ground (tan/beige)
  { class: SemanticClass.SAND, color: [190, 180, 150], threshold: 3000 },
  { class: SemanticClass.SAND, color: [210, 200, 170], threshold: 3000 },

  // Snow (white/very light)
  { class: SemanticClass.SNOW, color: [230, 230, 235], threshold: 2000 },
  { class: SemanticClass.SNOW, color: [245, 245, 250], threshold: 1500 },

  // Roads / pavement (gray)
  { class: SemanticClass.ROAD, color: [130, 130, 130], threshold: 2000 },
  { class: SemanticClass.ROAD, color: [160, 160, 160], threshold: 2000 },

  // Buildings / urban (light gray/beige)
  { class: SemanticClass.BUILDING, color: [180, 175, 170], threshold: 2500 },
  { class: SemanticClass.BUILDING, color: [200, 195, 185], threshold: 2500 },

  // Farmland (brown/golden)
  { class: SemanticClass.FARMLAND, color: [150, 130, 80], threshold: 3000 },
  { class: SemanticClass.FARMLAND, color: [170, 150, 100], threshold: 3000 },

  // Rock (dark gray)
  { class: SemanticClass.ROCK, color: [100, 95, 90], threshold: 2000 },
];

/**
 * Rule-based satellite pixel classifier.
 * Only fills cells that are currently UNKNOWN in the semantic map.
 * Uses simple RGB distance matching — no AI.
 */
export function classifyFromRaster(
  satellite: SatelliteData,
  semanticMap: SemanticMap,
  outputDir?: string,
): StageResult<SemanticMap> {
  const start = Date.now();

  // The satellite image and semantic map may have different resolutions.
  // Scale satellite pixels to map cells.
  const scaleX = satellite.width / semanticMap.width;
  const scaleY = satellite.height / semanticMap.height;

  let filled = 0;
  let total = 0;

  for (let my = 0; my < semanticMap.height; my++) {
    for (let mx = 0; mx < semanticMap.width; mx++) {
      const idx = my * semanticMap.width + mx;
      if (semanticMap.data[idx] !== SemanticClass.UNKNOWN) continue;
      total++;

      // Sample the satellite pixel
      const sx = Math.floor(mx * scaleX);
      const sy = Math.floor(my * scaleY);
      const si = (sy * satellite.width + sx) * 4;
      const r = satellite.pixels[si];
      const g = satellite.pixels[si + 1];
      const b = satellite.pixels[si + 2];

      // Find best matching color rule
      let bestClass = SemanticClass.GRASS; // default fallback
      let bestDist = Infinity;

      for (const rule of COLOR_RULES) {
        const dist = rgbDistSq([r, g, b], rule.color);
        if (dist < rule.threshold && dist < bestDist) {
          bestDist = dist;
          bestClass = rule.class;
        }
      }

      setClass(semanticMap, mx, my, bestClass, 0.3, 'raster');
      filled++;
    }
  }

  console.log(`  Raster classifier filled ${filled}/${total} unknown cells`);

  return {
    data: semanticMap,
    metadata: { stage: 'raster-classifier', durationMs: Date.now() - start, timestamp: Date.now() },
    debugOutputs: [],
  };
}
