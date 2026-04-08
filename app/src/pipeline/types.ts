export interface RenderResult {
  buffer: Buffer;
  complete: boolean; // true if all critical data sources succeeded
}

export interface TileRenderer {
  renderParentTile(z: number, x: number, y: number): Promise<RenderResult | null>;
}
