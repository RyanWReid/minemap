import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { PMTiles } from 'pmtiles';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { SemanticClass } from './types.js';
import { tileToBBox, tileToLatLng, latlngToTile } from './util/coord.js';
import { createSemanticMap, fillPolygon, drawLine } from './semantic/class-map.js';
import { BLOCKS } from './palette/block-types.js';
import { selectBiome, BIOME_PALETTES, pickBuildingStyle } from './palette/biome-rules.js';
import { quantizeTerrain } from './terrain/quantizer.js';
import { placeBlocks } from './voxel/placer.js';
import { sampleSurfaceColors } from './semantic/roof-sampler.js';
import { renderTopDown } from './preview/top-down.js';
import type { BoundingBox, HeightMap } from './types.js';

const app = express();
const PORT = 3001;
const CACHE_DIR = resolve('tile-cache');
mkdirSync(CACHE_DIR, { recursive: true });

// ============================================
// Database setup
// ============================================

const DB_PATH = resolve('minecraft-map.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_name TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    friend_code TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS waypoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL REFERENCES players(id),
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    icon TEXT DEFAULT 'default',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL REFERENCES players(id),
    achievement_key TEXT NOT NULL,
    unlocked_at TEXT DEFAULT (datetime('now')),
    UNIQUE(player_id, achievement_key)
  );
  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL REFERENCES players(id),
    friend_id INTEGER NOT NULL REFERENCES players(id),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(player_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER NOT NULL REFERENCES players(id),
    to_id INTEGER,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Add friend_code column if not exists
try { db.exec(`ALTER TABLE players ADD COLUMN friend_code TEXT UNIQUE`); } catch {}

// Generate friend codes for existing players without one
function generateFriendCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
const playersWithoutCode = db.prepare('SELECT id FROM players WHERE friend_code IS NULL').all() as any[];
for (const p of playersWithoutCode) {
  let code = generateFriendCode();
  while (db.prepare('SELECT id FROM players WHERE friend_code = ?').get(code)) code = generateFriendCode();
  db.prepare('UPDATE players SET friend_code = ? WHERE id = ?').run(code, p.id);
}

// Session store (in-memory, simple token-based)
const sessions = new Map<string, { playerId: number; playerName: string }>();

function createSession(playerId: number, playerName: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { playerId, playerName });
  return token;
}

function getSession(token: string | undefined) {
  if (!token) return null;
  return sessions.get(token) || null;
}

app.use(express.json());
app.use(cookieParser());

// ============================================
// Auth API
// ============================================

app.post('/api/register', (req, res) => {
  const { playerName, password } = req.body;
  if (!playerName || !password) return res.status(400).json({ error: 'Player name and password required' });
  if (playerName.length < 3 || playerName.length > 16) return res.status(400).json({ error: 'Name must be 3-16 characters' });
  if (!/^[a-zA-Z0-9_]+$/.test(playerName)) return res.status(400).json({ error: 'Name can only contain letters, numbers, and underscores' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const existing = db.prepare('SELECT id FROM players WHERE player_name = ?').get(playerName);
  if (existing) return res.status(409).json({ error: 'Player name already taken' });

  const hash = bcrypt.hashSync(password, 10);
  let friendCode = generateFriendCode();
  while (db.prepare('SELECT id FROM players WHERE friend_code = ?').get(friendCode)) friendCode = generateFriendCode();
  const result = db.prepare('INSERT INTO players (player_name, password_hash, friend_code) VALUES (?, ?, ?)').run(playerName, hash, friendCode);
  const token = createSession(result.lastInsertRowid as number, playerName);
  res.cookie('mc_session', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ ok: true, player: { id: result.lastInsertRowid, playerName, xp: 0, level: 1, friendCode } });
});

app.post('/api/login', (req, res) => {
  const { playerName, password } = req.body;
  if (!playerName || !password) return res.status(400).json({ error: 'Player name and password required' });

  const player = db.prepare('SELECT id, player_name, password_hash, xp, level FROM players WHERE player_name = ?').get(playerName) as any;
  if (!player || !bcrypt.compareSync(password, player.password_hash)) {
    return res.status(401).json({ error: 'Invalid player name or password' });
  }

  const token = createSession(player.id, player.player_name);
  res.cookie('mc_session', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ ok: true, player: { id: player.id, playerName: player.player_name, xp: player.xp, level: player.level } });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.mc_session;
  if (token) sessions.delete(token);
  res.clearCookie('mc_session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.json({ player: null });

  const player = db.prepare('SELECT id, player_name, xp, level, friend_code, created_at FROM players WHERE id = ?').get(session.playerId) as any;
  if (!player) return res.json({ player: null });

  const achievements = db.prepare('SELECT achievement_key, unlocked_at FROM achievements WHERE player_id = ?').all(session.playerId);
  const waypoints = db.prepare('SELECT id, name, lat, lng, icon, created_at FROM waypoints WHERE player_id = ? ORDER BY created_at DESC').all(session.playerId);

  res.json({
    player: {
      id: player.id,
      playerName: player.player_name,
      xp: player.xp,
      level: player.level,
      friendCode: player.friend_code,
      createdAt: player.created_at,
      achievements,
      waypoints,
    },
  });
});

app.post('/api/waypoints', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const { name, lat, lng, icon } = req.body;
  if (!name || lat == null || lng == null) return res.status(400).json({ error: 'name, lat, lng required' });

  const result = db.prepare('INSERT INTO waypoints (player_id, name, lat, lng, icon) VALUES (?, ?, ?, ?, ?)').run(session.playerId, name, lat, lng, icon || 'default');
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.delete('/api/waypoints/:id', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  db.prepare('DELETE FROM waypoints WHERE id = ? AND player_id = ?').run(req.params.id, session.playerId);
  res.json({ ok: true });
});

app.post('/api/achievement', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'achievement key required' });

  try {
    db.prepare('INSERT OR IGNORE INTO achievements (player_id, achievement_key) VALUES (?, ?)').run(session.playerId, key);
    // Award XP for new achievement
    db.prepare('UPDATE players SET xp = xp + 100 WHERE id = ?').run(session.playerId);
    const player = db.prepare('SELECT xp FROM players WHERE id = ?').get(session.playerId) as any;
    // Level up every 500 XP
    const newLevel = Math.floor(player.xp / 500) + 1;
    db.prepare('UPDATE players SET level = ? WHERE id = ?').run(newLevel, session.playerId);
    res.json({ ok: true, xp: player.xp, level: newLevel });
  } catch {
    res.json({ ok: true }); // Already unlocked
  }
});

// Serve static assets (sounds, etc.)
app.use('/sounds', express.static(resolve('public/sounds')));

// ============================================
// Direct single-tile fetchers (no bbox routing)
// ============================================

async function fetchOneVectorTile(z: number, x: number, y: number): Promise<VectorTile | null> {
  try {
    const PbfClass = (Pbf as any).default || Pbf;
    const url = `https://tiles.versatiles.org/tiles/osm/${z}/${x}/${y}.pbf`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 20) return null;
    return new VectorTile(new PbfClass(new Uint8Array(buf)));
  } catch (e) {
    console.warn(`  VersaTiles fetch failed: ${(e as Error).message}`);
    return null;
  }
}

async function fetchOneElevationTile(z: number, x: number, y: number): Promise<{data: Uint8ClampedArray, width: number} | null> {
  try {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const img = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imgData = ctx.getImageData(0, 0, img.width, img.height);
  return { data: imgData.data, width: img.width };
  } catch (e) {
    console.warn(`  Elevation fetch failed: ${(e as Error).message}`);
    return null;
  }
}

