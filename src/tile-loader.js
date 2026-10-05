// The map's tile loader: saved tiles first, the network second.
import { PMTiles } from 'pmtiles';
import { readLocalTile } from './tile-index.js';

// Where this page's tiles have come from so far.
export const tileStats = { local: 0, network: 0, failed: 0 };

// Returns the function MapLibre calls for every tile of an offmap:// source.
export function makeTileLoader(archiveUrl) {
  let archive = new PMTiles(archiveUrl); // the network fallback

  return async (params, abortController) => {
    // params.url looks like "offmap://14/4825/6156"
    const [z, x, y] = params.url.slice('offmap://'.length).split('/').map(Number);

    const local = await readLocalTile(z, x, y).catch((error) => {
      console.warn(`Could not read saved tile ${z}/${x}/${y}`, error);
      return null; // fall back to the network
    });
    if (local) {
      tileStats.local++;
      return { data: local };
    }

    const used = archive;
    try {
      const tile = await used.getZxy(z, x, y, abortController.signal);
      tileStats.network++;
      return { data: tile ? tile.data : new Uint8Array() }; // the archive has no such tile: draw nothing
    } catch (error) {
      if (error.name !== 'AbortError') {
        tileStats.failed++;
        // The library remembers a failed read of the file's header and would keep
        // failing after the server is back. A fresh archive object starts clean.
        if (archive === used) archive = new PMTiles(archiveUrl);
      }
      throw error;
    }
  };
}