import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { SemanticClass } from './types.js';
import { tileToBBox, tileToLatLng } from './util/coord.js';
import {
  createSemanticMap, fillPolygon, drawLine, getClass,
} from './semantic/class-map.js';
import { COLUMN_RULES, BLOCKS } from './palette/block-types.js';
import { selectBiome, BIOME_PALETTES, pickBuildingStyle, pickWallBlock } from './palette/biome-rules.js';

const app = express();
const PORT = 3001;
const TILE_SIZE = 256;
const CACHE_DIR = resolve('tile-cache');

mkdirSync(CACHE_DIR, { recursive: true });

// ============================================
// Mini-pipeline: runs per-tile, fast
// ============================================

async function fetchVectorTile(z: number, x: number, y: number): Promise<VectorTile | null> {
  const PbfClass = (Pbf as any).default || Pbf;
  const url = `https://tiles.versatiles.org/tiles/osm/${z}/${x}/${y}.pbf`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 20) return null;
    return new VectorTile(new PbfClass(new Uint8Array(buf)));
  } catch {
    return null;
  }
}

async function fetchElevation(z: number, x: number, y: number): Promise<Uint8ClampedArray | null> {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height).data;
  } catch {
    return null;
  }
}

function decodeTerrarium(data: Uint8ClampedArray, x: number, y: number, w: number): number {
  const px = Math.min(Math.max(0, Math.floor(x)), w - 1);
  const py = Math.min(Math.max(0, Math.floor(y)), w - 1);
  const i = (py * w + px) * 4;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}

// OSM kind -> SemanticClass (inline for speed)
function classifyKind(kind: string, layer: string): { cls: SemanticClass; width: number } {
  if (layer === 'buildings') return { cls: SemanticClass.BUILDING, width: 0 };
  if (layer === 'water_polygons' || layer === 'ocean') return { cls: SemanticClass.WATER, width: 0 };

  if (layer === 'streets') {
    const roadWidths: Record<string, number> = {
      motorway: 48, trunk: 40, primary: 32, secondary: 24, tertiary: 20,
      residential: 16, living_street: 14, service: 12, unclassified: 14,
      pedestrian: 12, footway: 8, path: 6, cycleway: 8, track: 10, steps: 6,
    };
    return { cls: SemanticClass.ROAD, width: roadWidths[kind] ?? 14 };
  }

  if (layer === 'land' || layer === 'sites') {
    const map: Record<string, SemanticClass> = {
      forest: SemanticClass.FOREST, wood: SemanticClass.FOREST,
      park: SemanticClass.PARK, garden: SemanticClass.PARK,
      grass: SemanticClass.GRASS, meadow: SemanticClass.GRASS,
      water: SemanticClass.WATER, sand: SemanticClass.SAND,
      cemetery: SemanticClass.CEMETERY, residential: SemanticClass.RESIDENTIAL_ZONE,
      farmland: SemanticClass.FARMLAND,
    };
    return { cls: map[kind] ?? SemanticClass.UNKNOWN, width: 0 };
  }

  return { cls: SemanticClass.UNKNOWN, width: 0 };
}

