// Minecraft tree sprites rendered from top-down view
// Each tree type has a canopy pattern and colors

const { BASE_COLORS, shade } = require('./blockColors');

// Colors
const OAK_LEAVES    = [56, 118, 29];   // Dark oak-ish green
const BIRCH_LEAVES  = [80, 140, 50];   // Lighter birch green
const SPRUCE_LEAVES = [33, 85, 25];    // Dark spruce
const DARK_OAK_LEAVES = [40, 90, 20];  // Very dark
const JUNGLE_LEAVES = [48, 130, 38];   // Tropical green
const OAK_LOG       = [109, 85, 50];   // Brown trunk
const BIRCH_LOG     = [200, 196, 182]; // White birch trunk
const SPRUCE_LOG    = [58, 37, 16];    // Dark trunk
const DARK_OAK_LOG  = [60, 46, 26];   // Dark brown

// Leaf shade variations (simulate depth/texture)
function leafShade(base, seed) {
  const variation = ((seed * 13) % 7) - 3; // -3 to +3
  return [
    Math.min(255, Math.max(0, base[0] + variation * 3)),
    Math.min(255, Math.max(0, base[1] + variation * 4)),
    Math.min(255, Math.max(0, base[2] + variation * 2)),
  ];
}

// Tree definitions - canopy patterns viewed from above
// 0 = empty, 1 = leaves, 2 = trunk, 3 = leaves (darker shade)
const TREE_TYPES = {
  oak: {
    // 7x7 canopy with rounded corners, trunk center
    size: 7,
    pattern: [
      [0,0,1,1,1,0,0],
      [0,1,1,1,1,1,0],
      [1,1,1,3,1,1,1],
      [1,1,3,2,3,1,1],
      [1,1,1,3,1,1,1],
      [0,1,1,1,1,1,0],
      [0,0,1,1,1,0,0],
    ],
    leaves: OAK_LEAVES,
    trunk: OAK_LOG,
  },
  oak_small: {
    // 5x5 small oak
    size: 5,
    pattern: [
      [0,1,1,1,0],
      [1,1,3,1,1],
      [1,3,2,3,1],
      [1,1,3,1,1],
      [0,1,1,1,0],
    ],
    leaves: OAK_LEAVES,
    trunk: OAK_LOG,
  },
  birch: {
    size: 5,
    pattern: [
      [0,1,1,1,0],
      [1,1,1,1,1],
      [1,1,2,1,1],
      [1,1,1,1,1],
      [0,1,1,1,0],
    ],
    leaves: BIRCH_LEAVES,
    trunk: BIRCH_LOG,
  },
  spruce: {
    // Pointed/diamond shape
    size: 7,
    pattern: [
      [0,0,0,1,0,0,0],
      [0,0,1,1,1,0,0],
      [0,1,1,1,1,1,0],
      [1,1,1,2,1,1,1],
      [0,1,1,1,1,1,0],
      [0,0,1,1,1,0,0],
      [0,0,0,1,0,0,0],
    ],
    leaves: SPRUCE_LEAVES,
    trunk: SPRUCE_LOG,
  },
  dark_oak: {
    // Wider canopy
    size: 9,
    pattern: [
      [0,0,0,1,1,1,0,0,0],
      [0,0,1,1,1,1,1,0,0],
      [0,1,1,3,1,3,1,1,0],
      [1,1,3,1,1,1,3,1,1],
      [1,1,1,1,2,1,1,1,1],
      [1,1,3,1,1,1,3,1,1],
      [0,1,1,3,1,3,1,1,0],
      [0,0,1,1,1,1,1,0,0],
      [0,0,0,1,1,1,0,0,0],
    ],
    leaves: DARK_OAK_LEAVES,
    trunk: DARK_OAK_LOG,
  },
  jungle: {
    // Large bushy canopy
    size: 7,
    pattern: [
      [0,1,1,1,1,1,0],
      [1,1,3,1,3,1,1],
      [1,3,1,1,1,3,1],
      [1,1,1,2,1,1,1],
      [1,3,1,1,1,3,1],
      [1,1,3,1,3,1,1],
      [0,1,1,1,1,1,0],
    ],
    leaves: JUNGLE_LEAVES,
    trunk: OAK_LOG,
  },
};

// Draw a single tree sprite onto the canvas
function drawTree(ctx, x, y, treeType, blockSize) {
  const tree = TREE_TYPES[treeType] || TREE_TYPES.oak_small;
  const halfSize = Math.floor(tree.size / 2);

  // Position so the trunk is at (x, y)
  const startX = Math.floor(x - halfSize * blockSize);
  const startY = Math.floor(y - halfSize * blockSize);

  for (let row = 0; row < tree.size; row++) {
    for (let col = 0; col < tree.size; col++) {
      const cell = tree.pattern[row][col];
      if (cell === 0) continue;

      const px = startX + col * blockSize;
      const py = startY + row * blockSize;

      let color;
      if (cell === 2) {
        // Trunk
        color = tree.trunk;
      } else if (cell === 3) {
        // Darker leaf shade
        color = leafShade(tree.leaves, row * 7 + col);
        // Darken it more
        color = [
          Math.floor(color[0] * 0.8),
          Math.floor(color[1] * 0.8),
          Math.floor(color[2] * 0.8),
        ];
      } else {
        // Normal leaves with slight variation
        const seed = (x * 73 + y * 37 + row * 13 + col * 7) & 0xFF;
        color = leafShade(tree.leaves, seed);
      }

      ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
      ctx.fillRect(px, py, blockSize, blockSize);
    }
  }
}

// Select tree type based on latitude/biome hint
function selectTreeType(lat, hash) {
  // Very rough biome estimation from latitude
  const absLat = Math.abs(lat);

  if (absLat > 55) {
    // Northern/southern — spruce
    return hash % 3 === 0 ? 'birch' : 'spruce';
  } else if (absLat > 40) {
    // Temperate — mixed
    const types = ['oak', 'oak_small', 'birch', 'dark_oak', 'oak'];
    return types[hash % types.length];
  } else if (absLat > 20) {
    // Subtropical
    const types = ['oak', 'dark_oak', 'oak', 'oak_small'];
    return types[hash % types.length];
  } else {
    // Tropical
    const types = ['jungle', 'dark_oak', 'jungle', 'oak'];
    return types[hash % types.length];
  }
}

// Scatter trees across a forest polygon area
// Returns array of {x, y, type} positions in pixel coordinates
function scatterTreePositions(bounds, density, tileSize, lat) {
  const trees = [];
  const spacing = Math.max(6, Math.floor(20 / density));

  for (let py = bounds.minY; py < bounds.maxY; py += spacing) {
    for (let px = bounds.minX; px < bounds.maxX; px += spacing) {
      // Jitter position for natural look
      const hash = ((px * 73856093) ^ (py * 19349663)) & 0xFFFF;
      const jitterX = (hash % spacing) - spacing / 2;
      const jitterY = ((hash >> 4) % spacing) - spacing / 2;

      const finalX = px + jitterX;
      const finalY = py + jitterY;

      if (finalX < 0 || finalX >= tileSize || finalY < 0 || finalY >= tileSize) continue;

      // Skip some for randomness
      if (hash % 10 < 3) continue;

      const treeType = selectTreeType(lat, hash);
      trees.push({ x: finalX, y: finalY, type: treeType });
    }
  }

  return trees;
}

module.exports = {
  TREE_TYPES,
  drawTree,
  selectTreeType,
  scatterTreePositions,
  OAK_LEAVES,
  BIRCH_LEAVES,
  SPRUCE_LEAVES,
};
