import { tilesForBbox, countTiles } from './tiles.js';
import { FileChangedError, fetchRange } from './pinned-fetch.js';
import { openArchive, forgetArchive, archiveEtag, lookupTiles } from './archive.js';
import { planChunks, ONE_MB } from './chunks.js';

// The building blocks, for callers that run the steps one at a time.
export { tilesForBbox, countTiles, openArchive, lookupTiles, planChunks };

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
    forgetArchive(url, archive); // don't keep a failed archive
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
      const etag = archiveEtag(archive);
      await fetchRange(url, 0, 1, etag); // is the file still the version we have open?
      const wanted = tilesForBbox(bbox, header.minZoom, header.maxZoom);
      const found = await lookupTiles(archive, header, wanted);
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
      forgetArchive(url, archive);
      if (!(error instanceof FileChangedError) || attempt === 2) throw error;
    }
  }
}
