// The fetcher. Runs in a Web Worker, off the page's main thread.
import { fetchRange, FileChangedError } from './pinned-fetch.js';
import { getRegion, chunksForRegion, markChunkDone, setRegionStatus } from './ledger.js';
import { writeChunk } from './store.js';

const CONCURRENCY = 4; // how many chunks are in flight at once
const active = new Set(); // regions being downloaded right now

async function downloadRegion(regionId) {
  const region = await getRegion(regionId);
  const chunks = await chunksForRegion(regionId);
  const pending = chunks.filter((chunk) => chunk.status === 'pending');
  let done = chunks.length - pending.length;
  let failure = null;

  const report = (status, message = '') =>
    postMessage({ regionId, status, done, total: chunks.length, message });
  report('downloading');

  // One lane takes the next pending chunk, finishes it, and repeats.
  async function lane() {
    while (pending.length > 0 && !failure) {
      const chunk = pending.shift();
      try {
        const { data } = await fetchRange(region.url, chunk.offset, chunk.length, region.etag);
        if (data.byteLength !== chunk.length) throw new Error(`Chunk ${chunk.index} came back the wrong size`);
        await writeChunk(regionId, chunk.index, data); // 1. bytes first
        await markChunkDone(regionId, chunk.index); //    2. then mark done
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