function decodeTerrarium(data: Uint8ClampedArray, x: number, y: number, w: number): number {
  const px = Math.min(Math.max(0, Math.floor(x)), w - 1);
  const py = Math.min(Math.max(0, Math.floor(y)), w - 1);
  const i = (py * w + px) * 4;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}

// ============================================
// Overture Maps: Microsoft Building Footprints via PMTiles
// ============================================

const OVERTURE_URL = 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-03-18.0/buildings.pmtiles';
const overtureTiles = new PMTiles(OVERTURE_URL);

async function fetchOvertureBuildings(bbox: BoundingBox, extent: number): Promise<number[][]> {
  const PbfClass = (Pbf as any).default || Pbf;
  const zoom = 14; // max zoom in Overture PMTiles
  const allPolygons: number[][][] = [];

  // Get tiles covering this bbox
  const n = Math.pow(2, zoom);
  const minX = Math.floor(((bbox.west + 180) / 360) * n);
  const maxX = Math.floor(((bbox.east + 180) / 360) * n);
  const minY = Math.floor((1 - Math.log(Math.tan(bbox.north * Math.PI / 180) + 1 / Math.cos(bbox.north * Math.PI / 180)) / Math.PI) / 2 * n);
  const maxY = Math.floor((1 - Math.log(Math.tan(bbox.south * Math.PI / 180) + 1 / Math.cos(bbox.south * Math.PI / 180)) / Math.PI) / 2 * n);

  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      try {
        const result = await overtureTiles.getZxy(zoom, tx, ty);
        if (!result?.data) continue;

        const tile = new VectorTile(new PbfClass(new Uint8Array(result.data)));
        const layer = tile.layers['building'];
        if (!layer) continue;

        for (let i = 0; i < layer.length; i++) {
          const feature = layer.feature(i);
          if (feature.type !== 3) continue; // polygons only

          // Convert tile coords to our semantic map coords
          const geom = feature.loadGeometry();
          for (const ring of geom) {
            const points: number[][] = [];
            for (const pt of ring) {
              // Tile-local coords (0-4096) -> lat/lng -> semantic map coords
              const lng = (tx + pt.x / 4096) / n * 360 - 180;
              const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + pt.y / 4096) / n)));
              const lat = latRad * 180 / Math.PI;

              const px = ((lng - bbox.west) / (bbox.east - bbox.west)) * extent;
              const py = ((bbox.north - lat) / (bbox.north - bbox.south)) * extent;
              points.push([px, py]);
            }
            allPolygons.push(points);
          }
        }
      } catch {
        // Individual tile fetch failure is ok
      }
    }
  }

  return allPolygons.flat() as any; // return as array of polygon point arrays
}

// Wrapper that returns polygon arrays properly
async function fetchOvertureBuildingPolygons(bbox: BoundingBox, extent: number): Promise<number[][][]> {
  const PbfClass = (Pbf as any).default || Pbf;
  const zoom = 15;
  const allPolygons: number[][][] = [];

  const n = Math.pow(2, zoom);
  const minX = Math.floor(((bbox.west + 180) / 360) * n);
  const maxX = Math.floor(((bbox.east + 180) / 360) * n);
  const minY = Math.floor((1 - Math.log(Math.tan(bbox.north * Math.PI / 180) + 1 / Math.cos(bbox.north * Math.PI / 180)) / Math.PI) / 2 * n);
  const maxY = Math.floor((1 - Math.log(Math.tan(bbox.south * Math.PI / 180) + 1 / Math.cos(bbox.south * Math.PI / 180)) / Math.PI) / 2 * n);

  const tilePromises = [];
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      tilePromises.push((async () => {
        try {
          const result = await overtureTiles.getZxy(zoom, tx, ty);
          if (!result?.data) return;
          const tile = new VectorTile(new PbfClass(new Uint8Array(result.data)));
          const layer = tile.layers['building'];
          if (!layer) return;

          for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i);
            if (feature.type !== 3) continue;
            const geom = feature.loadGeometry();
            for (const ring of geom) {
              const points: number[][] = [];
              for (const pt of ring) {
                const lng = (tx + pt.x / 4096) / n * 360 - 180;
                const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + pt.y / 4096) / n)));
                const lat = latRad * 180 / Math.PI;
                const px = ((lng - bbox.west) / (bbox.east - bbox.west)) * extent;
                const py = ((bbox.north - lat) / (bbox.north - bbox.south)) * extent;
                points.push([px, py]);
              }
              if (points.length >= 3) allPolygons.push(points);
            }
          }
        } catch {}
      })());
    }
  }

  await Promise.all(tilePromises);
  return allPolygons;
}

// ============================================
// OSM kind classification
// ============================================

const ROAD_KINDS = new Set(['motorway','trunk','primary','secondary','tertiary','residential','living_street','service','unclassified','pedestrian','footway','path','cycleway','track','steps','motorway_link','trunk_link','primary_link','secondary_link','tertiary_link']);
const ROAD_WIDTHS: Record<string, number> = { motorway:48, trunk:40, primary:32, secondary:24, tertiary:20, residential:16, living_street:14, service:12, unclassified:14, pedestrian:12, footway:8, path:6, cycleway:8, track:10, steps:6 };
const LAND_MAP: Record<string, SemanticClass> = { forest:SemanticClass.FOREST, wood:SemanticClass.FOREST, nature_reserve:SemanticClass.FOREST, grass:SemanticClass.GRASS, meadow:SemanticClass.GRASS, village_green:SemanticClass.GRASS, park:SemanticClass.PARK, garden:SemanticClass.PARK, recreation_ground:SemanticClass.PARK, farmland:SemanticClass.FARMLAND, farmyard:SemanticClass.FARMLAND, sand:SemanticClass.SAND, beach:SemanticClass.SAND, bare_rock:SemanticClass.ROCK, wetland:SemanticClass.WETLAND, scrub:SemanticClass.SCRUB, cemetery:SemanticClass.CEMETERY, residential:SemanticClass.RESIDENTIAL_ZONE, commercial:SemanticClass.INDUSTRIAL, industrial:SemanticClass.INDUSTRIAL };

// ============================================
// Render a z14 parent tile at 1024x1024, cache it,
// then slice out the correct 256x256 sub-tile for z15/z16.
// This guarantees perfect tile alignment.
// ============================================

// ============================================
// Overpass API: get ALL buildings + roads for an area
// ============================================

interface OverpassResult {
  buildings: OverpassElement[];
  roads: OverpassElement[];
  trees: Array<{lat:number,lon:number}>;
  highwayCount: number;
}

interface OverpassElement {
  type: string;
  geometry?: Array<{lat:number,lon:number}>;
  lat?: number;
  lon?: number;
  tags: Record<string,string>;
}

const OVERPASS_CACHE = resolve('overpass-cache');
mkdirSync(OVERPASS_CACHE, { recursive: true });

