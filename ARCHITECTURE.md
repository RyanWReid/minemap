# Minecraft Map — Voxelization Pipeline Architecture

## Overview

A modular pipeline that converts real-world geographic data into a Minecraft-like voxel world. Deterministic by default, with AI as an optional fallback behind clear interfaces.

```
INPUT SOURCES              PIPELINE STAGES              OUTPUTS
--------------             ----------------             -------
Satellite tiles   -->  [1. Ingest]                   Top-down PNG preview
OSM vector data   -->  [2. Semantic Map]  --------> Intermediate masks
Elevation/DEM     -->  [3. Terrain Gen]              Voxel chunk data
                       [4. Voxelizer]                .schem / .vox export
                       [5. Block Palette]            Web map tiles
                       [6. Export/Preview]            Debug overlays
```

---

## Folder Structure

```
minecraft-map/
  pipeline/
    src/
      index.ts                  # CLI entry point
      types.ts                  # All shared type definitions

      ingest/
        satellite.ts            # Fetch/load satellite raster tiles
        osm.ts                  # Fetch/parse OSM vector data
        elevation.ts            # Fetch/decode DEM heightmap tiles
        worldcover.ts           # Fetch pre-computed land cover classification

      semantic/
        class-map.ts            # SemanticMap data structure (2D grid of land classes)
        raster-classifier.ts    # Rule-based: pixel color -> land class
        vector-fuser.ts         # OSM features -> semantic map overlay
        worldcover-loader.ts    # Pre-computed ESA/Dynamic World -> semantic map
        ai-fallback.ts          # OPTIONAL: AI segmentation for ambiguous regions

      terrain/
        heightmap.ts            # HeightMap data structure
        quantizer.ts            # Continuous elevation -> stepped Minecraft terrain
        slope-stepper.ts        # Generate staircase terrain from gradients
        water-leveler.ts        # Flatten water bodies to uniform Y level

      voxel/
        chunk.ts                # VoxelChunk data structure (16x16x256 block grid)
        world.ts                # VoxelWorld (collection of chunks)
        placer.ts               # Place blocks based on semantic map + height
        road-simplifier.ts      # Snap roads to block grid, simplify widths
        building-extruder.ts    # Extrude building footprints to 3D
        tree-placer.ts          # Place Minecraft tree structures
        water-filler.ts         # Fill water volumes

      palette/
        block-types.ts          # Minecraft block type definitions
        color-table.ts          # RGB -> block type mapping (OKLab nearest-neighbor)
        biome-rules.ts          # Biome/climate -> block family rules
        style-hints.ts          # OPTIONAL: AI-assisted style interpretation

      export/
        schem.ts                # Export to .schem (Sponge Schematic v3)
        vox.ts                  # Export to .vox (MagicaVoxel)
        nbt.ts                  # NBT encoding utilities
        chunk-data.ts           # Export raw chunk data (JSON)

      preview/
        top-down.ts             # Render top-down PNG from voxel data
        tile-renderer.ts        # Generate web map tiles from voxel data
        debug-overlay.ts        # Render debug masks (semantic, height, etc.)

      util/
        coord.ts                # Lat/lng <-> tile <-> block coordinate transforms
        color.ts                # Color space conversions (RGB, OKLab, CIELAB)
        image.ts                # Image load/save helpers

    test/
      semantic.test.ts
      terrain.test.ts
      voxel.test.ts
      palette.test.ts
      export.test.ts

    cli/
      ingest.ts                 # CLI: fetch data for a bounding box
      classify.ts               # CLI: generate semantic map
      voxelize.ts               # CLI: run full pipeline
      preview.ts                # CLI: render preview image
      export.ts                 # CLI: export to .schem/.vox
```

---

## Data Models

### 1. BoundingBox
```ts
interface BoundingBox {
  north: number;  // latitude
  south: number;
  east: number;   // longitude
  west: number;
}
```

### 2. SemanticClass (enum)
```ts
enum SemanticClass {
  UNKNOWN = 0,
  WATER = 1,
  GRASS = 2,
  FOREST = 3,
  FARMLAND = 4,
  SAND = 5,
  ROCK = 6,
  SNOW = 7,
  ROAD = 8,
  BUILDING = 9,
  PARKING = 10,
  RAILWAY = 11,
  WETLAND = 12,
  SCRUB = 13,
  BARE_GROUND = 14,
  PARK = 15,
  CEMETERY = 16,
  INDUSTRIAL = 17,
  RESIDENTIAL_ZONE = 18,
}
```

### 3. SemanticMap
```ts
interface SemanticMap {
  width: number;        // pixels/blocks
  height: number;
  data: Uint8Array;     // SemanticClass per cell (row-major)
  resolution: number;   // meters per cell
  origin: { lat: number; lng: number };
  confidence: Float32Array; // 0-1 confidence per cell (for AI fallback)
  source: ('raster' | 'vector' | 'worldcover' | 'ai')[];
}
```

