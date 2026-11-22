import { validCoordinates } from './proximity.js';

// Deployment: allow TILE_ORIGIN in img-src in both the HTTP and HTML CSPs.
// These are native images: browser HTTP cache only, no service-worker caching,
// app credentials, geocoder, telemetry or prefetch. Request only visible tiles
// after an explicit map action, and never exceed MAX_ZOOM.
// https://operations.osmfoundation.org/policies/tiles/
// https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
const TILE_ORIGIN = 'https://tile.openstreetmap.org';
const TILE_SIZE = 256, WIDTH = 480, HEIGHT = 320, OVERVIEW_ZOOM = 13, MAX_ZOOM = 19, PADDING = 44;
const REGIONAL_ZOOM = 12, DETAIL_ZOOM = 16;
// Match the 36px marker body plus room for its focus outline (CSS pixels).
const PIN_CLEARANCE = 42, REGIONAL_CLEARANCE = 54;
const wrap = (value, range) => ((value % range) + range) % range;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function project(site) {
  if (!validCoordinates(site) || Math.abs(site.latitude) > 85.05112878) return null;
  const radians = site.latitude * Math.PI / 180;
  return { x: wrap((site.longitude + 180) / 360, 1), y: clamp((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2, 0, 1) };
}

export function mapViewport(sites, minZoom = 0, maxZoom = MAX_ZOOM) {
  const points = sites.map(project).filter(Boolean);
  if (!points.length) return null;
  const xs = points.map(({ x }) => x).sort((a, b) => a - b);
  // Place the longitudinal seam in the largest gap to handle the antimeridian.
  let seam = xs[0], maxGap = xs[0] + 1 - xs.at(-1);
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] - xs[i - 1] > maxGap) { seam = xs[i]; maxGap = xs[i] - xs[i - 1]; }
  }
  let right = 0, top = 1, bottom = 0;
  for (const point of points) {
    right = Math.max(right, wrap(point.x - seam, 1));
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  let zoom = maxZoom;
  while (zoom > minZoom && (right * TILE_SIZE * 2 ** zoom > WIDTH - 2 * PADDING ||
    (bottom - top) * TILE_SIZE * 2 ** zoom > HEIGHT - 2 * PADDING)) zoom--;
  return centeredViewport(seam + right / 2, (top + bottom) / 2, zoom);
}

function centeredViewport(centerX, centerY, zoom) {
  const count = 2 ** zoom, world = TILE_SIZE * count;
  const left = Math.round(centerX * world - WIDTH / 2);
  const upper = world < HEIGHT ? Math.floor((world - HEIGHT) / 2) : clamp(Math.round(centerY * world - HEIGHT / 2), 0, world - HEIGHT);
  const tiles = [];
  for (let y = Math.max(0, Math.floor(upper / TILE_SIZE)); y < Math.min(count, Math.ceil((upper + HEIGHT) / TILE_SIZE)); y++) {
    for (let x = Math.floor(left / TILE_SIZE); x < Math.ceil((left + WIDTH) / TILE_SIZE); x++) {
      tiles.push({ zoom, x: wrap(x, count), y, left: x * TILE_SIZE - left, top: y * TILE_SIZE - upper });
    }
  }
  return {
    tiles, zoom, key: `${zoom}/${left}/${upper}`,
    zoomAt(delta, x = WIDTH / 2, y = HEIGHT / 2) {
      const next = clamp(zoom + delta, 0, MAX_ZOOM);
      if (next === zoom) return this;
      const newWorld = TILE_SIZE * 2 ** next;
      return centeredViewport(wrap((left + x) / world + (WIDTH / 2 - x) / newWorld, 1),
        (upper + y) / world + (HEIGHT / 2 - y) / newWorld, next);
    },
    point(site) {
      const position = project(site);
      if (!position) return null;
      return { x: (centerX + wrap(position.x - centerX + .5, 1) - .5) * world - left, y: position.y * world - upper };
    },
  };
}

