import type { BlockType, ColumnRule } from '../types.js';
import { SemanticClass } from '../types.js';

// ============================================
// Block definitions with Minecraft map colors
// ============================================

export const BLOCKS: Record<string, BlockType> = {
  air:              { id: 'minecraft:air',              name: 'Air',              mapColor: [0, 0, 0],       category: 'air' },
  stone:            { id: 'minecraft:stone',            name: 'Stone',            mapColor: [112, 112, 112], category: 'terrain' },
  granite:          { id: 'minecraft:granite',          name: 'Granite',          mapColor: [153, 102, 89],  category: 'terrain' },
  dirt:             { id: 'minecraft:dirt',             name: 'Dirt',             mapColor: [151, 109, 77],  category: 'terrain' },
  coarse_dirt:      { id: 'minecraft:coarse_dirt',      name: 'Coarse Dirt',      mapColor: [151, 109, 77],  category: 'terrain' },
  grass_block:      { id: 'minecraft:grass_block',      name: 'Grass Block',      mapColor: [127, 178, 56],  category: 'terrain' },
  sand:             { id: 'minecraft:sand',             name: 'Sand',             mapColor: [247, 233, 163], category: 'terrain' },
  sandstone:        { id: 'minecraft:sandstone',        name: 'Sandstone',        mapColor: [213, 201, 140], category: 'terrain' },
  gravel:           { id: 'minecraft:gravel',           name: 'Gravel',           mapColor: [112, 112, 112], category: 'terrain' },
  clay:             { id: 'minecraft:clay',             name: 'Clay',             mapColor: [164, 168, 184], category: 'terrain' },
  snow_block:       { id: 'minecraft:snow_block',       name: 'Snow',             mapColor: [255, 255, 255], category: 'terrain' },
  ice:              { id: 'minecraft:ice',              name: 'Ice',              mapColor: [160, 160, 255], category: 'terrain' },
  podzol:           { id: 'minecraft:podzol',           name: 'Podzol',           mapColor: [112, 70, 35],   category: 'terrain' },
  farmland:         { id: 'minecraft:farmland',         name: 'Farmland',         mapColor: [143, 100, 60],  category: 'terrain' },
  mud:              { id: 'minecraft:mud',              name: 'Mud',              mapColor: [100, 90, 75],   category: 'terrain' },
  moss_block:       { id: 'minecraft:moss_block',       name: 'Moss',             mapColor: [80, 120, 50],   category: 'terrain' },
  bedrock:          { id: 'minecraft:bedrock',          name: 'Bedrock',          mapColor: [25, 25, 25],    category: 'terrain' },

  water:            { id: 'minecraft:water',            name: 'Water',            mapColor: [64, 64, 255],   category: 'water' },

  // Logs
  oak_log:          { id: 'minecraft:oak_log',          name: 'Oak Log',          mapColor: [143, 119, 72],  category: 'vegetation' },
  spruce_log:       { id: 'minecraft:spruce_log',       name: 'Spruce Log',       mapColor: [58, 37, 16],    category: 'vegetation' },
  dark_oak_log:     { id: 'minecraft:dark_oak_log',     name: 'Dark Oak Log',     mapColor: [60, 46, 26],    category: 'vegetation' },
  jungle_log:       { id: 'minecraft:jungle_log',       name: 'Jungle Log',       mapColor: [85, 68, 25],    category: 'vegetation' },
  acacia_log:       { id: 'minecraft:acacia_log',       name: 'Acacia Log',       mapColor: [103, 96, 86],   category: 'vegetation' },
  stripped_spruce_log: { id: 'minecraft:stripped_spruce_log', name: 'Stripped Spruce', mapColor: [115, 85, 48], category: 'vegetation' },

  // Leaves
  oak_leaves:       { id: 'minecraft:oak_leaves',       name: 'Oak Leaves',       mapColor: [0, 124, 0],     category: 'vegetation' },
  spruce_leaves:    { id: 'minecraft:spruce_leaves',    name: 'Spruce Leaves',    mapColor: [33, 85, 25],    category: 'vegetation' },
  dark_oak_leaves:  { id: 'minecraft:dark_oak_leaves',  name: 'Dark Oak Leaves',  mapColor: [0, 100, 0],     category: 'vegetation' },
  jungle_leaves:    { id: 'minecraft:jungle_leaves',    name: 'Jungle Leaves',    mapColor: [48, 130, 38],   category: 'vegetation' },
  acacia_leaves:    { id: 'minecraft:acacia_leaves',    name: 'Acacia Leaves',    mapColor: [0, 124, 0],     category: 'vegetation' },

  // Ground cover
  grass:            { id: 'minecraft:grass',            name: 'Grass',            mapColor: [0, 124, 0],     category: 'vegetation' },
  fern:             { id: 'minecraft:fern',             name: 'Fern',             mapColor: [0, 124, 0],     category: 'vegetation' },
  dead_bush:        { id: 'minecraft:dead_bush',        name: 'Dead Bush',        mapColor: [143, 119, 72],  category: 'vegetation' },
  snow:             { id: 'minecraft:snow',             name: 'Snow Layer',       mapColor: [255, 255, 255], category: 'terrain' },
  packed_ice:       { id: 'minecraft:packed_ice',       name: 'Packed Ice',       mapColor: [140, 140, 230], category: 'terrain' },
  dirt_path:        { id: 'minecraft:dirt_path',        name: 'Dirt Path',        mapColor: [148, 121, 65],  category: 'road' },

  // Roads
  gray_concrete:    { id: 'minecraft:gray_concrete',    name: 'Gray Concrete',    mapColor: [76, 76, 76],    category: 'road' },
  light_gray_concrete: { id: 'minecraft:light_gray_concrete', name: 'Light Gray Concrete', mapColor: [153, 153, 153], category: 'road' },
  black_concrete:   { id: 'minecraft:black_concrete',   name: 'Black Concrete',   mapColor: [25, 25, 25],    category: 'road' },
  green_concrete:   { id: 'minecraft:green_concrete',   name: 'Green Concrete',   mapColor: [73, 91, 36],    category: 'road' },
  white_concrete:   { id: 'minecraft:white_concrete',   name: 'White Concrete',   mapColor: [230, 230, 230], category: 'structure' },

  // Structure blocks
  stone_bricks:     { id: 'minecraft:stone_bricks',     name: 'Stone Bricks',     mapColor: [112, 112, 112], category: 'structure' },
  stone_brick_slab: { id: 'minecraft:stone_brick_slab', name: 'Stone Brick Slab', mapColor: [112, 112, 112], category: 'structure' },
  stone_brick_stairs: { id: 'minecraft:stone_brick_stairs', name: 'Stone Brick Stairs', mapColor: [112, 112, 112], category: 'structure' },
  mossy_cobblestone: { id: 'minecraft:mossy_cobblestone', name: 'Mossy Cobblestone', mapColor: [90, 108, 90], category: 'structure' },
  cobblestone_wall: { id: 'minecraft:cobblestone_wall', name: 'Cobblestone Wall', mapColor: [112, 112, 112], category: 'structure' },
  bricks:           { id: 'minecraft:bricks',           name: 'Bricks',           mapColor: [153, 51, 51],   category: 'structure' },
  quartz_block:     { id: 'minecraft:quartz_block',     name: 'Quartz',           mapColor: [255, 252, 245], category: 'structure' },
  smooth_quartz:    { id: 'minecraft:smooth_quartz',    name: 'Smooth Quartz',    mapColor: [255, 252, 245], category: 'structure' },
  quartz_stairs:    { id: 'minecraft:quartz_stairs',    name: 'Quartz Stairs',    mapColor: [255, 252, 245], category: 'structure' },
  smooth_stone:     { id: 'minecraft:smooth_stone',     name: 'Smooth Stone',     mapColor: [160, 160, 160], category: 'structure' },
  polished_andesite: { id: 'minecraft:polished_andesite', name: 'Polished Andesite', mapColor: [130, 130, 130], category: 'structure' },
  oak_planks:       { id: 'minecraft:oak_planks',       name: 'Oak Planks',       mapColor: [143, 119, 72],  category: 'structure' },
  spruce_planks:    { id: 'minecraft:spruce_planks',    name: 'Spruce Planks',    mapColor: [115, 85, 48],   category: 'structure' },
  dark_oak_slab:    { id: 'minecraft:dark_oak_slab',    name: 'Dark Oak Slab',    mapColor: [60, 46, 26],    category: 'structure' },
  spruce_slab:      { id: 'minecraft:spruce_slab',      name: 'Spruce Slab',      mapColor: [115, 85, 48],   category: 'structure' },
  oak_slab:         { id: 'minecraft:oak_slab',         name: 'Oak Slab',         mapColor: [143, 119, 72],  category: 'structure' },
  acacia_slab:      { id: 'minecraft:acacia_slab',      name: 'Acacia Slab',      mapColor: [168, 90, 50],   category: 'structure' },
  cobblestone:      { id: 'minecraft:cobblestone',      name: 'Cobblestone',      mapColor: [112, 112, 112], category: 'structure' },
  terracotta:       { id: 'minecraft:terracotta',       name: 'Terracotta',       mapColor: [152, 94, 67],   category: 'structure' },
  white_terracotta: { id: 'minecraft:white_terracotta', name: 'White Terracotta', mapColor: [209, 178, 161], category: 'structure' },
  orange_terracotta: { id: 'minecraft:orange_terracotta', name: 'Orange Terracotta', mapColor: [162, 84, 38], category: 'structure' },
  red_terracotta:   { id: 'minecraft:red_terracotta',   name: 'Red Terracotta',   mapColor: [143, 61, 47],   category: 'structure' },
  yellow_terracotta: { id: 'minecraft:yellow_terracotta', name: 'Yellow Terracotta', mapColor: [186, 133, 35], category: 'structure' },
  cyan_terracotta:  { id: 'minecraft:cyan_terracotta',  name: 'Cyan Terracotta',  mapColor: [86, 91, 91],    category: 'structure' },
  brown_terracotta: { id: 'minecraft:brown_terracotta', name: 'Brown Terracotta', mapColor: [77, 51, 36],    category: 'structure' },
  dark_oak_planks:  { id: 'minecraft:dark_oak_planks',  name: 'Dark Oak Planks',  mapColor: [60, 46, 26],    category: 'structure' },
  white_concrete:   { id: 'minecraft:white_concrete',   name: 'White Concrete',   mapColor: [230, 230, 230], category: 'structure' },
  light_gray_concrete_struct: { id: 'minecraft:light_gray_concrete', name: 'Light Gray Concrete', mapColor: [153, 153, 153], category: 'structure' },
  light_blue_concrete: { id: 'minecraft:light_blue_concrete', name: 'Light Blue Concrete', mapColor: [102, 153, 216], category: 'structure' },
  smooth_sandstone: { id: 'minecraft:smooth_sandstone', name: 'Smooth Sandstone', mapColor: [213, 201, 140], category: 'structure' },
  cut_sandstone:    { id: 'minecraft:cut_sandstone',    name: 'Cut Sandstone',    mapColor: [213, 201, 140], category: 'structure' },
  sandstone_slab:   { id: 'minecraft:sandstone_slab',   name: 'Sandstone Slab',   mapColor: [213, 201, 140], category: 'structure' },
  sandstone_stairs: { id: 'minecraft:sandstone_stairs', name: 'Sandstone Stairs', mapColor: [213, 201, 140], category: 'structure' },
  sandstone_wall:   { id: 'minecraft:sandstone_wall',   name: 'Sandstone Wall',   mapColor: [213, 201, 140], category: 'structure' },
  terracotta_wall:  { id: 'minecraft:terracotta_wall',  name: 'Terracotta Wall',  mapColor: [152, 94, 67],   category: 'structure' },

  // Fences
  oak_fence:        { id: 'minecraft:oak_fence',        name: 'Oak Fence',        mapColor: [143, 119, 72],  category: 'decoration' },
  dark_oak_fence:   { id: 'minecraft:dark_oak_fence',   name: 'Dark Oak Fence',   mapColor: [60, 46, 26],    category: 'decoration' },
  spruce_fence:     { id: 'minecraft:spruce_fence',     name: 'Spruce Fence',     mapColor: [115, 85, 48],   category: 'decoration' },

  // Glass
  glass:            { id: 'minecraft:glass',            name: 'Glass',            mapColor: [175, 213, 228], category: 'structure' },
  glass_pane:       { id: 'minecraft:glass_pane',       name: 'Glass Pane',       mapColor: [175, 213, 228], category: 'structure' },

  rail:             { id: 'minecraft:rail',             name: 'Rail',             mapColor: [100, 80, 50],   category: 'decoration' },

  // Lane markings & detail blocks
  yellow_concrete:  { id: 'minecraft:yellow_concrete',  name: 'Yellow Concrete',  mapColor: [241, 175, 21],  category: 'road' },
  white_carpet:     { id: 'minecraft:white_carpet',     name: 'White Carpet',     mapColor: [233, 236, 236], category: 'road' },
  lily_pad:         { id: 'minecraft:lily_pad',         name: 'Lily Pad',         mapColor: [0, 124, 0],     category: 'vegetation' },
  blue_ice:         { id: 'minecraft:blue_ice',         name: 'Blue Ice',         mapColor: [40, 40, 180],   category: 'water' },
  dark_gray_concrete: { id: 'minecraft:gray_concrete',  name: 'Shadow Block',     mapColor: [40, 40, 40],    category: 'structure' },
};

