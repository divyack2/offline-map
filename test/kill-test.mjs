// The kill test. For each of five moments in a download, it starts the download, kills the
// browser at that moment, reopens it, and checks what survived and what the resume fetched.
//
//   node test/kill-test.mjs          all five
//   node test/kill-test.mjs 4 5      only the fourth and fifth
//
// Stop your own tile server first: this script runs one on the same port.
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ARCHIVE_FILE = 'data/nyc.pmtiles'; // the map file on disk
const ARCHIVE_PATH = '/nyc.pmtiles'; //     its path in ARCHIVE_URL
const TILE_PORT = 9000; //                  the port in ARCHIVE_URL
const APP_PORT = 5174; //                   not 5173, so your own dev server and its saved data are untouched
const APP_URL = `http://localhost:${APP_PORT}/`;
const PAGE_ENTRY = '/src/main.js';
const WORKER_ENTRY = '/src/fetcher.js';
const ASSET_HOST = 'https://protomaps.github.io/**';
const VIEW = { center: [-73.985, 40.755], zoom: 13 }; // the area each run downloads: midtown Manhattan
const CONCURRENCY = 4; // must match fetcher.js
const BEFORE_KILL = 5; // how many chunks are allowed to finish before the interruption

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function withTimeout(promise, ms, message) {
  return Promise.race([promise, sleep(ms).then(() => { throw new Error(message); })]);
}

// ---------------------------------------------------------------------------------------------
// The tile server. It serves byte ranges of the map file like your own server does, and can
// also stop answering, or cut one answer off halfway.
// ---------------------------------------------------------------------------------------------
const archive = fs.openSync(ARCHIVE_FILE, 'r');
const archiveStat = fs.fstatSync(archive);
const ETAG = `W/"${archiveStat.size.toString(16)}-${Math.floor(archiveStat.mtimeMs).toString(16)}"`;

function readRange(offset, length) {
  const buffer = Buffer.alloc(length);
  fs.readSync(archive, buffer, 0, length, offset);
  return buffer;
}
const hashOfRange = (offset, length) => crypto.createHash('sha256').update(readRange(offset, length)).digest('hex');

const net = new EventEmitter();
function resetNet() {
  net.removeAllListeners();
  net.holdEverything = false; // answer nothing at all
  net.downloadStarted = false; // set just before the Download click, so chunk requests can be told apart
  net.chunkBudget = Infinity; // how many more chunk requests get a full answer; the rest are held
  net.cutNextChunk = false; // answer the first chunk past the budget with only half its bytes
  net.armed = null; // the database call to freeze at, read by test/failpoints.js
}
resetNet();
const requestLog = []; // every range request: { offset, length, pinned }
const notes = []; // every retry, stop or failure the fetcher reported, with its reason
const sockets = new Set();

const tileServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, If-Match');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, Content-Range, Content-Length');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__armed') return res.end(JSON.stringify(net.armed));
  if (url.pathname === '/__note') return res.end(String(notes.push(url.searchParams.get('text'))));
  if (url.pathname === '/__freeze') return net.emit('frozen', JSON.parse(url.searchParams.get('key'))); // never answered
  if (url.pathname !== ARCHIVE_PATH) return res.writeHead(404).end();

  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
  if (!range) return res.writeHead(400).end();
  const offset = Number(range[1]);
  const length = Number(range[2]) - offset + 1;
  const pinned = Boolean(req.headers['if-match']); // the fetcher and the planner pin their requests; the map does not
  requestLog.push({ offset, length, pinned });
  if (pinned && req.headers['if-match'] !== ETAG) return res.writeHead(412).end();
  if (offset + length > archiveStat.size) return res.writeHead(416).end();

  const headers = { ETag: ETAG, 'Content-Range': `bytes ${offset}-${offset + length - 1}/${archiveStat.size}`, 'Content-Length': length };
  if (net.holdEverything) return net.emit('held');
  if (net.downloadStarted && pinned && length > 1) { // a chunk request
    if (net.chunkBudget <= 0) {
      if (!net.cutNextChunk) return net.emit('held');
      net.cutNextChunk = false;
      res.writeHead(206, headers); // promises the whole chunk...
      return res.write(readRange(offset, Math.floor(length / 2)), () => net.emit('cut', { offset, length })); // ...and sends half
    }
    net.chunkBudget--;
  }
  res.writeHead(206, headers).end(readRange(offset, length));
});
tileServer.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
const startTileServer = () => new Promise((resolve, reject) => {
  tileServer.once('error', reject);
  tileServer.listen(TILE_PORT, () => { tileServer.off('error', reject); resolve(); });
});
const stopTileServer = () => new Promise((resolve) => {
  if (!tileServer.listening) return resolve();
  tileServer.close(resolve);
  for (const socket of sockets) socket.destroy();
});

