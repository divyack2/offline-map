// The tile index: for every tile saved on this device, where its bytes are.
import { listRegions, chunksForRegion } from './ledger.js';
import { readChunkSlice } from './store.js';

// "z/x/y" -> { regionId, chunkIndex, start, length }
const index = new Map();
const keyFor = (z, x, y) => `${z}/${x}/${y}`;

// Adds the tiles of one region's finished chunks to the index.
export async function indexRegion(regionId) {
  const chunks = await chunksForRegion(regionId);
  for (const chunk of chunks) {
    if (chunk.status !== 'done') continue; // only bytes the ledger vouches for
    for (const tile of chunk.tiles) {
      index.set(keyFor(tile.z, tile.x, tile.y), {
        regionId,
        chunkIndex: chunk.index,
        start: tile.offset - chunk.offset, // where the tile begins inside the chunk's file
        length: tile.length,
      });
    }
  }
}

// Rebuilds the whole index from the ledger. Returns how many tiles it holds.
export async function buildIndex() {
  index.clear();
  for (const region of await listRegions()) await indexRegion(region.id);
  return index.size;
}

export function hasLocalTile(z, x, y) {
  return index.has(keyFor(z, x, y));
}

// Tiles are stored gzip-compressed, and every gzip file starts with these two bytes.
function isGzip(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function gunzip(buffer) {
  const unzipped = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(unzipped).arrayBuffer();
}

// Returns one tile's bytes, ready for MapLibre, or null if it isn't saved here.
export async function readLocalTile(z, x, y) {
  const where = index.get(keyFor(z, x, y));
  if (!where) return null;

  let stored;
  try {
    stored = await readChunkSlice(where.regionId, where.chunkIndex, where.start, where.length);
  } catch (error) {
    if (error.name === 'NotFoundError') return null; // the ledger says done, but the file is gone
    throw error;
  }
  if (stored.byteLength !== where.length) return null; // the file is shorter than it should be

  return isGzip(stored) ? gunzip(stored) : stored;
}