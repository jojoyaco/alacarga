import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutMapMarkers, mapMarkerGroups, mapViewport, mapPlaceName, nextGroupViewport } from '../public/location-map.js';
const demoGroups = {e800001: ['campus-norte','Campus Norte','−1B'], e800002: ['campus-norte','Campus Norte','Visitas'], e800003: ['campus-norte','Campus Norte','−2'], e800004: ['campus-sur','Campus Sur','−1'], e800005: ['campus-sur','Campus Sur','−2']};
const evsareMapGroup = key => { const value = demoGroups[key]; return value ? { id: value[0], name: value[1], label: value[2] } : null; };

test('the larger map uses valid tiles even when the world is shorter than the viewport', () => {
  const view = mapViewport([{ latitude: 43, longitude: -8 }, { latitude: -43, longitude: 171 }], 0, 0);
  assert.ok(view.tiles.length > 0);
  assert.ok(view.tiles.every(tile => tile.x === 0 && tile.y === 0 && tile.zoom === 0));
});

test('a single location stays centered on the taller map at street zoom', () => {
  const site = { latitude: 43.31, longitude: -8.51 };
  const view = mapViewport([site], 19, 19);
  const { x, y } = view.point(site);
  assert.ok(Math.abs(x - 240) < 1);
  assert.ok(Math.abs(y - 160) < 1);
});

test('pinch zoom preserves the off-center geographic anchor and respects limits', () => {
  const site = { latitude: 43.31, longitude: -8.51 };
  const anchor = { latitude: 43.311, longitude: -8.509 };
  const initial = mapViewport([site], 13, 13);
  const point = initial.point(anchor);
  const enlarged = initial.zoomAt(2, point.x, point.y);
  assert.equal(enlarged.zoom, 15);
  assert.ok(Math.abs(enlarged.point(anchor).x - point.x) < 1);
  assert.ok(Math.abs(enlarged.point(anchor).y - point.y) < 1);
  assert.equal(enlarged.zoomAt(99).zoom, 19);
  assert.equal(enlarged.zoomAt(-99).zoom, 0);
});

test('even large zoom changes keep tile loads to a single visible, bounded viewport', () => {
  const site = { latitude: 43.31, longitude: -8.51 };
  const view = mapViewport([site], 13, 13);
  for (const next of [view.zoomAt(99, 1, 2), view.zoomAt(-99, 479, 319)]) {
    assert.ok(next.tiles.length <= 9);
    assert.ok(next.tiles.every(tile => tile.zoom >= 0 && tile.zoom <= 19 &&
      tile.left < 480 && tile.left > -256 && tile.top < 320 && tile.top > -256));
  }
});

const arteixo = (name, longitude = -8.51, id = null) => ({ id, name, longitude, latitude: 43.31, mapGroup: evsareMapGroup(id) });
const tecnologia = [arteixo('Arteixo Campus Norte -1B', -8.51, 'e800001'), arteixo('Arteixo Campus Norte -1A - Visitas', -8.51, 'e800002'), arteixo('Campus Norte -2', -8.5097, 'e800003')];

test('overlapping members of the same campus use the common name; mixed nearby sites use the locality', () => {
  assert.equal(mapPlaceName(tecnologia), 'Campus Norte');
  assert.equal(mapPlaceName([...tecnologia, arteixo('Campus Sur -1', -8.51, 'e800004')]), 'Arteixo');
  assert.equal(mapPlaceName([{ latitude: 40.4, longitude: -3.7 }, { latitude: 40.42, longitude: -3.69 }]), 'Madrid');
});

test('the Arteixo family has a named local marker and retains individual street identifiers even at identical coordinates', () => {
  const overview = mapViewport(tecnologia, 13, 13);
  const groups = mapMarkerGroups(tecnologia, overview);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].identifier.name, 'Campus Norte');
  assert.deepEqual(groups[0].sites, tecnologia);
  const detail = mapViewport(tecnologia, 16, 16);
  assert.deepEqual(mapMarkerGroups(tecnologia, detail).map(marker => [marker.identifier.suffix, marker.sites.length]),
    [['−1B', 1], ['Visitas', 1], ['−2', 1]]);
});

test('unknown sites stay independent even with identical names and coordinates', () => {
  const unrelated = [arteixo('Arteixo Rotonda 1'), arteixo('Arteixo Campus Nortes 1'), arteixo('Arteixo Campus Norte'),
    arteixo('Arteixo Campus Norte3'), arteixo('Arteixo Campus Norte -1B'), arteixo('Arteixo Campus Norte 3', -8.505)];
  const sites = [...tecnologia, ...unrelated];
  const groups = mapMarkerGroups(sites, mapViewport(sites, 13, 13));
  assert.deepEqual(groups.map(marker => marker.sites), [tecnologia, ...unrelated.map(site => [site])]);
});

