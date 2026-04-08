const { createCanvas, loadImage } = require('canvas');
const PbfModule = require('pbf');
const Pbf = PbfModule.default || PbfModule;
const { VectorTile } = require('@mapbox/vector-tile');
const colors = require('./blockColors');
const { drawTree, selectTreeType, scatterTreePositions } = require('./treeSprites');

const TILE_SIZE = 256;
const MAX_SOURCE_ZOOM = 14; // VersaTiles max zoom

// ============================================
// Tile fetching
// ============================================

async function fetchVectorTile(z, x, y) {
  const url = `https://tiles.versatiles.org/tiles/osm/${z}/${x}/${y}.pbf`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength < 20) return null;
  const pbf = new Pbf(new Uint8Array(buffer));
  return new VectorTile(pbf);
}

async function fetchElevationTile(z, x, y) {
  // AWS Terrain Tiles - Terrarium encoding (free, no API key)
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const img = await loadImage(Buffer.from(buffer));

    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  } catch {
    return null;
  }
}

// Decode Terrarium elevation: elevation = (R * 256 + G + B / 256) - 32768
function getElevation(imageData, x, y) {
  const w = imageData.width;
  const px = Math.min(Math.max(0, Math.floor(x)), w - 1);
  const py = Math.min(Math.max(0, Math.floor(y)), imageData.height - 1);
  const idx = (py * w + px) * 4;
  const r = imageData.data[idx];
  const g = imageData.data[idx + 1];
  const b = imageData.data[idx + 2];
  return (r * 256 + g + b / 256) - 32768;
}

// ============================================
// Tile coordinate utilities
// ============================================

function tileToLatLng(z, x, y) {
  const n = Math.pow(2, z);
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  const lat = latRad * 180 / Math.PI;
  return { lat, lng };
}

// ============================================
// Overzooming
// ============================================

function getSourceTile(z, x, y) {
  if (z <= MAX_SOURCE_ZOOM) {
    return { sz: z, sx: x, sy: y, scale: 1, offsetX: 0, offsetY: 0 };
  }
  const diff = z - MAX_SOURCE_ZOOM;
  const factor = Math.pow(2, diff);
  const sx = Math.floor(x / factor);
  const sy = Math.floor(y / factor);
  const offsetX = (x % factor) / factor;
  const offsetY = (y % factor) / factor;
  return { sz: MAX_SOURCE_ZOOM, sx, sy, scale: factor, offsetX, offsetY };
}

// ============================================
// Feature -> color mappings
// ============================================

function getRoadStyle(properties) {
  const kind = properties.kind || '';
  const rail = properties.rail || false;

  if (rail || kind === 'rail' || kind === 'subway' || kind === 'tram' || kind === 'light_rail') {
    return { color: colors.ROAD_COLORS.rail, width: colors.ROAD_WIDTHS.rail };
  }

  const kindMap = {
    motorway: 'motorway', motorway_link: 'motorway',
    trunk: 'trunk', trunk_link: 'trunk',
    primary: 'primary', primary_link: 'primary',
    secondary: 'secondary', secondary_link: 'secondary',
    tertiary: 'tertiary', tertiary_link: 'tertiary',
    residential: 'residential', living_street: 'residential',
    service: 'service', pedestrian: 'pedestrian',
    footway: 'footway', path: 'path',
    cycleway: 'cycleway', track: 'track',
    steps: 'steps', unclassified: 'minor',
  };

  const mapped = kindMap[kind] || 'default';
  return {
    color: colors.ROAD_COLORS[mapped] || colors.ROAD_COLORS.default,
    width: colors.ROAD_WIDTHS[mapped] || colors.ROAD_WIDTHS.default,
  };
}

