// sample test for now to make sure lookupTiles() is working as expected

import { tilesForBbox, openArchive, lookupTiles } from '../src/planner.js';

const archive = openArchive('http://localhost:9000/nyc.pmtiles');
const header = await archive.getHeader();
console.log(`File holds zoom ${header.minZoom} to ${header.maxZoom}`);

const regions = {
  'East Village':  [-73.992, 40.721, -73.972, 40.735],
  'Manhattan':     [-74.03, 40.70, -73.91, 40.88],
  'Five boroughs': [-74.26, 40.49, -73.70, 40.92],
};

console.log('File covers', header.minLon, header.minLat, header.maxLon, header.maxLat);

for (const [name, bbox] of Object.entries(regions)) {
  const wanted = tilesForBbox(bbox, header.minZoom, header.maxZoom);
  const found = await lookupTiles(archive, header, wanted);
  const bytes = found.reduce((sum, t) => sum + t.length, 0);
  console.log(
    `${name}: ${found.length} of ${wanted.length} tiles found, ` +
    `${(bytes / 1e6).toFixed(2)} MB`
  );
}