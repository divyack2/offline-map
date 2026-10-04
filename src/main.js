import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { planRegion, countRegionTiles, MAX_PLAN_TILES } from './planner.js';
import { saveRegion } from './ledger.js';

// Any URL starting with pmtiles:// is now handled by the PMTiles library.
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const map = new maplibregl.Map({
  container: 'map',
  center: [-73.98, 40.75],
  zoom: 11,
  style: {
    version: 8,
    glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles://http://localhost:9000/nyc.pmtiles',
        attribution: '© OpenStreetMap',
      },
    },
    layers: layers('protomaps', namedFlavor('light'), { lang: 'en' }),
  },
});

map.addControl(new maplibregl.NavigationControl());

const ARCHIVE_URL = 'http://localhost:9000/nyc.pmtiles';
const MAX_REGION_BYTES = 50_000_000; // placeholder; milestone 5 replaces it

const statusEl = document.getElementById('status');
const downloadEl = document.getElementById('download');
const dialogEl = document.getElementById('confirm');
const estimateEl = document.getElementById('estimate');
const confirmEl = document.getElementById('confirm-download');
const closeEl = document.getElementById('confirm-close');
let currentPlan = null;
let latestRequest = 0;

function megabytes(bytes) {
  return (bytes / 1e6).toFixed(1) + ' MB';
}

// The area the map is showing, as [west, south, east, north].
function viewBbox() {
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

// Runs after every map move. It only counts tiles; no plan is made here.
async function updatePanel() {
  let count;
  try {
    count = await countRegionTiles(ARCHIVE_URL, viewBbox());
  } catch (error) {
    statusEl.textContent = 'Could not reach the map server.';
    downloadEl.hidden = true;
    console.error(error);
    return;
  }
  const smallEnough = count <= MAX_PLAN_TILES;
  statusEl.textContent = smallEnough ? 'This area can be downloaded.' : 'Zoom in to download an area.';
  downloadEl.hidden = !smallEnough;
}

map.on('moveend', updatePanel);
updatePanel();

// Clicking Download makes the plan and shows its size in a popup.
downloadEl.addEventListener('click', async () => {
  const requestId = ++latestRequest;
  currentPlan = null;
  confirmEl.hidden = true;
  estimateEl.textContent = 'Measuring…';
  dialogEl.showModal();

  let plan;
  try {
    plan = await planRegion(ARCHIVE_URL, viewBbox());
  } catch (error) {
    if (requestId === latestRequest) estimateEl.textContent = 'Could not measure this area.';
    console.error(error);
    return;
  }
  if (requestId !== latestRequest || !dialogEl.open) return; // the popup was closed meanwhile

  const summary = `${megabytes(plan.totalBytes)} (${plan.tileCount} tiles, ${plan.chunks.length} chunks)`;
  const hasDetail = plan.chunks.some((chunk) => chunk.tiles.some((tile) => tile.z === plan.maxZoom));
  if (!hasDetail) {
    estimateEl.textContent = 'No detailed map data in this area.';
  } else if (plan.totalBytes > MAX_REGION_BYTES) {
    estimateEl.textContent = `This area is ${summary}. The download limit is ${megabytes(MAX_REGION_BYTES)}, so zoom in.`;
  } else {
    estimateEl.textContent = `This area is ${summary}.`;
    currentPlan = plan;
    confirmEl.hidden = false;
  }
});

closeEl.addEventListener('click', () => dialogEl.close());

confirmEl.addEventListener('click', async () => {
  const regionId = await saveRegion(currentPlan);
  console.log('Saved region', regionId);
  dialogEl.close();
});