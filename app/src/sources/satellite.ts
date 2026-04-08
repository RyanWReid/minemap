import { createCanvas, loadImage } from 'canvas';
import { SemanticClass } from '../types.js';

export async function fetchSatelliteTilePixels(z: number, x: number, y: number): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const img = await loadImage(buf);
      const canvas = createCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, img.width, img.height);
    } catch {
      if (attempt < 2) { await new Promise(r => setTimeout(r, 1000)); continue; }
      return null;
    }
  }
  return null;
}

/**
 * Conservative satellite ground refinement.
 * Only reclassifies pixels that are VERY clearly not grass.
 * Biased heavily toward keeping grass — only overrides for obvious water,
 * large bare dirt patches, and clearly non-green terrain.
 */
export function refineGroundFromSatellite(
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
