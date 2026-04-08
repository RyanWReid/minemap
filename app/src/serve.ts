import express from 'express';
import { createCanvas, loadImage } from 'canvas';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// Pipeline — switch between v1 and v2 via PIPELINE_VERSION env var
import { renderParentTile as renderV1 } from './pipeline/v1.js';
import { renderParentTile as renderV2 } from './pipeline/v2.js';
import type { RenderResult } from './pipeline/types.js';

const app = express();
const PORT = 3001;
const PIPELINE_VERSION = process.env.PIPELINE_VERSION === 'v1' ? 'v1' : 'v2';
const renderParentTile = PIPELINE_VERSION === 'v2' ? renderV2 : renderV1;
const TILE_VERSION = PIPELINE_VERSION;
const CACHE_DIR = resolve('tile-cache', TILE_VERSION);
mkdirSync(CACHE_DIR, { recursive: true });
const STATIC_ONLY = !!process.env.STATIC_ONLY;

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
  const result = db.prepare('DELETE FROM waypoints WHERE id = ? AND player_id = ?').run(req.params.id, session.playerId);
  if (result.changes === 0) return res.status(403).json({ error: 'Not your waypoint' });
  res.json({ ok: true });
});

app.post('/api/achievement', (req, res) => {
  const session = getSession(req.cookies?.mc_session);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'achievement key required' });

  const result = db.prepare('INSERT OR IGNORE INTO achievements (player_id, achievement_key) VALUES (?, ?)').run(session.playerId, key);
  if (result.changes > 0) {
    // New achievement — award XP
    db.prepare('UPDATE players SET xp = xp + 100 WHERE id = ?').run(session.playerId);
    const player = db.prepare('SELECT xp FROM players WHERE id = ?').get(session.playerId) as any;
    const newLevel = Math.floor(player.xp / 500) + 1;
    db.prepare('UPDATE players SET level = ? WHERE id = ?').run(newLevel, session.playerId);
    res.json({ ok: true, xp: player.xp, level: newLevel, unlocked: true });
  } else {
    // Already unlocked — no XP
    const player = db.prepare('SELECT xp, level FROM players WHERE id = ?').get(session.playerId) as any;
    res.json({ ok: true, xp: player.xp, level: player.level, unlocked: false });
  }
});

// Serve static assets (sounds, etc.)
app.use('/sounds', express.static(resolve('public/sounds')));


const parentCache = new Map<string, Buffer>();

// ============================================
// Parent render queue — paced to avoid Overpass rate limits
// ============================================
const RENDER_MAX_CONCURRENT = 3; // max parent tiles rendering at once
let renderActive = 0;

