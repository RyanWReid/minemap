// Minecraft map color palette
// Based on Minecraft's in-game map rendering colors
// Each base color has 3 shades: dark (0.71), normal (0.86), light (1.0)

const BASE_COLORS = {
  GRASS:      [127, 178, 56],
  SAND:       [247, 233, 163],
  WOOL:       [199, 199, 199],
  FIRE:       [255, 0, 0],
  ICE:        [160, 160, 255],
  METAL:      [167, 167, 167],
  PLANT:      [0, 124, 0],
  SNOW:       [255, 255, 255],
  CLAY:       [164, 168, 184],
  DIRT:       [151, 109, 77],
  STONE:      [112, 112, 112],
  WATER:      [64, 64, 255],
  WOOD:       [143, 119, 72],
  QUARTZ:     [255, 252, 245],
  GRAY:       [76, 76, 76],
  LIGHT_GRAY: [153, 153, 153],
  GREEN:      [102, 127, 51],
  RED:        [153, 51, 51],
  BLACK:      [25, 25, 25],
  GOLD:       [250, 238, 77],
  DIAMOND:    [92, 219, 213],
  LAPIS:      [74, 128, 255],
  EMERALD:    [0, 217, 58],
  SPRUCE:     [129, 86, 49],
  NETHER:     [112, 2, 0],
  TERRACOTTA: [209, 177, 161],
  CRIMSON:    [148, 63, 97],
  CYAN:       [22, 156, 157],
  DEEPSLATE:  [100, 100, 100],
};

// Apply shade multiplier to a base color
function shade(color, level) {
  const multipliers = [0.71, 0.86, 1.0];
  const m = multipliers[level] || 0.86;
  return [
    Math.floor(color[0] * m),
    Math.floor(color[1] * m),
    Math.floor(color[2] * m),
  ];
}

// Convert RGB array to CSS string
function rgb(color) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

// Convert RGB array to hex
function hex(color) {
  return '#' + color.map(c => c.toString(16).padStart(2, '0')).join('');
}

// ============================================
// OSM Feature -> Minecraft Color Mappings
// ============================================

// Background color (unexplored land)
const BACKGROUND = shade(BASE_COLORS.GRASS, 1);

// Water
const WATER_COLOR = shade(BASE_COLORS.WATER, 1);
const WATER_DEEP = shade(BASE_COLORS.WATER, 0);

// Roads by class
const ROAD_COLORS = {
  motorway:     shade(BASE_COLORS.GRAY, 2),
  trunk:        shade(BASE_COLORS.GRAY, 2),
  primary:      shade(BASE_COLORS.GRAY, 2),
  secondary:    shade(BASE_COLORS.LIGHT_GRAY, 1),
  tertiary:     shade(BASE_COLORS.LIGHT_GRAY, 1),
  minor:        shade(BASE_COLORS.LIGHT_GRAY, 2),
  residential:  shade(BASE_COLORS.LIGHT_GRAY, 2),
  service:      shade(BASE_COLORS.LIGHT_GRAY, 2),
  path:         shade(BASE_COLORS.DIRT, 1),
  footway:      shade(BASE_COLORS.DIRT, 1),
  pedestrian:   shade(BASE_COLORS.LIGHT_GRAY, 2),
  cycleway:     shade(BASE_COLORS.LIGHT_GRAY, 1),
  track:        shade(BASE_COLORS.DIRT, 0),
  steps:        shade(BASE_COLORS.STONE, 1),
  rail:         shade(BASE_COLORS.STONE, 0),
  subway:       shade(BASE_COLORS.STONE, 0),
  tram:         shade(BASE_COLORS.STONE, 0),
  default:      shade(BASE_COLORS.LIGHT_GRAY, 1),
};

