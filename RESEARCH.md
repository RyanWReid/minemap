# Minecraft Google Maps: Technical Research

## 1. How Google Maps Works Technically

### Tile-Based Rendering

Google Maps divides the world into a grid of square tiles, each 256x256 pixels. Tiles are addressed by three coordinates: **Z** (zoom level), **X** (column), and **Y** (row), served via URLs like `https://.../Z/X/Y.png`.

- **Zoom level 0**: Entire world = 1 tile (256x256)
- **Zoom level 1**: 4 tiles (2x2)
- **Zoom level N**: 4^N tiles (2^N x 2^N)
- Google Maps typically supports ~21 zoom levels

This is called the **"slippy map"** approach (OSM terminology). The tile coordinate system uses a Mercator projection, where lat/lng are transformed into pixel coordinates, then divided by tile size.

### Raster Tiles vs Vector Tiles

| Aspect | Raster Tiles | Vector Tiles |
|--------|-------------|--------------|
| Format | Pre-rendered PNG/JPEG images | Protobuf-encoded geometry + attributes |
| Rendering | Server-side | Client-side (WebGL) |
| Bandwidth | Larger per tile | Smaller, compresses well |
| Styling | Fixed at render time | Dynamic, client-controlled |
| Zoom | Discrete levels, pixelates between | Smooth continuous zoom |
| Rotation | Not supported | Fully supported |
| Labels | Baked into image | Rendered dynamically, collision-detected |

Google Maps transitioned to vector tiles (WebGL) as the default, with raster as fallback. Vector tiles enable smooth zooming, dynamic styling, 3D building extrusions, and runtime label placement.

### Directions / Routing

Google Maps routing uses:
- **Graph-based shortest path** algorithms on a road network graph
- **Contraction Hierarchies** and **A\*** variants for real-time route calculation
- Pre-computed hierarchical shortcuts for long-distance routes
- Multiple route options with different optimization criteria (fastest, shortest, avoid highways)
- Turn-by-turn decomposition of the path into human-readable instructions

### UI Components

| Component | Description |
|-----------|-------------|
| **Map Canvas** | The main tile-rendered viewport with pan/zoom |
| **Search Bar** | Geocoding input with autocomplete (Places API) |
| **Directions Panel** | Origin/destination inputs, route options, step-by-step |
| **Layer Toggle** | Satellite / Map / Terrain view switcher |
| **Street View** | Panoramic imagery, entered via Pegman drag-and-drop |
| **Zoom Controls** | +/- buttons, scroll wheel, pinch gesture |
| **Scale Bar** | Distance reference |
| **Info Windows** | Pop-up cards on click with details |
| **Mini Map** | Overview inset (optional) |
| **Timeline/History** | Historical imagery slider (satellite view) |

---

## 2. Map Rendering Libraries

### Leaflet.js

- **Type**: Lightweight 2D slippy map library (~42KB)
- **Rendering**: HTML5 Canvas + SVG
- **Custom tile sources**: YES -- `L.TileLayer` with custom `getTileUrl()`, or `L.GridLayer` for arbitrary HTML/Canvas tiles
- **3D terrain**: NO native support (2D only)
- **Minecraft suitability**: EXCELLENT for 2D top-down maps. Proven approach -- both Minecraft Overviewer and Mapcrafter use Leaflet as their web viewer. Supports custom coordinate systems via `L.CRS.Simple`.
- **Key advantage**: Simple, well-documented, huge plugin ecosystem (hundreds of plugins). Very easy to add markers, popups, polylines for pathfinding visualization.
- **Key limitation**: No 3D. No smooth sub-pixel zoom (raster only without plugins).

**Existing Minecraft projects using Leaflet:**
- Minecraft Overviewer (isometric tiles + Leaflet viewer)
- Mapcrafter (isometric/top-down + Leaflet viewer)
- Leaflet-Minecraft-Region-Tiles-Map (custom tile naming for Minecraft regions)
- uNmINeD (web export with Leaflet-style viewer)

### MapLibre GL JS (open-source fork of Mapbox GL JS)

- **Type**: WebGL-powered vector tile renderer
- **Rendering**: WebGL 2.0
- **Custom tile sources**: YES -- raster tiles, vector tiles (MVT), GeoJSON, custom sources
- **3D terrain**: YES -- native `raster-dem` source + `setTerrain()` for 3D terrain from DEM elevation tiles (RGBA-encoded heightmaps)
- **Minecraft suitability**: VERY GOOD. Can render 2D tile layers, overlay vector data (paths, markers, POIs), and display 3D terrain from heightmaps. The terrain feature could directly map Minecraft Y-values to elevation.
- **Key advantage**: Smooth vector rendering, 3D terrain, globe view, building extrusions, runtime styling, rotation/tilt. Style specification is JSON-based and very flexible.
- **Key limitation**: Terrain is draped (surface only), not true voxel rendering. More complex setup than Leaflet.

**Tile serving**: TileServer GL (by MapTiler) can serve both vector and raster tiles in MBTiles/PMTiles format, compatible with MapLibre.

### OpenLayers

- **Type**: Full-featured 2D mapping library (enterprise-grade)
- **Rendering**: HTML5 Canvas + WebGL (partial)
- **Custom tile sources**: YES -- widest format support (WMS, WMTS, WFS, GeoJSON, TopoJSON, KML, GPX, XYZ tiles, custom)
- **3D terrain**: NO native 3D, but integrates with CesiumJS via **ol-cesium** bridge library
- **Minecraft suitability**: GOOD for 2D. Overkill for simple use cases. The ol-cesium bridge allows 2D map with optional 3D globe toggle.
- **Key advantage**: Most comprehensive geospatial format support. Good for complex data overlays.
- **Key limitation**: Steeper learning curve, heavier than Leaflet, no native 3D.

### deck.gl

- **Type**: WebGL2/WebGPU visualization framework for large datasets
- **Rendering**: WebGL 2.0 / WebGPU
- **Custom tile sources**: YES -- TileLayer for 2D tiles, Tile3DLayer for 3D Tiles spec
- **3D terrain**: YES -- via TerrainLayer and integration with MapLibre/Google basemaps
- **Minecraft suitability**: INTERESTING for data visualization overlays. PointCloudLayer could render block data as colored 3D points. Custom layers possible for voxel rendering.
- **Key advantage**: Handles millions of data points efficiently. Composable layer system. Can overlay on MapLibre basemaps.
- **Key limitation**: Designed for data visualization, not general-purpose mapping. No built-in UI components (search, directions). Would need to build custom voxel layer.

### CesiumJS

- **Type**: 3D globe and map engine
- **Rendering**: WebGL
- **Custom tile sources**: YES -- imagery providers, terrain providers, 3D Tiles
- **3D terrain**: YES -- `CustomHeightmapTerrainProvider` accepts a callback function returning height arrays. Supports quantized-mesh and heightmap terrain formats.
- **Minecraft suitability**: INTERESTING for globe-like 3D view of a Minecraft world. Could map Minecraft heightmap to CesiumJS terrain. The 3D Tiles format could potentially represent chunk-level 3D models.
- **Key advantage**: True 3D globe with terrain. The `CustomHeightmapTerrainProvider` could directly consume Minecraft height data (unsigned int16, row-major order). Timeline/animation support.
- **Key limitation**: Designed for Earth-scale geodata. Adapting to Minecraft's flat coordinate system requires significant CRS work. Heavy runtime (~3MB+). Terrain is heightmap-based (no caves/overhangs).

**Heightmap format**: CesiumJS terrain tiles use unsigned int16 arrays in row-major order (north to south, west to east), supporting heights from -1000m to 12107m.

### Three.js (for 3D voxel rendering)

- **Type**: General-purpose WebGL 3D engine
- **Rendering**: WebGL / WebGPU (via WebGPURenderer)
- **Custom tile sources**: N/A (not a mapping library)
- **3D terrain**: YES (arbitrary 3D geometry)
- **Minecraft suitability**: BEST for true 3D block-level rendering. BlueMap already proves this works. Supports voxel rendering with optimization techniques.
- **Key advantage**: Full 3D control. Existing Minecraft renderers (BlueMap) use it. Massive community and ecosystem.
- **Key limitation**: Not a mapping library -- no built-in tile loading, zoom levels, coordinate systems, or map UI. Everything must be built from scratch.

**Voxel optimization techniques for Three.js:**
- **Greedy meshing**: Merges adjacent same-type block faces into larger quads. Can reduce vertices from ~73K to ~4K per chunk.
- **Face culling**: Don't render faces between two solid blocks.
- **Chunk-based loading**: Only load/render chunks near the camera.
- **LOD (Level of Detail)**: Reduce detail at distance.
- **Instanced rendering**: For repeated block types.

### Library Comparison Summary

| Library | 2D Tiles | 3D Terrain | Custom Sources | Voxels | UI Components | Best For |
|---------|----------|------------|----------------|--------|---------------|----------|
| Leaflet | *** | - | *** | - | ** | 2D satellite/top-down view |
| MapLibre GL | *** | ** | *** | - | ** | 2D + terrain elevation |
| OpenLayers | *** | * (via cesium) | *** | - | ** | Enterprise/GIS overlays |
| deck.gl | ** | ** | ** | * | - | Data viz overlays |
| CesiumJS | ** | *** | ** | - | * | Globe/3D terrain view |
| Three.js | - | *** | - | *** | - | True 3D block rendering |

**Recommended hybrid approach**: Use **MapLibre GL** as the primary 2D map engine (with custom raster tiles for top-down view and DEM tiles for terrain), with a toggle to switch to **Three.js** for immersive 3D "Street View" style rendering. This mirrors Google Maps' architecture of 2D map + Street View.

---

## 3. Generating Map Tiles from Minecraft World Data

### Reading Minecraft World Data

Minecraft worlds are stored in the **Anvil** file format:
- World directory contains `region/` folder with `.mca` files
- Each region file = 32x32 chunks = 512x512 blocks
- Each chunk = 16x16 blocks wide, up to 384 blocks tall (post 1.18: Y -64 to 319)
- Block data stored in NBT (Named Binary Tag) format, gzip/zlib compressed

