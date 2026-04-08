# Minecraft Map

**The entire real world, rendered as a Minecraft map.** Pan, zoom, search, and navigate anywhere on Earth -- every tile is generated on-the-fly from real geographic data using a full 3D voxel pipeline.

![Title Screen](screenshots/title-screen.png)

---

## The Map

Real OpenStreetMap data -- roads, buildings, parks, water, forests -- transformed into Minecraft block art through a voxel rendering pipeline. Buildings have actual height extrusion, terrain follows real elevation data, and trees are placed with biome-appropriate sprites.

![Map View](screenshots/map-view.png)

### How Tiles Are Rendered

Each 256px tile goes through a five-stage pipeline:

1. **Fetch** -- pull vector tiles, building footprints, roads, and elevation for the tile's bounding box
2. **Classify** -- rasterize features into a semantic map (water, road, building, forest, park, etc.)
3. **Heightmap** -- decode Terrarium elevation into Minecraft Y levels
4. **Voxelize** -- place blocks column-by-column: surface, subsurface, trees, building extrusion, water fill
5. **Render** -- top-down orthographic render with Minecraft-style north-face shading for depth

Cold tiles render in ~3-6 seconds. Cached tiles are instant.

The pipeline recognizes **24 terrain types** including water, grass, forest, farmland, sand, rock, snow, roads, buildings, parking, railway, wetland, parks, pools, sports pitches, playgrounds, dirt paths, and more. **Biome-aware palettes** adapt block choices based on latitude and elevation -- Mediterranean, temperate, arid, arctic, etc.

---

## Search & Directions

Search any place on Earth with autocomplete powered by Photon geocoding. Select a result to fly to it with a place card showing name, address, and a directions button.

<p align="center">
  <img src="screenshots/search.png" width="45%" alt="Search"/>
  <img src="screenshots/place-card.png" width="53%" alt="Place Card"/>
</p>

Get driving directions with distance and estimated time. Add waypoints, swap origin/destination, and expand step-by-step instructions.

![Directions](screenshots/directions.png)

### Turn-by-Turn Navigation

Hit **Start Navigation** to enter a GPS-tracked navigation mode with a pixel-art compass that rotates to your heading, step-by-step turn instructions, and distance to the next maneuver.

![Navigation](screenshots/navigation.png)

---

## Real-Time Lighting

Enable **Real-Time Lighting** in settings to sync the map's atmosphere to your actual time of day. Dawn, day, dusk, and night each have distinct color tints -- or force any time with cheats.

<p align="center">
  <img src="screenshots/dawn.png" width="49%" alt="Dawn"/>
  <img src="screenshots/day.png" width="49%" alt="Day"/>
</p>
<p align="center">
  <img src="screenshots/dusk.png" width="49%" alt="Dusk"/>
  <img src="screenshots/night.png" width="49%" alt="Night"/>
</p>

---

## Live Weather

Weather is fetched from Open-Meteo for wherever you're looking on the map. A Minecraft clock HUD displays the time with a 64-frame animated clock face, current temperature, and conditions.

Weather cheats let you force rain, snow, thunder, or clear skies -- complete with animated particle overlays on the map.

<p align="center">
  <img src="screenshots/rain.png" width="49%" alt="Rain"/>
  <img src="screenshots/snow.png" width="49%" alt="Snow"/>
</p>

---

## Everything Else

| Feature | Description |
|---------|-------------|
| **Title Screen** | Authentic Minecraft title screen with scrolling panorama, random splash text, and "Map Edition" subtitle |
| **Accounts** | Create an account with a player name to unlock social features |
| **Friends** | Share a 6-digit friend code, see friends' live locations on the map via WebSocket |
| **Chat** | Real-time multiplayer chat, Minecraft PE style |
| **Music** | Iconic Minecraft tracks (Sweden, Mice on Venus, Subwoofer Lullaby, Living Mice) with volume controls |
| **Ambient Sounds** | Biome-aware ambient audio (grass, water, rain, birdsong) that responds to visible terrain |
| **Sound Effects** | Authentic Minecraft UI sounds (clicks, chest open/close, level up, orb pickup) |
| **Achievements** | Unlock achievements for first search, first navigation, first friend, and more |
| **POI Markers** | Points of interest with Minecraft item sprite icons (restaurants, shops, hospitals, fuel, etc.) |
| **Nether Portal** | Teleport effect with portal animation when jumping 5km+ on the map |
| **Map Frame** | Decorative Minecraft item frame border around the viewport |
| **3 Map Layers** | Switch between Minecraft, Satellite, and Roads views |
| **Coordinates** | Cursor position shown as Minecraft X/Z coordinates plus real lat/lng |
| **Cheats Menu** | Force time of day (dawn/day/dusk/night) and weather (clear/rain/thunder/snow) |
| **Home/Spawn Point** | Set a spawn point and teleport back anytime |
| **Location Tracking** | GPS tracking with a rotating player marker |
| **Tile Prefetcher** | Background tile loading for smooth exploration |
| **Loading Screen** | Minecraft-style loading bar with "Building terrain..." steps |

---

## Data Sources

| Source | Provides |
|--------|----------|
| [VersaTiles](https://versatiles.org) | Base vector tiles (roads, land use, water) |
| [Overpass API](https://overpass-api.de) | Complete OSM buildings, roads, paths, land features |
| [Overture Maps](https://overturemaps.org) | Microsoft AI building footprints (fills OSM gaps -- 2.6B buildings worldwide) |
| [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | Real elevation data (Terrarium encoding) |
| [Photon](https://photon.komoot.io) | Place search & geocoding |
| [OSRM](http://project-osrm.org) | Driving directions & routing |
| [Open-Meteo](https://open-meteo.com) | Real-time weather data |

## Tech Stack

- **Tile Server**: Express.js + TypeScript with SQLite tile cache
- **Rendering**: Node Canvas -- 2D top-down voxel render with north-face shading
- **Frontend**: Leaflet.js with pixelated rendering, vanilla JS
- **Vector Tiles**: @mapbox/vector-tile + pbf
- **Building Data**: PMTiles (Overture Maps)
- **Real-time**: WebSocket server for friends & chat
- **Auth**: bcryptjs + session cookies
- **Deployment**: Docker (Coolify-ready)

## Quick Start

```bash
cd app
npm install
npx tsx src/serve.ts
```

Open **http://localhost:3001**.

### Docker

```bash
docker build -t minecraft-map .
docker run -p 3001:3001 minecraft-map
```

## License

MIT

---

*Not affiliated with Mojang or Microsoft. Built by [Ryan Reid](https://github.com/RyanWReid).*