function place(node, x, y) {
  // Individual DOM style properties do not need unsafe-inline in the CSP.
  node.style.left = `${x / WIDTH * 100}%`;
  node.style.top = `${y / HEIGHT * 100}%`;
}

function siteIdentifier(site) {
  const group = site.mapGroup;
  if (!group?.id || !group.name || !group.label) return null;
  return { key: group.id, name: group.name, suffix: group.label };
}

export function mapMarkerGroups(sites, viewport, groupFamilies = true) {
  if (!viewport) return [];
  const groups = [], families = new Map();
  for (const site of sites) {
    const point = viewport.point(site);
    if (!point || point.x < -1 || point.x > WIDTH + 1 || point.y < -1 || point.y > HEIGHT + 1) continue;
    const identifier = siteIdentifier(site);
    const grouped = groupFamilies && identifier && viewport.zoom < DETAIL_ZOOM;
    const family = grouped ? families.get(identifier.key) : null;
    if (family) {
      family.marker.sites.push(site);
      family.points.push(point);
    } else {
      const marker = { ...point, sites: [site], identifier };
      groups.push(marker);
      if (grouped) families.set(identifier.key, { marker, points: [point] });
    }
  }
  for (const { marker, points } of families.values()) {
    // Use the member nearest the center, not an invented point between sites.
    const center = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
    const distance = point => (point.x - center.x) ** 2 + (point.y - center.y) ** 2;
    Object.assign(marker, points.reduce((best, point) => distance(point) < distance(best) ? point : best));
  }
  return groups;
}

export function layoutMapMarkers(sites, viewport, scale) {
  if (!viewport) return [];
  const regional = viewport.zoom < REGIONAL_ZOOM;
  const clearance = (regional ? REGIONAL_CLEARANCE : PIN_CLEARANCE) / scale;
  const layout = [];
  // Visual clusters are transient and anchored at a member. Do not expand a
  // cluster's radius via its members or let screen proximity imply a family.
  for (const marker of mapMarkerGroups(sites, viewport, !regional)) {
    const collision = layout.find(({ x, y }) => Math.abs(x - marker.x) < clearance && Math.abs(y - marker.y) < clearance);
    if (collision) {
      collision.sites.push(...marker.sites);
      collision.identifier = null;
      collision.kind = regional ? 'regional' : 'stack';
    } else {
      const kind = marker.sites.length > 1 ? 'family' : 'site';
      layout.push({ ...marker, identifier: regional ? null : marker.identifier, kind });
    }
  }
  return layout;
}

export function nextGroupViewport(sites, viewport, scale, visibleSites = sites) {
  const fit = mapViewport(sites);
  if (!viewport || sites.length < 2 || !fit || fit.zoom <= viewport.zoom) return null;
  const wanted = new Set(sites);
  let fallback = null;
  for (let zoom = viewport.zoom + 1; zoom <= fit.zoom; zoom++) {
    const next = mapViewport(sites, zoom, zoom);
    const markers = layoutMapMarkers(visibleSites, next, scale).filter(marker => marker.sites.some(site => wanted.has(site)));
    const covered = markers.reduce((count, marker) => count + marker.sites.filter(site => wanted.has(site)).length, 0);
    if (covered !== sites.length) continue;
    if (markers.length > 1) return next;
    fallback = next;
  }
  return fallback;
}

export function mapPlaceName(sites) {
  if (!sites.length) return '';
  const group = sites[0].mapGroup;
  if (group && sites.every(site => site.mapGroup?.id === group.id)) return group.name;
  const places = [
    ['Arteixo', 43.26, 43.36, -8.59, -8.44], ['A Coruña', 43.18, 43.40, -8.62, -8.25],
    ['Madrid', 40.08, 40.72, -4.04, -3.20], ['Zaragoza', 41.48, 41.81, -1.20, -.71],
    ['Barcelona', 41.11, 41.82, 1.65, 2.88], ['Valencia', 38.99, 39.69, -.75, -.09],
    ['Alicante', 38.05, 38.69, -.91, -.16], ['Bilbao', 43.14, 43.41, -3, -2.72],
    ['Asturias', 43.1, 43.7, -7.2, -4.45], ['Galicia', 41.79, 43.82, -9.33, -6.74],
  ];
  for (const [name, south, north, west, east] of places) {
    if (sites.every(s => s.latitude >= south && s.latitude <= north && s.longitude >= west && s.longitude <= east)) return name;
  }
  if (sites.some(s => /^arteixo-/i.test(s.mapGroup?.id ?? '')) && sites.filter(s => s.latitude >= 43.26 && s.latitude <= 43.36 && s.longitude >= -8.59 && s.longitude <= -8.44).length > sites.length / 2) return 'Arteixo y alrededores';
  return '';
}

