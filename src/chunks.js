export const ONE_MB = 1_000_000;

// Takes the output of lookupTiles and groups tiles that sit back to back in
// the file into chunks of at most maxChunkBytes. Each chunk is one range
// request: { offset, length, tiles }.
export function planChunks(found, maxChunkBytes = ONE_MB) {
  const sorted = [...found].sort((a, b) => a.offset - b.offset);
  const chunks = [];
  let current = null;

  for (const tile of sorted) {
    const tileEnd = tile.offset + tile.length;
    if (current) {
      const chunkEnd = current.offset + current.length;
      const newLength = Math.max(chunkEnd, tileEnd) - current.offset;
      const touches = tile.offset <= chunkEnd;
      if (touches && newLength <= maxChunkBytes) {
        current.length = newLength;
        current.tiles.push(tile);
        continue;
      }
    }
    current = { offset: tile.offset, length: tile.length, tiles: [tile] };
    chunks.push(current);
  }
  return chunks;
}