// ============================================
// Column rules: how to build a vertical column for each semantic class
// ============================================

export const COLUMN_RULES: Record<SemanticClass, ColumnRule> = {
  [SemanticClass.UNKNOWN]:          { surface: 'minecraft:dirt',             subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone' },
  [SemanticClass.WATER]:            { surface: 'minecraft:water',            subsurface: 'minecraft:clay',    depth: 5, base: 'minecraft:stone', fillToSeaLevel: true },
  [SemanticClass.GRASS]:            { surface: 'minecraft:grass_block',      subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone' },
  [SemanticClass.FOREST]:           { surface: 'minecraft:grass_block',      subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone', trees: true },
  [SemanticClass.FARMLAND]:         { surface: 'minecraft:farmland',         subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone' },
  [SemanticClass.SAND]:             { surface: 'minecraft:sand',             subsurface: 'minecraft:sandstone', depth: 4, base: 'minecraft:stone' },
  [SemanticClass.ROCK]:             { surface: 'minecraft:stone',            subsurface: 'minecraft:stone',   depth: 10, base: 'minecraft:stone' },
  [SemanticClass.SNOW]:             { surface: 'minecraft:snow_block',       subsurface: 'minecraft:stone',   depth: 2, base: 'minecraft:stone' },
  [SemanticClass.ROAD]:             { surface: 'minecraft:gray_concrete',    subsurface: 'minecraft:gravel',  depth: 2, base: 'minecraft:stone' },
  [SemanticClass.BUILDING]:         { surface: 'minecraft:stone_bricks',     subsurface: 'minecraft:stone',   depth: 1, base: 'minecraft:stone', extrude: true },
  [SemanticClass.PARKING]:          { surface: 'minecraft:smooth_stone',     subsurface: 'minecraft:gravel',  depth: 2, base: 'minecraft:stone' },
  [SemanticClass.RAILWAY]:          { surface: 'minecraft:gravel',           subsurface: 'minecraft:stone',   depth: 2, base: 'minecraft:stone' },
  [SemanticClass.WETLAND]:          { surface: 'minecraft:moss_block',       subsurface: 'minecraft:mud',     depth: 3, base: 'minecraft:stone' },
  [SemanticClass.SCRUB]:            { surface: 'minecraft:grass_block',      subsurface: 'minecraft:coarse_dirt', depth: 3, base: 'minecraft:stone' },
  [SemanticClass.BARE_GROUND]:      { surface: 'minecraft:coarse_dirt',      subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone' },
  [SemanticClass.PARK]:             { surface: 'minecraft:grass_block',      subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone', trees: 'sparse' },
  [SemanticClass.CEMETERY]:         { surface: 'minecraft:podzol',           subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone' },
  [SemanticClass.INDUSTRIAL]:       { surface: 'minecraft:smooth_stone',     subsurface: 'minecraft:stone',   depth: 1, base: 'minecraft:stone' },
  [SemanticClass.RESIDENTIAL_ZONE]: { surface: 'minecraft:grass_block',      subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone' },
  [SemanticClass.POOL]:             { surface: 'minecraft:water',            subsurface: 'minecraft:quartz_block', depth: 1, base: 'minecraft:stone', fillToSeaLevel: true },
  [SemanticClass.SPORTS_PITCH]:     { surface: 'minecraft:green_concrete',   subsurface: 'minecraft:dirt',    depth: 2, base: 'minecraft:stone' },
  [SemanticClass.PLAYGROUND]:       { surface: 'minecraft:sand',             subsurface: 'minecraft:dirt',    depth: 2, base: 'minecraft:stone' },
  [SemanticClass.SCHOOL]:           { surface: 'minecraft:grass_block',      subsurface: 'minecraft:dirt',    depth: 3, base: 'minecraft:stone' },
  [SemanticClass.PATH_DIRT]:        { surface: 'minecraft:dirt_path',        subsurface: 'minecraft:dirt',    depth: 2, base: 'minecraft:stone' },
};
