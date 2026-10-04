import { openDB } from 'idb';

// Opens the ledger database, creating its two tables the first time.
let ledger = null;
export function openLedger() {
  ledger ??= openDB('offmap', 1, {
    upgrade(db) {
      db.createObjectStore('regions', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['regionId', 'index'] });
    },
  });
  return ledger;
}

// Writes a plan to the ledger: one region record plus one record per chunk,
// all in a single transaction. Returns the new region's id.
export async function saveRegion(plan) {
  const db = await openLedger();
  const { chunks, ...summary } = plan;
  const region = {
    ...summary,
    id: crypto.randomUUID(),
    chunkCount: chunks.length,
    status: 'downloading',
    createdAt: Date.now(),
  };

  const tx = db.transaction(['regions', 'chunks'], 'readwrite');
  const writes = [tx.objectStore('regions').add(region)];
  chunks.forEach((chunk, index) => {
    writes.push(tx.objectStore('chunks').add({ ...chunk, regionId: region.id, index, status: 'pending' }));
  });
  await Promise.all([...writes, tx.done]);
  return region.id;
}

export async function listRegions() {
  const db = await openLedger();
  return db.getAll('regions');
}

// Every chunk record of one region, in plan order.
export async function chunksForRegion(regionId) {
  const db = await openLedger();
  return db.getAll('chunks', IDBKeyRange.bound([regionId, 0], [regionId, Infinity]));
}