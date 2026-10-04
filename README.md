# offline-map
fun maps that can be viewed offline!

## How the planner works

`src/planner.js` turns a map area into a short list of byte-range requests against a `.pmtiles` archive:

1. **Bounding box → tile coordinates** (`tilesForBbox`). Takes a `[west, south, east, north]` box and lists every `{ z, x, y }` tile that touches it, at every zoom level the archive has.
2. **Tile coordinates → byte locations** (`lookupTiles`). Looks up each tile in the archive's directory, following leaf directories where needed. Each tile the archive actually contains comes back with its `offset` and `length` in the file. Tiles it doesn't have are skipped.
3. **Byte locations → chunks** (`planChunks`). Sorts the tiles by offset and merges tiles that sit back to back in the file into chunks of at most 1 MB. Each chunk is one HTTP range request.

### Chunked tile requests

Step 3 means we don't need one HTTP request per tile. Tiles that are next to each other in the archive come down together in a single range request.

Output of `node testing/check-chunks.js`:

| Region        | Tiles | Chunks | Requests saved |
|---------------|------:|-------:|---------------:|
| East Village  |    24 |     10 |    2.4× fewer |
| Manhattan     |   395 |     49 |      8× fewer |
| Five boroughs | 3,677 |     99 |     37× fewer |