async function fetchOverpass(south: number, west: number, north: number, east: number): Promise<OverpassResult> {
  // Check disk cache first
  const cacheKey = `${south.toFixed(4)}_${west.toFixed(4)}_${north.toFixed(4)}_${east.toFixed(4)}`;
  const cachePath = join(OVERPASS_CACHE, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      // Backfill highwayCount for old cache entries
      if (cached.highwayCount === undefined) {
        cached.highwayCount = cached.roads?.filter((e: any) => e.tags?.highway)?.length ?? 0;
      }
      console.log(`  Overpass: cached (${cached.buildings.length} buildings, ${cached.roads.length} roads, ${cached.highwayCount} highways)`);
      return cached;
    } catch {}
  }
  const bbox = `${south},${west},${north},${east}`;
  // Query 1: Buildings + roads + surface info
  const q1 = `[out:json][timeout:25][bbox:${bbox}];(way["building"];way["highway"];);out geom;`;
  // Query 2: Everything else — land, water, leisure, amenities, trees
  const q2 = `[out:json][timeout:25][bbox:${bbox}];(way["natural"];way["waterway"];way["leisure"];way["landuse"];way["amenity"~"parking|school|hospital"];way["barrier"~"fence|wall|hedge"];node["natural"="tree"];node["natural"="tree_row"];);out geom;`;

  const url1 = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q1)}`;
  const url2 = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q2)}`;

  try {
    // Fetch queries sequentially to avoid Overpass rate limits
    const fetchJSON = async (url: string) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (res.status === 429 || res.status === 504) {
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          if (!res.ok) return null;
          const text = await res.text();
          if (text.startsWith('<')) return null; // XML error response
          return JSON.parse(text);
        } catch { continue; }
      }
      return null;
    };

    // Sequential to avoid Overpass rate limits (429/504)
    const d1 = await fetchJSON(url1);
    const d2 = await fetchJSON(url2);

    const buildings: OverpassElement[] = [];
    const roads: OverpassElement[] = [];
    const trees: Array<{lat:number,lon:number}> = [];
    let highwayCount = 0;

    const allElements: any[] = [];
    if (d1) allElements.push(...(d1.elements || []));
    if (d2) allElements.push(...(d2.elements || []));

    for (const e of allElements) {
      if (!e.tags) continue;
      if (e.type === 'node' && e.tags.natural === 'tree' && e.lat && e.lon) {
        trees.push({ lat: e.lat, lon: e.lon });
        continue;
      }
      if (!e.geometry || e.geometry.length < 2) continue;
      if (e.tags.building) {
        buildings.push(e);
      } else {
        if (e.tags.highway) highwayCount++;
        roads.push(e);
      }
    }

    const result = { buildings, roads, trees, highwayCount };
    // Only cache if we got meaningful data (don't poison cache with empty results)
    if (buildings.length > 0 || highwayCount > 0) {
      try { writeFileSync(cachePath, JSON.stringify(result)); } catch {}
    }
    return result;
  } catch {
    console.log('  Overpass failed, using VersaTiles only');
    return { buildings: [], roads: [], trees: [], highwayCount: 0 };
  }
}

/** Convert lat/lng geometry to tile pixel coordinates */
function geoToTilePixels(
  geom: Array<{lat:number,lon:number}>,
  bbox: {north:number,south:number,east:number,west:number},
  extent: number,
): number[][] {
  return geom.map(p => [
    ((p.lon - bbox.west) / (bbox.east - bbox.west)) * extent,
    ((bbox.north - p.lat) / (bbox.north - bbox.south)) * extent,
  ]);
}

const HIGHWAY_CLASS: Record<string, SemanticClass> = {};
// All highway types -> ROAD
['motorway','trunk','primary','secondary','tertiary','residential','living_street',
 'service','unclassified','pedestrian','footway','path','cycleway','track','steps',
 'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link'].forEach(k => HIGHWAY_CLASS[k] = SemanticClass.ROAD);

const HIGHWAY_WIDTHS: Record<string, number> = {
  motorway:60, trunk:50, primary:40, secondary:30, tertiary:25,
  residential:20, living_street:18, service:15, unclassified:18,
  pedestrian:15, footway:10, path:8, cycleway:10, track:12, steps:8,
};

// ============================================
// Satellite ground refinement
// ============================================

/** Fetch a single Esri satellite tile and return its RGBA pixels */
async function fetchSatelliteTilePixels(z: number, x: number, y: number): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  try {
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.width, img.height);
  } catch { return null; }
}

/**
 * Conservative satellite ground refinement.
 * Only reclassifies pixels that are VERY clearly not grass.
 * Biased heavily toward keeping grass — only overrides for obvious water,
 * large bare dirt patches, and clearly non-green terrain.
 */
function refineGroundFromSatellite(
  semMap: { data: Uint8Array; confidence: Float32Array; width: number; height: number },
  satPixels: Uint8ClampedArray,
  satWidth: number,
  satHeight: number,
): number {
  const scaleX = satWidth / semMap.width;
  const scaleY = satHeight / semMap.height;
  let refined = 0;

  for (let my = 0; my < semMap.height; my++) {
    for (let mx = 0; mx < semMap.width; mx++) {
      const idx = my * semMap.width + mx;
      // Only refine low-confidence GRASS cells (the default fill)
      if (semMap.data[idx] !== SemanticClass.GRASS || semMap.confidence[idx] > 0.15) continue;

      // Sample satellite pixel (average a 5x5 area for stability — reduces noise from roofs/shadows)
      const cx = Math.floor(mx * scaleX);
      const cy = Math.floor(my * scaleY);
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const sx = Math.min(Math.max(cx + dx, 0), satWidth - 1);
          const sy = Math.min(Math.max(cy + dy, 0), satHeight - 1);
          const si = (sy * satWidth + sx) * 4;
          rSum += satPixels[si]; gSum += satPixels[si + 1]; bSum += satPixels[si + 2];
          count++;
        }
      }
      const r = rSum / count, g = gSum / count, b = bSum / count;

      // KEEP AS GRASS if there's any green signal at all (very conservative)
      if (g > r * 0.95 && g > 50) continue;
      // Keep as grass if it's ambiguous / mid-tone
      if (r > 80 && r < 200 && g > 70 && g < 180 && b > 60 && b < 160) continue;

      // Only classify WATER if blue is strongly dominant
      if (b > r * 1.5 && b > g * 1.3 && b > 50) {
        // Pool vs water: pools are brighter
        const cls = (r + g + b > 350) ? SemanticClass.POOL : SemanticClass.WATER;
        semMap.data[idx] = cls;
        semMap.confidence[idx] = 0.2;
        refined++;
        continue;
      }

      // Only classify BARE GROUND if very clearly brown/tan with NO green
      if (r > 140 && r > g * 1.3 && r > b * 1.5 && g < 130 && b < 100) {
        semMap.data[idx] = SemanticClass.BARE_GROUND;
        semMap.confidence[idx] = 0.2;
        refined++;
        continue;
      }

      // Dense forest: very dark with green dominance
      if (g > r && g > b && r < 50 && g < 70 && b < 45) {
        semMap.data[idx] = SemanticClass.FOREST;
        semMap.confidence[idx] = 0.2;
        refined++;
      }
    }
  }
  return refined;
}

const parentCache = new Map<string, Buffer>();

interface RenderResult {
  buffer: Buffer;
  complete: boolean; // true if all critical data sources succeeded
}

