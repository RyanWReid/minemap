const express = require('express');
const path = require('path');
const { renderTile } = require('./src/tileRenderer');

const app = express();
const PORT = 3000;

// Tile cache (in-memory for POC)
const tileCache = new Map();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Tile endpoint
app.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const z = parseInt(req.params.z);
  const x = parseInt(req.params.x);
  const y = parseInt(req.params.y);

  // Validate zoom range
  if (z < 0 || z > 19 || isNaN(z) || isNaN(x) || isNaN(y)) {
    return res.status(400).send('Invalid tile coordinates');
  }

  const key = `${z}/${x}/${y}`;

  // Check cache
  if (tileCache.has(key)) {
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(tileCache.get(key));
  }

  try {
    console.log(`Rendering tile ${key}...`);
    const startTime = Date.now();
    const png = await renderTile(z, x, y);
    const elapsed = Date.now() - startTime;
    console.log(`  -> ${key} rendered in ${elapsed}ms`);

    // Cache it
    // Keep cache from growing unbounded
    if (tileCache.size > 5000) {
      const firstKey = tileCache.keys().next().value;
      tileCache.delete(firstKey);
    }
    tileCache.set(key, png);

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (err) {
    console.error(`Error rendering tile ${key}:`, err);
    res.status(500).send('Tile rendering failed');
  }
});

app.listen(PORT, () => {
  console.log(`\n  Minecraft Map server running at http://localhost:${PORT}\n`);
});