### 4. HeightMap
```ts
interface HeightMap {
  width: number;
  height: number;
  data: Float32Array;   // elevation in meters (continuous)
  quantized: Uint8Array; // elevation in blocks (0-255, after stepping)
  seaLevel: number;     // Y level for sea level (default: 64)
  resolution: number;
}
```

### 5. BlockType
```ts
interface BlockType {
  id: string;              // e.g. "minecraft:grass_block"
  name: string;            // e.g. "Grass Block"
  mapColor: [number, number, number]; // RGB for top-down preview
  category: 'terrain' | 'vegetation' | 'structure' | 'road' | 'water' | 'decoration';
}
```

### 6. VoxelChunk
```ts
interface VoxelChunk {
  cx: number;            // chunk X (in chunk coords, 1 chunk = 16 blocks)
  cz: number;            // chunk Z
  blocks: Uint16Array;   // block palette index, 16x256x16 (XYZ order)
  palette: BlockType[];  // blocks used in this chunk
  height: number;        // max Y used
}
```

### 7. VoxelWorld
```ts
interface VoxelWorld {
  chunks: Map<string, VoxelChunk>; // key: "cx,cz"
  bounds: BoundingBox;
  blockWidth: number;    // total X blocks
  blockDepth: number;    // total Z blocks
  seaLevel: number;
  palette: BlockType[];  // global palette
}
```

### 8. PipelineStageResult
```ts
interface PipelineStageResult<T> {
  data: T;
  metadata: {
    stage: string;
    timestamp: number;
    durationMs: number;
    inputHash: string;
  };
  debugOutputs: { name: string; path: string }[];
}
```

---

## Where AI Is Used vs. Not Used

### DETERMINISTIC (no AI) — the core pipeline

| Stage | What it does | How |
|-------|-------------|-----|
| **Satellite ingest** | Fetch raster tiles | HTTP fetch, tile math |
| **OSM ingest** | Fetch vector features | Overpass API / vector tiles |
| **Elevation ingest** | Fetch DEM tiles | AWS Terrain Tiles, decode Terrarium |
| **WorldCover load** | Load pre-computed land classes | ESA WorldCover / Dynamic World tiles |
| **Vector fusion** | OSM features -> semantic map | Tag-based rules (building=yes -> BUILDING, highway=* -> ROAD, etc.) |
| **Raster classify** | Pixel color -> land class | Color distance thresholds (green=GRASS, blue=WATER, gray=ROAD) |
| **Terrain quantize** | Continuous height -> stepped blocks | Floor to integer, staircase algorithm |
| **Water leveling** | Flatten water to uniform Y | Set all WATER cells to seaLevel |
| **Block placement** | Semantic class + height -> 3D blocks | Rule table: GRASS@Y -> grass_block on dirt stack |
| **Road simplify** | Snap roads to block grid | Bresenham line rasterization, width quantization |
| **Building extrude** | Footprint + height -> 3D box | Fill polygon, stack walls, add roof |
| **Tree placement** | Place Minecraft tree structures | Scatter in FOREST/PARK, avoid collisions |
| **Block palette** | Class -> block type | Lookup table keyed by SemanticClass + biome |
| **Export** | Write .schem / .vox | Binary format encoding |
| **Preview** | Render top-down image | Read block colors, write PNG |

### AI-ASSISTED (optional, behind interfaces)

| Stage | When triggered | What it does | Fallback if no AI |
|-------|---------------|-------------|-------------------|
| **ai-fallback.ts** | SemanticMap has UNKNOWN cells > threshold | Run segmentation model on satellite tile to classify ambiguous pixels | Leave as UNKNOWN -> map to dirt |
| **style-hints.ts** | User enables "smart palette" | Suggest block variations based on regional architectural style | Use default palette |
| **Landmark abstraction** | User enables landmarks | Recognize notable structures, suggest simplified Minecraft builds | Skip landmarks |
| **Missing data inference** | Gaps in elevation or OSM coverage | Interpolate/infer missing features | Use defaults |

### AI interface contract
```ts
interface AIClassifier {
  classify(image: ImageData, existingMap: SemanticMap): Promise<SemanticMap>;
  readonly modelId: string;
  readonly confidence: number;
}

interface AIStyleAdvisor {
  suggestPalette(region: BoundingBox, semanticMap: SemanticMap): Promise<PaletteOverrides>;
  readonly modelId: string;
}
```

AI modules:
- Are never called automatically — require explicit `--use-ai` flag
- Return confidence scores on every cell they touch
- Their outputs are saved as debug images before being applied
- The pipeline runs identically without them (just with more UNKNOWN/default cells)

---

## Pipeline Flow

