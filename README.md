# Minecraft Map

An interactive web map that renders the real world in Minecraft block art style. Pan, zoom, and search anywhere on Earth — every tile is generated on-the-fly from real geographic data.

![Minecraft Map](https://img.shields.io/badge/style-Minecraft-brightgreen)

## Features

- **Live tile generation** — explores the whole world, rendering Minecraft-style tiles as you pan and zoom
- **Real geographic data** — roads, buildings, parks, water, forests, paths all sourced from OpenStreetMap + Overture Maps
- **3D voxel pipeline** — builds an actual voxel world per tile, then renders top-down with Minecraft north-shading
- **Biome-aware palettes** — block choices adapt to latitude/elevation (Mediterranean, temperate, arid, arctic, etc.)
- **Complete building coverage** — combines OSM data with Microsoft/Overture AI building footprints (2.6B buildings worldwide)
- **Real elevation** — terrain heights from AWS Terrain Tiles create hills, valleys, and coastlines
- **Tree placement** — biome-appropriate trees with proper trunk + canopy in forests and parks
- **Multiple map layers** — toggle between Minecraft, Satellite, and Roads views
- **Search** — find any place by name or coordinates
- **Location tracking** — show your position on the map with a Minecraft-style marker

## Data Sources

| Source | What it provides |
|--------|-----------------|
| [VersaTiles](https://versatiles.org) | Base vector tiles (roads, land use, water) |
| [Overpass API](https://overpass-api.de) | Complete OSM buildings, roads, paths, land features |
| [Overture Maps](https://overturemaps.org) | Microsoft AI building footprints (fills OSM gaps) |
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | Elevation data (Terrarium encoding) |

## Quick Start

```bash
cd pipeline
npm install
npx tsx src/serve.ts
```

Open **http://localhost:3001** in your browser.

## How It Works

Each map tile goes through this pipeline:

1. **Fetch** — pull vector tiles, building footprints, road data, and elevation for the tile's bounding box
2. **Classify** — rasterize all features into a semantic map (water, road, building, forest, park, etc.)
3. **Heightmap** — decode Terrarium elevation into Minecraft Y levels
4. **Voxelize** — place blocks column-by-column: surface, subsurface, trees, building extrusion, water fill
5. **Render** — top-down orthographic render with Minecraft-style north-shading for depth

Tiles are cached after first render. Cold tiles take ~3-6s, cached tiles are instant.

## Semantic Classes

The pipeline recognizes 24 terrain/feature types including water, grass, forest, farmland, sand, rock, snow, roads, buildings, parking, railway, wetland, parks, pools, sports pitches, playgrounds, dirt paths, and more.

## Tech Stack

- **Server**: Express.js + TypeScript
- **Frontend**: Leaflet.js with pixelated rendering
- **Rendering**: Node Canvas (2D top-down voxel render)
- **Vector tiles**: @mapbox/vector-tile + pbf
- **Building data**: PMTiles (Overture Maps)

## License

MIT