// ---------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------
function launch(profileDir) {
  return chromium.launchPersistentContext(profileDir, { // persistent: saved data lives in profileDir and outlives the browser
    headless: !process.env.HEADED,
    viewport: { width: 1200, height: 800 },
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' }),
    args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...JSON.parse(process.env.CHROME_ARGS ?? '[]')],
  });
}

// kill -9 on every process of this browser: no warning, no cleanup, nothing gets to finish.
async function killBrowser(profileDir) {
  execFileSync('pkill', ['-9', '-f', profileDir]);
  for (let i = 0; i < 50; i++) {
    try { execFileSync('pgrep', ['-f', profileDir]); } catch { return; } // pgrep fails once none are left
    await sleep(100);
  }
  throw new Error('The browser did not die');
}

async function openApp(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(APP_URL);
  await withTimeout(page.waitForFunction(() => window.map && window.tileStats), 30_000,
    `The app did not start. Check that ${PAGE_ENTRY} creates a variable named "map" and sets window.tileStats.`);
  return page;
}

// Runs `test` in the page every 200 ms until it returns something truthy.
async function waitUntil(page, test, arg, ms, message) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.evaluate(test, arg)) return;
    await sleep(200);
  }
  throw new Error(message);
}

// Waits until the map has stopped asking for tiles.
async function settle(page) {
  let last = '';
  for (let quiet = 0; quiet < 4;) {
    await sleep(250);
    const now = await page.evaluate(() => JSON.stringify(window.tileStats) + window.map.areTilesLoaded());
    quiet = now === last && now.endsWith('true') ? quiet + 1 : 0;
    last = now;
  }
}

async function goToView(page) {
  await page.evaluate((view) => window.map.jumpTo(view), VIEW);
  await settle(page);
}

// Clicks "Download this area". Resolves once the popup offers Download, with the popup's text.
async function openPopup(page) {
  await page.click('#download');
  await page.waitForSelector('#confirm-download:not([hidden])', { timeout: 30_000 });
  return page.textContent('#estimate');
}

// Reads the ledger and the store: every region, every chunk's status, and a hash of every chunk file.
function readState(page) {
  return page.evaluate(async () => {
    const { openLedger, listRegions, chunksForRegion } = await import('/src/ledger.js');
    const root = await navigator.storage.getDirectory();
    const hash = async (buffer) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

    const regions = [];
    for (const region of await listRegions()) {
      const chunks = [];
      for (const chunk of await chunksForRegion(region.id)) {
        let file = null;
        try {
          const folder = await (await root.getDirectoryHandle('regions')).getDirectoryHandle(region.id);
          const bytes = await (await (await folder.getFileHandle(`${chunk.index}.bin`)).getFile()).arrayBuffer();
          file = { length: bytes.byteLength, hash: await hash(bytes) };
        } catch { /* no file for this chunk */ }
        chunks.push({ index: chunk.index, offset: chunk.offset, length: chunk.length, status: chunk.status, file });
      }
      const entries = [];
      try {
        const folder = await (await root.getDirectoryHandle('regions')).getDirectoryHandle(region.id);
        for await (const [name, handle] of folder.entries()) entries.push(`${name}:${(await handle.getFile()).size}`);
      } catch { /* no folder */ }
      regions.push({ id: region.id, status: region.status, chunks, entries });
    }
    const folders = [];
    try {
      for await (const name of (await root.getDirectoryHandle('regions')).keys()) folders.push(name);
    } catch { /* no regions folder yet */ }
    return { regions, chunkRecords: await (await openLedger()).count('chunks'), folders };
  });
}

// Opens the site WITHOUT starting the app, so the saved state can be read before anything resumes.
async function inspect(context) {
  const page = context.pages()[0] ?? (await context.newPage());
  await context.route(`**${PAGE_ENTRY}*`, (route) => route.abort());
  await page.goto(APP_URL);
  const state = await readState(page);
  await context.unroute(`**${PAGE_ENTRY}*`);
  return state;
}

