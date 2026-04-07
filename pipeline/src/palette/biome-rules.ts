import { SemanticClass } from '../types.js';

/**
 * Pre-generated biome/region -> block family mappings.
 * No runtime AI — these are static lookup tables curated at dev time.
 */

export type BiomeType =
  | 'temperate'
  | 'tropical'
  | 'arid'
  | 'arctic'
  | 'mediterranean'
  | 'urban_modern'
  | 'urban_historic'
  | 'rural';

export interface BuildingStyle {
  walls: string[];      // weighted block choices for walls
  roof: string;
  floor: string;
  accent: string;       // trim, windowsills
  minHeight: number;
  maxHeight: number;
}

export interface BiomePalette {
  terrain: {
    surface: string;
    subsurface: string;
    deep: string;
  };
  vegetation: {
    treeLog: string;
    treeLeaves: string;
    groundCover: string; // flowers, ferns, etc.
  };
  water: {
    surface: string;
    bed: string;
  };
  roads: {
    major: string;
    minor: string;
    path: string;
  };
  buildings: BuildingStyle[];
}

/** Select biome from latitude and elevation */
export function selectBiome(lat: number, elevation: number): BiomeType {
  const absLat = Math.abs(lat);
  if (absLat > 60) return 'arctic';
  if (absLat > 45 && elevation > 1500) return 'arctic';
  if (absLat < 15) return 'tropical';
  if (absLat >= 30 && absLat <= 45 && elevation < 500) return 'mediterranean';
  if (elevation > 1000 && absLat > 25) return 'arid'; // high desert
  return 'temperate';
}