test('nearby reviewed groups remain distinct and filtered members never reappear', () => {
  const online = [arteixo('Campus Sur -1', -8.51, 'e800004'), arteixo('Campus Sur -2', -8.51, 'e800005')];
  const sites = [...tecnologia, ...online];
  const viewport = mapViewport(sites, 13, 13);
  assert.deepEqual(mapMarkerGroups(sites, viewport).map(marker => marker.identifier.name), ['Campus Norte', 'Campus Sur']);
  assert.deepEqual(mapMarkerGroups([online[0]], viewport)[0].sites, [online[0]]);
});

function assertAnchoredAndClear(layout, viewport, scale) {
  const centers = [];
  for (const { x, y, sites } of layout) {
    assert.ok(sites.some(site => viewport.point(site).x === x && viewport.point(site).y === y));
    assert.ok(centers.every(point => Math.abs(point.x - x) * scale >= 41.99 || Math.abs(point.y - y) * scale >= 41.99));
    centers.push({ x, y });
  }
}

test('Europe overview counts nearby locations only, at real member coordinates', () => {
  const paris = { name: 'Paris', latitude: 48.85, longitude: 2.35 };
  const warsaw = { name: 'Warsaw', latitude: 52.23, longitude: 21.01 };
  const unrelated = arteixo('Another Arteixo site');
  const sites = [...tecnologia, unrelated, paris, warsaw];
  const viewport = mapViewport(sites), scale = 320 / 480;
  const markers = layoutMapMarkers(sites, viewport, scale);
  assert.deepEqual(markers.map(({ kind, sites, identifier }) => [kind, sites, identifier]), [
    ['regional', [...tecnologia, unrelated], null], ['site', [paris], null], ['site', [warsaw], null],
  ]);
  assertAnchoredAndClear(markers, viewport, scale);
  const filtered = layoutMapMarkers([tecnologia[1], paris], viewport, scale);
  assert.deepEqual(filtered.map(({ kind, sites }) => [kind, sites]), [['site', [tecnologia[1]]], ['site', [paris]]]);
});

test('local views keep reviewed family semantics and use non-regional stacks for physical collisions', () => {
  const viewport = mapViewport(tecnologia, 13, 13);
  const family = layoutMapMarkers(tecnologia, viewport, 1);
  assert.equal(family[0].kind, 'family');
  assert.equal(family[0].identifier.name, 'Campus Norte');
  assertAnchoredAndClear(family, viewport, 1);

  const online = arteixo('Campus Sur -1', -8.51, 'e800004');
  const sites = [...tecnologia, online];
  const detail = mapViewport(sites, 19, 19), scale = .67;
  const markers = layoutMapMarkers(sites, detail, scale);
  assert.deepEqual(markers.map(({ kind, sites, identifier }) => [kind, sites, identifier?.suffix]), [
    ['stack', [tecnologia[0], tecnologia[1], online], undefined], ['site', [tecnologia[2]], '−2'],
  ]);
  assertAnchoredAndClear(markers, detail, scale);
  assert.deepEqual(layoutMapMarkers([online], detail, scale)[0].sites, [online]);
});

test('a regional cluster does not chain along a row of locations', () => {
  const spots = [{ x: 100, y: 120 }, { x: 150, y: 120 }, { x: 200, y: 120 }];
  const viewport = { zoom: 10, point: site => site };
  const markers = layoutMapMarkers(spots, viewport, 1);
  assert.deepEqual(markers.map(marker => marker.sites), [spots.slice(0, 2), spots.slice(2)]);
  assertAnchoredAndClear(markers, viewport, 1);
});

test('tapping a local stack zooms until distinct coordinates can be separated', () => {
  const sites = [arteixo('Parking oeste'), arteixo('Parking este', -8.5097)];
  const overview = mapViewport(sites, 16, 16);
  assert.equal(layoutMapMarkers(sites, overview, .75).length, 1);
  const detail = nextGroupViewport(sites, overview, .75);
  assert.ok(detail.zoom > overview.zoom);
  assert.equal(layoutMapMarkers(sites, detail, .75).length, 2);
});

test('coincident sites zoom to the maximum before falling back to the in-map selector', () => {
  const sites = [arteixo('Nivel 1'), arteixo('Nivel 2')];
  const overview = mapViewport(sites, 16, 16);
  const detail = nextGroupViewport(sites, overview, .75);
  assert.equal(detail.zoom, 19);
  assert.equal(nextGroupViewport(sites, detail, .75), null);
});