function shortPlaceName(site) {
  const id = siteIdentifier(site);
  if (id) return `${id.name} · ${id.suffix}`;
  return site.name;
}

export function createLocationMap({ base, canvas, tiles, markers, status, overview, zoomIn, zoomOut, group, groupHeading, groupClose, members, select, siteItem }) {
  let viewport = null, current = [], selected = null, loaded = 0, failed = 0, shown = 0;
  let expanded = [];
  let suppressTapUntil = 0;
  const sameSites = (a, b) => a.length === b.length && a.every((site, i) => site === b[i]);
  const pressed = () => {
    for (const marker of markers.children) {
      const { sites } = marker;
      if (sites.length === 1) marker.setAttribute('aria-pressed', String(sites.includes(selected)));
      else marker.setAttribute('aria-expanded', String(sameSites(sites, expanded)));
      marker.dataset.selected = String(sites.includes(selected));
    }
    for (const item of members.children) item.firstElementChild.setAttribute('aria-pressed', String(item.firstElementChild.chargerSite === selected));
  };
  function positionMembers(anchor) {
    if (group.hidden || !anchor) return;
    const frame = base.getBoundingClientRect(), map = canvas.getBoundingClientRect(), pin = anchor.getBoundingClientRect();
    const inset = 6, gap = 7;
    const above = pin.top - map.top - gap, below = map.bottom - pin.bottom - gap;
    const side = above > below ? 'above' : 'below';
    // Prefer the marker's side with more space; an edge marker must not push the chooser off the map.
    group.style.maxHeight = `${Math.max(0, Math.min(192, map.height - inset * 2))}px`;
    const popup = group.getBoundingClientRect();
    group.style.left = `${clamp(pin.left + pin.width / 2 - frame.left - popup.width / 2, inset, Math.max(inset, map.right - frame.left - popup.width - inset))}px`;
    group.style.top = `${clamp((side === 'above' ? pin.top - popup.height - gap : pin.bottom + gap) - frame.top, map.top - frame.top + inset,
      Math.max(map.top - frame.top + inset, map.bottom - frame.top - popup.height - inset))}px`;
  }
  function showMembers(sites = [], anchor = null) {
    expanded = sites;
    group.hidden = !sites.length;
    groupHeading.textContent = mapPlaceName(sites) || 'Elegir ubicación';
    const common = sites[0]?.mapGroup;
    members.replaceChildren(...sites.map(site => {
      const item = siteItem(site);
      const button = item.firstElementChild;
      if (common && sites.every(s => s.mapGroup?.id === common.id)) {
        button.firstElementChild.textContent = site.mapGroup.label;
        button.setAttribute('aria-label', `${common.name} · ${site.mapGroup.label}`);
      }
      button.addEventListener('click', () => {
        showMembers();
        overview.hidden = false;
        setViewport(mapViewport([site], MAX_ZOOM));
        select(site);
        draw().find(pin => pin.sites.includes(site))?.focus({ preventScroll: true });
      });
      return item;
    }));
    positionMembers(anchor);
    pressed();
  }
  function closeMembers() {
    const marker = [...markers.children].find(pin => sameSites(pin.sites, expanded));
    showMembers();
    (marker || overview).focus({ preventScroll: true });
  }
  groupClose.addEventListener('click', closeMembers);
  group.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeMembers(); } });
  function updateStatus() {
    const hasCoordinates = current.some(project);
    canvas.hidden = base.hidden = !viewport || !hasCoordinates;
    zoomIn.disabled = !viewport || viewport.zoom >= MAX_ZOOM;
    zoomOut.disabled = !viewport || viewport.zoom <= 0;
    if (!viewport) overview.hidden = !hasCoordinates;
    const message = !current.length ? '' : !hasCoordinates
      ? 'Estas ubicaciones no tienen coordenadas para el mapa. Usa la lista.'
      : !viewport || !shown
      ? 'No hay marcadores en este encuadre. Vuelve al mapa general o usa la lista.'
      : loaded === 0 && failed === viewport.tiles.length ? 'No se pudo cargar OpenStreetMap. Los marcadores y la lista siguen disponibles.'
      : loaded === 0 ? 'Cargando OpenStreetMap…'
      : failed ? 'El mapa no se ha cargado por completo. Puedes usar la lista.'
      : shown < current.length ? 'Las demás ubicaciones siguen disponibles en la lista.' : '';
    if (status.textContent !== message) status.textContent = message;
  }
  function labelMarkers() {
    const buttons = [...markers.children];
    for (const button of buttons) button.querySelector('.charger-map-label')?.remove();
    if (!viewport || !canvas.clientWidth) return;
    const rect = canvas.getBoundingClientRect();
    const obstacles = buttons.map(button => ({ button, rect: button.getBoundingClientRect() }));
    const overlaps = (a, b) => a.left < b.right + 4 && a.right > b.left - 4 && a.top < b.bottom + 3 && a.bottom > b.top - 3;
    const priority = button => button.sites.includes(selected) ? 1000 : button.sites.length;
    const ordered = [...buttons].sort((a, b) => priority(b) - priority(a));
    const usedLabels = new Set();
    for (const button of ordered) {
      if (!button.labelText) continue;
      const key = button.labelText.normalize('NFC').trim().toLocaleLowerCase('es');
      if (usedLabels.has(key)) continue;
      const label = document.createElement('span');
      label.className = 'charger-map-label';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = button.labelText;
      button.append(label);
      let placed = false;
      for (const side of ['above', 'below', 'right', 'left']) {
        label.dataset.side = side;
        const box = label.getBoundingClientRect();
        if (box.top < rect.top || box.bottom > rect.bottom || box.left < rect.left || box.right > rect.right ||
            obstacles.some(o => o.button !== button && overlaps(box, o.rect))) continue;
        obstacles.push({ button: null, rect: box });
        placed = true;
        break;
      }
      if (!placed) label.remove();
      else usedLabels.add(key);
    }
  }
  function draw() {
    const previousFocus = markers.contains(document.activeElement) ? document.activeElement.sites : null;
    // Make the canvas measurable when opening the map from a hidden state.
    if (viewport && base.hidden && current.some(project)) canvas.hidden = base.hidden = false;
    const groups = layoutMapMarkers(current, viewport, (canvas.clientWidth || 280) / WIDTH);
    shown = groups.reduce((total, marker) => total + marker.sites.length, 0);
    const buttons = groups.map(({ x, y, sites, identifier, kind }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'charger-map-pin';
      button.sites = sites;
      button.dataset.kind = kind;
      button.setAttribute('aria-controls', sites.length === 1 ? 'charger-site-details' : group.id);
      const detail = viewport.zoom >= DETAIL_ZOOM;
      const suffix = detail ? identifier?.suffix : null;
      button.labelText = kind === 'site' ? shortPlaceName(sites[0]) : mapPlaceName(sites);
      const label = sites.length === 1 ? sites[0].name :
        `${button.labelText ? `${button.labelText}. ` : ''}${sites.length} ${kind === 'regional' ? 'ubicaciones cercanas' : 'ubicaciones en este marcador'}. ${viewport.zoom < MAX_ZOOM ? 'Acercar mapa.' : 'Elegir ubicación.'}`;
      button.setAttribute('aria-label', label);
      button.title = label;
      const body = document.createElement('span');
      body.className = 'charger-map-pin-body';
      body.setAttribute('aria-hidden', 'true');
      body.textContent = kind === 'regional' ? String(sites.length) : kind === 'stack' ? '…'
        : suffix && /^[\p{L}\d−-]{1,4}$/u.test(suffix) ? suffix : '•';
      button.append(body);
      place(button, x, y);
      button.addEventListener('click', event => { if (event.detail === 0 || performance.now() >= suppressTapUntil) activate(sites, button); });
      return button;
    });
    markers.replaceChildren(...buttons);
    updateStatus();
    const expandedAnchor = expanded.length && buttons.find(button => sameSites(button.sites, expanded));
    if (expandedAnchor) positionMembers(expandedAnchor);
    else if (expanded.length) {
      const memberFocus = members.contains(document.activeElement) ? document.activeElement.chargerSite : null;
      showMembers();
      if (memberFocus) (buttons.find(button => button.sites.includes(memberFocus)) || overview).focus({ preventScroll: true });
    }
    pressed();
    labelMarkers();
    if (previousFocus) (buttons.find(button => button.sites.some(site => previousFocus.includes(site))) ||
      (!overview.hidden ? overview : null))?.focus({ preventScroll: true });
    return buttons;
  }

  function activate(sites, anchor) {
    if (sites.length === 1) {
      showMembers();
      overview.hidden = false;
      setViewport(mapViewport(sites, MAX_ZOOM));
      draw();
      select(sites[0]);
      return;
    }
    if (sameSites(sites, expanded)) {
      showMembers();
      return;
    }
    const detail = nextGroupViewport(sites, viewport, (canvas.clientWidth || 280) / WIDTH, current);
    if (detail) {
      overview.hidden = false;
      setViewport(detail);
      draw();
      return;
    }
    showMembers(sites, anchor);
    members.firstElementChild?.firstElementChild.focus();
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (!pinch && !canvas.hidden && canvas.clientWidth) draw();
  }) : null;

  function clear() {
    observer?.disconnect();
    viewport = null;
    selected = null;
    current = [];
    loaded = failed = shown = 0;
    base.hidden = canvas.hidden = true;
    tiles.replaceChildren();
    markers.replaceChildren();
    status.textContent = '';
    overview.hidden = true;
    resetPinch();
    showMembers();
  }

  function zoom(delta, x, y) {
    if (!viewport || !delta) return;
    showMembers();
    overview.hidden = false;
    setViewport(viewport.zoomAt(delta, x, y));
    draw();
  }
  zoomIn.addEventListener('click', () => zoom(1));
  zoomOut.addEventListener('click', () => zoom(-1));
  const pointers = new Map();
  let pinch = null;
  function resetPinch() {
    pointers.clear();
    pinch = null;
  }
  function measure([a, b]) {
    return { span: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }
  function startPinch(touches, ids) {
    const initial = measure(touches);
    pinch = { initial, last: initial, ids, ended: false, canceled: false };
  }
  function finishPinch() {
    const { initial, last, canceled } = pinch;
    pinch = null;
    suppressTapUntil = performance.now() + 450;
    if (canceled || !initial.span || !last.span) return;
    const ratio = Math.log2(last.span / initial.span);
    const rect = canvas.getBoundingClientRect();
    if (Math.abs(ratio) >= 0.24 && rect.width && rect.height) {
      // One commit per gesture keeps intermediate movements from fetching tiles.
      zoom(Math.sign(ratio) * Math.max(1, Math.round(Math.abs(ratio))),
        clamp((last.x - rect.left) / rect.width * WIDTH, 0, WIDTH),
        clamp((last.y - rect.top) / rect.height * HEIGHT, 0, HEIGHT));
    }
  }
  if ('ontouchstart' in canvas) {
    // Cancel native page pinch only for contacts that both began on the map.
    // touch.target is the original element; targetTouches alone misses two different pins.
    const nonPassive = { passive: false };
    const prevent = event => { if (event.cancelable) event.preventDefault(); };
    function trackTouches(event) {
      if (!viewport || canvas.hidden) return;
      const active = Array.from(event.touches);
      const local = active.filter(touch => canvas.contains(touch.target));
      if (!pinch && active.length === 2 && local.length === 2) startPinch(local, local.map(touch => touch.identifier));
      if (!pinch) return;
      prevent(event);
      if (active.length !== 2) pinch.canceled = true;
      const pair = active.filter(touch => pinch.ids.includes(touch.identifier));
      if (!pinch.ended && pair.length === 2) pinch.last = measure(pair);
    }
    function releaseTouches(event) {
      if (!pinch) return;
      const remaining = Array.from(event.touches).filter(touch => pinch.ids.includes(touch.identifier));
      if (remaining.length === 2) return;
      prevent(event);
      if (event.type === 'touchcancel') pinch.canceled = true;
      if (!pinch.ended) {
        const pair = remaining.concat(Array.from(event.changedTouches).filter(touch => pinch.ids.includes(touch.identifier)));
        if (pair.length === 2) pinch.last = measure(pair);
        pinch.ended = true;
      }
      if (!remaining.length) finishPinch();
    }
    canvas.addEventListener('touchstart', trackTouches, nonPassive);
    canvas.addEventListener('touchmove', trackTouches, nonPassive);
    canvas.addEventListener('touchend', releaseTouches, nonPassive);
    canvas.addEventListener('touchcancel', releaseTouches);
  } else {
    // Pointer-only browsers are handled separately; never consume both event streams.
    canvas.addEventListener('pointerdown', event => {
      if (!viewport || canvas.hidden || event.pointerType !== 'touch') return;
      pointers.set(event.pointerId, event);
      if (pinch) pinch.canceled = true;
      else if (pointers.size === 2) startPinch([...pointers.values()], [...pointers.keys()]);
    });
    canvas.addEventListener('pointermove', event => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, event);
      if (pinch && !pinch.ended) pinch.last = measure(pinch.ids.map(id => pointers.get(id)));
    });
    function releasePointer(event) {
      if (!pointers.has(event.pointerId)) return;
      if (pinch?.ids.includes(event.pointerId)) {
        if (event.type !== 'pointerup') pinch.canceled = true;
        if (!pinch.ended && event.type === 'pointerup') {
          pointers.set(event.pointerId, event);
          pinch.last = measure(pinch.ids.map(id => pointers.get(id)));
        }
        pinch.ended = true;
      }
      pointers.delete(event.pointerId);
      if (pinch && !pinch.ids.some(id => pointers.has(id))) finishPinch();
    }
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, releasePointer);
  }

  function setViewport(next) {
    if (!next || viewport?.key === next.key) return;
    viewport = next;
    loaded = failed = 0;
    observer?.observe(canvas);
    tiles.replaceChildren(...next.tiles.map(tile => {
      const image = document.createElement('img');
      image.alt = '';
      image.draggable = false;
      image.crossOrigin = 'anonymous';
      // OSM requires the HTTP Referer. Send only this app's origin, never a path.
      // https://operations.osmfoundation.org/policies/tiles/
      image.referrerPolicy = 'origin';
      place(image, tile.left, tile.top);
      image.addEventListener('load', () => { if (viewport === next) { loaded++; updateStatus(); } }, { once: true });
      image.addEventListener('error', () => {
        image.hidden = true;
        if (viewport === next) { failed++; updateStatus(); }
      }, { once: true });
      image.src = `${TILE_ORIGIN}/${tile.zoom}/${tile.x}/${tile.y}.png`;
      return image;
    }));
  }

  return {
    clear,
    open(sites, near = null) {
      showMembers();
      const focus = near && project(near);
      overview.hidden = !focus;
      setViewport(focus ? mapViewport([near], OVERVIEW_ZOOM, OVERVIEW_ZOOM) : mapViewport(sites, 0, OVERVIEW_ZOOM));
      draw();
    },
    show(sites) {
      if (sameSites(sites, current)) return;
      if (expanded.some(site => !sites.includes(site))) showMembers();
      current = sites;
      draw();
    },
    select(site) { selected = site; pressed(); labelMarkers(); },
  };
}
