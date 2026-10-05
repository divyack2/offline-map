// Fonts and icons: the saved copy first, the network second.
// Every file fetched from the network is saved, so it is there next time.
const CACHE_NAME = 'offmap-assets-v1';
const SCHEME = 'offmapasset://';

// Where this page's fonts and icons have come from so far.
export const assetStats = { local: 0, network: 0, failed: 0 };

// Returns one file as a Response, from the cache if it is there.
async function getAsset(url, signal) {
  const cache = await caches.open(CACHE_NAME);
  const saved = await cache.match(url);
  if (saved) {
    assetStats.local++;
    return saved;
  }

  let bytes;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`${url} failed with status ${response.status}`);
    bytes = await response.arrayBuffer(); // the whole file has arrived before anything is saved
  } catch (error) {
    if (error.name !== 'AbortError') assetStats.failed++;
    throw error;
  }
  assetStats.network++;
  await cache.put(url, new Response(bytes)).catch((error) => console.warn(`Could not save ${url}`, error));
  return new Response(bytes);
}

// Returns the function MapLibre calls for every offmapasset:// URL.
export function makeAssetLoader(baseUrl) {
  return async (params, abortController) => {
    const response = await getAsset(baseUrl + params.url.slice(SCHEME.length), abortController.signal);
    // MapLibre wants the icon list already parsed, and everything else as raw bytes.
    return { data: params.type === 'json' ? await response.json() : await response.arrayBuffer() };
  };
}

// Saves the given files ahead of time. Failures are ignored; the next page load tries again.
export async function saveAssets(baseUrl, paths) {
  await Promise.all(paths.map((path) => getAsset(baseUrl + path).catch(() => {})));
}