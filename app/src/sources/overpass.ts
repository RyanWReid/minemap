import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';

export interface OverpassResult {
  buildings: OverpassElement[];
  roads: OverpassElement[];
  trees: Array<{lat:number,lon:number}>;
  highwayCount: number;
  /** Whether the primary query (buildings+roads) returned valid data */
  primaryQuerySucceeded: boolean;
}

export interface OverpassElement {
  type: string;
  geometry?: Array<{lat:number,lon:number}>;
  lat?: number;
  lon?: number;
  tags: Record<string,string>;
}

const OVERPASS_CACHE = resolve('overpass-cache');
mkdirSync(OVERPASS_CACHE, { recursive: true });

// Overpass server config — priority: OVERPASS_URL env > OVERPASS_LOCAL > public rotation
const OVERPASS_SERVERS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : process.env.OVERPASS_LOCAL
    ? ['http://localhost:12345/api/interpreter']
    : [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      ];
let overpassServerIdx = 0;

// Global concurrency limiter for Overpass — max 2 concurrent requests to avoid 429 storms
const OVERPASS_MAX_CONCURRENT = 2;
let overpassInFlight = 0;
const overpassQueue: Array<() => void> = [];

async function overpassGate(): Promise<void> {
  if (overpassInFlight < OVERPASS_MAX_CONCURRENT) {
    overpassInFlight++;
    return;
  }
  return new Promise(resolve => {
    overpassQueue.push(resolve);
  });
}

function overpassRelease(): void {
  overpassInFlight--;
  const next = overpassQueue.shift();
  if (next) {
    overpassInFlight++;
    next();
  }
}

export async function fetchOverpass(south: number, west: number, north: number, east: number): Promise<OverpassResult> {
  // Check disk cache first
  const cacheKey = `${south.toFixed(6)}_${west.toFixed(6)}_${north.toFixed(6)}_${east.toFixed(6)}`;
  const cachePath = join(OVERPASS_CACHE, `${cacheKey}.json`);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      // Backfill fields for old cache entries
      if (cached.highwayCount === undefined) {
        cached.highwayCount = cached.roads?.filter((e: any) => e.tags?.highway)?.length ?? 0;
      }
      if (cached.primaryQuerySucceeded === undefined) {
        cached.primaryQuerySucceeded = true; // assume cached entries were valid
      }
      console.log(`  Overpass: cached (${cached.buildings.length} buildings, ${cached.roads.length} roads, ${cached.highwayCount} highways)`);
      return cached;
    } catch {}
  }
  const bbox = `${south},${west},${north},${east}`;
  // Query 1: Buildings + roads (CRITICAL — tile is incomplete without this)
  const q1 = `[out:json][timeout:25][bbox:${bbox}];(way["building"];way["highway"];);out geom;`;
  // Query 2: Everything else — land, water, leisure, amenities, trees
  const q2 = `[out:json][timeout:25][bbox:${bbox}];(way["natural"];way["waterway"];way["leisure"];way["landuse"];way["amenity"~"parking|school|hospital"];way["barrier"~"fence|wall|hedge"];node["natural"="tree"];node["natural"="tree_row"];);out geom;`;

  const server = OVERPASS_SERVERS[overpassServerIdx++ % OVERPASS_SERVERS.length];
  const url1 = `${server}?data=${encodeURIComponent(q1)}`;
  const url2 = `${server}?data=${encodeURIComponent(q2)}`;

  // Retry with exponential backoff: 2s, 4s, 8s
  const fetchJSON = async (url: string, label: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (res.status === 429 || res.status === 504) {
          const delay = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
          console.log(`  Overpass ${label}: ${res.status}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (!res.ok) {
          console.log(`  Overpass ${label}: HTTP ${res.status}`);
          return null;
        }
        const text = await res.text();
        if (text.startsWith('<')) {
          console.log(`  Overpass ${label}: XML error response (likely timeout)`);
          const delay = 2000 * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        return JSON.parse(text);
      } catch (err) {
        const delay = 2000 * Math.pow(2, attempt);
        console.log(`  Overpass ${label}: ${err instanceof Error ? err.message : 'fetch error'}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/3)`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
    }
    console.log(`  Overpass ${label}: FAILED after 3 attempts`);
    return null;
  };

  // Sequential + gated to avoid Overpass rate limits (429/504)
  await overpassGate();
  let d1, d2;
  try {
    d1 = await fetchJSON(url1, 'Q1:roads+buildings');
    d2 = await fetchJSON(url2, 'Q2:nature+land');
  } finally {
    overpassRelease();
  }

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

  const primaryQuerySucceeded = d1 !== null;
  const result: OverpassResult = { buildings, roads, trees, highwayCount, primaryQuerySucceeded };

  // Only cache if the primary query succeeded (don't poison cache with failed fetches)
  if (primaryQuerySucceeded && (buildings.length > 0 || highwayCount > 0)) {
    try { writeFileSync(cachePath, JSON.stringify(result)); } catch {}
  }

  console.log(`  Overpass: ${buildings.length} buildings, ${highwayCount} highways, primary=${primaryQuerySucceeded ? 'OK' : 'FAILED'}`);
  return result;
}

/** Fetch POI data from Overpass for search */
export async function fetchOverpassPOI(south: number, west: number, north: number, east: number): Promise<any> {
  const server = OVERPASS_SERVERS[0];
  const q = `[out:json][timeout:15][bbox:${south},${west},${north},${east}];(node["amenity"]["name"];node["shop"]["name"];way["amenity"]["name"];way["shop"]["name"];);out center 500;`;
  const res = await fetch(server, {
    method: 'POST',
    body: `data=${encodeURIComponent(q)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  return res.json();
}
