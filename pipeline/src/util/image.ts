import { createCanvas, loadImage, type Canvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

/** Load an image from a URL into pixel data */
export async function fetchImageData(
  url: string,
): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const img = await loadImage(buffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, img.width, img.height);
  return { data: imageData.data, width: img.width, height: img.height };
}

/** Create a canvas and fill with a color grid (for debug output) */
export function renderColorGrid(
  width: number,
  height: number,
  getColor: (x: number, y: number) => [number, number, number],
): Canvas {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(width, height);
  const pixels = imageData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const [r, g, b] = getColor(x, y);
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/** Save a canvas to a PNG file */
export function savePNG(canvas: Canvas, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const buffer = canvas.toBuffer('image/png');
  writeFileSync(path, buffer);
}
