// The store: downloaded chunk bytes, kept as files in the browser's
// private folder for this site (OPFS). One folder per region, one file per chunk.

async function regionFolder(regionId, create) {
  const root = await navigator.storage.getDirectory();
  const regions = await root.getDirectoryHandle('regions', { create });
  return regions.getDirectoryHandle(regionId, { create });
}

// Saves one chunk's bytes. Safe to repeat: a second write replaces the first.
export async function writeChunk(regionId, index, data) {
  const folder = await regionFolder(regionId, true);
  const file = await folder.getFileHandle(`${index}.bin`, { create: true });
  const writer = await file.createWritable();
  await writer.write(data);
  await writer.close(); // the bytes only become the file's contents here
}

// Returns one chunk's bytes as an ArrayBuffer.
export async function readChunk(regionId, index) {
  const folder = await regionFolder(regionId, false);
  const file = await folder.getFileHandle(`${index}.bin`);
  return (await file.getFile()).arrayBuffer();
}

// Removes every file of one region. Does nothing if there are none.
export async function deleteRegionFiles(regionId) {
  try {
    const root = await navigator.storage.getDirectory();
    const regions = await root.getDirectoryHandle('regions');
    await regions.removeEntry(regionId, { recursive: true });
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
  }
}