async function renderParentTile(sz: number, sx: number, sy: number): Promise<RenderResult | null> {
  const parentKey = `parent_${sz}_${sx}_${sy}`;

  const bbox = tileToBBox(sz, sx, sy);
  const extent = 4096;
  const renderSize = 1024;

  // Fetch all data sources in parallel
  async function fetchAllSources() {
    return Promise.all([
      fetchOneVectorTile(sz, sx, sy),
      fetchOneElevationTile(sz, sx, sy),
      fetchOverpass(bbox.south, bbox.west, bbox.north, bbox.east),
      fetchSatelliteTilePixels(sz, sx, sy),
    ]);
  }

  let [vt, elevTile, overpass, satTile] = await fetchAllSources();

  // Check completeness — actual highway roads are critical (not just any non-building element)
  let hasOverpassRoads = (overpass.highwayCount ?? overpass.roads.length) > 0;
  let hasElevation = elevTile !== null;

  // Retry once if missing critical data
  if (!hasOverpassRoads || !hasElevation) {
    const missing = [];
    if (!hasOverpassRoads) missing.push(`overpass highways (got ${overpass.roads.length} non-building elements but 0 highways)`);
    if (!hasElevation) missing.push('elevation');
    console.log(`  Incomplete data (missing: ${missing.join(', ')}), retrying in 3s...`);
    await new Promise(r => setTimeout(r, 3000));
    // Only re-fetch what's missing
    if (!hasOverpassRoads) {
      overpass = await fetchOverpass(bbox.south, bbox.west, bbox.north, bbox.east);
      hasOverpassRoads = (overpass.highwayCount ?? overpass.roads.length) > 0;
    }
    if (!hasElevation) {
      elevTile = await fetchOneElevationTile(sz, sx, sy);
      hasElevation = elevTile !== null;
    }
  }

  // Still no Overpass roads after retry — refuse to render
  if (!hasOverpassRoads) {
    console.log(`  SKIPPED: No Overpass highway data after retry — returning 503`);
    return null;
  }

  const complete = hasOverpassRoads && hasElevation;

  console.log(`  Overpass: ${overpass.buildings.length} buildings, ${overpass.roads.length} roads`);

  // Build semantic map at full vector tile resolution
  const semMap = createSemanticMap(extent, extent, bbox, 1);
  semMap.sources.add('vector');
  for (let i = 0; i < semMap.data.length; i++) {
    semMap.data[i] = SemanticClass.GRASS;
    semMap.confidence[i] = 0.1;
  }

  if (vt) {
    const layerOrder = [
      { name: 'ocean', cls: SemanticClass.WATER },
      { name: 'land', cls: null as SemanticClass | null },
      { name: 'sites', cls: null as SemanticClass | null },
      { name: 'water_polygons', cls: SemanticClass.WATER },
      { name: 'street_polygons', cls: SemanticClass.ROAD },
      { name: 'streets', cls: null as SemanticClass | null },
      { name: 'buildings', cls: SemanticClass.BUILDING },
    ];

    for (const { name, cls: defaultCls } of layerOrder) {
      const layer = vt.layers[name];
      if (!layer) continue;

      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        const props = f.properties as Record<string, any>;
        const kind = (props.kind as string) || '';

        if (name === 'streets' && props.tunnel) continue;
        if (name === 'streets' && (props.rail || kind === 'rail' || kind === 'subway' || kind === 'tram')) continue;

        let cls = defaultCls;
        let width = 0;

        if (name === 'streets') {
          const isDirt = kind === 'path' || kind === 'track' || kind === 'bridleway';
          const isPaved = kind === 'cycleway' || kind === 'footway' || kind === 'pedestrian' || kind === 'steps';
          cls = isDirt ? SemanticClass.PATH_DIRT : isPaved ? SemanticClass.PARKING : SemanticClass.ROAD;
          width = ROAD_WIDTHS[kind] ?? 14;
        } else if (name === 'land' || name === 'sites') {
          cls = LAND_MAP[kind] ?? null;
          if (!cls) continue;
        }
        if (!cls) continue;

        const geom = f.loadGeometry();
        const points: number[][] = [];
        for (const ring of geom) {
          for (const pt of ring) points.push([pt.x, pt.y]);
        }

        const priority = cls === SemanticClass.BUILDING ? 0.9 : cls === SemanticClass.ROAD ? 0.8 : cls === SemanticClass.WATER ? 0.6 : 0.3;

        if (f.type === 3) {
          fillPolygon(semMap, points, cls, priority, 'vector');
        } else if (f.type === 2 && width > 0) {
          drawLine(semMap, points, cls, width, priority, 'vector');
        }
      }
    }
  }

  // Overlay Overpass data — complete coverage from OSM
  // Process in priority order: land cover < water < roads < buildings

  for (const element of overpass.roads) {
    if (!element.geometry || element.geometry.length < 2) continue;
    const t = element.tags;

    let cls: SemanticClass | null = null;
    let width = 0;
    let priority = 0.4;

    // Natural features
    if (t.natural === 'water') { cls = SemanticClass.WATER; priority = 0.7; }
    else if (t.natural === 'beach' || t.natural === 'sand') { cls = SemanticClass.SAND; priority = 0.7; }
    else if (t.natural === 'wood' || t.natural === 'scrub') { cls = SemanticClass.FOREST; priority = 0.45; }
    else if (t.natural === 'grassland') { cls = SemanticClass.GRASS; priority = 0.4; }
    else if (t.natural === 'bare_rock' || t.natural === 'cliff' || t.natural === 'scree') { cls = SemanticClass.ROCK; priority = 0.5; }
    else if (t.natural === 'wetland') { cls = SemanticClass.WETLAND; priority = 0.5; }
    // Waterways
    else if (t.waterway) { cls = SemanticClass.WATER; width = t.waterway === 'river' ? 30 : 15; priority = 0.7; }
    // Land use
    else if (t.landuse === 'forest' || t.landuse === 'orchard') { cls = SemanticClass.FOREST; priority = 0.45; }
    else if (t.landuse === 'meadow' || t.landuse === 'grass' || t.landuse === 'village_green') { cls = SemanticClass.GRASS; priority = 0.4; }
    else if (t.landuse === 'farmland' || t.landuse === 'farmyard') { cls = SemanticClass.FARMLAND; priority = 0.45; }
    else if (t.landuse === 'cemetery') { cls = SemanticClass.CEMETERY; priority = 0.45; }
    else if (t.landuse === 'residential') { cls = SemanticClass.RESIDENTIAL_ZONE; priority = 0.2; }
    else if (t.landuse === 'commercial' || t.landuse === 'retail') { cls = SemanticClass.INDUSTRIAL; priority = 0.3; }
    else if (t.landuse === 'industrial') { cls = SemanticClass.INDUSTRIAL; priority = 0.3; }
    else if (t.landuse === 'construction' || t.landuse === 'brownfield') { cls = SemanticClass.BARE_GROUND; priority = 0.35; }
    // Leisure — detailed classification
    else if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'nature_reserve') { cls = SemanticClass.PARK; priority = 0.45; }
    else if (t.leisure === 'swimming_pool') { cls = SemanticClass.POOL; priority = 0.8; }
    else if (t.leisure === 'pitch') {
      // Sports surface: grass, clay, sand, asphalt etc.
      cls = SemanticClass.SPORTS_PITCH; priority = 0.6;
      if (t.surface === 'grass' || t.sport === 'soccer' || t.sport === 'baseball') cls = SemanticClass.PARK; // grass pitch
    }
    else if (t.leisure === 'playground') { cls = SemanticClass.PLAYGROUND; priority = 0.55; }
    else if (t.leisure === 'golf_course') { cls = SemanticClass.PARK; priority = 0.45; }
    // Amenities
    else if (t.amenity === 'parking') { cls = SemanticClass.PARKING; priority = 0.6; }
    else if (t.amenity === 'school') { cls = SemanticClass.SCHOOL; priority = 0.2; }
    // Railway
    else if (t.railway) { cls = SemanticClass.RAILWAY; width = 12; priority = 0.75; }
    // Green dashed on OSM = bridleway/path/track = dirt paths
    else if (t.highway === 'path' || t.highway === 'track' || t.highway === 'bridleway') {
      cls = SemanticClass.PATH_DIRT;
      width = HIGHWAY_WIDTHS[t.highway] ?? 8;
      priority = 0.7;
    }
    // Blue dashed on OSM = cycleway + footway/pedestrian/steps = paved concrete
    else if (t.highway === 'cycleway' || t.highway === 'footway' || t.highway === 'pedestrian' || t.highway === 'steps') {
      cls = SemanticClass.PARKING; // smooth_stone = light gray paved/concrete
      width = HIGHWAY_WIDTHS[t.highway] ?? 10;
      priority = 0.75;
    }
    // Roads (highest non-building priority)
    else if (t.highway) {
      cls = SemanticClass.ROAD;
      width = HIGHWAY_WIDTHS[t.highway] ?? 18;
      priority = 0.85;
    }

    if (!cls) continue;
    const points = geoToTilePixels(element.geometry, bbox, extent);

    const first = element.geometry[0];
    const last = element.geometry[element.geometry.length - 1];
    const isClosed = Math.abs(first.lat - last.lat) < 0.00001 && Math.abs(first.lon - last.lon) < 0.00001;

    if (isClosed && width === 0) {
      fillPolygon(semMap, points, cls, priority, 'vector');
    } else {
      drawLine(semMap, points, cls, width || 15, priority, 'vector');
    }
  }

  // Buildings from Overpass (highest priority)
  for (const building of overpass.buildings) {
    if (!building.geometry || building.geometry.length < 3) continue;
    const points = geoToTilePixels(building.geometry, bbox, extent);
    fillPolygon(semMap, points, SemanticClass.BUILDING, 0.95, 'vector');
  }

  // Overture Maps: Microsoft AI building footprints (fills OSM gaps)
  // Fetch the exact same z14 tile we're rendering
  const overturePolygons: number[][][] = [];
  try {
    const PbfClass2 = (Pbf as any).default || Pbf;
    const otResult = await overtureTiles.getZxy(sz, sx, sy);
    if (otResult?.data) {
      const otTile = new VectorTile(new PbfClass2(new Uint8Array(otResult.data)));
      const otLayer = otTile.layers['building'];
      if (otLayer) {
        const n = Math.pow(2, sz);
        for (let i = 0; i < otLayer.length; i++) {
          const f = otLayer.feature(i);
          if (f.type !== 3) continue;
          const geom = f.loadGeometry();
          for (const ring of geom) {
            const points: number[][] = [];
            for (const pt of ring) {
              // Tile-local MVT coords (0-4096) map directly to our semantic map (also 0-4096)
              points.push([pt.x, pt.y]);
            }
            if (points.length >= 3) overturePolygons.push(points);
          }
        }
      }
    }
  } catch {}
  console.log(`  Overture direct: ${overturePolygons.length} polygons`);
  let overtureNew = 0;
  for (const polygon of overturePolygons) {
    // Only fill if the area isn't already marked as BUILDING by OSM
    // Check center point
    let cx = 0, cy = 0;
    for (const [px, py] of polygon) { cx += px; cy += py; }
    cx /= polygon.length; cy /= polygon.length;
    const ci = Math.floor(cy) * extent + Math.floor(cx);
    if (ci >= 0 && ci < semMap.data.length && semMap.data[ci] !== SemanticClass.BUILDING) {
      fillPolygon(semMap, polygon, SemanticClass.BUILDING, 0.9, 'vector');
      overtureNew++;
    }
  }
  console.log(`  Overture: ${overturePolygons.length} footprints (${overtureNew} new)`);

  // Individual trees from OSM (mark cells as FOREST for tree placement)
  console.log(`  Individual trees: ${overpass.trees.length}`);
  for (const tree of overpass.trees) {
    const px = ((tree.lon - bbox.west) / (bbox.east - bbox.west)) * extent;
    const py = ((bbox.north - tree.lat) / (bbox.north - bbox.south)) * extent;
    // Mark a small area as forest so the placer puts a tree there
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx*dx + dy*dy > 12) continue;
        const x = Math.floor(px + dx);
        const y = Math.floor(py + dy);
        if (x >= 0 && x < extent && y >= 0 && y < extent) {
          const idx = y * extent + x;
          if (semMap.data[idx] === SemanticClass.GRASS || semMap.data[idx] === SemanticClass.PARK) {
            semMap.data[idx] = SemanticClass.FOREST;
            semMap.confidence[idx] = 0.5;
          }
        }
      }
    }
  }

  // Refine ground cover using satellite imagery
  if (satTile) {
    const refined = refineGroundFromSatellite(semMap, satTile.data, satTile.width, satTile.height);
    console.log(`  Satellite ground refinement: ${refined} cells reclassified`);
  }

  // Downsample: 4096 -> 1024
  const scaleDown = extent / renderSize;
  const newData = new Uint8Array(renderSize * renderSize);
  const newConf = new Float32Array(renderSize * renderSize);
  for (let ny = 0; ny < renderSize; ny++) {
    for (let nx = 0; nx < renderSize; nx++) {
      const srcIdx = Math.min(ny * scaleDown, extent - 1) * extent + Math.min(nx * scaleDown, extent - 1);
      newData[ny * renderSize + nx] = semMap.data[srcIdx];
      newConf[ny * renderSize + nx] = semMap.confidence[srcIdx];
    }
  }
  const workingMap = { ...semMap, width: renderSize, height: renderSize, data: newData, confidence: newConf };

  // Build heightmap at render resolution
  const elevation = new Float32Array(renderSize * renderSize);
  if (elevTile) {
    for (let py = 0; py < renderSize; py++) {
      for (let px = 0; px < renderSize; px++) {
        elevation[py * renderSize + px] = decodeTerrarium(elevTile.data, (px / renderSize) * elevTile.width, (py / renderSize) * elevTile.width, elevTile.width);
      }
    }
  }
  // Fixed global elevation scaling — prevents seams between adjacent tiles.
  // All tiles use the same mapping: 0m real = Y64 (sea level), 1m = 0.5 blocks.
  const seaLevel = 64;
  const metersPerBlock = 2; // 1 block per 2 meters of real elevation
  const quantized = new Uint8Array(renderSize * renderSize);
  for (let i = 0; i < elevation.length; i++) {
    const y = seaLevel + Math.round(elevation[i] / metersPerBlock);
    quantized[i] = Math.min(255, Math.max(1, y));
  }

  const heightMap: HeightMap = {
    width: renderSize, height: renderSize, elevation, quantized, seaLevel,
    resolution: 1, origin: { lat: bbox.north, lng: bbox.west }, bounds: bbox,
  };

  // Use the EXACT pipeline code that produced the approved output
  const terrainResult = quantizeTerrain(heightMap, { seaLevel });

  // Sample satellite colors for building roofs (makes white roofs white, not terracotta)
  let surfaceColors = undefined;
  if (satTile) {
    const satData = {
      pixels: satTile.data,
      width: satTile.width,
      height: satTile.height,
      bounds: bbox,
      tileZoom: sz,
    };
    surfaceColors = sampleSurfaceColors(satData, workingMap);
  }

  const worldResult = placeBlocks(workingMap, terrainResult.data, undefined, surfaceColors);
  const pipelineResult = renderTopDown(worldResult.data, '');

  const result = pipelineResult.buffer!;
  if (complete) {
    parentCache.set(parentKey, result);
    if (parentCache.size > 50) {
      const first = parentCache.keys().next().value;
      if (first) parentCache.delete(first);
    }
  }

  return { buffer: result, complete };
}