// ---------------------------------------------------------------------------------------------
// The five interruptions. Each `interrupt` resolves at the moment the browser should die.
// Each `survivors` checks the state found on disk afterwards.
// ---------------------------------------------------------------------------------------------
const nothingSaved = (state, check) => {
  check('no region was saved', state.regions.length === 0, `${state.regions.length} regions`);
  check('no chunk records were saved', state.chunkRecords === 0, `${state.chunkRecords} records`);
  check('no chunk files were saved', state.folders.length === 0, `${state.folders.length} folders`);
};

const scenarios = [
  {
    name: 'During planning',
    async interrupt(page) {
      net.holdEverything = true; // the planner's requests get no answer, so planning is stuck halfway
      const held = new Promise((resolve) => net.once('held', resolve));
      page.click('#download').catch(() => {});
      await held;
      await sleep(300);
    },
    survivors: nothingSaved,
  },
  {
    name: "In the middle of a chunk's fetch",
    async interrupt(page) {
      net.chunkBudget = BEFORE_KILL;
      net.cutNextChunk = true;
      const cut = new Promise((resolve) => net.once('cut', resolve));
      await openPopup(page);
      net.downloadStarted = true;
      await page.click('#confirm-download');
      const chunk = await cut;
      await sleep(300); // let the half-answer reach the browser
      return chunk;
    },
    survivors(state, check, cutChunk) {
      const chunk = state.regions[0]?.chunks.find((c) => c.offset === cutChunk.offset);
      check('the half-fetched chunk is not marked done', chunk?.status === 'pending', chunk?.status);
      check('the half-fetched chunk left no file', chunk?.file === null, JSON.stringify(chunk?.file));
    },
  },
  {
    name: 'Between chunks',
    async interrupt(page) {
      net.chunkBudget = BEFORE_KILL;
      await openPopup(page);
      net.downloadStarted = true;
      await page.click('#confirm-download');
      // Wait until exactly BEFORE_KILL chunks are marked done and every other request is being held.
      await waitUntil(page, async (wanted) => {
        const { listRegions, chunksForRegion } = await import('/src/ledger.js');
        const [region] = await listRegions();
        return Boolean(region) && (await chunksForRegion(region.id)).filter((chunk) => chunk.status === 'done').length === wanted;
      }, BEFORE_KILL, 30_000, `The download never reached ${BEFORE_KILL} finished chunks`);
    },
    survivors(state, check) {
      const done = state.regions[0]?.chunks.filter((c) => c.status === 'done').length;
      check(`exactly ${BEFORE_KILL} chunks are marked done`, done === BEFORE_KILL, `${done} done`);
    },
  },
  {
    name: 'After bytes are written, before the chunk is marked done',
    // In the worker, markChunkDone begins by reading the chunk's record. Freeze there:
    // the chunk's bytes are already saved and its record still says pending.
    armed: { where: 'worker', method: 'get', store: 'chunks', skip: BEFORE_KILL },
    async interrupt(page) {
      const frozen = new Promise((resolve) => net.once('frozen', resolve));
      await openPopup(page);
      net.downloadStarted = true;
      await page.click('#confirm-download');
      return frozen; // resolves with [region id, chunk index]
    },
    survivors(state, check, [, index]) {
      const chunk = state.regions[0]?.chunks.find((c) => c.index === index);
      check('that chunk is not marked done', chunk?.status === 'pending', chunk?.status);
      const whole = chunk?.file?.length === chunk?.length && chunk?.file?.hash === hashOfRange(chunk.offset, chunk.length);
      check('that chunk\'s file is complete and correct, so the kill landed between the write and the mark', whole, JSON.stringify(chunk?.file));
    },
  },
  {
    name: 'During the ledger write',
    // On the page, saveRegion adds the region and every chunk record in one transaction.
    // Freeze partway through the chunk records, with the transaction still open.
    armed: { where: 'page', method: 'add', store: 'chunks', skip: BEFORE_KILL },
    async interrupt(page) {
      const frozen = new Promise((resolve) => net.once('frozen', resolve));
      await openPopup(page);
      net.downloadStarted = true;
      page.click('#confirm-download').catch(() => {}); // the page freezes inside this click, so don't wait for it
      await frozen;
    },
    survivors: nothingSaved,
  },
];