/** Render a single map tile using the pipeline logic */
async function renderTile(z: number, x: number, y: number): Promise<Buffer> {
  // Use z14 for vector data (VersaTiles max)
  const sourceZ = Math.min(z, 14);

  // For zoom > 14, calculate which source tile to use and the sub-region
  let sourceX = x, sourceY = y;
  let scale = 1, offsetX = 0, offsetY = 0;
  if (z > sourceZ) {
    const diff = z - sourceZ;
    const factor = Math.pow(2, diff);
    sourceX = Math.floor(x / factor);
    sourceY = Math.floor(y / factor);
    scale = factor;
    offsetX = (x % factor) / factor;
    offsetY = (y % factor) / factor;
  }

  const { lat } = tileToLatLng(z, x, y + 0.5);

  // Fetch data in parallel
  const [vt, elevData] = await Promise.all([
    fetchVectorTile(sourceZ, sourceX, sourceY),
    fetchElevation(sourceZ, sourceX, sourceY),
  ]);

  // Build semantic map at 256x256
  const extent = 4096;
  const mapSize = TILE_SIZE;
  const bbox = tileToBBox(z, x, y);
  const semMap = createSemanticMap(mapSize, mapSize, bbox, 1);

  // Fill background
  for (let i = 0; i < semMap.data.length; i++) {
    semMap.data[i] = SemanticClass.GRASS;
    semMap.confidence[i] = 0.1;
  }

  if (vt) {
    const mapCoord = (val: number) =>
      ((val / extent) - (scale > 1 ? offsetX : 0)) * scale * mapSize;

    const layerOrder = ['ocean', 'land', 'sites', 'water_polygons', 'street_polygons', 'streets', 'buildings'];

    for (const layerName of layerOrder) {
      const layer = vt.layers[layerName];
      if (!layer) continue;

      for (let i = 0; i < layer.length; i++) {
        const feature = layer.feature(i);
        const props = feature.properties as Record<string, any>;
        const kind = (props.kind as string) || '';

        if (layerName === 'streets' && props.tunnel) continue;
        if (layerName === 'streets' && (props.rail || kind === 'rail' || kind === 'subway')) continue;

        const { cls, width } = classifyKind(kind, layerName);
        if (cls === SemanticClass.UNKNOWN && layerName !== 'ocean') continue;
        const actualCls = layerName === 'ocean' ? SemanticClass.WATER : cls;

        const geom = feature.loadGeometry();
        const points: number[][] = [];
        for (const ring of geom) {
          for (const pt of ring) {
            points.push([mapCoord(pt.x), mapCoord(pt.y)]);
          }
        }

        const priority = actualCls === SemanticClass.BUILDING ? 0.9 :
                         actualCls === SemanticClass.ROAD ? 0.8 :
                         actualCls === SemanticClass.WATER ? 0.6 : 0.3;

        if (feature.type === 3) {
          fillPolygon(semMap, points, actualCls, priority, 'vector');
        } else if (feature.type === 2 && width > 0) {
          drawLine(semMap, points, actualCls, width * scale * mapSize / extent, priority, 'vector');
        }
      }
    }
  }

  // Determine biome
  const midElev = elevData ? decodeTerrarium(elevData, 128, 128, 256) : 0;
  const biome = selectBiome(lat, midElev);
  const biomePalette = BIOME_PALETTES[biome];

  // Build elevation grid
  const seaLevel = 64;
  const heightGrid = new Uint8Array(mapSize * mapSize);
  if (elevData) {
    let minE = Infinity, maxE = -Infinity;
    const elevSamples = new Float32Array(mapSize * mapSize);
    for (let py = 0; py < mapSize; py++) {
      for (let px = 0; px < mapSize; px++) {
        let ex: number, ey: number;
        if (scale > 1) {
          ex = (offsetX + px / (mapSize * scale)) * 256 * scale;
          ey = (offsetY + py / (mapSize * scale)) * 256 * scale;
        } else {
          ex = (px / mapSize) * 256;
          ey = (py / mapSize) * 256;
        }
        const e = decodeTerrarium(elevData, ex, ey, 256);
        elevSamples[py * mapSize + px] = e;
        if (e < minE) minE = e;
        if (e > maxE) maxE = e;
      }
    }
    const range = maxE - minE || 1;
    const blockRange = Math.min(80, Math.max(10, Math.ceil(range)));
    const baseY = Math.max(5, seaLevel - Math.floor(blockRange * 0.3));
    for (let i = 0; i < elevSamples.length; i++) {
      const norm = (elevSamples[i] - minE) / range;
      heightGrid[i] = Math.min(255, Math.max(1, Math.floor(baseY + norm * blockRange)));
    }
  } else {
    heightGrid.fill(seaLevel);
  }

  // Render top-down with block colors + north-shading
  const canvas = createCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const imageData = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const pixels = imageData.data;

  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      const cls = semMap.data[py * TILE_SIZE + px] as SemanticClass;
      const rule = COLUMN_RULES[cls];

      let color: [number, number, number];
      const blockDef = Object.values(BLOCKS).find(b => b.id === rule.surface);
      color = blockDef?.mapColor ?? [127, 178, 56];

      // Building roofs
      if (cls === SemanticClass.BUILDING) {
        const bx = Math.floor(px / 4) * 4;
        const bz = Math.floor(py / 4) * 4;
        const hash = ((bx * 73856093) ^ (bz * 19349663)) & 0xFFFF;
        const style = pickBuildingStyle(biome, hash);
        const roofBlock = Object.values(BLOCKS).find(b => b.id === style.roof);
        if (roofBlock) color = roofBlock.mapColor;

        // Edge detection for building outlines
        const isEdge = (
          px === 0 || py === 0 || px === TILE_SIZE - 1 || py === TILE_SIZE - 1 ||
          getClass(semMap, px - 1, py) !== SemanticClass.BUILDING ||
          getClass(semMap, px + 1, py) !== SemanticClass.BUILDING ||
          getClass(semMap, px, py - 1) !== SemanticClass.BUILDING ||
          getClass(semMap, px, py + 1) !== SemanticClass.BUILDING
        );
        if (isEdge) {
          color = [Math.floor(color[0] * 0.6), Math.floor(color[1] * 0.6), Math.floor(color[2] * 0.6)];
        }
      }

      // Trees in forest/park
      if (cls === SemanticClass.FOREST || cls === SemanticClass.PARK) {
        const hash = ((px * 73856093) ^ (py * 19349663)) & 0xFFFF;
        const isTree = cls === SemanticClass.FOREST ? hash < 2000 : hash < 500;
        if (isTree) {
          // Tree canopy
          const leafBlock = Object.values(BLOCKS).find(b => b.id === biomePalette.vegetation.treeLeaves);
          color = leafBlock?.mapColor ?? [0, 100, 0];
          // Trunk at center
          const isTrunk = hash < 200;
          if (isTrunk) {
            const logBlock = Object.values(BLOCKS).find(b => b.id === biomePalette.vegetation.treeLog);
            color = logBlock?.mapColor ?? [100, 80, 40];
          }
        }
      }

      // North-shading from elevation
      const thisY = heightGrid[py * TILE_SIZE + px];
      const northY = py > 0 ? heightGrid[(py - 1) * TILE_SIZE + px] : thisY;
      const diff = thisY - northY;
      const shade = diff > 0 ? 1.1 : diff < 0 ? 0.78 : 0.93;

      const pi = (py * TILE_SIZE + px) * 4;
      pixels[pi] = Math.min(255, Math.floor(color[0] * shade));
      pixels[pi + 1] = Math.min(255, Math.floor(color[1] * shade));
      pixels[pi + 2] = Math.min(255, Math.floor(color[2] * shade));
      pixels[pi + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
}

// ============================================
// Server
// ============================================

const tileCache = new Map<string, Buffer>();

app.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const z = parseInt(req.params.z);
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);

  if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 18) {
    return res.status(400).send('Invalid tile coordinates');
  }

  const key = `${z}/${x}/${y}`;

  // Check memory cache
  if (tileCache.has(key)) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(tileCache.get(key));
  }

  // Check disk cache
  const cachePath = join(CACHE_DIR, `${z}_${x}_${y}.png`);
  if (existsSync(cachePath)) {
    const buf = readFileSync(cachePath);
    tileCache.set(key, buf);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(buf);
  }

  try {
    const start = Date.now();
    const png = await renderTile(z, x, y);
    const ms = Date.now() - start;
    console.log(`  ${key} rendered in ${ms}ms`);

    // Cache
    tileCache.set(key, png);
    writeFileSync(cachePath, png);

    // Keep memory cache bounded
    if (tileCache.size > 2000) {
      const first = tileCache.keys().next().value;
      if (first) tileCache.delete(first);
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (err) {
    console.error(`Error rendering ${key}:`, err);
    res.status(500).send('Tile render failed');
  }
});