function getLandColor(kind) {
  const landMap = {
    forest: colors.LANDCOVER_COLORS.forest, wood: colors.LANDCOVER_COLORS.wood,
    grass: colors.LANDCOVER_COLORS.grass, meadow: colors.LANDCOVER_COLORS.meadow,
    park: colors.PARK_COLOR, garden: colors.LANDCOVER_COLORS.garden,
    recreation_ground: colors.PARK_COLOR, village_green: colors.PARK_COLOR,
    nature_reserve: colors.LANDCOVER_COLORS.wood,
    orchard: colors.LANDCOVER_COLORS.grass, allotments: colors.LANDCOVER_COLORS.garden,
    farmland: colors.LANDUSE_COLORS.farmland, farmyard: colors.LANDUSE_COLORS.farmland,
    sand: colors.LANDCOVER_COLORS.sand, beach: colors.LANDCOVER_COLORS.beach,
    scree: colors.LANDCOVER_COLORS.rock, bare_rock: colors.LANDCOVER_COLORS.rock,
    residential: colors.LANDUSE_COLORS.residential,
    commercial: colors.LANDUSE_COLORS.commercial,
    industrial: colors.LANDUSE_COLORS.industrial,
    retail: colors.LANDUSE_COLORS.retail,
    cemetery: colors.LANDUSE_COLORS.cemetery,
    military: colors.LANDUSE_COLORS.military,
    railway: colors.LANDUSE_COLORS.railway,
    quarry: colors.LANDUSE_COLORS.quarry,
    wetland: colors.LANDCOVER_COLORS.wetland,
    scrub: colors.LANDCOVER_COLORS.scrub,
    heath: colors.LANDCOVER_COLORS.scrub,
    glacier: colors.LANDCOVER_COLORS.ice,
  };
  return landMap[kind] || null;
}

function getSiteColor(kind) {
  const siteMap = {
    university: colors.BUILDING_COLORS.university,
    college: colors.BUILDING_COLORS.university,
    school: colors.BUILDING_COLORS.school,
    hospital: colors.BUILDING_COLORS.hospital,
    parking: colors.ROAD_COLORS.service,
    playground: colors.PARK_COLOR, pitch: colors.PARK_COLOR,
    sports_centre: colors.PARK_COLOR,
    golf_course: colors.PARK_COLOR,
    swimming_pool: colors.WATER_COLOR,
  };
  return siteMap[kind] || null;
}

// ============================================
// Drawing helpers
// ============================================

