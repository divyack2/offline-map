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

// How many tiles tilesForBbox would return, worked out without building the list.
export function countTiles([west, south, east, north], minZoom, maxZoom) {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const columns = clamp(lonToX(east, z), z) - clamp(lonToX(west, z), z) + 1;
    const rows = clamp(latToY(south, z), z) - clamp(latToY(north, z), z) + 1;
    total += columns * rows;
  }
  return total;
}

// Thrown when the file at the URL is no longer the version we were reading.
export class FileChangedError extends Error {}

// One range request. When `etag` is given, the request is pinned to that
// version of the file: the server is told to refuse if the file has changed
// (If-Match), and the ETag on the answer is checked as well.
export async function fetchRange(url, offset, length, etag) {
  const headers = { Range: `bytes=${offset}-${offset + length - 1}` };
  if (etag) headers['If-Match'] = etag;
  const response = await fetch(url, { headers, cache: 'no-store' });

  // 412: the If-Match check failed. 416: the range is past the end of the
  // file, which for a pinned request means the file was replaced by a shorter one.
  if (response.status === 412 || (etag && response.status === 416)) {
    throw new FileChangedError(`${url} changed on the server`);
  }
  if (response.status !== 206) {
    throw new Error(`Range request to ${url} failed with status ${response.status}`);
  }
  const actual = response.headers.get('ETag');
  if (!actual) throw new Error('Server sent no ETag, so the file version cannot be pinned');
  if (etag && actual !== etag) throw new FileChangedError(`${url} changed on the server`);
  return { data: await response.arrayBuffer(), etag: actual };
}

// How the pmtiles library reads the file. The first answer fixes the version;
// every later read must come from that same version or it throws.
class PinnedSource {
  constructor(url) {
    this.url = url;
    this.etag = null;
  }
  getKey() {
    return this.url;
  }
  async getBytes(offset, length) {
    const result = await fetchRange(this.url, offset, length, this.etag);
    this.etag ??= result.etag;
    return { data: result.data };
  }
}

// Opens the archive, reusing the one already open for this URL so its header
// and directories are fetched once, not on every plan.
const archives = new Map();
export function openArchive(url) {
  if (!archives.has(url)) archives.set(url, new PMTiles(new PinnedSource(url)));
  return archives.get(url);
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

// The most tiles a plan is allowed to check. Above this, planning is too slow
// (and for very large areas, too memory-hungry) to run in the page.
export const MAX_PLAN_TILES = 50_000;

// Counts the tiles a plan for this box would have to check. Cheap: it needs
// only the archive's zoom range, which comes from the cached header.
export async function countRegionTiles(url, bbox) {
  const archive = openArchive(url);
  try {
    const header = await archive.getHeader();
    return countTiles(bbox, header.minZoom, header.maxZoom);
  } catch (error) {
    if (archives.get(url) === archive) archives.delete(url); // don't keep a failed archive
    throw error;
  }
}

// The whole planner in one call: bounding box in, plan out.
// Every offset in the plan was read from the version of the file named by
// plan.etag. If the file changes while we plan, we start over once.
export async function planRegion(url, bbox, maxChunkBytes = ONE_MB) {
  const tileCount = await countRegionTiles(url, bbox);
  if (!(tileCount <= MAX_PLAN_TILES)) {
    throw new Error(`Area too large to plan: ${tileCount} tiles, limit ${MAX_PLAN_TILES}`);
  }

  for (let attempt = 1; ; attempt++) {
    const archive = openArchive(url);
    try {
      const header = await archive.getHeader();
      const etag = archive.source.etag;
      await fetchRange(url, 0, 1, etag); // is the file still the version we have open?
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
    } catch (error) {
      // Whatever went wrong, this archive's cached pieces can't be trusted.
      if (archives.get(url) === archive) archives.delete(url);
      if (!(error instanceof FileChangedError) || attempt === 2) throw error;
    }
  }
}