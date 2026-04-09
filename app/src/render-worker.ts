import { renderParentTile as renderV1 } from './pipeline/v1.js';
import { renderParentTile as renderV2 } from './pipeline/v2.js';
import { createCanvas, loadImage } from 'canvas';

const z = parseInt(process.env.RENDER_Z!);
const x = parseInt(process.env.RENDER_X!);
const y = parseInt(process.env.RENDER_Y!);
const pipelineVersion = process.env.RENDER_PIPELINE || 'v2';

const renderParentTile = pipelineVersion === 'v2' ? renderV2 : renderV1;

async function run() {
  const result = await renderParentTile(z, x, y);
  if (!result) {
    process.send!({ ok: false });
    return;
  }

  const { buffer: parentPNG, complete } = result;
  const parentImg = await loadImage(parentPNG);
  const factor = 4;
  const subSize = parentImg.width / factor;
  const subTiles: { key: string; buf: Buffer }[] = [];

  for (let sy = 0; sy < factor; sy++) {
    for (let sx = 0; sx < factor; sx++) {
      const tileX = x * factor + sx;
      const tileY = y * factor + sy;
      const key = `16_${tileX}_${tileY}`;

      const canvas = createCanvas(256, 256);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(parentImg, sx * subSize, sy * subSize, subSize, subSize, 0, 0, 256, 256);
      subTiles.push({ key, buf: canvas.toBuffer('image/png') });
    }
  }

  process.send!({ ok: true, complete, subTiles });
}

run().catch(err => {
  console.error('Render worker error:', err);
  process.send!({ ok: false, error: String(err) });
}).finally(() => {
  setTimeout(() => process.exit(0), 100);
});