```
1. INGEST
   User provides: bounding box (lat/lng) OR image file
   ├── fetch satellite tiles (raster)
   ├── fetch OSM data (vector)
   ├── fetch elevation DEM (heightmap)
   └── fetch WorldCover (pre-computed classes)
   Output: raw tiles, GeoJSON, heightmap arrays
   Debug: saved to /output/01-ingest/

2. SEMANTIC MAP
   ├── WorldCover tiles -> base SemanticMap (10m resolution)
   ├── OSM vector overlay -> upgrade BUILDING, ROAD, WATER, PARK, RAILWAY
   ├── Raster fallback -> fill remaining UNKNOWN from satellite pixel colors
   └── [OPTIONAL] AI fallback -> classify remaining UNKNOWN cells
   Output: SemanticMap (Uint8Array grid)
   Debug: color-coded class map PNG saved to /output/02-semantic/

3. TERRAIN
   ├── DEM -> HeightMap (continuous meters)
   ├── Quantize to integer block heights
   ├── Apply staircase stepping (no slopes > 1 block per cell)
   └── Flatten WATER cells to seaLevel
   Output: HeightMap with .quantized
   Debug: grayscale heightmap PNG saved to /output/03-terrain/

4. VOXELIZE
   For each (x, z) cell in the semantic map:
   ├── Look up SemanticClass and quantized height Y
   ├── Place terrain column (bedrock -> stone -> surface block)
   ├── Place surface features:
   │   ├── ROAD -> road blocks at surface
   │   ├── BUILDING -> extrude walls + roof from Y to Y+height
   │   ├── FOREST -> place tree structure at surface
   │   ├── WATER -> fill to seaLevel with water blocks
   │   ├── PARK -> grass + scattered trees
   │   └── etc.
   └── Organize into 16x16 VoxelChunks
   Output: VoxelWorld
   Debug: top-down block color PNG saved to /output/04-voxel/

5. EXPORT
   ├── .schem (Sponge Schematic v3) for WorldEdit
   ├── .vox (MagicaVoxel) for viewing
   ├── chunk JSON for web viewer
   └── web map tiles for our Leaflet frontend
   Output: files in /output/05-export/
```

---

## Block Palette Rules (Phase 2)

```ts
// Semantic class -> block column rules
const PALETTE_RULES: Record<SemanticClass, ColumnRule> = {
  GRASS:      { surface: 'grass_block', subsurface: 'dirt', depth: 3 },
  FOREST:     { surface: 'grass_block', subsurface: 'dirt', depth: 3, trees: true },
  WATER:      { surface: 'water', subsurface: 'clay', depth: 5, fillToSeaLevel: true },
  ROAD:       { surface: 'gray_concrete', subsurface: 'gravel', depth: 2 },
  BUILDING:   { surface: 'stone_bricks', subsurface: 'stone', depth: 1, extrude: true },
  SAND:       { surface: 'sand', subsurface: 'sandstone', depth: 4 },
  FARMLAND:   { surface: 'farmland', subsurface: 'dirt', depth: 3 },
  ROCK:       { surface: 'stone', subsurface: 'stone', depth: 10 },
  SNOW:       { surface: 'snow_block', subsurface: 'stone', depth: 2 },
  PARK:       { surface: 'grass_block', subsurface: 'dirt', depth: 3, trees: 'sparse' },
  RAILWAY:    { surface: 'gravel', subsurface: 'stone', depth: 2 },
  CEMETERY:   { surface: 'podzol', subsurface: 'dirt', depth: 3 },
  INDUSTRIAL: { surface: 'smooth_stone', subsurface: 'stone', depth: 1 },
  WETLAND:    { surface: 'moss_block', subsurface: 'mud', depth: 3 },
  SCRUB:      { surface: 'grass_block', subsurface: 'coarse_dirt', depth: 3 },
};
```

---

## Tech Stack

- **Language**: TypeScript (Node.js)
- **Image processing**: `canvas` (node-canvas) for raster ops
- **NBT encoding**: `prismarine-nbt` for .schem/.nbt export
- **Vector tiles**: `@mapbox/vector-tile` + `pbf` for OSM data
- **CLI**: `commander` or simple arg parsing
- **Testing**: `vitest`
- **No heavy frameworks** — pure functions, explicit data flow

---

## What We Already Have vs. What's New

### Already built (in current codebase):
- VersaTiles vector tile fetching
- Block color palette (`blockColors.js`)
- Tile rendering with canvas (`tileRenderer.js`)
- Minecraft tree sprites (`treeSprites.js`)
- Elevation tile fetching (AWS Terrarium)
- Elevation shading post-processing
- Web map frontend with Leaflet
- Satellite/roads toggle

### New for the pipeline:
- Proper SemanticMap data structure
- WorldCover/Dynamic World integration (replaces naive color classification)
- True 3D voxel generation (VoxelChunk, VoxelWorld)
- Building extrusion from OSM footprints
- Road snapping/simplification
- .schem and .vox exporters
- CLI interface for each stage
- AI fallback interfaces (implement later)
- Debug output at each stage