**Parsing libraries:**
- Python: `twoolie/NBT`, `anvil-parser`, `quarry`
- JavaScript: `prismarine-nbt`, `node-anvil`, Kaitai Struct NBT spec
- Java: Native Minecraft libraries
- C++: Used by Overviewer and Mapcrafter for performance

### Approach 1: Top-Down 2D Tiles (Satellite View)

This is the most common approach. For each X,Z column, find the highest non-air block and render its color.

**Existing tools:**
- **Minecraft Overviewer** (Python/C): Renders isometric tiles into a quadtree, served via Leaflet. Tile size: 384x384px. 8 chunks per tile. Bottom-up quadtree generation.
- **Mapcrafter** (C++): Supports both top-down and isometric views. 4 rotation angles. Uses Leaflet for web display.
- **uNmINeD** (.NET): Fast 2D mapper. Renders each block as a colored square or textured square. Supports web export with zoom levels up to 8:1.

**Custom implementation approach:**
1. Parse region files, iterate chunks
2. For each block column (x,z), find top solid block, get its color/texture
3. Render to 256x256 or 512x512 tile images (PNG)
4. Organize in `z/x/y.png` directory structure (slippy map standard)
5. Apply lighting: calculate sunlight angle, add shadows based on height differences
6. Generate multiple zoom levels by downscaling (4 tiles -> 1 parent tile)

**Coordinate mapping**: Minecraft coords map to tile coords:
- `tileX = floor(blockX / tileBlockSize)`
- `tileZ = floor(blockZ / tileBlockSize)`
- At zoom 0, entire world = 1 tile. Each zoom level doubles resolution.

### Approach 2: Isometric / 3D Tiles

Renders blocks in pseudo-3D isometric projection (like the original SimCity).

**How Overviewer does it:**
- Projection: oblique isometric at ~35 degrees, looking South-East
- Each block = 24x24 pixel sprite (top face + two side faces)
- Affine transforms applied to block textures: rotation/scaling for top face, shearing for sides
- Chunk section = 384x384 pixel tile
- 8 chunks tessellate into each tile in a diamond pattern
- Coordinate transform: `col = chunkX + chunkZ`, `row = chunkZ - chunkX`

**Mapcrafter supports:**
- Isometric (3D-looking) view
- Top-down (2D flat) view
- 4 rotation angles (NE, SE, SW, NW)
- Configurable texture sizes

### Approach 3: Real 3D Rendering with WebGL

Full 3D rendering of actual block geometry in the browser.

