// Prints the README's measurement tables, using the app's own planner on the real map file.
//
//   node scripts/measure.mjs
//
// Your tile server must be running, because the planner reads the file over HTTP like the app does.
import * as planner from '../src/planner.js';

const ARCHIVE_URL = 'http://localhost:9000/nyc.pmtiles';

// Each region is a rectangle: [west, south, east, north].
const REGIONS = {
  'East Village': [-73.992, 40.722, -73.972, 40.734],
  Manhattan: [-74.03, 40.7, -73.91, 40.88],
  'Five boroughs': [-74.26, 40.49, -73.7, 40.92],
};
const CHUNK_TABLE_REGIONS = ['Manhattan', 'Five boroughs'];
const CHUNK_SIZES = { '256 KB': 256_000, '1 MB': 1_000_000, '4 MB': 4_000_000, 'No limit': Infinity };

for (const name of ['planRegion', 'planChunks']) {
  if (typeof planner[name] !== 'function') {
    console.error(`src/planner.js does not export ${name}. It exports: ${Object.keys(planner).join(', ')}`);
    process.exit(1);
  }
}

const count = (n) => Math.round(n).toLocaleString('en-US');
const megabytes = (bytes) => (bytes / 1e6).toFixed(1);
const kilobytes = (bytes) => count(bytes / 1e3);
const sum = (numbers) => numbers.reduce((total, n) => total + n, 0);

function printTable(title, header, rows) {
  console.log(`\n${title}\n`);
  console.log(`| ${header.join(' | ')} |`);
  console.log(`| ${header.map((_, i) => (i === 0 ? '---' : '---:')).join(' | ')} |`); // numbers right-aligned
  for (const row of rows) console.log(`| ${row.join(' | ')} |`);
}

// Plan every region once, at the app's default chunk size.
const plans = {};
try {
  for (const [name, bbox] of Object.entries(REGIONS)) plans[name] = await planner.planRegion(ARCHIVE_URL, bbox);
} catch (error) {
  console.error(`Could not plan against ${ARCHIVE_URL}. Is your tile server running?\n${error.message}`);
  process.exit(1);
}

// Table 1: how big is a region?
printTable(
  'Region size (chunks of up to 1 MB)',
  ['Region', 'Tiles', 'Chunks', 'MB', 'Share of bytes at the deepest zoom'],
  Object.entries(plans).map(([name, plan]) => {
    const tiles = plan.chunks.flatMap((chunk) => chunk.tiles);
    const deepest = sum(tiles.filter((tile) => tile.z === plan.maxZoom).map((tile) => tile.length));
    return [name, count(plan.tileCount), count(plan.chunks.length), megabytes(plan.totalBytes), `${Math.round((100 * deepest) / sum(tiles.map((tile) => tile.length)))}%`];
  }),
);

// Table 2: what does the chunk size limit buy?
// A failed request loses the bytes of its own chunk, so the chunk sizes are the cost of one failure.
for (const name of CHUNK_TABLE_REGIONS) {
  const tiles = plans[name].chunks.flatMap((chunk) => chunk.tiles);
  const row = (label, sizes) => [label, count(sizes.length), kilobytes(sum(sizes) / sizes.length), kilobytes(Math.max(...sizes))];
  printTable(
    `Chunk size: ${name} (${megabytes(plans[name].totalBytes)} MB)`,
    ['Chunk size limit', 'Requests', 'Average request (KB)', 'Largest request (KB)'],
    [
      row('One request per tile', tiles.map((tile) => tile.length)),
      ...Object.entries(CHUNK_SIZES).map(([label, limit]) => row(label, planner.planChunks(tiles, limit).map((chunk) => chunk.length))),
    ],
  );
}