// ---------------------------------------------------------------------------------------------
// One run: interrupt, kill, look at what survived, reopen, let it finish, go offline.
// ---------------------------------------------------------------------------------------------
async function run(scenario, number) {
  const results = [];
  const check = (what, ok, found = '') => results.push({ what, ok: Boolean(ok), found });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offmap-kill-'));
  resetNet();
  net.armed = scenario.armed ?? null;
  requestLog.length = 0;
  await startTileServer();
  let context;

  try {
    // 1. Start a download and kill the browser at the chosen moment.
    context = await launch(profileDir);
    let page = await openApp(context);
    await goToView(page);
    const detail = await withTimeout(scenario.interrupt(page), 60_000, 'The download never reached this moment');
    await killBrowser(profileDir);
    // The browser's last requests can still be sitting unread in this script's sockets, because
    // killBrowser blocks the script while it runs. Let them be logged before drawing the line.
    await sleep(500);
    const requestsBeforeKill = requestLog.splice(0);
    notes.length = 0;

    // 2. Reopen the browser and read what survived, before the app runs.
    resetNet();
    context = await launch(profileDir);
    const atKill = await inspect(context);
    scenario.survivors(atKill, check, detail);
    if (process.env.DEBUG && atKill.regions[0]) {
      const r = atKill.regions[0];
      console.log('   [debug] at kill: ' + r.chunks.map((c) => `${c.index}${c.status === 'done' ? 'D' : 'p'}${c.file ? (c.file.length === c.length ? 'F' : 'f') : ''}`).join(' '));
      console.log('   [debug] folder: ' + r.entries.join(' ') + ' | requested before kill: ' + requestsBeforeKill.filter((q) => q.pinned && q.length > 1).length + ' | frozen at ' + JSON.stringify(detail));
    }
    const savedRegion = atKill.regions[0];
    if (savedRegion) {
      check('the region is still marked as downloading', savedRegion.status === 'downloading', savedRegion.status);
      const broken = savedRegion.chunks.filter((c) => c.status === 'done' && c.file?.hash !== hashOfRange(c.offset, c.length));
      check('every chunk marked done has its complete, correct file', broken.length === 0, `${broken.length} broken`);
    }

    // 3. Start the app and let it finish. A saved region resumes by itself; otherwise download again.
    page = await openApp(context);
    if (!savedRegion) {
      await sleep(2000);
      const resumed = requestLog.filter((r) => r.pinned && r.length > 1).length;
      check('nothing was resumed', resumed === 0, `${resumed} requests`);
      await goToView(page);
      await openPopup(page);
      await page.click('#confirm-download');
    }
    await waitUntil(page, async () => {
      const { listRegions } = await import('/src/ledger.js');
      const regions = await listRegions();
      return regions.length === 1 && regions[0].status === 'complete';
    }, null, 120_000, 'The download did not complete after the browser was reopened');

    const atEnd = await readState(page);
    const chunks = atEnd.regions[0].chunks;
    if (process.env.DEBUG) console.log('   [debug] folder at end: ' + atEnd.regions[0].entries.filter((e) => !/^\d+\.bin:[1-9]/.test(e)).join(' ') + ' (' + atEnd.regions[0].entries.length + ' entries)');
    const wrong = chunks.filter((c) => c.status !== 'done' || c.file?.hash !== hashOfRange(c.offset, c.length));
    check(`all ${chunks.length} chunks are done and their files match the map file byte for byte`, wrong.length === 0, `${wrong.length} wrong`);

    // What did the resume fetch? Compare the server's request log with the state at the kill.
    const key = (r) => `${r.offset}:${r.length}`;
    const timesFetched = (log, chunk) => log.filter((r) => r.pinned && key(r) === key(chunk)).length;
    const doneAtKill = (savedRegion?.chunks ?? []).filter((c) => c.status === 'done');
    const pendingAtKill = chunks.filter((c) => !doneAtKill.some((d) => d.index === c.index));
    const refetchedDone = doneAtKill.filter((c) => timesFetched(requestLog, c) > 0).length;
    const notOnce = pendingAtKill.filter((c) => timesFetched(requestLog, c) !== 1);
    const inFlight = pendingAtKill.filter((c) => timesFetched(requestsBeforeKill, c) > 0).length;
    check(`none of the ${doneAtKill.length} finished chunks was fetched again`, refetchedDone === 0, `${refetchedDone} fetched again`);
    check(`each of the ${pendingAtKill.length} unfinished chunks was fetched exactly once`, notOnce.length === 0,
      notOnce.map((c) => `chunk ${c.index} fetched ${timesFetched(requestLog, c)} times`).join(', '));
    check('the resume needed no retries', notes.length === 0, notes.join(' | '));
    check(`work repeated: ${inFlight} chunks that were in flight at the kill (limit ${CONCURRENCY})`, inFlight <= CONCURRENCY, `${inFlight}`);

    // 4. Network off: stop the tile server, block the font and icon host, reload, and look at the region.
    await stopTileServer();
    await context.route(ASSET_HOST, (route) => route.abort());
    page = await openApp(context);
    await settle(page);
    const before = await page.evaluate(() => ({ ...window.tileStats }));
    await goToView(page);
    const after = await page.evaluate(() => ({ ...window.tileStats }));
    const drawn = { local: after.local - before.local, network: after.network - before.network, failed: after.failed - before.failed };
    check('offline, the region draws entirely from saved tiles', drawn.local > 0 && drawn.network === 0 && drawn.failed === 0, JSON.stringify(drawn));
    const readable = await page.evaluate(async () => {
      const { listRegions, chunksForRegion } = await import('/src/ledger.js');
      const { buildIndex, readLocalTile } = await import('/src/tile-index.js');
      await buildIndex();
      const count = { tiles: 0, unreadable: 0 };
      for (const region of await listRegions()) {
        for (const chunk of await chunksForRegion(region.id)) {
          for (const tile of chunk.tiles) {
            count.tiles++;
            if (!(await readLocalTile(tile.z, tile.x, tile.y))) count.unreadable++;
          }
        }
      }
      return count;
    });
    check(`offline, all ${readable.tiles} tiles of the region read back from the store`, readable.tiles > 0 && readable.unreadable === 0, `${readable.unreadable} unreadable`);
    await page.screenshot({ path: `test/kill-test-${number}-offline.png` });
  } catch (error) {
    check('the run finished', false, error.message.split('\n')[0]);
  } finally {
    await context?.close().catch(() => {});
    await stopTileServer();
    try { execFileSync('pkill', ['-9', '-f', profileDir]); } catch { /* already gone */ }
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
// Serve the app with two test-only additions: load the freeze hook into the page and the worker,
// and put the map object on `window` so this script can move it. Your files are not changed.
const vite = await createViteServer({
  server: { port: APP_PORT, strictPort: true, forwardConsole: false },
  cacheDir: 'node_modules/.vite-kill-test',
  logLevel: 'error',
  plugins: [{
    name: 'kill-test-hooks',
    transform(code, id) {
      const file = id.split('?')[0];
      if (file.endsWith(PAGE_ENTRY)) return `import '/test/failpoints.js';\n${code}\nwindow.map = map;\n`;
      if (file.endsWith(WORKER_ENTRY)) return `import '/test/failpoints.js';\n${code}`;
    },
  }],
});
await vite.listen();

let failures = 0;
try {
  try {
    await startTileServer();
  } catch (error) {
    throw new Error(`Port ${TILE_PORT} is in use. Stop your tile server and run this again. (${error.code})`);
  }

  // A practice load: lets Vite prepare its files, and shows what each run will download.
  const practiceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offmap-kill-'));
  const practice = await launch(practiceDir);
  const page = await openApp(practice);
  await goToView(page);
  console.log(`Each run downloads: ${await openPopup(page)}`);
  await practice.close();
  fs.rmSync(practiceDir, { recursive: true, force: true });
  await stopTileServer();

  const wanted = process.argv.slice(2).map(Number);
  let ran = 0;
  for (const [index, scenario] of scenarios.entries()) {
    if (wanted.length > 0 && !wanted.includes(index + 1)) continue;
    ran++;
    console.log(`\n${index + 1}. ${scenario.name}`);
    for (const { what, ok, found } of await run(scenario, index + 1)) {
      if (!ok) failures++;
      console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !found ? '' : ` (found: ${found})`}`);
    }
  }
  console.log(failures === 0 ? `\nAll ${ran} interruptions passed.` : `\n${failures} checks failed.`);
} catch (error) {
  failures++;
  console.error(`\nThe kill test could not run: ${error.message}`);
} finally {
  await stopTileServer();
  await vite.close();
}
process.exit(failures === 0 ? 0 : 1);