**BlueMap** (the leading implementation):
- Backend: Java (78.8% of codebase) -- reads world files, generates 3D model data
- Frontend: Three.js + Vue.js -- renders 3D models in browser via WebGL
- Runs as Spigot/Paper plugin, Fabric/Forge mod, or standalone CLI
- Renders asynchronously (doesn't block server thread)
- Generates actual 3D surface models, not just heightmaps

**Custom Three.js approach:**
1. Parse world data on server (Node.js/Python/Rust)
2. Generate optimized mesh data per chunk:
   - Apply face culling (skip faces between adjacent solid blocks)
   - Apply greedy meshing (merge coplanar same-type faces)
   - Output: vertex buffer + index buffer + UV coords + colors
3. Serialize mesh data (binary format, gzip compressed)
4. Client loads chunks on demand based on camera position
5. Three.js renders with materials/textures mapped to block types

**Performance considerations:**
- A single Minecraft chunk (16x16x384) has up to 98,304 blocks
- Naive rendering: 6 faces x 2 triangles x 3 vertices = 36 vertices/block = 3.5M vertices/chunk
- With face culling: typically reduces to ~20% (surface blocks only)
- With greedy meshing: further reduces to ~5-10% of culled amount
- Target: ~50-200 chunks visible at once = need aggressive optimization

### Approach 4: Height Maps / Terrain Elevation

Generate height data for use with MapLibre GL or CesiumJS terrain rendering.

**For MapLibre GL `raster-dem` tiles:**
- Format: Terrain-RGB encoding (Mapbox format)
- Each pixel R,G,B encodes elevation: `height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)`
- Generate 256x256 PNG tiles where pixel color = encoded Y-value of highest block
- MapLibre renders as 3D terrain mesh with draping

**For CesiumJS:**
- `CustomHeightmapTerrainProvider`: callback returns `Uint16Array` of heights
- Row-major order, north-to-south, west-to-east
- Custom width/height per tile (e.g., 16x16 matching chunk size)

**Limitation**: Heightmap terrain cannot represent:
- Caves and underground spaces
- Overhangs and floating blocks
- Multi-level structures (bridges over water, etc.)
- The Nether (ceiling + floor)

For these, true 3D rendering (Three.js / BlueMap approach) is needed.

---

## 4. Pathfinding in Minecraft Worlds

### Core Algorithm: A* on the Block Grid

A* is the standard approach for Minecraft pathfinding, proven in both vanilla Minecraft mob AI and community projects.

**How vanilla Minecraft does it:**
- Path generated for each potential target
- Blocks have associated movement penalties (e.g., soul sand = slow, water = swim cost)
- Mobs prefer paths through blocks with smallest penalty
- Path recalculated when target moves or path becomes blocked

**Key implementation details for web-based pathfinding:**

```
Graph representation:
- Nodes: walkable block positions (x, y, z) where the block below is solid
         and the block at foot-level and head-level are passable
- Edges: movements between adjacent walkable positions
- Edge weights: movement cost (varies by action type)

Heuristic: 3D Euclidean distance or Chebyshev distance to goal

Movement costs (example):
- Walk forward 1 block:     1.0
- Walk diagonal:            1.414
- Jump up 1 block:          2.0 (slower)
- Drop down 1 block:        1.5
- Drop down 2+ blocks:      1.5 + fall damage cost
- Swim 1 block:             2.5
- Sprint:                   0.7 (faster than walk)
- Walk on soul sand:        1.5
- Walk through cobweb:      5.0
```

### Existing JavaScript Implementation: mineflayer-pathfinder

The most mature JS-based Minecraft pathfinder. Key design:

- **Movements class**: Configures pathfinding behavior (block costs, breakable blocks, placeable blocks)
- **Goals system**: Composable goal types:
  - `GoalBlock(x, y, z)` -- reach specific block
  - `GoalNear(x, y, z, range)` -- get within range
  - `GoalXZ(x, z)` -- reach X,Z ignoring Y
  - `GoalY(y)` -- reach specific Y level
  - `GoalCompositeAll` -- satisfy all sub-goals
  - `GoalCompositeAny` -- satisfy any sub-goal
- **Cost functions**: Customizable per-block costs, exclusion zones, danger areas
- **Search radius**: Configurable limit to prevent runaway searches

### Non-Voxel Pathfinding: Pathcrafter

Alternative approach that doesn't restrict movement to whole blocks:
- Still uses A* at its core
- Heavily modified vertex/edge generation allows movement at any angle
- Reduces travel time vs block-grid pathfinding
- Trades optimality for realism (finds "good" not "optimal" solutions)
- Heavy performance penalty, can exhaust memory in large open areas
- Currently limited: basic jumping only, no momentum/strafing

### Multi-Dimensional Routing (Nether Portals as Fast Travel)

This is analogous to Google Maps showing different transport modes (car, transit, walking).

**Modeling approach:**
```
The routing graph becomes multi-layered:
- Layer 1: Overworld (normal movement)
- Layer 2: Nether (normal movement, 8x distance compression)
- Layer 3: End (if applicable)

Portal connections:
- Overworld (x, y, z) <-> Nether (x/8, y, z/8)
- Portal transition cost = loading time + search time

The 8:1 Nether:Overworld ratio means:
- Walking 100 blocks in Nether = 800 blocks in Overworld
- Optimal long-distance routes may involve:
  1. Walk to nearest portal in Overworld
  2. Enter Nether
  3. Walk compressed distance
  4. Exit through destination portal

This is directly analogous to Google Maps transit routing:
"Walk to subway -> ride subway -> walk from subway to destination"
```

**Route comparison UI (like Google Maps):**
- Route A: "Walk (Overworld)" -- 1200 blocks, ~3 min
- Route B: "Via Nether" -- 200 blocks effective, ~45 sec
- Route C: "Elytra flight" -- 1200 blocks, ~30 sec

### Implementation for Web Application

For a web-based Minecraft Google Maps, pathfinding should run:

**Option A: Server-side**
- Pre-process world data into a navigation graph
- A* runs on server, returns path as coordinate array
- Better for large worlds (can handle more memory)
- Allows pre-computation and caching of common routes

**Option B: Client-side (Web Worker)**
- Send chunk data to browser
- Run A* in a Web Worker (non-blocking)
- More responsive, no server round-trip
- Limited by browser memory for large searches

**Option C: Hybrid**
- Server pre-computes navigation mesh (walkability grid)
- Client loads nav mesh tiles on demand
- Client runs A* on loaded nav mesh data
- Best balance of responsiveness and scalability

---

## 5. AI Generation Possibilities

### Procedural Terrain Generation with AI

**GAN-based approaches (proven in research):**

- **World-GAN**: A 3D GAN architecture specifically for Minecraft. Uses 3D convolutional filters to process voxel-sized slices. Employs `block2vec` (inspired by `word2vec`) to create block embeddings. Can learn from and generate structures directly in 3D voxel space.
- **Minecraft-Terrain-GAN**: Uses GANs to generate new Minecraft terrains from training data.
- **Modular procedural generation**: Combines procedurally generated modules with learned rules for voxel map creation.

**Style transfer approaches:**
- Apply real-world terrain characteristics to procedurally generated heightmaps
- StyleGAN2 adapted for 4-channel output (heightmap + 3 terrain attributes)
- Neural style transfer from NASA satellite DEM data to game terrain

**Practical application for this project:**
- Train on existing Minecraft world data to generate new terrain chunks
- Fill in unexplored areas with AI-generated terrain that matches the style of explored regions
- Generate "what-if" terrain variations

### Enhance / Upscale Map Renders

**Super-resolution for map tiles:**
- AI upscaling (Real-ESRGAN, etc.) could upscale low-res tile renders to higher resolution
- Particularly useful for generating smooth zoom transitions between tile levels
- Could upscale 256x256 tiles to 1024x1024 for higher zoom levels without re-rendering

**Texture enhancement:**
- AI models could enhance block textures at close zoom levels
- Generate more detailed/realistic textures from the simple Minecraft palette
- Neural style transfer to apply photorealistic styles to block renders

### "Street View" Style Renders from Block Data

**Approach 1: Traditional rendering**
- Three.js or Babylon.js rendering from a first-person camera position
- Place camera at player head height (Y + 1.62 blocks)
- Render 360-degree panoramic image (equirectangular projection)
- Pre-render panoramas at regular intervals along paths
- Display in a panorama viewer (like Google Street View uses)

**Approach 2: Neural Radiance Fields (NeRF)**
- Train a NeRF model on multiple rendered views of a Minecraft area
- Generate novel views from any camera position/angle
- Input: sparse set of rendered images with known camera poses
- Output: photorealistic novel views via volume rendering
- Limitation: Training takes hours per scene; rendering ~1-30 seconds per frame
- Better suited for pre-generating "showcase" views than real-time exploration

**Approach 3: 3D Gaussian Splatting (newer, faster)**
- Represents scene as millions of 3D Gaussians instead of NeRF's implicit MLP
- Faster training and real-time rendering
- Could convert Minecraft block data to Gaussian primitives
- More practical for interactive exploration than NeRF
- Active research area: GVKF (Gaussian Voxel Kernel Functions) bridges voxels and Gaussians

**Most practical approach:**
Pre-render 360-degree panoramas at key locations using Three.js, then use a web-based panorama viewer (like Pannellum or Marzipano) for the "Street View" experience. This is the most performant and doesn't require AI.

### Create 3D Views from 2D Map Data

**AI depth estimation:**
- Models like MiDaS or Depth Anything can estimate depth from 2D images
- Could generate heightmaps from 2D top-down renders
- Useful if you only have the 2D tile renders but not the original world data

**Diffusion models for 3D generation:**
- Recent models can generate 3D scenes from 2D images
- Could theoretically generate detailed 3D views of areas only seen from above
- Still experimental and computationally expensive

**Practical alternative:**
Since Minecraft world data already contains full 3D information, it's more efficient to render 3D views directly from the block data rather than trying to reconstruct 3D from 2D renders. AI 3D generation makes more sense if you want to generate terrain for areas that don't exist yet.

---

## 6. Existing Open Source Projects (Reference Implementations)

| Project | Language | View Type | Web Viewer | Tile Format | Status |
|---------|----------|-----------|------------|-------------|--------|
| [Minecraft Overviewer](https://github.com/overviewer/Minecraft-Overviewer) | Python/C | Isometric | Leaflet | Quadtree PNG | Mature |
| [Mapcrafter](https://github.com/mapcrafter/mapcrafter) | C++ | Isometric + Top-down | Leaflet | Tiles | Mature |
| [BlueMap](https://github.com/BlueMap-Minecraft/BlueMap) | Java + JS | Full 3D | Three.js + Vue | 3D models | Active |
| [uNmINeD](https://unmined.net/) | .NET | 2D top-down | Custom | Web export | Active |
| [Leaflet-Minecraft-Region-Tiles-Map](https://github.com/HakkaTjakka/Leaflet-Minecraft-Region-Tiles-Map) | JS/C++ | 2D | Leaflet | Region tiles | Niche |
| [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) | JavaScript | N/A (pathfinding) | N/A | N/A | Active |
| [Maple](https://github.com/stylextv/maple) | Java | N/A (pathfinding bot) | N/A | N/A | Active |

---

## 7. Recommended Architecture

```
+------------------------------------------------------------------+
|                        Frontend (Browser)                         |
|                                                                   |
|  +------------------+  +------------------+  +------------------+ |
|  | MapLibre GL JS   |  | Three.js Scene   |  | Pannellum        | |
|  | (2D Map View)    |  | (3D Block View)  |  | (Street View)    | |
|  | - Raster tiles   |  | - Greedy meshing |  | - 360 panoramas  | |
|  | - DEM terrain    |  | - Chunk loading  |  | - Navigation     | |
|  | - Vector overlays|  | - LOD system     |  |                  | |
|  +------------------+  +------------------+  +------------------+ |
|                                                                   |
|  +------------------+  +------------------+  +------------------+ |
|  | Search/Geocode   |  | Directions Panel |  | Layer Controls   | |
|  | - POI search     |  | - A* pathfinding |  | - Satellite/Map  | |
|  | - Coord lookup   |  | - Multi-route    |  | - Biomes overlay | |
|  | - Autocomplete   |  | - Nether routing |  | - Players/mobs   | |
|  +------------------+  +------------------+  +------------------+ |
+------------------------------------------------------------------+
                              |
                         REST/WebSocket API
                              |
+------------------------------------------------------------------+
|                     Backend (Node.js / Rust)                      |
|                                                                   |
|  +------------------+  +------------------+  +------------------+ |
|  | Tile Server      |  | World Parser     |  | Pathfinding      | |
|  | - Render tiles   |  | - Anvil/NBT read |  | - Nav mesh gen   | |
|  | - Cache tiles    |  | - Block lookup   |  | - A* solver      | |
|  | - DEM generation |  | - Chunk indexing |  | - Route caching  | |
|  | - Zoom levels    |  | - Live updates   |  | - Multi-dim      | |
|  +------------------+  +------------------+  +------------------+ |
|                                                                   |
|  +------------------+  +------------------+                       |
|  | POI Index        |  | AI Services      |                       |
|  | - Named locations|  | - Terrain gen    |                       |
|  | - Player bases   |  | - Tile upscale   |                       |
|  | - Biome search   |  | - NeRF renders   |                       |
|  +------------------+  +------------------+                       |
+------------------------------------------------------------------+
                              |
                     Minecraft World Files
                    (.mca region files / NBT)
```

### Key Technical Decisions

1. **Primary 2D engine**: MapLibre GL JS -- supports custom tiles, 3D terrain from DEM, vector overlays for paths/POIs, smooth zooming
2. **3D engine**: Three.js -- proven by BlueMap, greedy meshing for performance
3. **Tile generation**: Custom server-side renderer (Node.js with native addon or Rust for performance)
4. **Pathfinding**: Server-side A* with navigation mesh, results streamed to client
5. **World parsing**: Use `prismarine-nbt` (JS) or custom Rust parser for speed
6. **Street View**: Pre-rendered Three.js panoramas at key locations, served via panorama viewer

---

## 8. Visual Style: Minecraft/Pixel Art Aesthetic for Real-World Maps

This section explores the reverse direction: making a map of the **real world** look like Minecraft or a retro pixel art game. The goal is a Google Maps-like navigation app where the rendering style is blocky, pixelated, and voxel-themed.

### 8.1 Precedent: Google Maps 8-Bit Quest (2012)

Google themselves proved this concept in their 2012 April Fools' prank, "Google Maps 8-bit for NES" (codename "Quest"). Key details:

- A "Quest" button appeared alongside the standard Map/Satellite/Earth toggles
- The entire map was re-rendered in 8-bit pixel art style, including terrain, roads, water, and landmarks
- Street View was also pixelated into 8-bit graphics
- Driving directions remained functional in pixel mode
- An 8-bit soundtrack played and pixel-art monsters appeared on the map
- The implementation used pre-rendered raster tiles -- Google generated a complete alternate tile set with the pixel art aesthetic

**Technical takeaway**: Google used **server-side tile replacement** -- they rendered an entirely separate set of map tiles in pixel art style. This is the brute-force approach but proves it works at global scale.

Sources:
- [PCWorld: Google Maps Goes 8-Bit](https://www.pcworld.com/article/469565/google_maps_goes_8_bit_for_april_fools.html)
- [GameScenes: Google Maps 8-bit for NES](https://www.gamescenes.org/2012/03/game-art-googles-google-maps-8-bit-for-nes-2012.html)
- [Retro Games Collector](https://www.retrogamescollector.com/google-maps-in-8-bit-april-fools-joke/)

### 8.2 The Zelda Tile Approach (Aerial Imagery to Game Tiles)

Alastair Aitchison created a system that converts real-world Bing Maps aerial imagery into Legend of Zelda-style map tiles. This is the closest existing example to what we want.

**How it works:**
1. Intercepts tile requests via a C# HTTP handler
2. Divides each 256x256 aerial tile into 32x32 pixel subtiles
3. Calculates the average RGB color of each subtile
4. Applies classification rules to map colors to game tile types:
   - `G > B > R` --> Grass tile
   - `B > R and B > G` --> Water tile
   - `R >= G and R >= B and B <= 90` --> Rock tile
   - `R >= G and R >= B and B > 90` --> Dirt/Sand tile
   - All channels >= 225 --> Snow tile
   - 1/50 random chance on grass --> Flower tile
5. Replaces each subtile with the corresponding 8-bit sprite image
6. Returns the composed tile as the response

**Technical assessment**: This approach is directly adaptable to our project. Instead of Zelda sprites, we would use Minecraft block textures (grass, water, stone, sand, snow). The classification logic can be made more sophisticated using land-use data from OSM rather than just aerial color averages.

Source: [Creating Legend of Zelda Map Tiles from Bing Maps Aerial Imagery](https://alastaira.wordpress.com/2012/03/14/creating-the-legend-of-zelda-map-tiles-from-bing-maps-aerial-imagery/)

### 8.3 Google Maps API Styling Limits

Google Maps provides JSON-based styling that can customize map appearance. However, it has significant limitations for achieving a Minecraft aesthetic:

**What CAN be styled:**
- Feature types: administrative areas, landscape, POI, roads, transit, water
- Element types: geometry (fill/stroke), labels (text/icon)
- Properties: color (hex), weight (pixels), visibility (on/off/simplified), hue, saturation, lightness, gamma, invert_lightness

**What CANNOT be done:**
- Cannot replace tile imagery with custom textures/patterns
- Cannot change the rendering engine or line shapes (roads are always smooth curves, not blocky)
- Cannot apply pixelation or grid-snapping effects
- Cannot replace font rendering with pixel fonts
- Cannot swap icons with custom sprite sheets (only marker icons via AdvancedMarkerElement)
- Style array has a maximum character limit; exceeding it causes silent failure
- All changes are cosmetic color/visibility adjustments to the existing rendering -- no structural changes

**What CAN be customized (markers/overlays):**
- `AdvancedMarkerElement`: Full HTML/CSS custom markers, supports PNG, SVG, GIF, TIFF icons
- Custom overlays: Can draw arbitrary HTML/Canvas on top of the map
- The blue location dot can be replaced with a custom marker using the Geolocation API + a custom `AdvancedMarkerElement` with a pixel-art player icon

**Snazzy Maps examples** (styled Google Maps):
- "Map Game" style: Warm tan palette, no labels, game-board aesthetic
- "Retro" style: Vintage muted tones
- These are just color adjustments -- they don't achieve true pixel art

**Verdict**: Google Maps styling is **insufficient** for a Minecraft aesthetic. You can change colors and hide labels, but you cannot make roads blocky, apply pixelation, use custom textures for terrain, or fundamentally alter the rendering. Google Maps is a dead end for this use case unless used purely as a data source (geocoding, routing) with rendering handled by another engine.

Sources:
- [Google Maps Style Reference](https://developers.google.com/maps/documentation/javascript/style-reference)
- [Google Maps JSON Styling Overview](https://developers.google.com/maps/documentation/javascript/json-styling-overview)
- [Snazzy Maps - Map Game](https://snazzymaps.com/style/275684/map-game)
- [AdvancedMarkerElement Graphic Markers](https://developers.google.com/maps/documentation/javascript/advanced-markers/graphic-markers)

### 8.4 Mapbox/MapLibre Custom Rendering (Most Promising Approach)

MapLibre GL JS (and Mapbox GL JS) offer the deepest customization for achieving a game-like map aesthetic. The style specification provides fine-grained control over every visual element.

#### 8.4.1 Layer Types and Pattern Support

MapLibre supports 10 layer types, several of which support custom pattern fills:

| Layer Type | Pattern Property | Use for Minecraft Style |
|------------|-----------------|------------------------|
| `fill` | `fill-pattern` | Terrain areas (grass block, sand, dirt textures) |
| `line` | `line-pattern` + `line-dasharray` | Roads (cobblestone/path textures) |
| `fill-extrusion` | `fill-extrusion-pattern` | 3D buildings (stone brick, wood plank textures) |
| `symbol` | `icon-image` | POI icons (chest, sign, torch icons) |
| `background` | `background-pattern` | Base layer (dirt/stone texture) |
| `raster` | N/A | Satellite imagery (could be pixelated via shaders) |

**Pattern constraints**: All pattern images must have dimensions that are powers of two (2, 4, 8, ..., 512). Patterns are loaded from sprite sheets.

#### 8.4.2 Sprite Sheets for Minecraft Block Textures

MapLibre uses sprite sheets -- a single PNG containing all icons/patterns, paired with a JSON index file describing each image's position and dimensions.

**Implementation plan for Minecraft textures:**
1. Create a sprite sheet PNG containing Minecraft block textures:
   - `grass_block_top` (16x16 or 32x32)
   - `water_still` (animated frames if desired)
   - `sand`, `stone`, `dirt`, `snow`, `gravel`
   - `cobblestone` (for roads)
   - `oak_planks`, `stone_bricks` (for buildings)
   - Custom POI icons: chest, sign, crafting table, bed, etc.
2. Create the JSON index file mapping names to positions
3. Reference textures in the MapLibre style: `"fill-pattern": "grass_block_top"`
4. Use the `spreet` CLI tool or manual creation to generate spritesheets from SVG/PNG sources

**Proven example**: The "Pencil Style for MapLibre" project demonstrates this exact workflow, using custom sprite sheets with `pencil-wave` and `pencil-hatch` patterns for water and buildings. The same technique applies to Minecraft textures.

#### 8.4.3 Custom Line Styles for Roads

Roads can be styled to look blocky/pixelated using:
- `line-pattern`: Apply a cobblestone or path texture
- `line-dasharray`: Create segmented/blocky line patterns (e.g., `[2, 2, 8, 2]`)
- `line-width`: Increase for prominent, game-like roads
- Color: Use Minecraft-appropriate colors (gray for stone, brown for dirt paths)
- Multiple layers: Stack a wider dark outline under a narrower colored road for game-style roads

#### 8.4.4 3D Building Extrusions

MapLibre's `fill-extrusion` layer renders 3D buildings that could be styled like Minecraft:
- `fill-extrusion-height`: Extrude buildings to their actual height
- `fill-extrusion-pattern`: Apply stone/brick/wood textures to building walls
- `fill-extrusion-color`: Flat color as fallback
- `fill-extrusion-opacity`: Control transparency

**Limitation**: Extrusions are smooth geometric shapes, not true voxels. Buildings will have flat walls, not the stepped/blocky look of Minecraft. For true voxel buildings, a custom Three.js layer or post-processing would be needed.

#### 8.4.5 Custom Fonts/Glyphs

MapLibre supports custom fonts via SDF (Signed Distance Field) glyphs. A pixel art font (like Minecraft's default font) could be served as custom glyphs, replacing the default sans-serif with blocky pixel text.

#### 8.4.6 Existing Mapbox + Minecraft Projects

**Mapbox Unity SDK - Minecraft World**: Mapbox published a blog post and demo creating a Minecraft-inspired world in Unity using real-world map data:
- Mapbox Studio creates a color-coded style where each color maps to a voxel type
- Raster tiles are queried pixel by pixel to determine block type
- Terrain-RGB elevation data determines voxel stacking height
- Real-world land use (from Mapbox Streets) drives block selection: forests -> trees, water -> water blocks, urban -> stone

This is for Unity/3D, not web, but the **data pipeline concept is directly applicable**: use Mapbox/MapLibre vector tile data to determine what "block type" each area should be, then render accordingly.

Sources:
- [MapLibre Style Spec - Sprite](https://maplibre.org/maplibre-style-spec/sprite/)
- [MapLibre Style Spec - Layers](https://maplibre.org/maplibre-style-spec/layers/)
- [A Pencil Style for MapLibre](https://googlemapsmania.blogspot.com/2025/11/a-pencil-style-for-maplibre.html)
- [Mapbox: Minecraft-inspired world with Unity](https://blog.mapbox.com/how-to-design-a-minecraft-inspired-world-with-mapbox-and-unity-92afd924879c)
- [Creating Minecraft-inspired Worlds with Mapbox Unity SDK](https://blog.mapbox.com/creating-minecraft-inspired-worlds-with-the-mapbox-unity-sdk-17007f4e10ba)
- [Spreet - Spritesheet generator](https://github.com/flother/spreet)

### 8.5 WebGL/Canvas Post-Processing (Pixelation Shaders)

The most flexible approach to achieving a pixel art look is applying WebGL post-processing shaders to the entire map output. This can work with any map renderer.

#### 8.5.1 Pixelation Shader (GLSL)

The core pixelation technique in a fragment shader:

```glsl
uniform sampler2D sceneTex;
uniform float pixel_w; // e.g., 8.0 (pixel block width)
uniform float pixel_h; // e.g., 8.0 (pixel block height)
uniform float rt_w;    // render target width
uniform float rt_h;    // render target height

void main() {
  vec2 uv = gl_FragCoord.xy / vec2(rt_w, rt_h);
  float dx = pixel_w / rt_w;
  float dy = pixel_h / rt_h;
  vec2 coord = vec2(dx * floor(uv.x / dx), dy * floor(uv.y / dy));
  gl_FragColor = vec4(texture2D(sceneTex, coord).rgb, 1.0);
}
```

This snaps UV coordinates to a grid, effectively downsampling and upsampling the image. The `pixel_w`/`pixel_h` uniforms control block size. A value of 4-8 gives a moderate retro look; 16+ gives a very chunky appearance.

**Color reduction** can be added for an even more retro aesthetic:
```glsl
// Reduce to N-bit color depth (e.g., 5-6-5 = 16-bit color)
vec3 depth = vec3(32.0, 64.0, 32.0);
color.rgb = floor(color.rgb * depth) / depth;
```

#### 8.5.2 Leaflet + WebGL Shaders: leaflet.tilelayer.gl

The `leaflet.tilelayer.gl` plugin applies WebGL fragment shaders to Leaflet tile layers per-tile. Features:
- Applies shaders to individual tiles as they load
- Supports multi-tile compositing (merge DEM + satellite)
- Includes a **pixelated demo** that forces nearest-neighbor interpolation when overzooming
- Custom fragment shaders can do color transforms, pixelation, dithering, etc.

**Usage**: Define a `fragmentShader` string and pass it to the `L.TileLayer.GL` constructor. The shader receives tile texture as a sampler2D.

**Limitation**: Processes tiles individually, not the whole viewport. Effects are per-tile, so pixelation grid may not align across tile boundaries.

Source: [leaflet.tilelayer.gl on npm](https://www.npmjs.com/package/leaflet.tilelayer.gl)

#### 8.5.3 MapLibre GL JS Custom Layers (Full-Map Post-Processing)

MapLibre supports custom WebGL layers via the `CustomLayerInterface`:
- `prerender(gl, matrix)`: Called before each frame; can render to an offscreen framebuffer
- `render(gl, matrix)`: Called during rendering; draws directly to the main framebuffer
- Full access to the WebGL context (same GL context as the map)

**Full-map pixelation approach:**
1. Render the entire map to a framebuffer texture (offscreen) using `prerender`
2. In `render`, draw a full-screen quad with the framebuffer texture
3. Apply the pixelation fragment shader to the quad

**Alternative approach**: Access MapLibre's canvas element directly, create a second WebGL context or use `canvas.getContext('2d')` to read pixels, process them, and write to an overlay canvas. This is simpler but less performant.

**MapLibre-gl-shader-layer**: A community library (`geoblocks/maplibre-gl-shader-layer`) provides building blocks for creating tiled custom shader layers in MapLibre GL JS, powered by Three.js. This can simplify shader integration.

Sources:
- [MapLibre CustomLayerInterface](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/)
- [maplibre-gl-shader-layer](https://github.com/geoblocks/maplibre-gl-shader-layer)
- [Geeks3D Pixelation Shader](https://www.geeks3d.com/20101029/shader-library-pixelation-post-processing-effect-glsl/)
- [WebGL Fundamentals - Pixelization](https://webglfundamentals.org/webgl/lessons/webgl-qna-how-to-get-pixelize-effect-in-webgl-.html)

### 8.6 Tangram: WebGL Map Renderer with Built-In Shader Support

Tangram is a WebGL-powered map renderer (originally by Mapzen) with first-class support for custom GLSL shaders, making it particularly interesting for game-style maps.

**Key features for Minecraft-style rendering:**
- **Isometric camera**: Built-in isometric projection with adjustable perspective, perfect for a 2.5D Minecraft look
- **Scene files**: All styling defined in YAML, including inline GLSL shader code
- **Shader blocks library** (`tangrams/blocks`): Pre-built reusable shader snippets:
  - `polygons/pixelate`: Applies a pixelated pattern to polygon fills
    - Configurable `PIXELATE_SCALE` (1.0 to 1000.0, default 40.0)
    - Configurable `PIXELATE_BACKGROUND_COLOR` and `PIXELATE_COLOR`
  - `filter/dithered`: Color dithering for a posterized retro look
  - `filter/grain`: Lens grain effect for texture
  - `elevation/contours`: Contour lines from terrain elevation
  - `color/palette`: Procedural color palette generation
- **Custom shaders**: Write arbitrary GLSL vertex/fragment shaders inline in the scene YAML file
- **3D buildings**: Extrude buildings with custom lighting and materials
- **Dynamic filtering**: Runtime data filtering and styling

**Usage example:**
```yaml
import:
  - https://tangrams.github.io/blocks/polygons/pixelate.yaml

styles:
  pixelated-terrain:
    base: polygons
    mix: [pixelate]
    shaders:
      defines:
        PIXELATE_SCALE: 20.0
```

**Assessment**: Tangram is the most capable renderer for applying game-like shader effects to real-world map data with minimal code. Its isometric camera + pixelation shader + 3D buildings could create a compelling Minecraft-adjacent aesthetic. However, Tangram is less actively maintained since Mapzen shut down (the open-source fork continues), and it has a smaller community than MapLibre.

Sources:
- [Tangram WebGL Maps](https://tangrams.github.io/tangram/)
- [Tangram Blocks (shader library)](https://github.com/tangrams/blocks)
- [Tangram Shader Overview](https://github.com/tangrams/tangram-docs/blob/main/docs/Overviews/Shaders-Overview.md)

### 8.7 Isometric / 3D Map Renderers

Several existing tools render real-world OSM data in 3D, which could be restyled for a Minecraft look.

#### 8.7.1 F4map

- WebGL-based 3D renderer for OpenStreetMap data
- Shows 3D buildings with height, trees, terrain, dynamic shadows, day/night cycle, real-time weather
- Proprietary modeled building database for landmarks (e.g., Eiffel Tower)
- Camera can rotate and tilt but cannot go to street level
- Performance-heavy on low-spec machines
- **Minecraft potential**: The 3D buildings and terrain could theoretically be restyled with block textures, but F4map is proprietary/closed-source, limiting modification

Source: [F4map Demo](https://demo.f4map.com/)

#### 8.7.2 OSM Buildings

- Open-source library for 3D building visualization from OSM data
- Renders building footprints extruded to their tagged height
- Can be integrated with Leaflet or MapLibre as an overlay
- **Minecraft potential**: Building meshes could be post-processed to snap to a block grid and textured with Minecraft materials

Source: [OSM Buildings](https://osmbuildings.org/)

#### 8.7.3 OSM2World

- Open-source renderer: full 3D world from OSM data
- Supports 250+ OSM tags: lane markings, benches, power lines, building facades
- Available as web app (WebGL), desktop, CLI, or JVM library
- **Minecraft potential**: HIGH. OSM2World generates actual 3D geometry that could be voxelized (snapped to a block grid) and textured with Minecraft materials, similar to how Arnis converts OSM to Minecraft worlds

Source: [OSM2World](https://osm2world.org/)

#### 8.7.4 Tangram (Isometric Mode)

As described in 8.6, Tangram has a built-in isometric camera that renders real-world vector data in a 2.5D isometric view. Combined with pixelation shaders and block-colored styling, this could produce a convincing game-overworld look.

### 8.8 Voxel Earth / Real-World Voxelization Projects

These projects convert actual real-world data into Minecraft-compatible voxel formats:

#### 8.8.1 VoxelEarth

Converts Google Photorealistic 3D Tiles into Minecraft blocks:
- **Pipeline**: Download 3D Tiles (GLB) --> Draco decompress --> CPU voxelization --> Minecraft block placement
- Player position maps to lat/lng, triggering tile download and voxelization on demand
- Uses Google Maps Platform API for 3D tile data
- Modular architecture: each stage (download, decode, voxelize) is a separate CLI tool
- Requires Java 21+, Paper/Spigot 1.20.4+
- **Web relevance**: The voxelization algorithm could be adapted for browser-based rendering. Instead of placing Minecraft blocks, the voxelized data could feed a Three.js voxel renderer.

Source: [VoxelEarth GitHub](https://github.com/ryanhlewis/VoxelEarth)

#### 8.8.2 Arnis

Converts OSM data to Minecraft worlds using rule-based algorithms:
- Reads OSM building footprints, roads, land use via Overpass API
- Uses AWS Terrain Tiles for elevation
- Deterministic (not AI): direct mapping rules from OSM tags to Minecraft blocks
- Supports Java, Bedrock, and Education editions
- **Web relevance**: The OSM-to-block mapping rules are directly reusable. Roads become cobblestone paths, water becomes water blocks, forests become tree structures, buildings become stone/wood structures. This rule set can drive a WebGL voxel renderer.

Source: [Arnis - Generate Real-World Minecraft Maps](https://arnismc.com/)

#### 8.8.3 Blocky Earth (2012)

An early WebGL experiment using Three.js to render real-world map data in a Minecraft-like blocky style directly in the browser. Described as "a WebGL-mashup experiment combining real map data with a minecraft like view block-style viewer using Three.js." Demonstrates that browser-based voxel rendering of real-world data is feasible.

Source: [Blocky Earth](https://html5gamedevelopment.com/2012-02-blocky-earth-webgl-minecraft-like-map-viewer/)

### 8.9 Self-Hosted Tile Infrastructure

For full control over map rendering, self-hosted tile serving is essential:

#### Protomaps / PMTiles

- Single-file tile archive format (like SQLite for map tiles)
- Served via HTTP Range requests -- works on any static file host (S3, Nginx, GitHub Pages)
- Supports both vector and raster tiles
- TypeScript library generates MapLibre GL styles in multiple themes
- Bundled sprites and fonts via `basemaps-assets`
- **Minecraft relevance**: Host custom Minecraft-textured vector tiles from a single PMTiles file. No tile server needed.

#### OpenMapTiles

- Open-source vector tile generation from OSM data
- Compatible with MapLibre GL styles
- Can be self-hosted with complete control over data and styling

Sources:
- [Protomaps](https://protomaps.com/)
- [PMTiles Docs](https://docs.protomaps.com/pmtiles/)
- [OpenMapTiles](https://openmaptiles.org/)

### 8.10 Recommended Approach for Minecraft-Styled Real-World Map

Based on this research, there are three viable architecture tiers:

#### Tier 1: Style-Only (Fastest to Implement)

Use **MapLibre GL JS** with a heavily customized style:
1. Create a Minecraft block texture sprite sheet (grass, water, stone, sand, etc.)
2. Apply `fill-pattern` for terrain polygons using block textures
3. Apply `line-pattern` for roads using cobblestone/path textures
4. Apply `fill-extrusion-pattern` for 3D buildings using stone brick textures
5. Use custom pixel font glyphs for labels
6. Replace all POI icons with Minecraft item sprites (chest, sign, etc.)
7. Replace the location marker with a Minecraft player skin icon
8. Use Protomaps/PMTiles for self-hosted tiles with full style control

**Pros**: Works with existing map infrastructure, moderate effort, interactive and performant
**Cons**: Roads and terrain boundaries are still smooth curves (not blocky), buildings are smooth extrusions (not voxels)

#### Tier 2: Style + Post-Processing (Best Balance)

Everything from Tier 1, plus:
1. Apply a WebGL pixelation post-processing shader to the entire MapLibre canvas
2. Add color quantization to reduce the color palette to Minecraft-like colors
3. Snap coordinates to a grid for a blocky feel
4. Use Tangram's isometric camera mode as an alternative view

**Pros**: The pixelation shader makes everything look properly retro/blocky, masking the smooth geometry underneath
**Cons**: Text becomes hard to read when pixelated (may need an unpixelated UI overlay), some performance overhead from post-processing

#### Tier 3: Full Voxel Rendering (Most Authentic)

Build a custom rendering pipeline:
1. Use OSM vector tile data to determine land use, roads, buildings, water
2. Apply Arnis-style rule mapping: OSM tags --> Minecraft block types
3. Use terrain elevation data (Mapbox Terrain-RGB or AWS Terrain Tiles) for voxel height
4. Render using Three.js with greedy meshing optimization
5. Implement a Leaflet/MapLibre-compatible tile interface for 2D overview
6. Toggle between 2D overview and 3D voxel street-level view

**Pros**: Most authentic Minecraft look with true voxel geometry
**Cons**: Significant engineering effort, performance-heavy for large areas, custom rendering pipeline must handle all map features (zoom, pan, labels, routing)

#### Recommended: Start with Tier 2, Evolve to Tier 3

Begin with a MapLibre-based map using Minecraft textures and a pixelation shader. This gives an immediate visual payoff with reasonable effort. The 2D map view will look convincingly game-like with the shader applied.

For the 3D "street view" mode, build a Three.js voxel renderer that converts OSM data around the user's location into Minecraft blocks on-the-fly. This can be developed incrementally while the 2D map provides the primary navigation experience.

### 8.11 Pixel Art Map Generators (Reference Tools)

Several existing tools generate pixel art maps, useful as style references:

| Tool | Type | Description |
|------|------|-------------|
| [AMCharts Pixel Map Generator](https://pixelmap.amcharts.com/) | Web tool | Generates customizable pixel maps of countries/regions, 100+ map sources, 90+ projections, export as SVG/PNG/HTML |
| [Tavern Crowd 8-Bit Map Generator](https://taverncrowd.com/8-bit-map-generator) | AI tool | Creates 8-bit overworld maps, dungeon screens, towns, battle backgrounds in retro style |
| [PixelLab](https://www.pixellab.ai/) | AI tool | Generates pixel art game assets including maps, tilesets, textures for top-down and side-scrolling games |
| [Pixa Pixel Map Generator](https://www.pixa.com/create/pixel-map-generator) | AI tool | Text-to-pixel-map generation with 8-bit or 16-bit style options |

These are primarily for fantasy/game map generation, not real-world geography, but they demonstrate the visual aesthetic we're targeting.

### 8.12 Key Technical Insights Summary

1. **Google Maps styling is too limited** -- only color/visibility changes, no texture replacement or geometry modification
2. **MapLibre GL JS is the best platform** -- pattern fills, custom sprites, custom fonts, custom WebGL layers, 3D extrusions, and full access to the WebGL context for post-processing
3. **Pixelation shaders are trivial to implement** -- a 5-line fragment shader can make any map look retro
4. **The Zelda tile approach proves real-world-to-game-tile conversion works** -- aerial imagery color analysis maps to game tile types
5. **Mapbox/Unity Minecraft demo proves the data pipeline works** -- vector tile land use data can drive block type selection
6. **Arnis proves OSM-to-Minecraft-blocks conversion works** -- rule-based mapping from OSM tags to block types
7. **Tangram has the best built-in shader support** for game-like effects but is less actively maintained
8. **Self-hosted tiles (Protomaps/PMTiles) give full rendering control** with zero server infrastructure
9. **The sprite sheet system in MapLibre is purpose-built** for exactly this use case -- loading custom textures for map features
10. **Full voxel rendering of real-world data in the browser is proven feasible** by Blocky Earth (2012) and VoxelEarth (modern)

---

## 9. Deterministic Voxelization Pipeline: State of the Art

This section covers the technical landscape for converting real-world geographic data into Minecraft-like voxel worlds using rule-based, deterministic pipelines (not AI image generation).

### 9.1 Existing Open-Source Voxelization Tools

#### Arnis (github.com/louis-e/arnis)

The most complete open-source OSM-to-Minecraft converter. Written in Rust, Apache 2.0 licensed.

**Full Pipeline:**
1. **Data Acquisition**: Fetches OSM data via Overpass API for a user-specified bounding box
2. **Parsing**: `osm_parser.rs` transforms OSM JSON into `ProcessedElement` variants (Node, Way, Relation)
3. **Coordinate Transform**: Converts geographic lat/lng to Minecraft XZ coordinates
4. **Element Processing**: Tag-based dispatching routes elements to specialized processors
5. **Terrain/Ground**: Fetches AWS Terrain Tiles (Terrarium RGB), applies Gaussian blur for smooth transitions
6. **Serialization**: Outputs Java Edition Anvil (.mca) or Bedrock Edition (.mcworld) format

**Block Assignment System:**
- Block definitions centralized in `src/block_definitions.rs`
- Uses lightweight u8 ID-based mapping (each block gets an 8-bit identifier)
- `BlockWithProperties` struct for complex blocks needing NBT properties (stairs, doors, rails, etc.)
- Tag-based dispatching: OSM tags (`building`, `highway`, `natural`, `water`) route to specialized processors
- Building processor: Uses `BuildingCategory` tags to select wall materials, roof styles, interior generation
- Highway processor: Examines `surface` values for stone vs. dirt path blocks
- Water processor: Scanline rasterization for lakes/basins

**Color-to-Block Mapping:**
- `DEFINED_COLORS` array maps RGB tuples to sets of block options
- Example: `(233, 107, 57)` maps to brick/nether brick options
- Supports both random and seeded RNG-based block selection for reproducibility
- Bedrock translation via `src/bedrock_block_map.rs`
- Issue #285 requested proper hex color code matching; was completed August 2025, but no CIELAB/Delta-E algorithm documented in the discussion

**Terrain/Elevation:**
- AWS Terrain Tiles in Terrarium RGB format
- `UrbanGroundComputer` analyzes building density to apply stone ground in cities vs. grass in rural areas
- Gaussian blur applied for smooth terrain transitions

**Output Formats:**
- Java Edition: Standard Anvil `.mca` region files (direct world directory structure)
- Bedrock Edition: `.mcworld` files (compressed archives containing LevelDB databases)
- No schematic output (creates full playable worlds)

**Project Structure:**
```
src/main.rs                  - Entry point (CLI/GUI)
src/data_processing.rs       - Main orchestration pipeline
src/osm_parser.rs           - OSM JSON transformation
src/block_definitions.rs    - Block ID -> Minecraft block mapping
src/bedrock_block_map.rs    - Java -> Bedrock block translation
src/element_processing/     - Feature-specific handlers (buildings, highways, water, natural, landuse)
src/world_editor/           - Format-agnostic block placement (java.rs, bedrock.rs)
src/gui.rs                  - Tauri backend for GUI
```

#### Terra 1:1 / Terra++ (github.com/orangeadam3/terra121)

Minecraft Forge mod that generates real-world terrain at 1:1 scale (1 block = 1 meter).

**Data Sources:**
- Elevation: AWS Terrain Tiles (real-time download)
- Tree cover: ARCGIS REST TreeCover2000 Image Server
- Roads: OpenStreetMap (Open Database License)
- Requires Cubic Chunks mod to remove 256-block height limit

**Block Mapping:**
- Biome-based: maps real-world climate/terrain zones to Minecraft biomes
- Elevation drives block selection (snow above treeline, stone on cliffs, etc.)
- Roads rendered as gray blocks based on OSM highway tags

#### Voxel Earth (github.com/ryanhlewis/VoxelEarth)

Pipeline for converting Google 3D Tiles to Minecraft voxels.

**Pipeline:**
1. `java-3dtiles-downloader`: Fetches Google Photorealistic 3D Tiles as GLB files
2. `java-draco-decoder`: Decompresses Draco-encoded geometry via LWJGL + Assimp
3. `java-cpu-voxelizer`: Converts GLB meshes into JSON "block + xyzi" files
4. Loads via `/loadjson` command in-game

**Key Design Decision:** CPU voxelization only. GPU (cuda_voxelizer) was abandoned because disk I/O overhead made end-to-end pipeline slower than CPU-only.

**Output:** JSON files containing block type + coordinate data.

#### OSM2World (github.com/tordanik/OSM2World)

Converts OSM data to 3D models. Java-based. Outputs OBJ, glTF, and other 3D formats. Not Minecraft-specific but relevant as intermediate format.

#### FileToVox (github.com/Zarbuz/FileToVox)

Converts various file formats to MagicaVoxel .vox files:
- PNG images (folder of layers)
- Heightmaps with colormap overlay
- Point clouds (.asc, .xyz)
- 3D meshes (via MeshSampler .OBJ/.FBX -> point cloud)
- Procedural terrain generation via JSON config
- Supports worlds larger than 126^3 voxels via region system

#### mesh_to_schematic (github.com/City-of-Helsinki/mesh_to_schematic)

Converts 3D meshes to colored Minecraft .schematic files. Used by City of Helsinki for urban visualization.

#### RoboSat (github.com/mapbox/robosat)

Mapbox's semantic segmentation tool for aerial/satellite imagery. Extracts buildings, parking lots, roads, water, clouds. Trains FCN models and post-processes segmentation masks into cleaned geometries.

### 9.2 Minecraft Schematic/Export Formats

#### .schem (Sponge Schematic, Version 3) -- Modern Standard

**Binary Structure:** GZip-compressed NBT, root compound wrapping a "Schematic" compound.

```
Root Compound
  └── Schematic (Compound)
       ├── Version: int (3)
       ├── DataVersion: int (Minecraft data version)
       ├── Width: unsigned short (X-axis)
       ├── Height: unsigned short (Y-axis)
       ├── Length: unsigned short (Z-axis)
       ├── Offset: int[3] (optional, default [0,0,0])
       ├── Metadata (Compound, optional)
       │    ├── Name: string
       │    ├── Author: string
       │    ├── Date: long
       │    └── RequiredMods: string[]
       ├── Blocks (Compound, optional)
       │    ├── Palette (Compound) -- maps block state strings to indices
       │    │    e.g. "minecraft:planks[variant=oak]" -> 1
       │    ├── Data (byte array) -- varint-encoded palette indices
       │    │    Index formula: x + z * Width + y * Width * Length
       │    └── BlockEntities (Compound[], optional)
       │         ├── Pos: int[3]
       │         ├── Id: string (resource location)
       │         └── Data: Compound
       ├── Biomes (Compound, optional) -- new in v3
       │    ├── Palette (Compound) -- "minecraft:biome_name" -> index
       │    └── Data (byte array) -- varint-encoded, same index formula
       └── Entities (Compound[], optional)
            ├── Pos: double[3]
            ├── Id: string
            └── Data: Compound
```

**Key Details:**
- Block data uses varint encoding (wiki.vg specification)
- Palette indices start at 0, no gaps, for optimal compression
- Block state format: `namespace:block[prop1=val1,prop2=val2]`
- All field names case-sensitive
- Version history: v1 (2016), v2 (2019, added entities/biomes/DataVersion), v3 (2021, added 3D biome support)

#### .schematic (Legacy MCEdit) -- Pre-1.13

**Binary Structure:** GZip-compressed NBT, single root compound.

```
Root Compound
  ├── Width: short (X-axis)
  ├── Height: short (Y-axis)
  ├── Length: short (Z-axis)
  ├── Materials: string ("Alpha", "Classic", or "Pocket")
  ├── Blocks: byte array -- 8-bit block IDs
  │    Index formula: (Y * Length + Z) * Width + X  (YZX order)
  ├── Data: byte array -- 4-bit metadata (lower nibble only)
  ├── AddBlocks: byte array (optional) -- extra 4 bits per block for IDs > 255
  │    Even indices: high nibble, odd indices: low nibble
  ├── Entities: NBT List
  ├── TileEntities: NBT List
  ├── WEOriginX/Y/Z: int (optional, WorldEdit)
  └── WEOffsetX/Y/Z: int (optional, WorldEdit)
```

**Limitations:**
- Uses numeric block IDs (not string-based resource locations)
- Incompatible with post-1.13 Minecraft without ID-to-string mapping
- Max 4096 unique block types (12-bit IDs with AddBlocks)

#### .nbt (Minecraft Structure Block Format)

Used by vanilla structure blocks and `/place template` command. Stored in data packs at `data/<namespace>/structure/`.

**Structure:**
- GZip-compressed NBT compound
- Blocks stored as palette + indexed block list (similar to .schem)
- Each block entry includes position, palette index, and optional NBT data
- Block entities stored inline with their block entries
- Entities stored separately with relative coordinates
- Maximum practical size limited by structure block UI (48x48x48 in vanilla)

#### .vox (MagicaVoxel)

**Binary Structure:** RIFF-style format.

```
Header:
  4 bytes: magic "VOX " (with trailing space)
  4 bytes: version (int, typically 150)

Chunks (12-byte header each):
  4 bytes: chunk ID (char[4])
  4 bytes: content size N (int)
  4 bytes: children size M (int)
  N bytes: content
  M bytes: child chunks

Chunk Types:
  MAIN  -- root container, no content, all others are children
  PACK  -- optional, contains int num_models (absent = 1 model)
  SIZE  -- 3 ints: x, y, z dimensions (z = gravity direction)
  XYZI  -- int num_voxels, then num_voxels * 4 bytes: x, y, z, colorIndex (1 byte each)
  RGBA  -- 256 colors, each 4 bytes: R, G, B, A
           Palette index [0-254] maps to stored colors [1-255]
           Index 0 is always transparent
  MATL  -- material properties (replaced deprecated MATT)
```

**Limits:** Each model max 256x256x256. Multiple models via PACK chunk.

#### .litematic (Litematica)

Modern NBT-based format used by the Litematica mod. Contains:
- Metadata (name, author, description, time)
- Regions with block palette + block data
- Tile entity data
- Optional entity data
- Minecraft data version for compatibility

#### Format Comparison

| Format | Max Size | Block Encoding | Entities | Modern MC | Read/Write Libraries |
|--------|----------|----------------|----------|-----------|---------------------|
| .schem v3 | ~unlimited | String palette + varint | Yes | Yes (1.13+) | prismarine-schematic, SchematicJS, fastnbt |
| .schematic | ~unlimited | Numeric IDs + nibble data | Yes | No (pre-1.13) | prismarine-schematic (read-only), many legacy |
| .nbt structure | 48x48x48 (vanilla) | String palette + indices | Yes | Yes | SchematicJS, prismarine-nbt |
| .vox | 256^3 per model | XYZ + color index | No | N/A | py-vox-io, vox-format (Rust), Kaitai parsers |
| .litematic | ~unlimited | String palette + packed bits | Yes | Yes | litemapy (Python) |

### 9.3 Libraries for Reading/Writing These Formats

#### JavaScript / TypeScript

| Library | npm Package | Formats | Read | Write | Notes |
|---------|------------|---------|------|-------|-------|
| prismarine-schematic | `prismarine-schematic` | .schem (rw), .schematic (r) | Yes | Yes (.schem only) | Part of PrismarineJS ecosystem. Depends on prismarine-block, prismarine-world |
| prismarine-nbt | `prismarine-nbt` | Raw NBT (big/little/varint endian) | Yes | Yes | Auto-detects endianness, auto-decompresses gzip. Works for Java + Bedrock |
| SchematicJS | `@enginehub/schematicjs` | .schem v1-3, .nbt, .schematic | Yes | Yes | From EngineHub (WorldEdit authors). No entity/block entity support. TypeScript |

**prismarine-schematic API:**
```js
// Read
const schematic = await Schematic.read(buffer); // auto-detects format
// Write
const buffer = await schematic.write(); // always Sponge format
// Manipulate
schematic.setBlock(pos, block);
schematic.getBlock(pos);
schematic.forEach((block, pos) => { ... });
// World integration
const schem = await Schematic.copy(world, start, end, offset, version);
await schematic.paste(world, at);
// Serialize
const json = schematic.toJSON();
const cmds = schematic.makeWithCommands(offset, 'pc'); // generates /setblock commands
```

#### Python

| Library | Package | Formats | Notes |
|---------|---------|---------|-------|
| py-vox-io | `py-vox-io` | .vox (rw) | No dependencies, straightforward read/write |
| numpy-vox-io | `numpy-vox-io` | .vox (rw) | NumPy-based, some compatibility issues with latest .vox |
| litemapy | `litemapy` | .litematic (rw) | Full read/write for Litematica format |
| nbtlib | `nbtlib` | Raw NBT (rw) | General NBT manipulation |
| amulet-nbt | `amulet-nbt` | Raw NBT (rw) | Fast C++ backend, used by Amulet world editor |
| anvil-parser | `anvil-parser` | .mca (rw) | Read/write Minecraft Anvil region files |

#### Rust

| Library | Crate | Notes |
|---------|-------|-------|
| fastnbt | `fastnbt` | Fast serde-based NBT, zero-copy where possible. Best for performance |
| hematite-nbt | `hematite-nbt` | Full serde support, mature. From the Hematite project |
| quartz_nbt | `quartz_nbt` | Supports zlib/gz compression, SNBT conversion |
| vox-format | `vox-format` | MagicaVoxel .vox read/write |

**Note:** The three Rust NBT crates all support serde but are not interoperable due to custom handling of NBT Array types.

### 9.4 Semantic Segmentation Models for Satellite Imagery

#### Pre-Trained Foundation Models

**SatlasPretrain (Allen AI, github.com/allenai/satlaspretrain_models)**
- Labels across 7 task modalities, 100+ unique tasks
- Supports: segmentation, detection, instance segmentation, regression, classification
- Architectures: Swin Transformer v2 (Base, Tiny), ResNet (50, 152)
- Input: Sentinel-2 (3 or 9 bands), Sentinel-1 (2 bands), Landsat 8/9 (11 bands), Aerial RGB (0.5-2m/px)
- Number of output classes configurable via `num_categories`
- Fine-tunable on downstream tasks with better performance than training from scratch
- License: ODC-BY
- No documented ONNX export capability

**TorchGeo (github.com/torchgeo/torchgeo, by Microsoft)**
- PyTorch domain library for geospatial data
- Provides datasets, samplers, transforms, and pre-trained models
- First library to support models pre-trained on different multispectral sensors
- Includes EuroSAT (27,000 images, 64x64px, 10 classes) and many other datasets
- Lightning datamodules with train-val-test splits
- Pre-calculated channel statistics for normalization

#### Existing Land Cover Datasets/Products (No Model Training Needed)

**Google Dynamic World**
- 10m resolution, near-real-time (updated every 2-5 days)
- 9 classes: Water, Trees, Grass, Flooded Vegetation, Crops, Shrub & Scrub, Built Environment, Bare Ground, Snow & Ice
- Per-pixel probability bands + label band
- Access: Google Earth Engine (`GOOGLE/DYNAMICWORLD/V1`), web app (dynamicworld.app), Google Cloud Storage
- Completely free, unrestricted use
- Based on Sentinel-2 imagery + deep learning
- Partnership between Google Earth + World Resources Institute

**ESA WorldCover**
- 10m resolution, global coverage
- 11 classes: Tree Cover, Shrubland, Grassland, Cropland, Built-up, Bare/Sparse Vegetation, Snow & Ice, Permanent Water Bodies, Herbaceous Wetland, Mangrove, Moss & Lichen
- Based on Sentinel-1 + Sentinel-2
- Available as Cloud Optimized GeoTIFFs in 3x3 degree tiles (2,651 tiles total)
- Free, unrestricted use
- Download: worldcover2021.esa.int, AWS S3 (`esa-worldcover` bucket)

#### Standard Class Taxonomies

| Source | Classes | Resolution |
|--------|---------|------------|
| Dynamic World | 9 | 10m |
| ESA WorldCover | 11 | 10m |
| EuroSAT | 10 (AnnualCrop, Forest, HerbaceousVeg, Highway, Industrial, Pasture, PermanentCrop, Residential, River, SeaLake) | 10m (64x64 patches) |
| NLCD (US only) | 16 | 30m |
| Copernicus CORINE | 44 | 100m |

#### Browser-Based Inference

**Current State:**
- TensorFlow.js: DeepLab v3 available as pre-trained model for in-browser semantic segmentation
- ONNX Runtime Web: Can run ONNX models in browser, but satellite-specific models are not commonly exported to ONNX
- WebNN API: Emerging standard for browser-based neural network inference (Microsoft pushing)
- Practical limitation: Most satellite segmentation models are large (100MB+) and require multispectral input, making browser inference impractical for real-time use
- Better approach: Use pre-computed land cover tiles (Dynamic World, ESA WorldCover) rather than running inference in the browser

**Practical Recommendation for This Project:**
Rather than running ML inference, consume pre-computed land cover classification tiles from Dynamic World or ESA WorldCover. These provide per-pixel class labels at 10m resolution, which maps almost perfectly to Minecraft's 1 block = 1 meter scale (just 10:1 downscaling needed). The 9-11 classes map cleanly to Minecraft block types.

#### Accuracy

- Dynamic World: ~73% overall accuracy globally, higher in well-mapped regions
- ESA WorldCover: ~75% overall accuracy (independently validated)
- DeepLab v3+ with Inception-V3 on EuroSAT: 99.4% (but this is scene classification, not pixel-level segmentation)
- U-Net + MobileNet attention models: competitive results for pixel-level segmentation

### 9.5 Heightmap / Elevation Data Sources

#### Comparison of Free Global DEMs

| Dataset | Resolution | Coverage | Accuracy (RMSE) | Format | Access |
|---------|-----------|----------|-----------------|--------|--------|
| SRTM v4.1 (CGIAR) | 90m (~3 arc-sec) | 60N-56S | ~4.5m | GeoTIFF | Free, CGIAR-CSI |
| SRTM 1 arc-sec | 30m | 60N-56S | ~6m | BIL, DTED, GeoTIFF | Free, USGS EarthExplorer (registration required) |
| ASTER GDEM v3 | 30m (~1 arc-sec) | 83N-83S | ~8.5m | GeoTIFF | Free, NASA EarthData |
| Copernicus GLO-30 | 30m | Global | Better than SRTM | Cloud Optimized GeoTIFF | Free (except Armenia/Azerbaijan), Copernicus Data Space, AWS, OpenTopography |
| Copernicus GLO-90 | 90m | Global | Same as GLO-30 | Cloud Optimized GeoTIFF | Free, same sources |
| Copernicus EEA-10 | 10m | 39 European countries | Best of all | GeoTIFF | Free |
| ALOS AW3D30 | 30m | Global | ~5m | GeoTIFF | Free, JAXA |

**For Minecraft-scale terrain (1 block = 1 meter):**
- 30m resolution DEMs give 1 height sample per 30x30 block area -- adequate for macro terrain
- 10m EEA gives 1 sample per 10x10 blocks -- good for European locations
- For true 1m resolution, you need LIDAR data (available for many cities/countries but not global)
- Interpolation (bilinear or bicubic) between DEM samples creates smooth terrain between known points

#### AWS Terrain Tiles (Terrarium Encoding)

**URL Pattern:**
```
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
https://s3.amazonaws.com/elevation-tiles-prod/normal/{z}/{x}/{y}.png
https://s3.amazonaws.com/elevation-tiles-prod/geotiff/{z}/{x}/{y}.tif
https://s3.amazonaws.com/elevation-tiles-prod/skadi/{N|S}{lat}/{N|S}{lat}{E|W}{lng}.hgt.gz
```

EU mirror: `elevation-tiles-prod-eu` (eu-central-1)

**No authentication required:** `aws s3 ls --no-sign-request s3://elevation-tiles-prod/`

**Zoom levels:** 0-15

**Terrarium Decoding:**
```javascript
// Each pixel RGB encodes elevation in meters
// Red = 256s place, Green = 1s place, Blue = fractional (1/256)
function decodeTerrarium(r, g, b) {
  return (r * 256 + g + b / 256) - 32768;
}

// Encoding (for generating tiles):
function encodeTerrarium(elevation) {
  const v = elevation + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v % 256);
  const b = Math.floor((v - Math.floor(v)) * 256);
  return [r, g, b];
}
```

**Precision:** 3mm (1/256 meter). Range: -11,000 to 8,900 meters.

**Example:** Elevation 2523.266m encodes as RGB(137, 219, 68).

#### MapTiler Terrain RGB

**Encoding:** Same as Mapbox Terrain-RGB:
```javascript
height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
```

- Available up to zoom level 14
- ~30m effective resolution
- Requires MapTiler API key
- Low bandwidth (only loads visible tiles)

**Note:** Terrarium and MapTiler/Mapbox use DIFFERENT encoding formulas. Terrarium offset is 32768; Mapbox/MapTiler offset is 10000 with 0.1 scale factor.

#### Arnis's Elevation Approach (as documented by AWS blog)

Arnis fetches AWS Terrain Tiles in Terrarium format, decodes RGB to height, applies Gaussian blur for smooth transitions, and uses the `UrbanGroundComputer` to blend stone ground (cities) vs grass (rural) based on building density analysis.

### 9.6 Block Palette Mapping Approaches

#### Minecraft's Official Map Color System

Minecraft uses 62 base colors (IDs 0-61), each with 4 shade levels. This yields 248 unique colors (plus transparent).

**Shade Multipliers:**
| Shade | Multiplier | Fraction | Use |
|-------|-----------|----------|-----|
| 0 (darkest) | 135/255 | 0.529 | Lower elevation than block to north |
| 1 | 180/255 | 0.706 | Same elevation |
| 2 (brightest) | 220/255 | 0.863 | Higher elevation |
| 3 (original) | 255/255 | 1.000 | Flat surface |

**Base Colors (selected -- full list at minecraft.wiki/w/Map_item_format):**
```
ID  Name              RGB              Sample Blocks
0   NONE              transparent      Air, Glass
1   GRASS             127, 178, 56     Grass Block, Slime
2   SAND              247, 233, 163    Sand, Sandstone
3   WOOL              199, 199, 199    Cobweb, Mushroom Stem
4   FIRE              255, 0, 0        Lava, TNT
5   ICE               160, 160, 255    Ice, Packed Ice
6   METAL             167, 167, 167    Iron Block, Anvil
7   PLANT             0, 124, 0        Leaves, Flowers
8   SNOW              255, 255, 255    Snow, White Wool
9   CLAY              164, 168, 184    Clay
10  DIRT              151, 109, 77     Dirt, Coarse Dirt
11  STONE             112, 112, 112    Cobblestone, Bedrock
12  WATER             64, 64, 255      Water, Kelp
13  WOOD              143, 119, 72     Oak Planks, Chests
14  QUARTZ            255, 252, 245    Quartz, Sea Lantern
15  COLOR_ORANGE      216, 127, 51     Pumpkin, Orange Wool
16  COLOR_MAGENTA     178, 76, 216     Magenta Wool, Purpur
17  COLOR_LIGHT_BLUE  102, 153, 216    Light Blue Wool
...through ID 61 (GLOW_LICHEN: 127, 167, 150)
```

Full machine-readable data: github.com/cerus/minecraft-map-colors (JSON, all versions 1.8.3-1.21.8)

#### Color Matching Algorithms

**Approach 1: CIELAB Delta-E (Industry Standard)**
- Convert both target color and all block colors to CIELAB color space
- Compute Delta-E distance (perceptual color difference)
- CIE76 (simple Euclidean in Lab): fast, good enough for most uses
- CIE2000 (CIEDE2000): most accurate, accounts for human perception nonlinearities
- Libraries: `python-colormath`, `coloraide`, `hamada147/IsThisColourSimilar` (JS CIE2000)

**Approach 2: OKLab (Modern Perceptual)**
- Björn Ottosson's perceptual color space (2020)
- Euclidean distance in OKLab coordinates correlates well with perceived difference
- Simpler math than CIEDE2000, nearly as accurate
- Now in CSS Color Level 4/5 specification
- Minecraft-specific implementation: **Blockpedia** (Rust crate, github.com/Nano112/blockpedia)

**Approach 3: Simple RGB Euclidean (Fast but Inaccurate)**
```javascript
distance = sqrt((r1-r2)^2 + (g1-g2)^2 + (b1-b2)^2)
```
- Fast but perceptually inaccurate (green channel overweighted)
- Weighted variant: `distance = sqrt(2*(dr)^2 + 4*(dg)^2 + 3*(db)^2)` (slightly better)

#### Blockpedia (Rust, github.com/Nano112/blockpedia)

The most comprehensive block color database:
- 1,058+ blocks from Minecraft 1.20.4
- Color data for 472+ blocks (extracted from real textures)
- Supports RGB, HSL, OKLab, and CIELab color spaces
- Perceptual color matching via OKLab distance: `color.distance_oklab(&target) < 20.0`
- Available on crates.io (Rust 1.82+)
- Data stored in JSON, sourced from PrismarineJS + MCPropertyEncyclopedia

#### How Existing Projects Handle Block Mapping

**Arnis:** Tag-based deterministic mapping. OSM tags directly select blocks (e.g., `highway=residential` -> stone slab, `building=commercial` -> quartz). Color matching used for `building:colour` OSM tag -> concrete/terracotta selection.

**VoxelEarth:** Photogrammetry texture colors mapped to Minecraft block palette. Details of matching algorithm not documented.

**Terra 1:1:** Biome/elevation-based. Real-world climate zones -> Minecraft biomes -> natural block types. Snow above treeline, sandstone in deserts, etc.

**This project (blockColors.js):** Uses Minecraft's official map color base colors with 3 shade levels (0.71, 0.86, 1.0). Maps OSM feature types directly to specific base colors:
- Roads: GRAY/LIGHT_GRAY shades by road class
- Buildings: TERRACOTTA/QUARTZ/STONE by building type
- Water: WATER base color
- Land use: GRASS/PLANT/DIRT/SAND by category
- Widths defined per road class (motorway=6px, path=1px at z17)

### 9.7 Key Technical Decisions & Recommendations

**For a web-based voxelization pipeline converting geographic data to Minecraft-style output:**

1. **Land cover classification:** Use Dynamic World (9 classes, 10m, free, updated every 2-5 days) or ESA WorldCover (11 classes, 10m, free) rather than running ML models. Both are available as tile services.

2. **Elevation data:** AWS Terrain Tiles (Terrarium format, zoom 0-15, no auth, free). Decode: `(R*256 + G + B/256) - 32768`. For higher precision, Copernicus GLO-30 (30m, free).

3. **Block palette matching:** OKLab color space with Euclidean distance. More accurate than RGB, simpler than CIEDE2000. Use Minecraft's 62 base colors x 4 shades = 248 palette entries as the target color space.

4. **Output format:** Sponge Schematic v3 (.schem) for importability into Minecraft. Use `@enginehub/schematicjs` or `prismarine-schematic` (JS), `fastnbt` (Rust), or `nbtlib`/`amulet-nbt` (Python) for writing. The format supports unlimited dimensions with string-based block IDs and varint-encoded palette indices.

5. **OSM feature mapping:** Follow Arnis's approach of tag-based dispatching. Map OSM tags deterministically to block types (highway -> stone variants, building -> terracotta/quartz by type, natural=water -> water blocks, landuse=forest -> leaf/log blocks).

6. **Coordinate system:** At zoom 17, 1 pixel ~= 1 meter, which maps cleanly to 1 Minecraft block. Process 256x256 tiles to produce 256x256 block regions.