// Road widths in pixels at z17 (1px ~ 1m)
const ROAD_WIDTHS = {
  motorway:    6,
  trunk:       5,
  primary:     4,
  secondary:   3,
  tertiary:    3,
  minor:       2,
  residential: 2,
  service:     1.5,
  path:        1,
  footway:     1,
  pedestrian:  2,
  cycleway:    1,
  track:       1.5,
  steps:       1,
  rail:        2,
  subway:      2,
  tram:        1.5,
  default:     2,
};

// Building colors by type
const BUILDING_COLORS = {
  residential:  shade(BASE_COLORS.TERRACOTTA, 1),
  commercial:   shade(BASE_COLORS.QUARTZ, 1),
  office:       shade(BASE_COLORS.QUARTZ, 2),
  industrial:   shade(BASE_COLORS.STONE, 1),
  retail:       shade(BASE_COLORS.TERRACOTTA, 2),
  church:       shade(BASE_COLORS.QUARTZ, 2),
  hospital:     shade(BASE_COLORS.QUARTZ, 2),
  school:       shade(BASE_COLORS.TERRACOTTA, 1),
  university:   shade(BASE_COLORS.TERRACOTTA, 1),
  garage:       shade(BASE_COLORS.STONE, 0),
  warehouse:    shade(BASE_COLORS.DEEPSLATE, 1),
  default:      shade(BASE_COLORS.CLAY, 2),
};

// Building outline (darker shade)
const BUILDING_OUTLINE = shade(BASE_COLORS.STONE, 0);

// Land use colors
const LANDUSE_COLORS = {
  residential:  shade(BASE_COLORS.GRASS, 1),
  commercial:   shade(BASE_COLORS.LIGHT_GRAY, 1),
  industrial:   shade(BASE_COLORS.STONE, 1),
  retail:       shade(BASE_COLORS.LIGHT_GRAY, 1),
  cemetery:     shade(BASE_COLORS.GREEN, 0),
  military:     shade(BASE_COLORS.GRAY, 1),
  railway:      shade(BASE_COLORS.STONE, 0),
  farmland:     shade(BASE_COLORS.DIRT, 2),
  forest:       shade(BASE_COLORS.PLANT, 1),
  meadow:       shade(BASE_COLORS.GRASS, 2),
  grass:        shade(BASE_COLORS.GRASS, 2),
  orchard:      shade(BASE_COLORS.GREEN, 1),
  vineyard:     shade(BASE_COLORS.GREEN, 0),
  quarry:       shade(BASE_COLORS.STONE, 0),
  default:      shade(BASE_COLORS.GRASS, 1),
};

// Land cover colors
const LANDCOVER_COLORS = {
  farmland: shade(BASE_COLORS.DIRT, 2),
  wood:     shade(BASE_COLORS.PLANT, 1),
  forest:   shade(BASE_COLORS.PLANT, 1),
  grass:    shade(BASE_COLORS.GRASS, 2),
  meadow:   shade(BASE_COLORS.GRASS, 2),
  wetland:  shade(BASE_COLORS.GREEN, 0),
  sand:     shade(BASE_COLORS.SAND, 1),
  beach:    shade(BASE_COLORS.SAND, 2),
  rock:     shade(BASE_COLORS.STONE, 1),
  ice:      shade(BASE_COLORS.ICE, 2),
  scrub:    shade(BASE_COLORS.GREEN, 0),
  park:     shade(BASE_COLORS.GRASS, 2),
  garden:   shade(BASE_COLORS.GRASS, 2),
  default:  shade(BASE_COLORS.GRASS, 1),
};

// Park / leisure
const PARK_COLOR = shade(BASE_COLORS.GRASS, 2);

module.exports = {
  BASE_COLORS,
  shade,
  rgb,
  hex,
  BACKGROUND,
  WATER_COLOR,
  WATER_DEEP,
  ROAD_COLORS,
  ROAD_WIDTHS,
  BUILDING_COLORS,
  BUILDING_OUTLINE,
  LANDUSE_COLORS,
  LANDCOVER_COLORS,
  PARK_COLOR,
};
