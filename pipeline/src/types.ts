// ============================================
// Core geographic types
// ============================================

export interface BoundingBox {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

// ============================================
// Semantic classification
// ============================================

export enum SemanticClass {
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
  POOL = 19,
  SPORTS_PITCH = 20,
  PLAYGROUND = 21,
  SCHOOL = 22,
  PATH_DIRT = 23,
}

export const SEMANTIC_CLASS_NAMES: Record<SemanticClass, string> = {
  [SemanticClass.UNKNOWN]: 'Unknown',
  [SemanticClass.WATER]: 'Water',
  [SemanticClass.GRASS]: 'Grass',
  [SemanticClass.FOREST]: 'Forest',
  [SemanticClass.FARMLAND]: 'Farmland',
  [SemanticClass.SAND]: 'Sand',
  [SemanticClass.ROCK]: 'Rock',
  [SemanticClass.SNOW]: 'Snow',
  [SemanticClass.ROAD]: 'Road',
  [SemanticClass.BUILDING]: 'Building',
  [SemanticClass.PARKING]: 'Parking',
  [SemanticClass.RAILWAY]: 'Railway',
  [SemanticClass.WETLAND]: 'Wetland',
  [SemanticClass.SCRUB]: 'Scrub',
  [SemanticClass.BARE_GROUND]: 'Bare Ground',
  [SemanticClass.PARK]: 'Park',
  [SemanticClass.CEMETERY]: 'Cemetery',
  [SemanticClass.INDUSTRIAL]: 'Industrial',
  [SemanticClass.RESIDENTIAL_ZONE]: 'Residential',
  [SemanticClass.POOL]: 'Pool',
  [SemanticClass.SPORTS_PITCH]: 'Sports Pitch',
  [SemanticClass.PLAYGROUND]: 'Playground',
  [SemanticClass.SCHOOL]: 'School',
  [SemanticClass.PATH_DIRT]: 'Dirt Path',
};

// Color for debug visualization of each class
export const SEMANTIC_CLASS_COLORS: Record<SemanticClass, [number, number, number]> = {
  [SemanticClass.UNKNOWN]:          [128, 128, 128],
  [SemanticClass.WATER]:            [64, 64, 255],
  [SemanticClass.GRASS]:            [109, 153, 48],
  [SemanticClass.FOREST]:           [0, 107, 0],
  [SemanticClass.FARMLAND]:         [151, 109, 77],
  [SemanticClass.SAND]:             [213, 201, 140],
  [SemanticClass.ROCK]:             [112, 112, 112],
  [SemanticClass.SNOW]:             [255, 255, 255],
  [SemanticClass.ROAD]:             [76, 76, 76],
  [SemanticClass.BUILDING]:         [164, 168, 184],
  [SemanticClass.PARKING]:          [100, 100, 100],
  [SemanticClass.RAILWAY]:          [80, 60, 40],
  [SemanticClass.WETLAND]:          [40, 100, 60],
  [SemanticClass.SCRUB]:            [80, 110, 40],
  [SemanticClass.BARE_GROUND]:      [180, 160, 130],
  [SemanticClass.PARK]:             [127, 178, 56],
  [SemanticClass.CEMETERY]:         [90, 100, 70],
  [SemanticClass.INDUSTRIAL]:       [140, 140, 140],
  [SemanticClass.RESIDENTIAL_ZONE]: [170, 150, 130],
  [SemanticClass.POOL]: [60, 180, 220],
  [SemanticClass.SPORTS_PITCH]: [180, 120, 60],
  [SemanticClass.PLAYGROUND]: [200, 160, 80],
  [SemanticClass.SCHOOL]: [180, 160, 140],
  [SemanticClass.PATH_DIRT]: [148, 121, 65],
};

export interface SemanticMap {
  width: number;
  height: number;
  data: Uint8Array;           // SemanticClass per cell, row-major [y * width + x]
  resolution: number;         // meters per cell
  origin: GeoPoint;           // top-left corner
  bounds: BoundingBox;
  confidence: Float32Array;   // 0.0 - 1.0 per cell
  sources: Set<SemanticSource>;
}

export type SemanticSource = 'raster' | 'vector' | 'worldcover' | 'ai';

// ============================================
// Heightmap / terrain
// ============================================

export interface HeightMap {
  width: number;
  height: number;
  elevation: Float32Array;    // meters above sea level (continuous)
  quantized: Uint8Array;      // block Y level (0-255, after stepping)
  seaLevel: number;           // Y level for sea level (default: 64)
  resolution: number;         // meters per cell
  origin: GeoPoint;
  bounds: BoundingBox;
}

// ============================================
// Block types and palette
// ============================================

export type BlockCategory = 'terrain' | 'vegetation' | 'structure' | 'road' | 'water' | 'decoration' | 'air';

export interface BlockType {
  id: string;                                // e.g. "minecraft:grass_block"
  name: string;                              // e.g. "Grass Block"
  mapColor: [number, number, number];        // RGB for top-down preview
  category: BlockCategory;
}

export interface ColumnRule {
  surface: string;           // block ID for surface
  subsurface: string;        // block ID for layers below surface
  depth: number;             // how many subsurface layers
  base: string;              // block ID for deep underground (default: stone)
  trees?: boolean | 'sparse'; // scatter trees on this surface
  extrude?: boolean;         // extrude buildings upward
  fillToSeaLevel?: boolean;  // fill with water down to sea level
}

// ============================================
// Voxel world
// ============================================

export const CHUNK_SIZE_XZ = 16;
export const CHUNK_HEIGHT = 256;

export interface VoxelChunk {
  cx: number;                // chunk X coordinate
  cz: number;                // chunk Z coordinate
  blocks: Uint16Array;       // palette index per block, [x + z*16 + y*16*16]
  palette: BlockType[];      // blocks used in this chunk
  maxY: number;              // highest block placed
}

export interface VoxelWorld {
  chunks: Map<string, VoxelChunk>;   // key: "cx,cz"
  bounds: BoundingBox;
  blockWidth: number;        // total X extent in blocks
  blockDepth: number;        // total Z extent in blocks
  seaLevel: number;
  globalPalette: BlockType[];
}

// ============================================
// Pipeline stage tracking
// ============================================

export interface StageResult<T> {
  data: T;
  metadata: {
    stage: string;
    durationMs: number;
    timestamp: number;
  };
  debugOutputs: DebugOutput[];
}

export interface DebugOutput {
  name: string;
  path: string;
  description: string;
}

// ============================================
// AI interfaces (optional, Phase 3)
// ============================================

export interface AIClassifier {
  classify(
    imageData: ImageData,
    existingMap: SemanticMap,
  ): Promise<SemanticMap>;
  readonly modelId: string;
}

export interface AIStyleAdvisor {
  suggestPalette(
    region: BoundingBox,
    semanticMap: SemanticMap,
  ): Promise<PaletteOverride[]>;
  readonly modelId: string;
}

export interface PaletteOverride {
  semanticClass: SemanticClass;
  originalBlock: string;
  suggestedBlock: string;
  reason: string;
  confidence: number;
}

// ============================================
// OSM feature types (for vector ingestion)
// ============================================

export interface OSMFeature {
  type: 'point' | 'line' | 'polygon';
  semanticClass: SemanticClass;
  geometry: number[][];        // array of [x, y] in pixel/block coords
  properties: Record<string, string | number | boolean>;
  width?: number;              // for roads: width in blocks
  height?: number;             // for buildings: height in blocks
}

// ============================================
// Coordinate utilities
// ============================================

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}