export const BIOME_PALETTES: Record<BiomeType, BiomePalette> = {
  temperate: {
    terrain: { surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', deep: 'minecraft:stone' },
    vegetation: { treeLog: 'minecraft:oak_log', treeLeaves: 'minecraft:oak_leaves', groundCover: 'minecraft:grass' },
    water: { surface: 'minecraft:water', bed: 'minecraft:clay' },
    roads: { major: 'minecraft:gray_concrete', minor: 'minecraft:light_gray_concrete', path: 'minecraft:dirt_path' },
    buildings: [
      { walls: ['minecraft:bricks', 'minecraft:stone_bricks'], roof: 'minecraft:dark_oak_slab', floor: 'minecraft:oak_planks', accent: 'minecraft:stone_brick_stairs', minHeight: 6, maxHeight: 15 },
      { walls: ['minecraft:quartz_block', 'minecraft:smooth_quartz'], roof: 'minecraft:gray_concrete', floor: 'minecraft:polished_andesite', accent: 'minecraft:quartz_stairs', minHeight: 8, maxHeight: 25 },
      { walls: ['minecraft:white_concrete', 'minecraft:light_gray_concrete'], roof: 'minecraft:gray_concrete', floor: 'minecraft:smooth_stone', accent: 'minecraft:stone_slab', minHeight: 10, maxHeight: 40 },
    ],
  },

  tropical: {
    terrain: { surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', deep: 'minecraft:stone' },
    vegetation: { treeLog: 'minecraft:jungle_log', treeLeaves: 'minecraft:jungle_leaves', groundCover: 'minecraft:fern' },
    water: { surface: 'minecraft:water', bed: 'minecraft:sand' },
    roads: { major: 'minecraft:gray_concrete', minor: 'minecraft:light_gray_concrete', path: 'minecraft:coarse_dirt' },
    buildings: [
      { walls: ['minecraft:white_concrete', 'minecraft:yellow_terracotta'], roof: 'minecraft:red_terracotta', floor: 'minecraft:terracotta', accent: 'minecraft:dark_oak_fence', minHeight: 4, maxHeight: 10 },
      { walls: ['minecraft:sandstone', 'minecraft:smooth_sandstone'], roof: 'minecraft:acacia_slab', floor: 'minecraft:sandstone', accent: 'minecraft:sandstone_wall', minHeight: 5, maxHeight: 12 },
    ],
  },

  arid: {
    terrain: { surface: 'minecraft:sand', subsurface: 'minecraft:sandstone', deep: 'minecraft:stone' },
    vegetation: { treeLog: 'minecraft:acacia_log', treeLeaves: 'minecraft:acacia_leaves', groundCover: 'minecraft:dead_bush' },
    water: { surface: 'minecraft:water', bed: 'minecraft:sand' },
    roads: { major: 'minecraft:smooth_sandstone', minor: 'minecraft:sandstone', path: 'minecraft:sand' },
    buildings: [
      { walls: ['minecraft:sandstone', 'minecraft:smooth_sandstone', 'minecraft:cut_sandstone'], roof: 'minecraft:sandstone_slab', floor: 'minecraft:smooth_sandstone', accent: 'minecraft:sandstone_stairs', minHeight: 4, maxHeight: 12 },
      { walls: ['minecraft:terracotta', 'minecraft:white_terracotta'], roof: 'minecraft:terracotta', floor: 'minecraft:terracotta', accent: 'minecraft:terracotta_wall', minHeight: 3, maxHeight: 8 },
    ],
  },

  arctic: {
    terrain: { surface: 'minecraft:snow_block', subsurface: 'minecraft:packed_ice', deep: 'minecraft:stone' },
    vegetation: { treeLog: 'minecraft:spruce_log', treeLeaves: 'minecraft:spruce_leaves', groundCover: 'minecraft:snow' },
    water: { surface: 'minecraft:ice', bed: 'minecraft:packed_ice' },
    roads: { major: 'minecraft:gray_concrete', minor: 'minecraft:light_gray_concrete', path: 'minecraft:snow_block' },
    buildings: [
      { walls: ['minecraft:spruce_planks', 'minecraft:stripped_spruce_log'], roof: 'minecraft:spruce_slab', floor: 'minecraft:spruce_planks', accent: 'minecraft:spruce_fence', minHeight: 4, maxHeight: 8 },
      { walls: ['minecraft:stone_bricks', 'minecraft:cobblestone'], roof: 'minecraft:stone_brick_slab', floor: 'minecraft:stone_bricks', accent: 'minecraft:stone_brick_stairs', minHeight: 5, maxHeight: 12 },
    ],
  },

  mediterranean: {
    terrain: { surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', deep: 'minecraft:stone' },
    vegetation: { treeLog: 'minecraft:dark_oak_log', treeLeaves: 'minecraft:dark_oak_leaves', groundCover: 'minecraft:grass' },
    water: { surface: 'minecraft:water', bed: 'minecraft:sand' },
    roads: { major: 'minecraft:gray_concrete', minor: 'minecraft:smooth_stone', path: 'minecraft:cobblestone' },
    buildings: [
      { walls: ['minecraft:white_concrete', 'minecraft:white_terracotta'], roof: 'minecraft:orange_terracotta', floor: 'minecraft:terracotta', accent: 'minecraft:dark_oak_fence', minHeight: 4, maxHeight: 10 },
      { walls: ['minecraft:sandstone', 'minecraft:yellow_terracotta'], roof: 'minecraft:red_terracotta', floor: 'minecraft:smooth_sandstone', accent: 'minecraft:sandstone_wall', minHeight: 5, maxHeight: 12 },
    ],
  },

  urban_modern: {
    terrain: { surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', deep: 'minecraft:stone' },
    vegetation: { treeLog: 'minecraft:oak_log', treeLeaves: 'minecraft:oak_leaves', groundCover: 'minecraft:grass' },
    water: { surface: 'minecraft:water', bed: 'minecraft:clay' },
    roads: { major: 'minecraft:black_concrete', minor: 'minecraft:gray_concrete', path: 'minecraft:light_gray_concrete' },
    buildings: [
      { walls: ['minecraft:light_gray_concrete', 'minecraft:white_concrete', 'minecraft:gray_concrete'], roof: 'minecraft:gray_concrete', floor: 'minecraft:polished_andesite', accent: 'minecraft:glass', minHeight: 15, maxHeight: 60 },
      { walls: ['minecraft:quartz_block', 'minecraft:smooth_quartz'], roof: 'minecraft:smooth_quartz', floor: 'minecraft:quartz_block', accent: 'minecraft:glass_pane', minHeight: 20, maxHeight: 80 },
      { walls: ['minecraft:cyan_terracotta', 'minecraft:light_blue_concrete'], roof: 'minecraft:gray_concrete', floor: 'minecraft:smooth_stone', accent: 'minecraft:glass', minHeight: 10, maxHeight: 45 },
    ],
  },

  urban_historic: {
    terrain: { surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', deep: 'minecraft:stone' },
    vegetation: { treeLog: 'minecraft:oak_log', treeLeaves: 'minecraft:oak_leaves', groundCover: 'minecraft:grass' },
    water: { surface: 'minecraft:water', bed: 'minecraft:clay' },
    roads: { major: 'minecraft:cobblestone', minor: 'minecraft:stone_bricks', path: 'minecraft:cobblestone' },
    buildings: [
      { walls: ['minecraft:bricks', 'minecraft:stone_bricks'], roof: 'minecraft:dark_oak_slab', floor: 'minecraft:oak_planks', accent: 'minecraft:stone_brick_stairs', minHeight: 6, maxHeight: 15 },
      { walls: ['minecraft:cobblestone', 'minecraft:mossy_cobblestone'], roof: 'minecraft:spruce_slab', floor: 'minecraft:cobblestone', accent: 'minecraft:cobblestone_wall', minHeight: 5, maxHeight: 12 },
    ],
  },

  rural: {
    terrain: { surface: 'minecraft:grass_block', subsurface: 'minecraft:dirt', deep: 'minecraft:stone' },
    vegetation: { treeLog: 'minecraft:oak_log', treeLeaves: 'minecraft:oak_leaves', groundCover: 'minecraft:grass' },
    water: { surface: 'minecraft:water', bed: 'minecraft:dirt' },
    roads: { major: 'minecraft:gravel', minor: 'minecraft:dirt_path', path: 'minecraft:dirt_path' },
    buildings: [
      { walls: ['minecraft:oak_planks', 'minecraft:spruce_planks'], roof: 'minecraft:oak_slab', floor: 'minecraft:oak_planks', accent: 'minecraft:oak_fence', minHeight: 4, maxHeight: 8 },
      { walls: ['minecraft:cobblestone', 'minecraft:stone_bricks'], roof: 'minecraft:stone_brick_slab', floor: 'minecraft:cobblestone', accent: 'minecraft:cobblestone_wall', minHeight: 4, maxHeight: 10 },
    ],
  },
};

/** Pick a building style deterministically from a hash */
export function pickBuildingStyle(biome: BiomeType, hash: number): BuildingStyle {
  const palette = BIOME_PALETTES[biome];
  return palette.buildings[hash % palette.buildings.length];
}

/** Pick a wall block from a building style deterministically */
export function pickWallBlock(style: BuildingStyle, hash: number): string {
  return style.walls[hash % style.walls.length];
}
