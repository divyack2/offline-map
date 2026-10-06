# offmap

A web map you can take offline! Pan to an area, download it, and it'll show even when you have no network. The map data is one [PMTiles](https://docs.protomaps.com/pmtiles/) file on a plain file server, read with HTTP range requests. Nothing runs on the server.

The interesting part, however, is the download engine: it plans a region as a list of byte ranges, then fetches them in a way that survives a crash at any point in the process, and finally serves the result back to the map from the browser's own local storage.

## Result 1: how many requests does a region take?

A region is made up of hundreds of small "tiles". Fetching each tile separately works, but every request has fixed overhead and is one more request that can fail. Tiles that are neighbors on the map are usually neighbors in the file, so the planner takes advantage of that and joins tiles that sit back to back into one "chunked" range request, up to a size limit.

Manhattan, 18.5 MB, 395 tiles:

| Chunk size limit | Requests | Average request (KB) | Largest request (KB) |
| --- | ---: | ---: | ---: |
| One request per tile | 395 | 47 | 217 |
| 256 KB | 101 | 183 | 255 |
| **1 MB (used)** | **49** | **377** | **994** |
| 4 MB | 43 | 430 | 3,998 |
| No limit | 42 | 440 | 6,516 |

- **Joining tiles cuts requests by 8 times**, from 395 to 49.
- **Past 1 MB there is almost nothing left to gain.** Manhattan's tiles sit in 42 separate runs in the file, and the planner only joins tiles that touch, so 42 is the floor. Going from 1 MB to 4 MB saves 6 requests.
- **A bigger limit costs more per failure.** A failed request loses its whole chunk, so the largest request is the most one failure can waste. At 4 MB that is four times the 1 MB figure, for those 6 saved requests.

TODO: The same table for the five boroughs (95.5 MB, 3,677 tiles) shows 3,677 requests per tile, 99 at 1 MB, and 25 at 4 MB. As a caveat, though: the five boroughs are this entire file, so their tiles form one unbroken run. Cut from a larger file they would be broken up the way Manhattan is.

## Result 2: does a download survive being killed?

A download killed with `kill -9` at any of five points resumes to a byte-identical result, repeats at most 4 chunks of work, and still draws the map even with the network off.

| Kill point | State found on disk afterwards |
| --- | --- |
| During planning | Nothing saved |
| In the middle of a fetching a chunk's data | That chunk is not marked done, so no file for it |
| Between chunks | Exactly the finished chunks marked done |
| After a chunk's bytes are written, before it is marked done in the ledger | The file complete, its record still pending |
| During the ledger write that saves a new region | Nothing saved, though the chunk's data has been written to OPFS |

After every kill the test also checks that:

- every chunk marked done has a file whose hash matches the map file,
- no finished chunk is fetched again and each unfinished chunk is fetched exactly once,
- the repeated work is at most 4 chunks, which is the number of requests in flight at once,
- with the tile server stopped, the region draws entirely from saved tiles and every tile reads back.

The 4-chunk bound is the honest version of the guarantee. A crash can repeat the requests that were in flight. It never repeats finished work.

`test/kill-test.mjs` runs this in a real Chromium with Playwright. Breaking the app on purpose in four ways (marking before writing, splitting the transaction, re-fetching everything on resume, skipping the size check) makes it fail each time.

## How it works

- **Planner** (`src/planner.js`). Turns a rectangle/bounding box into a "plan". It figures out the tiles it covers at every zoom level, where each tile's bytes are in the PMTiles map file, and then groups those tiles into chunks. As a result, the download size shown to the user is exact, not an estimate. Every plan records the file's [ETag](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag), and every later request sends it back with `If-Match`, so a file replaced on the server mid-download fails cleanly instead of mixing two versions.
- **Ledger** (`src/ledger.js`). The plan is saved to IndexedDB in one transaction: one record for the region and one per chunk. The ledger is the only source of truth about what has been downloaded.
- **Store** (`src/store.js`). Chunk bytes are files in the browser's private file system ([OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)), one folder per region.
- **Fetcher** (`src/fetcher.js`). A Web Worker that downloads 4 chunks at a time. For each chunk it writes the bytes (to OPFS) first and marks the chunk done (ledger, in IndexedDB) second, so a crash between the two costs one repeated fetch and never a chunk marked done without its bytes. Failed requests are retried with exponential backoff and jitter. Unfinished regions restart on page load, when the device comes back online, and once a minute.
- **Serving** (`src/tile-index.js`, `src/tile-loader.js`). MapLibre asks a custom protocol for every tile. It reads the tile from the store if it is there and from the network if not, so online and offline are the same code path. Fonts and icons are cached the same way.