// In-flight parent renders to avoid duplicate work
const parentInFlight = new Map<string, Promise<Buffer>>();

/**
 * Render a z14 parent and pre-slice ALL 16 z16 sub-tiles into cache.
 * This way, when you pan, adjacent tiles are already ready.
 */
async function renderAndCacheParent(parentZ: number, parentX: number, parentY: number): Promise<void> {
  const parentKey = `p_${parentZ}_${parentX}_${parentY}`;

  // Already rendering this parent? Wait for it.
  if (parentInFlight.has(parentKey)) {
    await parentInFlight.get(parentKey);
    return;
  }

  const promise = (async () => {
    const start = Date.now();
    const renderResult = await renderParentTile(parentZ, parentX, parentY);
    if (!renderResult) return; // Incomplete data — don't generate tiles
    const { buffer: parentPNG, complete } = renderResult;
    const parentImg = await loadImage(parentPNG);
    const parentW = parentImg.width;

    // Slice into z16 tiles (4x4 = 16 tiles)
    const factor = 4; // z16 - z14 = 2, 2^2 = 4
    const subSize = parentW / factor;

    for (let sy = 0; sy < factor; sy++) {
      for (let sx = 0; sx < factor; sx++) {
        const tileX = parentX * factor + sx;
        const tileY = parentY * factor + sy;
        const key = `16_${tileX}_${tileY}`;
        const diskPath = join(CACHE_DIR, `${key}.png`);

        const canvas = createCanvas(256, 256);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(parentImg, sx * subSize, sy * subSize, subSize, subSize, 0, 0, 256, 256);
        const buf = canvas.toBuffer('image/png');

        // Only persist to disk if tile has complete data
        if (complete) {
          writeFileSync(diskPath, buf);
        }
        memCacheSet(key, buf);
      }
    }

    console.log(`  Parent ${parentZ}/${parentX}/${parentY} -> 16 tiles in ${Date.now() - start}ms${complete ? '' : ' (INCOMPLETE - not cached)'}`);
  })();

  parentInFlight.set(parentKey, promise);
  try { await promise; } finally { parentInFlight.delete(parentKey); }
}

