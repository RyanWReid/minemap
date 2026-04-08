import { createCanvas, loadImage } from 'canvas';

export async function fetchOneElevationTile(z: number, x: number, y: number): Promise<{data: Uint8ClampedArray, width: number} | null> {
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

export function decodeTerrarium(data: Uint8ClampedArray, x: number, y: number, w: number): number {
  const px = Math.min(Math.max(0, Math.floor(x)), w - 1);
  const py = Math.min(Math.max(0, Math.floor(y)), w - 1);
  const i = (py * w + px) * 4;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
}