function drawGeometry(ctx, geometry, type, extent, fillColor, strokeColor, lineWidth, renderState) {
  const { scale: tileScale, offsetX, offsetY } = renderState;
  const tileExtent = extent || 4096;

  const mapX = (val) => ((val / tileExtent) - (tileScale > 1 ? offsetX : 0)) * tileScale * TILE_SIZE;
  const mapY = (val) => ((val / tileExtent) - (tileScale > 1 ? offsetY : 0)) * tileScale * TILE_SIZE;

  if (type === 1) {
    ctx.fillStyle = colors.rgb(fillColor);
    for (const ring of geometry) {
      for (const [px, py] of ring) {
        ctx.fillRect(Math.floor(mapX(px)) - 1, Math.floor(mapY(py)) - 1, 3, 3);
      }
    }
  } else if (type === 2) {
    ctx.strokeStyle = colors.rgb(fillColor);
    ctx.lineWidth = lineWidth * (tileScale > 1 ? tileScale : 1);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    for (const ring of geometry) {
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const x = mapX(ring[i][0]);
        const y = mapY(ring[i][1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else if (type === 3) {
    ctx.fillStyle = colors.rgb(fillColor);
    ctx.beginPath();
    for (const ring of geometry) {
      for (let i = 0; i < ring.length; i++) {
        const x = mapX(ring[i][0]);
        const y = mapY(ring[i][1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fill();

    if (strokeColor) {
      ctx.strokeStyle = colors.rgb(strokeColor);
      ctx.lineWidth = Math.max(1, tileScale > 1 ? 2 : 1);
      ctx.stroke();
    }
  }
}

function getGeometry(feature) {
  return feature.loadGeometry().map(ring => ring.map(p => [p.x, p.y]));
}

// ============================================
// Elevation shading (Minecraft-style)
// ============================================

function applyElevationShading(ctx, elevationData, source) {
  if (!elevationData) return;

  const imageData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const pixels = imageData.data;

  // Build elevation grid for this tile
  const elevGrid = new Float32Array(TILE_SIZE * TILE_SIZE);
  const elevW = elevationData.width;
  const elevH = elevationData.height;

  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      // Map pixel to elevation tile coordinates (accounting for overzoom)
      let ex, ey;
      if (source.scale > 1) {
        ex = (source.offsetX + px / (TILE_SIZE * source.scale)) * elevW * source.scale;
        ey = (source.offsetY + py / (TILE_SIZE * source.scale)) * elevH * source.scale;
      } else {
        ex = (px / TILE_SIZE) * elevW;
        ey = (py / TILE_SIZE) * elevH;
      }
      elevGrid[py * TILE_SIZE + px] = getElevation(elevationData, ex, ey);
    }
  }

  // Apply Minecraft-style shading: compare each pixel with its northern neighbor
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      const idx = (py * TILE_SIZE + px) * 4;
      const elev = elevGrid[py * TILE_SIZE + px];
      const northElev = py > 0 ? elevGrid[(py - 1) * TILE_SIZE + px] : elev;

      const diff = elev - northElev;

      let multiplier;
      if (diff > 0.5) {
        // Higher than north = bright (lit from north, light catches the face)
        multiplier = 1.1 + Math.min(diff * 0.02, 0.15);
      } else if (diff < -0.5) {
        // Lower than north = shadow
        multiplier = 0.75 - Math.min(Math.abs(diff) * 0.015, 0.2);
      } else {
        // Same height = normal
        multiplier = 0.95;
      }

      pixels[idx]     = Math.min(255, Math.max(0, Math.floor(pixels[idx] * multiplier)));
      pixels[idx + 1] = Math.min(255, Math.max(0, Math.floor(pixels[idx + 1] * multiplier)));
      pixels[idx + 2] = Math.min(255, Math.max(0, Math.floor(pixels[idx + 2] * multiplier)));
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// ============================================
// Add texture noise (makes flat areas feel alive)
// ============================================

function applyTextureNoise(ctx) {
  const imageData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const pixels = imageData.data;

  // Simple seeded noise based on pixel position
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      const idx = (py * TILE_SIZE + px) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];

      // Only add noise to natural areas (greens, browns, blues)
      // Skip grays (roads/buildings) — those should stay clean
      const isGray = Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && r > 60;
      const isBuilding = r > 140 && g > 140 && b > 140 && Math.abs(r - g) < 30;

      if (!isGray && !isBuilding) {
        // Hash-based noise for consistency
        const hash = ((px * 73856093) ^ (py * 19349663)) & 0xFFFF;
        const noise = ((hash % 17) - 8) * 1.5; // -12 to +12 range

        pixels[idx]     = Math.min(255, Math.max(0, r + noise));
        pixels[idx + 1] = Math.min(255, Math.max(0, g + noise));
        pixels[idx + 2] = Math.min(255, Math.max(0, b + noise));
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// ============================================
// Add subtle grid lines (block boundaries)
// ============================================

function applyBlockGrid(ctx, z) {
  if (z < 15) return; // Only show grid at close zoom

  const imageData = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  const pixels = imageData.data;
  const gridSpacing = z >= 17 ? 1 : z >= 16 ? 2 : 4;

  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      if (px % gridSpacing === 0 || py % gridSpacing === 0) {
        const idx = (py * TILE_SIZE + px) * 4;
        // Darken slightly for grid lines
        pixels[idx]     = Math.floor(pixels[idx] * 0.92);
        pixels[idx + 1] = Math.floor(pixels[idx + 1] * 0.92);
        pixels[idx + 2] = Math.floor(pixels[idx + 2] * 0.92);
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

// ============================================
// Main render function
// ============================================

async function renderTile(z, x, y) {
  const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.antialias = 'none';

  // Fill background with grass
  ctx.fillStyle = colors.rgb(colors.BACKGROUND);
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

  // Get source tile info (overzoom if needed)
  const source = getSourceTile(z, x, y);
  const renderState = { scale: source.scale, offsetX: source.offsetX, offsetY: source.offsetY };

  // Fetch vector tile + elevation tile in parallel
  const [vt, elevationData] = await Promise.all([
    fetchVectorTile(source.sz, source.sx, source.sy).catch(() => null),
    fetchElevationTile(source.sz, source.sx, source.sy).catch(() => null),
  ]);

  if (!vt) {
    return canvas.toBuffer('image/png');
  }

  // ---- Render vector layers back to front ----

  const renderOrder = [
    { name: 'ocean', render: 'ocean' },
    { name: 'land', render: 'land' },
    { name: 'sites', render: 'sites' },
    { name: 'water_polygons', render: 'water' },
    { name: 'pier_polygons', render: 'pier' },
    { name: 'street_polygons', render: 'street_polygon' },
    { name: 'streets', render: 'streets' },
    { name: 'bridges', render: 'bridges' },
    { name: 'buildings', render: 'buildings' },
  ];

  for (const { name, render } of renderOrder) {
    const layer = vt.layers[name];
    if (!layer) continue;
    const extent = layer.extent || 4096;

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const props = feature.properties;
      const geomType = feature.type;
      const geometry = getGeometry(feature);

      switch (render) {
        case 'ocean':
          drawGeometry(ctx, geometry, geomType, extent, colors.WATER_COLOR, null, 0, renderState);
          break;

        case 'water':
          drawGeometry(ctx, geometry, geomType, extent, colors.WATER_COLOR, null, 0, renderState);
          break;

        case 'land': {
          const color = getLandColor(props.kind || '');
          if (color) drawGeometry(ctx, geometry, geomType, extent, color, null, 0, renderState);
          break;
        }

        case 'sites': {
          const color = getSiteColor(props.kind || '');
          if (color) drawGeometry(ctx, geometry, geomType, extent, color, null, 0, renderState);
          break;
        }

        case 'pier':
          drawGeometry(ctx, geometry, geomType, extent,
            colors.shade(colors.BASE_COLORS.WOOD, 1), null, 0, renderState);
          break;

        case 'street_polygon':
          drawGeometry(ctx, geometry, geomType, extent,
            colors.ROAD_COLORS.pedestrian, null, 0, renderState);
          break;

        case 'streets': {
          if (props.tunnel) continue;
          const style = getRoadStyle(props);
          drawGeometry(ctx, geometry, geomType, extent, style.color, null, style.width, renderState);
          break;
        }

        case 'bridges':
          drawGeometry(ctx, geometry, geomType, extent,
            colors.shade(colors.BASE_COLORS.STONE, 2), null, 0, renderState);
          break;

        case 'buildings': {
          // Vary building colors using a hash of position for variety
          const geom = geometry[0];
          if (geom && geom.length > 0) {
            const hash = ((geom[0][0] * 73856093) ^ (geom[0][1] * 19349663)) & 0xFFFF;
            const buildingPalette = [
              colors.BUILDING_COLORS.default,      // clay
              colors.BUILDING_COLORS.residential,   // terracotta
              colors.BUILDING_COLORS.commercial,    // quartz
              colors.shade(colors.BASE_COLORS.QUARTZ, 1), // light
              colors.shade(colors.BASE_COLORS.CLAY, 1),   // medium
              colors.shade(colors.BASE_COLORS.WOOL, 1),   // wool gray
            ];
            const color = buildingPalette[hash % buildingPalette.length];
            drawGeometry(ctx, geometry, geomType, extent, color, colors.BUILDING_OUTLINE, 1, renderState);
          } else {
            drawGeometry(ctx, geometry, geomType, extent,
              colors.BUILDING_COLORS.default, colors.BUILDING_OUTLINE, 1, renderState);
          }
          break;
        }
      }
    }
  }

  // ---- Draw Minecraft trees ----
  const { lat } = tileToLatLng(z, x, y + 0.5);

  // First, build a mask of where buildings and roads are so trees don't overlap
  const occupiedCanvas = createCanvas(TILE_SIZE, TILE_SIZE);
  const occCtx = occupiedCanvas.getContext('2d');
  occCtx.fillStyle = 'black';
  occCtx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

  // Mark buildings and roads as occupied (white)
  for (const layerName of ['buildings', 'streets', 'street_polygons']) {
    const layer = vt.layers[layerName];
    if (!layer) continue;
    const extent = layer.extent || 4096;
    occCtx.fillStyle = 'white';
    occCtx.strokeStyle = 'white';

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const geometry = getGeometry(feature);
      if (feature.type === 3) {
        drawGeometry(occCtx, geometry, 3, extent, [255,255,255], null, 0, renderState);
      } else if (feature.type === 2) {
        const w = (feature.properties.kind === 'motorway') ? 8 : 4;
        drawGeometry(occCtx, geometry, 2, extent, [255,255,255], null, w, renderState);
      }
    }
  }
  const occupiedData = occCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);

  function isOccupied(px, py) {
    const cx = Math.min(Math.max(0, Math.floor(px)), TILE_SIZE - 1);
    const cy = Math.min(Math.max(0, Math.floor(py)), TILE_SIZE - 1);
    return occupiedData.data[(cy * TILE_SIZE + cx) * 4] > 128;
  }

  // Only scatter trees in explicitly green/forested areas
  const FOREST_KINDS = new Set(['forest', 'wood', 'nature_reserve']);
  const PARK_KINDS = new Set(['park', 'garden', 'village_green', 'recreation_ground']);
  const SPARSE_KINDS = new Set(['orchard', 'scrub', 'allotments']);

  const treeAreas = [];

  for (const layerName of ['land', 'sites']) {
    const layer = vt.layers[layerName];
    if (!layer) continue;
    const extent = layer.extent || 4096;

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const kind = feature.properties.kind || '';
      const isForest = FOREST_KINDS.has(kind);
      const isPark = PARK_KINDS.has(kind);
      const isSparse = SPARSE_KINDS.has(kind);
      if (!isForest && !isPark && !isSparse) continue;
      if (feature.type !== 3) continue;

      const geometry = getGeometry(feature);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const mapXf = (val) => ((val / extent) - (source.scale > 1 ? source.offsetX : 0)) * source.scale * TILE_SIZE;
      const mapYf = (val) => ((val / extent) - (source.scale > 1 ? source.offsetY : 0)) * source.scale * TILE_SIZE;

      for (const ring of geometry) {
        for (const [gx, gy] of ring) {
          minX = Math.min(minX, mapXf(gx));
          minY = Math.min(minY, mapYf(gy));
          maxX = Math.max(maxX, mapXf(gx));
          maxY = Math.max(maxY, mapYf(gy));
        }
      }

      const density = isForest ? 2.0 : isPark ? 0.6 : 0.4;

      treeAreas.push({
        bounds: { minX: Math.floor(minX), minY: Math.floor(minY),
                  maxX: Math.ceil(maxX), maxY: Math.ceil(maxY) },
        density,
      });
    }
  }

  // Scatter trees, skipping occupied areas
  const blockSize = z >= 16 ? 2 : 1;
  for (const area of treeAreas) {
    const trees = scatterTreePositions(area.bounds, area.density, TILE_SIZE, lat);
    for (const tree of trees) {
      if (!isOccupied(tree.x, tree.y)) {
        drawTree(ctx, tree.x, tree.y, tree.type, blockSize);
      }
    }
  }

  // ---- Post-processing passes ----

  // 1. Apply elevation shading (the 3D effect)
  applyElevationShading(ctx, elevationData, source);

  // 2. Add texture noise to natural areas
  applyTextureNoise(ctx);

  // 3. Add block grid at close zoom
  applyBlockGrid(ctx, z);

  // 4. Pixelation pass — downsample and re-upscale for blocky look
  if (z <= 15) {
    const pixelSize = z <= 12 ? 3 : 2;
    const smallW = Math.floor(TILE_SIZE / pixelSize);
    const smallH = Math.floor(TILE_SIZE / pixelSize);
    const smallCanvas = createCanvas(smallW, smallH);
    const smallCtx = smallCanvas.getContext('2d');
    smallCtx.imageSmoothingEnabled = false;
    smallCtx.drawImage(canvas, 0, 0, smallW, smallH);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
    ctx.drawImage(smallCanvas, 0, 0, TILE_SIZE, TILE_SIZE);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { renderTile };