// Viewer
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Minecraft Map</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    @font-face {
      font-family: 'Minecraft';
      src: url('https://cdn.jsdelivr.net/gh/South-Paw/typeface-minecraft@master/fonts/minecraft.woff2') format('woff2');
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Minecraft', monospace; background: #1a1a1a; }
    #map { width: 100vw; height: 100vh; }
    .leaflet-tile { image-rendering: pixelated !important; }

    #controls {
      position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
      z-index: 1000; display: flex; gap: 0;
    }
    .ctrl-btn {
      font-family: 'Minecraft', monospace; font-size: 12px;
      padding: 8px 14px; border: 3px solid #555;
      background: #6b6b6b; color: #aaa; cursor: pointer;
      box-shadow: inset 2px 2px 0 #888, inset -2px -2px 0 #444;
    }
    .ctrl-btn:not(:last-child) { border-right: none; }
    .ctrl-btn.active {
      background: #4a8c3f; color: #fff;
      box-shadow: inset -2px -2px 0 #6ab35e, inset 2px 2px 0 #2d6324;
    }
    .ctrl-btn:hover:not(.active) { background: #888; }

    #search-container {
      position: absolute; top: 56px; left: 50%; transform: translateX(-50%);
      z-index: 1000; display: flex; gap: 0;
    }
    #search-input {
      font-family: 'Minecraft', monospace; font-size: 13px;
      padding: 8px 14px; width: 320px; border: 3px solid #555; border-right: none;
      background: #c6c6c6; color: #3f3f3f; outline: none;
      box-shadow: inset 2px 2px 0 #8b8b8b, inset -2px -2px 0 #fff;
    }
    #search-input::placeholder { color: #7a7a7a; }
    #search-btn {
      font-family: 'Minecraft', monospace; font-size: 13px;
      padding: 8px 14px; border: 3px solid #555;
      background: #8b8b8b; color: #fff; cursor: pointer;
      box-shadow: inset 2px 2px 0 #aaa, inset -2px -2px 0 #555;
    }

    #coords {
      position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
      z-index: 1000; font-family: 'Minecraft', monospace; font-size: 12px;
      color: #fff; background: rgba(0,0,0,0.7); padding: 6px 14px; border: 2px solid #555;
    }
    .leaflet-control-zoom a {
      font-family: 'Minecraft', monospace !important;
      background: #8b8b8b !important; border: 2px solid #555 !important;
      color: #fff !important;
    }
    .leaflet-control-attribution {
      font-family: 'Minecraft', monospace !important; font-size: 10px !important;
      background: rgba(0,0,0,0.6) !important; color: #aaa !important;
    }
  </style>