// ============================================
// Server with caching
// ============================================

const memCache = new Map<string, Buffer>();
const MEM_CACHE_MAX = 500;
function memCacheSet(key: string, buf: Buffer) {
  memCache.set(key, buf);
  if (memCache.size > MEM_CACHE_MAX) {
    const first = memCache.keys().next().value;
    if (first) memCache.delete(first);
  }
}

app.get('/tiles/:z/:x/:y.png', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const z = parseInt(req.params.z);
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);

  if (isNaN(z) || isNaN(x) || isNaN(y) || z < 0 || z > 16) {
    return res.status(400).send('');
  }

  const key = `${z}_${x}_${y}`;

  // TEMP: all caching disabled for dev — always re-render
  const diskPath = join(CACHE_DIR, `${key}.png`);
  /*
  if (memCache.has(key)) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache, no-store');
    return res.send(memCache.get(key));
  }
  if (existsSync(diskPath)) {
    const buf = readFileSync(diskPath);
    memCacheSet(key, buf);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache, no-store');
    return res.send(buf);
  }
  */

  try {
    if (z === 16) {
      // Render parent z14 tile and pre-cache all 16 z16 sub-tiles
      const parentX = Math.floor(x / 4);
      const parentY = Math.floor(y / 4);
      await renderAndCacheParent(14, parentX, parentY);

      // Now it should be cached (if render succeeded)
      if (existsSync(diskPath)) {
        const buf = readFileSync(diskPath);
        memCacheSet(key, buf);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-cache, no-store');
        return res.send(buf);
      }
      // If not on disk, render was incomplete — return 503 so browser retries
      if (memCache.has(key)) {
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-cache, no-store');
        return res.send(memCache.get(key));
      }
      return res.status(503).set('Retry-After', '5').send('');
    }

    // Fallback: render directly for z14 or below
    const start = Date.now();
    const result = await renderParentTile(z, x, y);
    if (!result) {
      return res.status(503).set('Retry-After', '5').send('');
    }
    const { buffer: png, complete } = result;
    console.log(`  ${z}/${x}/${y} rendered in ${Date.now() - start}ms${complete ? '' : ' (INCOMPLETE)'}`);

    if (complete) writeFileSync(diskPath, png);
    memCacheSet(key, png);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache, no-store');
    res.send(png);
  } catch (err) {
    console.error(`Error ${z}/${x}/${y}:`, err);
    res.status(500).send('');
  }
});

// ============================================
// Map frame textures (8-slice pixel art)
// ============================================