interface RenderJob {
  key: string;
  parentZ: number;
  parentX: number;
  parentY: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

const renderQueue: RenderJob[] = [];
const renderInFlight = new Map<string, Promise<void>>(); // dedup

function drainRenderQueue() {
  while (renderActive < RENDER_MAX_CONCURRENT && renderQueue.length > 0) {
    const job = renderQueue.shift()!;
    renderActive++;
    executeRenderJob(job)
      .then(() => job.resolve())
      .catch((err) => job.reject(err))
      .finally(() => {
        renderActive--;
        drainRenderQueue(); // process next in queue
      });
  }
}

async function executeRenderJob(job: RenderJob): Promise<void> {
  const start = Date.now();
  console.log(`  [${PIPELINE_VERSION}] Rendering parent ${job.parentZ}/${job.parentX}/${job.parentY}`);
  const renderResult = await renderParentTile(job.parentZ, job.parentX, job.parentY);
  if (!renderResult) return; // Overpass failed — tiles stay ungenerated
  const { buffer: parentPNG, complete } = renderResult;

  // Cache parent tile buffer
  if (complete) {
    const parentKey = `parent_${job.parentZ}_${job.parentX}_${job.parentY}`;
    parentCache.set(parentKey, parentPNG);
    if (parentCache.size > 50) {
      const first = parentCache.keys().next().value;
      if (first) parentCache.delete(first);
    }
  }

  const parentImg = await loadImage(parentPNG);
  const parentW = parentImg.width;

  const factor = 4;
  const subSize = parentW / factor;

  for (let sy = 0; sy < factor; sy++) {
    for (let sx = 0; sx < factor; sx++) {
      const tileX = job.parentX * factor + sx;
      const tileY = job.parentY * factor + sy;
      const key = `16_${tileX}_${tileY}`;
      const diskPath = join(CACHE_DIR, `${key}.png`);

      const canvas = createCanvas(256, 256);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(parentImg, sx * subSize, sy * subSize, subSize, subSize, 0, 0, 256, 256);
      const buf = canvas.toBuffer('image/png');

      if (complete) {
        writeFileSync(diskPath, buf);
        memCacheSet(key, buf);
      }
    }
  }

  const qLen = renderQueue.length;
  console.log(`  Parent ${job.parentZ}/${job.parentX}/${job.parentY} -> 16 tiles in ${Date.now() - start}ms${complete ? '' : ' (INCOMPLETE)'}${qLen > 0 ? ` [${qLen} queued, ${renderActive} active]` : ''}`);
}

/**
 * Queue a z14 parent render. Deduplicates concurrent requests for the same parent.
 * Max RENDER_MAX_CONCURRENT parents render at once — the rest wait in queue.
 */
async function renderAndCacheParent(parentZ: number, parentX: number, parentY: number): Promise<void> {
  const parentKey = `p_${parentZ}_${parentX}_${parentY}`;

  // Already rendering or queued? Wait for it.
  if (renderInFlight.has(parentKey)) {
    return renderInFlight.get(parentKey)!;
  }

  const promise = new Promise<void>((resolve, reject) => {
    renderQueue.push({ key: parentKey, parentZ, parentX, parentY, resolve, reject });
    drainRenderQueue();
  });

  renderInFlight.set(parentKey, promise);
  try { await promise; } finally { renderInFlight.delete(parentKey); }
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

  if (isNaN(z) || isNaN(x) || isNaN(y) || z !== 16) {
    return res.status(400).send('Only z16 tiles are supported');
  }

  const key = `${z}_${x}_${y}`;
  const diskPath = join(CACHE_DIR, `${key}.png`);

  // Static-only mode: serve cached tiles only, no rendering
  if (STATIC_ONLY) {
    if (existsSync(diskPath)) {
      const buf = readFileSync(diskPath);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buf);
    }
    return res.status(404).send('');
  }

  // Dev mode: serve from cache if available
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

  try {
    if (z === 16) {
      // Render parent z14 tile and pre-cache all 16 z16 sub-tiles
      const parentX = Math.floor(x / 4);
      const parentY = Math.floor(y / 4);
      await renderAndCacheParent(14, parentX, parentY);

      // Serve from disk (complete) or memory (incomplete fallback)
      if (existsSync(diskPath)) {
        const buf = readFileSync(diskPath);
        memCacheSet(key, buf);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-cache, no-store');
        return res.send(buf);
      }
      if (memCache.has(key)) {
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-cache, no-store');
        return res.send(memCache.get(key));
      }
      return res.status(503).set('Retry-After', '10').send('');
    }

    // Fallback: render directly for z14 or below
    const start = Date.now();
    const result = await renderParentTile(z, x, y);
    if (!result) {
      return res.status(503).set('Retry-After', '5').send('');
    }
    const { buffer: png, complete } = result;
    console.log(`  ${z}/${x}/${y} rendered in ${Date.now() - start}ms${complete ? '' : ' (INCOMPLETE)'}`);

    if (complete) {
      writeFileSync(diskPath, png);
      memCacheSet(key, png);
    }
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
  console.log(`  Pipeline: ${PIPELINE_VERSION} | Cache: tile-cache/${TILE_VERSION}/`);
  console.log(`  Mode: ${STATIC_ONLY ? 'STATIC (cached tiles only)' : 'FULL (rendering enabled)'}`);
  console.log(`  WebSocket server ready\n`);
});

