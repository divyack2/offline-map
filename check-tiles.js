// sample test for now to make sure that tilesForBbox() works as expected
import { tilesForBbox } from './planner.js';

const regions = {
  'East Village':  [-73.992, 40.721, -73.972, 40.735],
  'Manhattan':     [-74.03, 40.70, -73.91, 40.88],
  'Five boroughs': [-74.26, 40.49, -73.70, 40.92],
};

for (const [name, bbox] of Object.entries(regions)) {
  const tiles = tilesForBbox(bbox, 0, 15);
  const atZ15 = tiles.filter((t) => t.z === 15).length;
  console.log(`${name}: ${tiles.length} tiles total, ${atZ15} at zoom 15`);
}