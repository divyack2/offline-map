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