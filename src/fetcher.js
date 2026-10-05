// The fetcher. Runs in a Web Worker, off the page's main thread.
import { fetchRange, FileChangedError } from './pinned-fetch.js';
import { getRegion, chunksForRegion, markChunkDone, setRegionStatus } from './ledger.js';
import { writeChunk } from './store.js';

const CONCURRENCY = 4; // how many chunks are in flight at once
const MAX_ATTEMPTS = 8; // tries per chunk before the download stops
const BASE_DELAY_MS = 500; // the wait ceiling after the first failure
const MAX_DELAY_MS = 30_000; // the ceiling never grows past this
const active = new Set(); // regions being downloaded right now

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long to wait after failed attempt number `attempt` (1, 2, 3, ...).
// The ceiling doubles each time; the actual wait is a random point in its top half.
function backoffDelay(attempt) {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

// Resolves once the browser reports a network connection, checking once a second.
async function whenOnline() {
  while (!navigator.onLine) await sleep(1000);
}

async function downloadRegion(regionId) {
  const region = await getRegion(regionId);
  const chunks = await chunksForRegion(regionId);
  const pending = chunks.filter((chunk) => chunk.status === 'pending');
  let done = chunks.length - pending.length;
  let failure = null;

  const report = (status, message = '') =>
    postMessage({ regionId, status, done, total: chunks.length, message });
  report('downloading');

  // Fetches and saves one chunk, retrying when the failure looks temporary.
  async function downloadChunk(chunk) {
    for (let attempt = 1; ; attempt++) {
      if (!navigator.onLine) {
        report('waiting');
        await whenOnline();
      }
      if (failure) throw failure; // another lane already gave up
      try {
        const { data } = await fetchRange(region.url, chunk.offset, chunk.length, region.etag);
        if (data.byteLength !== chunk.length) throw new Error(`Chunk ${chunk.index} came back the wrong size`);
        await writeChunk(regionId, chunk.index, data); // 1. bytes first
        await markChunkDone(regionId, chunk.index); //    2. then mark done
        return;
      } catch (error) {
        const permanent = error instanceof FileChangedError || error.name === 'QuotaExceededError';
        if (permanent || attempt === MAX_ATTEMPTS) throw error;
        report('retrying', error.message);
        await sleep(backoffDelay(attempt));
      }
    }
  }

  // One lane takes the next pending chunk, finishes it, and repeats.
  async function lane() {
    while (pending.length > 0 && !failure) {
      const chunk = pending.shift();
      try {
        await downloadChunk(chunk);
        done++;
        if (!failure) report('downloading');
      } catch (error) {
        failure ??= error;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));

  if (!failure) {
    await setRegionStatus(regionId, 'complete');
    report('complete');
  } else if (failure instanceof FileChangedError) {
    await setRegionStatus(regionId, 'failed', 'The map file changed on the server.');
    report('failed', 'The map file changed on the server.');
  } else {
    report('stopped', failure.message); // the ledger still says 'downloading'
  }
}

onmessage = async (event) => {
  const { type, regionId } = event.data;
  if (type !== 'start' || active.has(regionId)) return;
  active.add(regionId);
  try {
    await downloadRegion(regionId);
  } catch (error) {
    postMessage({ regionId, status: 'stopped', done: 0, total: 0, message: error.message });
  } finally {
    active.delete(regionId);
  }
};