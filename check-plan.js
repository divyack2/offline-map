import { planRegion } from './planner.js';

const manhattan = [-74.03, 40.70, -73.91, 40.88];
const plan = await planRegion('http://localhost:9000/nyc.pmtiles', manhattan);

console.log({ ...plan, chunks: `${plan.chunks.length} chunks` });
console.log('First chunk:', { ...plan.chunks[0], tiles: `${plan.chunks[0].tiles.length} tiles` });