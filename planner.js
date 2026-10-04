import { PMTiles, zxyToTileId, findTile } from 'pmtiles';

// Longitude -> tile column at zoom z.
function lonToX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

// Latitude -> tile row at zoom z. Row 0 is the top (north) of the map.
function latToY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  const mercator = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return Math.floor(((1 - mercator / Math.PI) / 2) * 2 ** z);
}

function clamp(n, z) {
  return Math.max(0, Math.min(2 ** z - 1, n));
}

// bbox is [west, south, east, north] in degrees.
// Returns every tile touching the box at every zoom in [minZoom, maxZoom].
export function tilesForBbox([west, south, east, north], minZoom, maxZoom) {
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const xMin = clamp(lonToX(west, z), z);
    const xMax = clamp(lonToX(east, z), z);
    const yMin = clamp(latToY(north, z), z); // north edge = smaller row number
    const yMax = clamp(latToY(south, z), z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

// Opens the archive. Nothing is fetched until the first lookup.
export function openArchive(url) {
  return new PMTiles(url);
}

// Finds one tile's directory entry, following leaf directories as needed.
// Returns null if the file has no such tile.
async function findEntry(archive, header, tileId) {
  let dirOffset = header.rootDirectoryOffset;
  let dirLength = header.rootDirectoryLength;
  for (let depth = 0; depth <= 3; depth++) {
    const entries = await archive.cache.getDirectory(
      archive.source, dirOffset, dirLength, header
    );
    const entry = findTile(entries, tileId);
    if (!entry) return null;
    if (entry.runLength > 0) return entry; // a tile
    dirOffset = header.leafDirectoryOffset + entry.offset; // a pointer to a leaf
    dirLength = entry.length;
  }
  throw new Error('Directory nested too deep');
}

// Takes the tile list from tilesForBbox and returns, for each tile the file
// actually has, where its bytes are: { z, x, y, offset, length }.
export async function lookupTiles(archive, tiles) {
  const header = await archive.getHeader();
  const found = [];
  for (const { z, x, y } of tiles) {
    if (z < header.minZoom || z > header.maxZoom) continue;
    const entry = await findEntry(archive, header, zxyToTileId(z, x, y));
    if (!entry) continue;
    found.push({
      z, x, y,
      offset: header.tileDataOffset + entry.offset,
      length: entry.length,
    });
  }
  return found;
}

const ONE_MB = 1_000_000;

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

// Asks the server for the file's version fingerprint.
async function fetchEtag(url) {
  const response = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (!response.ok) throw new Error(`Could not reach ${url}: ${response.status}`);
  const etag = response.headers.get('ETag');
  if (!etag) throw new Error('Server sent no ETag, so the plan cannot be pinned');
  return etag;
}

// The whole planner in one call: bounding box in, plan out.
export async function planRegion(url, bbox, maxChunkBytes = ONE_MB) {
  const archive = openArchive(url);
  const [header, etag] = await Promise.all([archive.getHeader(), fetchEtag(url)]);
  const wanted = tilesForBbox(bbox, header.minZoom, header.maxZoom);
  const found = await lookupTiles(archive, wanted);
  const chunks = planChunks(found, maxChunkBytes);
  return {
    url,
    etag,
    bbox,
    minZoom: header.minZoom,
    maxZoom: header.maxZoom,
    tileCount: found.length,
    totalBytes: chunks.reduce((sum, c) => sum + c.length, 0),
    chunks,
  };
}