function generateFrameTextures() {
  const cache: Record<string, Buffer> = {};
  const T = 24; // frame thickness in pixels
  const C = 36; // corner size in pixels
  const px = 3;  // pixel scale

  // Color palette for the parchment frame
  const OUTER_DARK  = '#3d2e1a';
  const OUTER_MID   = '#6b5433';
  const FRAME_DARK  = '#8a7456';
  const FRAME_MID   = '#b8a47e';
  const FRAME_LIGHT = '#cdb99a';
  const FRAME_HI    = '#ddd0b4';
  const INNER_DARK  = '#5a4a30';

  function drawEdgeTop(w: number, h: number): Buffer {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    // Outer dark border (2px)
    ctx.fillStyle = OUTER_DARK;
    ctx.fillRect(0, 0, w, px * 2);
    // Outer mid
    ctx.fillStyle = OUTER_MID;
    ctx.fillRect(0, px * 2, w, px);
    // Highlight band
    ctx.fillStyle = FRAME_HI;
    ctx.fillRect(0, px * 3, w, px);
    // Main frame fill
    ctx.fillStyle = FRAME_LIGHT;
    ctx.fillRect(0, px * 4, w, px * 2);
    ctx.fillStyle = FRAME_MID;
    ctx.fillRect(0, px * 6, w, h - px * 8);
    // Inner shadow
    ctx.fillStyle = FRAME_DARK;
    ctx.fillRect(0, h - px * 2, w, px);
    ctx.fillStyle = INNER_DARK;
    ctx.fillRect(0, h - px, w, px);
    // Add pixel noise for texture
    for (let x = 0; x < w; x += px) {
      const hash = (x * 73856093) & 0xFFFF;
      if (hash % 7 === 0) {
        const ny = px * 4 + (hash % 4) * px;
        ctx.fillStyle = FRAME_MID;
        ctx.fillRect(x, ny, px, px);
      }
      if (hash % 11 === 0) {
        const ny = px * 5 + (hash % 3) * px;
        ctx.fillStyle = FRAME_HI;
        ctx.fillRect(x, ny, px, px);
      }
    }
    return c.toBuffer('image/png');
  }

  function drawEdgeLeft(w: number, h: number): Buffer {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = OUTER_DARK;
    ctx.fillRect(0, 0, px * 2, h);
    ctx.fillStyle = OUTER_MID;
    ctx.fillRect(px * 2, 0, px, h);
    ctx.fillStyle = FRAME_HI;
    ctx.fillRect(px * 3, 0, px, h);
    ctx.fillStyle = FRAME_LIGHT;
    ctx.fillRect(px * 4, 0, px * 2, h);
    ctx.fillStyle = FRAME_MID;
    ctx.fillRect(px * 6, 0, w - px * 8, h);
    ctx.fillStyle = FRAME_DARK;
    ctx.fillRect(w - px * 2, 0, px, h);
    ctx.fillStyle = INNER_DARK;
    ctx.fillRect(w - px, 0, px, h);
    for (let y = 0; y < h; y += px) {
      const hash = (y * 19349663) & 0xFFFF;
      if (hash % 7 === 0) { ctx.fillStyle = FRAME_MID; ctx.fillRect(px * 4 + (hash % 3) * px, y, px, px); }
      if (hash % 11 === 0) { ctx.fillStyle = FRAME_HI; ctx.fillRect(px * 5 + (hash % 2) * px, y, px, px); }
    }
    return c.toBuffer('image/png');
  }

  function drawCorner(pos: string): Buffer {
    const c = createCanvas(C, C);
    const ctx = c.getContext('2d');

    // Fill base
    ctx.fillStyle = FRAME_MID;
    ctx.fillRect(0, 0, C, C);

    // Outer edges
    ctx.fillStyle = OUTER_DARK;
    if (pos.includes('t')) ctx.fillRect(0, 0, C, px * 2);
    if (pos.includes('b')) ctx.fillRect(0, C - px * 2, C, px * 2);
    if (pos.includes('l')) ctx.fillRect(0, 0, px * 2, C);
    if (pos.includes('r')) ctx.fillRect(C - px * 2, 0, px * 2, C);

    ctx.fillStyle = OUTER_MID;
    if (pos.includes('t')) ctx.fillRect(px * 2, px * 2, C - px * 4, px);
    if (pos.includes('b')) ctx.fillRect(px * 2, C - px * 3, C - px * 4, px);
    if (pos.includes('l')) ctx.fillRect(px * 2, px * 2, px, C - px * 4);
    if (pos.includes('r')) ctx.fillRect(C - px * 3, px * 2, px, C - px * 4);

    // Highlight band
    ctx.fillStyle = FRAME_HI;
    if (pos.includes('t')) ctx.fillRect(px * 3, px * 3, C - px * 6, px);
    if (pos.includes('l')) ctx.fillRect(px * 3, px * 3, px, C - px * 6);

    // Light fill
    ctx.fillStyle = FRAME_LIGHT;
    const inner = px * 4;
    ctx.fillRect(inner, inner, C - inner * 2, C - inner * 2);

    // Inner shadow edges
    ctx.fillStyle = INNER_DARK;
    if (pos.includes('t')) ctx.fillRect(C - px, px * 2, px, C - px * 2); // right inner if top-right
    if (pos.includes('b')) ctx.fillRect(0, C - px, C, px);

    ctx.fillStyle = FRAME_DARK;
    const ie = C - px * 2;
    if (pos === 'tl') { ctx.fillRect(ie, px * 4, px, C - px * 4); ctx.fillRect(px * 4, ie, C - px * 4, px); }
    if (pos === 'tr') { ctx.fillRect(px, px * 4, px, C - px * 4); ctx.fillRect(px, ie, C - px * 4, px); }
    if (pos === 'bl') { ctx.fillRect(ie, px, px, C - px * 4); ctx.fillRect(px * 4, px, C - px * 4, px); }
    if (pos === 'br') { ctx.fillRect(px, px, px, C - px * 4); ctx.fillRect(px, px, C - px * 4, px); }

    // Corner accent — darker nub
    ctx.fillStyle = OUTER_DARK;
    if (pos === 'tl') { ctx.fillRect(0, 0, px * 3, px * 3); }
    if (pos === 'tr') { ctx.fillRect(C - px * 3, 0, px * 3, px * 3); }
    if (pos === 'bl') { ctx.fillRect(0, C - px * 3, px * 3, px * 3); }
    if (pos === 'br') { ctx.fillRect(C - px * 3, C - px * 3, px * 3, px * 3); }

    return c.toBuffer('image/png');
  }

  // Generate all 8 pieces
  cache['edge-top'] = drawEdgeTop(px * 16, T);
  // Bottom edge = top edge drawn flipped
  cache['edge-bottom'] = (() => {
    const c = createCanvas(px * 16, T);
    const ctx = c.getContext('2d');
    // Redraw top edge logic but reversed (dark at bottom, highlight at top)
    ctx.fillStyle = INNER_DARK;
    ctx.fillRect(0, 0, px * 16, px);
    ctx.fillStyle = FRAME_DARK;
    ctx.fillRect(0, px, px * 16, px);
    ctx.fillStyle = FRAME_MID;
    ctx.fillRect(0, px * 2, px * 16, T - px * 8);
    ctx.fillStyle = FRAME_LIGHT;
    ctx.fillRect(0, T - px * 6, px * 16, px * 2);
    ctx.fillStyle = FRAME_HI;
    ctx.fillRect(0, T - px * 4, px * 16, px);
    ctx.fillStyle = OUTER_MID;
    ctx.fillRect(0, T - px * 3, px * 16, px);
    ctx.fillStyle = OUTER_DARK;
    ctx.fillRect(0, T - px * 2, px * 16, px * 2);
    return c.toBuffer('image/png');
  })();
  cache['edge-left'] = drawEdgeLeft(T, px * 16);
  // Right edge = left edge drawn flipped
  cache['edge-right'] = (() => {
    const c = createCanvas(T, px * 16);
    const ctx = c.getContext('2d');
    ctx.fillStyle = INNER_DARK;
    ctx.fillRect(0, 0, px, px * 16);
    ctx.fillStyle = FRAME_DARK;
    ctx.fillRect(px, 0, px, px * 16);
    ctx.fillStyle = FRAME_MID;
    ctx.fillRect(px * 2, 0, T - px * 8, px * 16);
    ctx.fillStyle = FRAME_LIGHT;
    ctx.fillRect(T - px * 6, 0, px * 2, px * 16);
    ctx.fillStyle = FRAME_HI;
    ctx.fillRect(T - px * 4, 0, px, px * 16);
    ctx.fillStyle = OUTER_MID;
    ctx.fillRect(T - px * 3, 0, px, px * 16);
    ctx.fillStyle = OUTER_DARK;
    ctx.fillRect(T - px * 2, 0, px * 2, px * 16);
    return c.toBuffer('image/png');
  })();
  cache['corner-tl'] = drawCorner('tl');
  cache['corner-tr'] = drawCorner('tr');
  cache['corner-bl'] = drawCorner('bl');
  cache['corner-br'] = drawCorner('br');

  return cache;
}

const frameTextures = generateFrameTextures();

app.get('/frame/:piece.png', (req, res) => {
  const buf = frameTextures[req.params.piece];
  if (!buf) return res.status(404).send('');
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-cache, no-store');
  res.send(buf);
});

// Serve static assets from public/
app.use('/icons', express.static(resolve('public/icons')));
app.use('/fonts', express.static(resolve('public')));
app.use('/menu', express.static(resolve('public/menu')));
app.use(express.static(resolve('public')));

// Service worker for browser tile caching
app.get('/sw.js', (_req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.send(`
var CACHE_NAME = 'mc-tiles-v2';
var TILE_RE = /\\/tiles\\/\\d+\\/\\d+\\/\\d+\\.png/;
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});
self.addEventListener('fetch', function(e) {
  var url = new URL(e.request.url);
  if (!TILE_RE.test(url.pathname)) return;
  // Strip query params for cache key (ignore ?v= cache buster)
  var cacheUrl = url.origin + url.pathname;
  var cacheReq = new Request(cacheUrl);
  e.respondWith(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(cacheReq).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(resp) {
          if (resp.ok) cache.put(cacheReq, resp.clone());
          return resp;
        }).catch(function() {
          // Network failed — return empty response instead of crashing
          return new Response('', { status: 503, statusText: 'Tile unavailable' });
        });
      });
    }).catch(function() {
      // Cache API failed — just fetch directly
      return fetch(e.request);
    })
  );
});
  `);
});

