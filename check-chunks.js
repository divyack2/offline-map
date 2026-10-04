import { tilesForBbox, openArchive, lookupTiles, planChunks } from './planner.js';

const archive = openArchive('http://localhost:9000/nyc.pmtiles');
const header = await archive.getHeader();

const regions = {
  'East Village':  [-73.992, 40.721, -73.972, 40.735],
  'Manhattan':     [-74.03, 40.70, -73.91, 40.88],
  'Five boroughs': [-74.26, 40.49, -73.70, 40.92],
};

for (const [name, bbox] of Object.entries(regions)) {
  const wanted = tilesForBbox(bbox, header.minZoom, header.maxZoom);
  const found = await lookupTiles(archive, wanted);
  const chunks = planChunks(found);
  const bytes = chunks.reduce((sum, c) => sum + c.length, 0);
  const biggest = Math.max(...chunks.map((c) => c.length));
  console.log(
    `${name}: ${found.length} tiles -> ${chunks.length} chunks, ` +
    `${(bytes / 1e6).toFixed(2)} MB, biggest chunk ${(biggest / 1e6).toFixed(2)} MB`
  );
}