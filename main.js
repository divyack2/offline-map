import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';

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