// POI proxy — fetches amenities from Overpass for a bounding box
app.get('/pois', async (req, res) => {
  const { s, w, n, e } = req.query;
  if (!s || !w || !n || !e) return res.json([]);
  const bbox = `${s},${w},${n},${e}`;
  const query = `[out:json][timeout:15][bbox:${bbox}];(node["amenity"]["name"];node["shop"]["name"];way["amenity"]["name"];way["shop"]["name"];);out center 500;`;
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(12000),
    });
    const data = await r.json();
    const pois = (data.elements || []).map((el: any) => {
      const t = el.tags || {};
      const amenity = t.amenity || t.shop || 'other';
      const lat = el.lat || el.center?.lat;
      const lng = el.lon || el.center?.lon;
      if (!lat || !lng) return null;
      return { lat, lng, name: t.name || '', type: amenity };
    }).filter((p: any) => p && p.name);
    res.json(pois);
  } catch {
    res.json([]);
  }
});

// ============================================
// Friends API
// ============================================

app.get('/api/friends', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  // Get accepted friends
  const friends = db.prepare(`
    SELECT p.id, p.player_name, p.friend_code FROM friendships f
    JOIN players p ON p.id = CASE WHEN f.player_id = ? THEN f.friend_id ELSE f.player_id END
    WHERE (f.player_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
  `).all(session.playerId, session.playerId, session.playerId) as any[];

  // Get pending requests TO me
  const pending = db.prepare(`
    SELECT f.id as friendship_id, p.id, p.player_name, p.friend_code FROM friendships f
    JOIN players p ON p.id = f.player_id
    WHERE f.friend_id = ? AND f.status = 'pending'
  `).all(session.playerId) as any[];

  // Get my outgoing requests
  const sent = db.prepare(`
    SELECT f.id as friendship_id, p.id, p.player_name FROM friendships f
    JOIN players p ON p.id = f.friend_id
    WHERE f.player_id = ? AND f.status = 'pending'
  `).all(session.playerId) as any[];

  // Mark online status
  const onlineIds = new Set<number>();
  for (const [, client] of wsClients) {
    if (client.playerId) onlineIds.add(client.playerId);
  }

  res.json({
    friends: friends.map((f: any) => ({ ...f, online: onlineIds.has(f.id) })),
    pending,
    sent,
  });
});

app.post('/api/friends/add', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Friend code required' });

  const friend = db.prepare('SELECT id, player_name FROM players WHERE friend_code = ?').get(code.toUpperCase()) as any;
  if (!friend) return res.status(404).json({ error: 'Player not found' });
  if (friend.id === session.playerId) return res.status(400).json({ error: "That's your own code!" });

  // Check if already friends or pending
  const existing = db.prepare('SELECT id, status FROM friendships WHERE (player_id = ? AND friend_id = ?) OR (player_id = ? AND friend_id = ?)').get(session.playerId, friend.id, friend.id, session.playerId) as any;
  if (existing) {
    if (existing.status === 'accepted') return res.status(400).json({ error: 'Already friends!' });
    return res.status(400).json({ error: 'Request already pending' });
  }

  db.prepare('INSERT INTO friendships (player_id, friend_id, status) VALUES (?, ?, ?)').run(session.playerId, friend.id, 'pending');

  // Notify friend via WebSocket
  broadcastToPlayer(friend.id, { type: 'friend_request', from: session.playerName });

  res.json({ ok: true, friendName: friend.player_name });
});

app.post('/api/friends/accept', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const { friendshipId } = req.body;
  db.prepare('UPDATE friendships SET status = ? WHERE id = ? AND friend_id = ?').run('accepted', friendshipId, session.playerId);

  // Notify the requester
  const friendship = db.prepare('SELECT player_id FROM friendships WHERE id = ?').get(friendshipId) as any;
  if (friendship) broadcastToPlayer(friendship.player_id, { type: 'friend_accepted', by: session.playerName });

  res.json({ ok: true });
});

app.post('/api/friends/remove', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const { friendId } = req.body;
  db.prepare('DELETE FROM friendships WHERE (player_id = ? AND friend_id = ?) OR (player_id = ? AND friend_id = ?)').run(session.playerId, friendId, friendId, session.playerId);
  res.json({ ok: true });
});

// ============================================
// WebSocket server — real-time location + chat
// ============================================

const httpServer = createServer(app);

interface WSClient {
  ws: WebSocket;
  playerId: number;
  playerName: string;
  lat: number;
  lng: number;
  lastUpdate: number;
}

const wsClients = new Map<WebSocket, WSClient>();

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Auth from cookie
  const cookieStr = req.headers.cookie || '';
  const match = cookieStr.match(/mc_session=([^;]+)/);
  const session = match ? getSession(match[1]) : null;

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authenticated' }));
    ws.close();
    return;
  }

  const client: WSClient = {
    ws, playerId: session.playerId, playerName: session.playerName,
    lat: 0, lng: 0, lastUpdate: Date.now(),
  };
  wsClients.set(ws, client);
  console.log(`  WS: ${session.playerName} connected (${wsClients.size} online)`);

  // Send welcome
  ws.send(JSON.stringify({ type: 'welcome', playerName: session.playerName }));

  // Notify friends that this player is online
  broadcastToFriends(session.playerId, { type: 'friend_online', playerId: session.playerId, playerName: session.playerName });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'location') {
        client.lat = msg.lat;
        client.lng = msg.lng;
        client.lastUpdate = Date.now();
        // Broadcast to friends
        broadcastToFriends(session.playerId, {
          type: 'friend_location',
          playerId: session.playerId,
          playerName: session.playerName,
          lat: msg.lat, lng: msg.lng,
        });
      }

      if (msg.type === 'chat') {
        const content = (msg.content || '').trim().substring(0, 200);
        if (!content) return;
        // Save to DB
        db.prepare('INSERT INTO messages (from_id, content) VALUES (?, ?)').run(session.playerId, content);
        // Broadcast to all friends
        broadcastToFriends(session.playerId, {
          type: 'chat',
          playerId: session.playerId,
          playerName: session.playerName,
          content,
          timestamp: Date.now(),
        });
        // Echo back to sender
        ws.send(JSON.stringify({
          type: 'chat',
          playerId: session.playerId,
          playerName: session.playerName,
          content,
          timestamp: Date.now(),
          self: true,
        }));
      }
    } catch {}
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`  WS: ${session.playerName} disconnected (${wsClients.size} online)`);
    broadcastToFriends(session.playerId, { type: 'friend_offline', playerId: session.playerId, playerName: session.playerName });
  });
});

function broadcastToPlayer(playerId: number, msg: any) {
  const data = JSON.stringify(msg);
  for (const [, client] of wsClients) {
    if (client.playerId === playerId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

function broadcastToFriends(playerId: number, msg: any) {
  // Get this player's accepted friends
  const friends = db.prepare(`
    SELECT CASE WHEN player_id = ? THEN friend_id ELSE player_id END as fid
    FROM friendships WHERE (player_id = ? OR friend_id = ?) AND status = 'accepted'
  `).all(playerId, playerId, playerId) as any[];
  const friendIds = new Set(friends.map((f: any) => f.fid));

  const data = JSON.stringify(msg);
  for (const [, client] of wsClients) {
    if (friendIds.has(client.playerId) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  }
}

// Viewer — served from public/index.html via express.static

httpServer.listen(PORT, () => {
  console.log(`\n  Minecraft Map: http://localhost:${PORT}`);
  console.log(`  WebSocket server ready`);
  console.log(`  First tile load ~2-3s, then cached.\n`);
});

