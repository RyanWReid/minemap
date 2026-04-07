import type { OSMData } from '../ingest/osm.js';
import type { SemanticMap, StageResult } from '../types.js';
import { SemanticClass } from '../types.js';
import { createSemanticMap, fillPolygon, drawLine, renderSemanticDebug, classDistribution } from './class-map.js';

/** Priority order: higher priority classes overwrite lower ones */
const CLASS_PRIORITY: Record<SemanticClass, number> = {
  [SemanticClass.UNKNOWN]: 0,
  [SemanticClass.RESIDENTIAL_ZONE]: 1,
  [SemanticClass.GRASS]: 2,
  [SemanticClass.BARE_GROUND]: 2,
  [SemanticClass.SCRUB]: 2,
  [SemanticClass.FARMLAND]: 3,
  [SemanticClass.FOREST]: 4,
  [SemanticClass.PARK]: 4,
  [SemanticClass.CEMETERY]: 4,
  [SemanticClass.WETLAND]: 4,
  [SemanticClass.SAND]: 4,
  [SemanticClass.ROCK]: 4,
  [SemanticClass.SNOW]: 4,
  [SemanticClass.INDUSTRIAL]: 5,
  [SemanticClass.PARKING]: 5,
  [SemanticClass.WATER]: 6,
  [SemanticClass.RAILWAY]: 7,
  [SemanticClass.ROAD]: 8,
  [SemanticClass.BUILDING]: 9,
};

/**
 * Fuse OSM vector features into a SemanticMap.
 *
 * This is the primary rule-based classification path.
 * OSM data tells us exactly what each feature IS (building, road, park, etc.)
 * so no AI or guessing is needed.
 */
export function fuseVectorData(
  osmData: OSMData,
  outputDir?: string,
): StageResult<SemanticMap> {
  const start = Date.now();

  // Map size = tile grid * tile extent
  const width = osmData.tileGridWidth * osmData.tileExtent;
  const height = osmData.tileGridHeight * osmData.tileExtent;

  // Create semantic map at vector tile resolution
  const map = createSemanticMap(width, height, osmData.bounds, 1);
  map.sources.add('vector');

  // Fill background as grass (default land)
  for (let i = 0; i < map.data.length; i++) {
    map.data[i] = SemanticClass.GRASS;
    map.confidence[i] = 0.1;
  }

  // Sort features by priority (low priority first, high priority overwrites)
  const sortedFeatures = [...osmData.features].sort(
    (a, b) => (CLASS_PRIORITY[a.semanticClass] || 0) - (CLASS_PRIORITY[b.semanticClass] || 0),
  );

  console.log(`  Fusing ${sortedFeatures.length} features into semantic map (${width}x${height})...`);

  for (const feature of sortedFeatures) {
    const confidence = CLASS_PRIORITY[feature.semanticClass] / 10;

    if (feature.type === 'polygon') {
      fillPolygon(map, feature.geometry, feature.semanticClass, confidence, 'vector');
    } else if (feature.type === 'line') {
      drawLine(map, feature.geometry, feature.semanticClass, feature.width || 2, confidence, 'vector');
    }
  }

  // Log class distribution
  const dist = classDistribution(map);
  console.log('  Class distribution:', dist);

  const debugOutputs: StageResult<SemanticMap>['debugOutputs'] = [];
  if (outputDir) {
    const path = `${outputDir}/02-semantic/class-map.png`;
    renderSemanticDebug(map, path);
    debugOutputs.push({ name: 'class-map', path, description: 'Color-coded semantic class map' });
  }

  return {
    data: map,
    metadata: { stage: 'vector-fuser', durationMs: Date.now() - start, timestamp: Date.now() },
    debugOutputs,
  };
}