</head>
<body>
  <div id="controls">
    <button class="ctrl-btn active" id="btn-mc" onclick="setView('mc')">Minecraft</button>
    <button class="ctrl-btn" id="btn-sat" onclick="setView('sat')">Satellite</button>
    <button class="ctrl-btn" id="btn-roads" onclick="setView('roads')">Roads</button>
  </div>

  <div id="search-container">
    <input type="text" id="search-input" placeholder="Search any place..." />
    <button id="search-btn" onclick="doSearch()">Go</button>
  </div>

  <div id="map"></div>
  <div id="coords">X: 0, Z: 0</div>

  <script>
    const map = L.map('map', {
      center: [40.767, -73.975],
      zoom: 14,
      minZoom: 2,
      maxZoom: 17,
    });

    const mcLayer = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: 'Minecraft Map | &copy; OSM',
    });

    const satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: '&copy; Esri',
    });

    const roadsLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OSM',
    });

    let activeLayer = mcLayer;
    mcLayer.addTo(map);

    function setView(mode) {
      map.removeLayer(activeLayer);
      document.querySelectorAll('.ctrl-btn').forEach(b => b.classList.remove('active'));

      if (mode === 'mc') {
        activeLayer = mcLayer;
        document.getElementById('btn-mc').classList.add('active');
        document.getElementById('map').style.imageRendering = 'pixelated';
      } else if (mode === 'sat') {
        activeLayer = satLayer;
        document.getElementById('btn-sat').classList.add('active');
        document.getElementById('map').style.imageRendering = 'auto';
      } else {
        activeLayer = roadsLayer;
        document.getElementById('btn-roads').classList.add('active');
        document.getElementById('map').style.imageRendering = 'auto';
      }
      activeLayer.addTo(map);
    }

    map.on('mousemove', e => {
      const mcX = Math.floor(e.latlng.lng * 1000);
      const mcZ = Math.floor(-e.latlng.lat * 1000);
      document.getElementById('coords').textContent =
        'X: ' + mcX + '  Z: ' + mcZ + '  (' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4) + ')';
    });

    document.getElementById('search-input').addEventListener('keypress', e => {
      if (e.key === 'Enter') doSearch();
    });

    async function doSearch() {
      const q = document.getElementById('search-input').value.trim();
      if (!q) return;
      const coordMatch = q.match(/^(-?\\d+\\.?\\d*)\\s*,\\s*(-?\\d+\\.?\\d*)$/);
      if (coordMatch) {
        map.setView([parseFloat(coordMatch[1]), parseFloat(coordMatch[2])], 15);
        return;
      }
      try {
        const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(q) + '&limit=1',
          { headers: { 'User-Agent': 'MinecraftMap/1.0' } });
        const data = await res.json();
        if (data.length > 0) map.setView([parseFloat(data[0].lat), parseFloat(data[0].lon)], 15);
      } catch(e) { console.error('Search failed', e); }
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`\n  Minecraft Map: http://localhost:${PORT}`);
  console.log(`  Tiles generate on-the-fly as you explore!\n`);
});
