/**
 * Batch tile generator for pre-rendering a region.
 * Hits the running server to trigger tile rendering and caching.
 *
 * Usage: npx tsx src/batch-generate.ts [region]
 * Regions: temecula, ie, corridor, socal
 */

const BASE_URL = 'http://localhost:3001';

// Region definitions (lat/lng bounding boxes)
const REGIONS: Record<string, { name: string; north: number; south: number; west: number; east: number }> = {
  elsinore: {
    name: 'Lake Elsinore',
    north: 33.72, south: 33.62, west: -117.40, east: -117.28,
  },
  temecula: {
    name: 'Temecula / Murrieta',
    north: 33.55, south: 33.45, west: -117.20, east: -117.05,
  },
  ie: {
    name: 'Inland Empire (Riverside, SB, Temecula, Ontario)',
    north: 34.15, south: 33.40, west: -117.70, east: -116.80,
  },
  corridor: {
    name: 'LA → SD Corridor (LA, OC, IE, SD)',
    north: 34.35, south: 32.60, west: -118.70, east: -116.80,
  },
  socal: {
    name: 'Full SoCal (SB coast to border, desert excluded)',
    north: 34.50, south: 32.50, west: -119.30, east: -116.50,
  },
};

function latlngToTile(lat: number, lng: number, zoom: number) {
  const n = Math.pow(2, zoom);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

async function main() {
  const regionKey = process.argv[2] || 'temecula';
  const region = REGIONS[regionKey];
  if (!region) {
    console.error(`Unknown region: ${regionKey}`);
    console.error(`Available: ${Object.keys(REGIONS).join(', ')}`);
    process.exit(1);
  }

  // Calculate z14 parent tiles covering this region
  const nw = latlngToTile(region.north, region.west, 14);
  const se = latlngToTile(region.south, region.east, 14);

  const parentTiles: Array<{ x: number; y: number }> = [];
  for (let y = nw.y; y <= se.y; y++) {
    for (let x = nw.x; x <= se.x; x++) {
      parentTiles.push({ x, y });
    }
  }

  const totalZ16 = parentTiles.length * 16;
  console.log(`\n  Region: ${region.name}`);
  console.log(`  Bounds: ${region.north}N, ${region.south}S, ${region.west}W, ${region.east}E`);
  console.log(`  z14 parents: ${parentTiles.length}`);
  console.log(`  z16 tiles:   ${totalZ16}`);
  console.log(`  Est. time:   ~${Math.ceil(parentTiles.length * 4 / 60)} minutes\n`);

  // Check server is running
  try {
    await fetch(`${BASE_URL}/api/me`);
  } catch {
    console.error('  ERROR: Server not running at ' + BASE_URL);
    console.error('  Start it first: npx tsx src/serve.ts');
    process.exit(1);
  }

  // Process parents in batches — request one z16 tile per parent to trigger the full parent render
  const CONCURRENCY = 3;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const startTime = Date.now();

  async function renderParent(px: number, py: number) {
    // Request the first z16 sub-tile — this triggers the parent render + cache of all 16
    const z16x = px * 4;
    const z16y = py * 4;
    const url = `${BASE_URL}/tiles/16/${z16x}/${z16y}.png`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(120000) }); // 2 min timeout
        if (res.status === 200) {
          completed++;
          return;
        }
        if (res.status === 503) {
          // Overpass failed — wait and retry
          const delay = 5000 * (attempt + 1);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        failed++;
        return;
      } catch {
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        failed++;
        return;
      }
    }
    failed++;
  }

  // Process in batches of CONCURRENCY
  const queue = [...parentTiles];
  const active: Promise<void>[] = [];

  function logProgress() {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = completed / elapsed;
    const remaining = queue.length + active.length;
    const eta = rate > 0 ? Math.ceil(remaining / rate) : '?';
    const pct = Math.floor(((completed + failed) / parentTiles.length) * 100);
    process.stdout.write(`\r  [${pct}%] ${completed}/${parentTiles.length} done, ${failed} failed, ${remaining} remaining, ETA ${eta}s   `);
  }

  while (queue.length > 0 || active.length > 0) {
    while (active.length < CONCURRENCY && queue.length > 0) {
      const tile = queue.shift()!;
      const p = renderParent(tile.x, tile.y).then(() => {
        active.splice(active.indexOf(p), 1);
        logProgress();
      });
      active.push(p);
    }
    if (active.length > 0) {
      await Promise.race(active);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n  Done! ${completed} parents rendered (${completed * 16} z16 tiles) in ${elapsed}s`);
  if (failed > 0) console.log(`  ${failed} parents failed (Overpass unavailable)`);
  console.log(`  Tiles saved to tile-cache/v1/\n`);
}

main().catch(console.error);
