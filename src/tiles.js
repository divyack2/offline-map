// Longitude -> tile column at zoom z.
function lonToX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

// Latitude -> tile row at zoom z. Row 0 is the top (north) of the map.
function latToY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  const mercator = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return Math.floor(((1 - mercator / Math.PI) / 2) * 2 ** z);
}

function clamp(n, z) {
  return Math.max(0, Math.min(2 ** z - 1, n));
}

// The columns and rows a bbox covers at zoom z.
function tileRange([west, south, east, north], z) {
  return {
    xMin: clamp(lonToX(west, z), z),
    xMax: clamp(lonToX(east, z), z),
    yMin: clamp(latToY(north, z), z), // north edge = smaller row number
    yMax: clamp(latToY(south, z), z),
  };
}

// bbox is [west, south, east, north] in degrees.
// Returns every tile touching the box at every zoom in [minZoom, maxZoom].
export function tilesForBbox(bbox, minZoom, maxZoom) {
  const tiles = [];
  for (let z = minZoom; z <= maxZoom; z++) {
    const { xMin, xMax, yMin, yMax } = tileRange(bbox, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        tiles.push({ z, x, y });
      }
    }
  }
  return tiles;
}

// How many tiles tilesForBbox would return, worked out without building the list.
export function countTiles(bbox, minZoom, maxZoom) {
  let total = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const { xMin, xMax, yMin, yMax } = tileRange(bbox, z);
    total += (xMax - xMin + 1) * (yMax - yMin + 1);
  }
  return total;
}
