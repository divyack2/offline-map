import { PMTiles, zxyToTileId, findTile } from 'pmtiles';
import { PinnedSource } from './pinned-fetch.js';

// Opens the archive, reusing the one already open for this URL so its header
// and directories are fetched once, not on every plan.
const archives = new Map();
export function openArchive(url) {
  if (!archives.has(url)) archives.set(url, new PMTiles(new PinnedSource(url)));
  return archives.get(url);
}

// Drops a cached archive whose pieces can't be trusted, unless it has
// already been replaced by a newer one.
export function forgetArchive(url, archive) {
  if (archives.get(url) === archive) archives.delete(url);
}

// The version of the file this archive has been reading, or null before
// its first read.
export function archiveEtag(archive) {
  return archive.source.etag;
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
export async function lookupTiles(archive, header, tiles) {
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
