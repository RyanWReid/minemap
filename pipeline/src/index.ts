import { resolve } from 'path';
import type { BoundingBox } from './types.js';
import { ingestSatellite } from './ingest/satellite.js';
import { ingestElevation } from './ingest/elevation.js';
import { ingestOSM } from './ingest/osm.js';
import { fuseVectorData } from './semantic/vector-fuser.js';
import { classifyFromRaster } from './semantic/raster-classifier.js';
import { quantizeTerrain } from './terrain/quantizer.js';
import { placeBlocks } from './voxel/placer.js';
import { renderTopDown } from './preview/top-down.js';
import { renderSemanticDebug } from './semantic/class-map.js';
import { exportSchem } from './export/schem.js';
import { exportMapTiles } from './preview/tile-export.js';
import { sampleSurfaceColors } from './semantic/roof-sampler.js';

// ============================================
// CLI argument parsing
// ============================================

function parseArgs(): { bbox: BoundingBox; outputDir: string; zoom: number; name: string } {
  const args = process.argv.slice(2);

  // Default: a small area of Central Park, Manhattan
  let bbox: BoundingBox = {
    north: 40.770,
    south: 40.764,
    east: -73.970,
    west: -73.980,
  };

  let outputDir = resolve('output');
  let zoom = 14;
  let name = 'default';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--bbox': {
        const parts = args[++i].split(',').map(Number);
        if (parts.length !== 4) {
          console.error('--bbox requires 4 comma-separated values: south,west,north,east');
          process.exit(1);
        }
        bbox = { south: parts[0], west: parts[1], north: parts[2], east: parts[3] };
        break;
      }
      case '--zoom':
        zoom = parseInt(args[++i]);
        break;
      case '--output':
        outputDir = resolve(args[++i]);
        break;
      case '--name':
        name = args[++i];
        break;
      case '--help':
        console.log(`
Minecraft Map Pipeline — Phase 1

Usage:
  npx tsx src/index.ts [options]

Options:
  --bbox south,west,north,east   Bounding box (decimal degrees)
  --zoom N                       Tile zoom level (default: 14)
  --output DIR                   Output directory (default: ./output)
  --name NAME                    Run name (default: "default")
  --help                         Show this help

Example:
  npx tsx src/index.ts --bbox 40.764,-73.980,40.770,-73.970 --name central-park
`);
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  return { bbox, outputDir: resolve(outputDir, name), zoom, name };
}

// ============================================
// Main pipeline
// ============================================

async function main() {
  const { bbox, outputDir, zoom, name } = parseArgs();

  console.log(`\n=== Minecraft Map Pipeline ===`);
  console.log(`Region: ${name}`);
  console.log(`BBox: ${bbox.south},${bbox.west} -> ${bbox.north},${bbox.east}`);
  console.log(`Zoom: ${zoom}`);
  console.log(`Output: ${outputDir}\n`);

  const totalStart = Date.now();

  // ---- Stage 1: Ingest ----
  console.log('STAGE 1: Ingest');

  // Satellite at higher zoom for detail; OSM/elevation at their native zooms
  const satZoom = Math.min(zoom + 4, 18); // z18 = 0.45m/pixel
  const [satelliteResult, elevationResult, osmResult] = await Promise.all([
    ingestSatellite(bbox, satZoom, outputDir),
    ingestElevation(bbox, zoom, 64, outputDir),
    ingestOSM(bbox, zoom, outputDir),
  ]);

  console.log(`  Satellite: ${satelliteResult.data.width}x${satelliteResult.data.height}px (${satelliteResult.metadata.durationMs}ms)`);
  console.log(`  Elevation: ${elevationResult.data.width}x${elevationResult.data.height}px (${elevationResult.metadata.durationMs}ms)`);
  console.log(`  OSM: ${osmResult.data.features.length} features (${osmResult.metadata.durationMs}ms)`);

  // ---- Stage 2: Semantic Map ----
  console.log('\nSTAGE 2: Semantic Classification');

  // Primary: fuse OSM vector data (deterministic, rule-based)
  const semanticResult = fuseVectorData(osmResult.data, outputDir);
  const semanticMap = semanticResult.data;

  // Fallback: fill remaining UNKNOWN cells from satellite imagery
  classifyFromRaster(satelliteResult.data, semanticMap, outputDir);

  // Save final semantic map debug image
  const semanticDebugPath = `${outputDir}/02-semantic/class-map-final.png`;
  renderSemanticDebug(semanticMap, semanticDebugPath);
  console.log(`  Saved: ${semanticDebugPath}`);

  // ---- Stage 3: Voxelize ----
  console.log('\nSTAGE 3: Voxelize');

  // Downsample semantic map to a manageable block count.
  // The heightmap stays at its native resolution — the placer scales lookups.
  const maxBlocks = 512;
  const scaleDown = Math.max(1, Math.floor(Math.max(semanticMap.width, semanticMap.height) / maxBlocks));

  let workingSemanticMap = semanticMap;

  if (scaleDown > 1) {
    const newW = Math.ceil(semanticMap.width / scaleDown);
    const newH = Math.ceil(semanticMap.height / scaleDown);
    console.log(`  Downscaling semantic map ${semanticMap.width}x${semanticMap.height} -> ${newW}x${newH}`);

    const newData = new Uint8Array(newW * newH);
    const newConfidence = new Float32Array(newW * newH);
    for (let ny = 0; ny < newH; ny++) {
      for (let nx = 0; nx < newW; nx++) {
        const srcIdx = Math.min(ny * scaleDown, semanticMap.height - 1) * semanticMap.width +
                       Math.min(nx * scaleDown, semanticMap.width - 1);
        newData[ny * newW + nx] = semanticMap.data[srcIdx];
        newConfidence[ny * newW + nx] = semanticMap.confidence[srcIdx];
      }
    }

    workingSemanticMap = {
      ...semanticMap,
      width: newW,
      height: newH,
      data: newData,
      confidence: newConfidence,
    };
  }

  // ---- Stage 2.5: Terrain Quantization ----
  console.log('\nSTAGE 2.5: Terrain Quantization');
  const terrainResult = quantizeTerrain(elevationResult.data, { seaLevel: 64 }, outputDir);

  const worldResult = placeBlocks(workingSemanticMap, terrainResult.data, outputDir);

  // ---- Stage 4: Preview ----
  console.log('\nSTAGE 4: Preview');

  const previewPath = `${outputDir}/04-voxel/top-down.png`;
  renderTopDown(worldResult.data, previewPath);

  // ---- Stage 5: Export ----
  console.log('\nSTAGE 5: Export');

  const schemPath = `${outputDir}/05-export/${name}.schem`;
  const schemResult = exportSchem(worldResult.data, schemPath);

  // ---- Stage 6: Map Tiles ----
  console.log('\nSTAGE 6: Map Tiles');

  const tileInfo = exportMapTiles(worldResult.data, outputDir);

  // ---- Summary ----
  const totalMs = Date.now() - totalStart;
  console.log(`\n=== Pipeline Complete ===`);
  console.log(`Total time: ${totalMs}ms`);
  console.log(`World: ${worldResult.data.blockWidth}x${worldResult.data.blockDepth} blocks, ${worldResult.data.chunks.size} chunks`);
  console.log(`Map tiles: z${tileInfo.minZoom}-z${tileInfo.maxZoom} in ${tileInfo.tileDir}`);
  console.log(`\nTo view: npx tsx src/serve.ts --dir ${outputDir}`);
  console.log('');
}

main().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
