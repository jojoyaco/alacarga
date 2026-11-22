// Contrato: docs/api.md. Sin dependencias, credenciales persistidas ni datos de ejemplo.
import { byProximity, distanceMeters, validCoordinates } from './proximity.js';
import { createLocationMap } from './location-map.js';
import { chargingScenario } from './charging-estimate.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const byId = (id) => document.getElementById(id);
const field = (node, name) => $(`[data-field="${name}"]`, node);
const ACTIVE_STATES = new Set(['WAITING', 'OFFERED', 'ACCEPTED', 'CHARGING']);
const CONNECTORS = { ANY: 'Cualquier conector', TYPE2: 'Tipo 2', CCS2: 'CCS2', CHADEMO: 'CHAdeMO', SCHUKO: 'Schuko' };
const RESOURCE_STATES = { AVAILABLE: 'Disponible', BUSY: 'Ocupado', RESERVED: 'Reservado', RECHARGING: 'Cargando', MAINTENANCE: 'Mantenimiento', UNKNOWN: 'Desconocido', STALE: 'Obsoleto', UNVERIFIED: 'Sin verificar' };
const QUEUE_STATES = { WAITING: 'En cola', OFFERED: 'Te toca', ACCEPTED: 'Voy', CHARGING: 'Estoy cargando', EXPIRED: 'Vencido', CANCELLED: 'Cancelado', COMPLETED: 'Completado' };
const LOGIN_PATH = '/api/login';
const POLL_MS = 5000;
const FRESH_MS = 15000;
const PREFERENCES_KEY = 'alacarga.preferences.v1';
// Eliminar solo los contadores antiguos; Recientes ya no usa actividad local.
try { localStorage.removeItem('alacarga.site-opens.v1'); }
catch { /* El almacenamiento puede estar bloqueado. */ }
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
let preferenceStorageAvailable = true;
let preferences = readPreferences();
const state = {
  user: null, csrfToken: null, sessionKnown: false, config: null, configReadAt: 0,
  zones: [], zonesLoaded: false, me: null, connection: 'loading', lastSuccess: 0,
  lastSuccessClock: 0, revision: 0, clock: null, busy: new Set(),
  registration: null, serviceWorkerError: false, browserSubscription: null,
  pushRegisteredFor: null, installPrompt: null, estimateQueueId: null,
  evsareProfile: { status: 'idle', data: null, message: '', readAt: null, officialAction: false },
  evsareRecharges: { status: 'idle', data: null, message: '', readAt: null, officialAction: false },
};
const zoneNodes = new Map();
const adminNodes = new Map();
const PRIVATE_PAGES = ['my-chargers', 'my-turn', 'my-recharges', 'account-card'];
const emptyChargers = () => ({ status: 'idle', data: null, results: [], favoriteFilterKey: '', view: 'list', selected: null, historyDefaultResolved: false, selectionTouched: false, parkingSelection: null, rfid: null, message: '', reconnect: false, actions: [], turnLink: null, inFlight: false, nextCheck: 0 });
let chargers = emptyChargers();
let proximityPosition = null;
let proximityPermission;
let proximityAttempt = null;
const chargerMap = createLocationMap({
  base: byId('charger-map-base'), canvas: byId('charger-map-canvas'), tiles: byId('charger-map-tiles'),
  markers: byId('charger-map-markers'), status: byId('charger-map-status'), overview: byId('charger-map-overview'),
  zoomIn: byId('charger-map-zoom-in'), zoomOut: byId('charger-map-zoom-out'),
  group: byId('charger-map-group'), groupHeading: byId('charger-map-group-heading'), groupClose: byId('charger-map-group-close'),
  members: byId('charger-map-members'), select: openChargerSite, siteItem: chargerSiteItem,
});
let currentRefresh = null;
let lastAnnouncement = '';
let notificationSignature = '';
let lastExpiryRefresh = '';
let accountRevision = 0;
let rechargeSignature = '';

function text(node, value) {
  const next = value == null ? '' : String(value);
  if (node && node.textContent !== next) node.textContent = next;
}
function visible(node, show) { if (node) node.hidden = !show; }
function disabled(node, value) { if (node && node.disabled !== Boolean(value)) node.disabled = Boolean(value); }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function timestamp(value) { return value != null && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null; }
function hasActiveTurn() { return ACTIVE_STATES.has(state.me?.queue?.state); }
function serverNow() { return state.clock ? state.clock.time + performance.now() - state.clock.monotonic : Date.now(); }
function dataFresh() { return navigator.onLine !== false && state.connection === 'online' && performance.now() - state.lastSuccessClock < FRESH_MS; }
function canWrite() { return Boolean(state.user && state.me && state.csrfToken && dataFresh() && !state.busy.has('auth')); }
function isAdmin() { return state.user?.provider === 'local' && state.user.role === 'admin'; }
function identityKey(user) { return user ? JSON.stringify([user.id, user.provider, user.username, user.role]) : ''; }
function sameSession(left, right) { return identityKey(left.user) === identityKey(right.user) && left.csrfToken === right.csrfToken; }
function isEVsareError(error) { return error instanceof ApiError && String(error.code).startsWith('EVSARE_'); }
function needsOfficialAction(error) { return isEVsareError(error) && /PRIVACY|ACTION_REQUIRED|PASSWORD.*CHANGE|CHANGE.*PASSWORD/.test(error.code); }
function evsareErrorMessage(error) {
  if (needsOfficialAction(error)) return 'EVsare requiere una acción en su app oficial: revisa el cambio de contraseña o los consentimientos de privacidad pendientes. Después vuelve a conectar aquí. A la caaarga!! no realiza esos cambios por ti.';
  if (error.code === 'EVSARE_REAUTH_REQUIRED') return 'Necesitas reconectar con EVsare para consultar tu cuenta. Tu turno y tus zonas seguidas de A la caaarga!! no se han cancelado.';
  if (isEVsareError(error) && error.status === 503) return 'EVsare no está disponible en este momento. Puedes reintentar más tarde o reconectar; tu turno de A la caaarga!! no se ha cancelado.';
  return error.message;
}
function cloneTemplate(id) { return byId(id).content.firstElementChild.cloneNode(true); }
function shortTime(value) { return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function fullTime(value) { return new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function localInputTime(value) {
  if (!timestamp(value)) return '';
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function ageLabel(value) {
  const stamp = timestamp(value);
  if (!stamp) return 'Sin observación';
  const seconds = Math.max(0, Math.floor((serverNow() - stamp) / 1000));
  if (seconds < 60) return 'Hace menos de 1 min';
  if (seconds < 3600) return `Hace ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `Hace ${Math.floor(seconds / 3600)} h`;
  return fullTime(stamp);
}
function effectiveResourceStatus(resource) {
  if (!dataFresh()) return 'UNVERIFIED';
  const status = Object.hasOwn(RESOURCE_STATES, resource.status) ? resource.status : 'UNKNOWN';
  // El servidor conoce la asignación activa, aunque administración haya
  // confirmado la carga manualmente. Solo endurecemos localmente AVAILABLE;
  // nunca caducamos una ocupación por su fuente, su ETA o un TTL del navegador.
  if (status !== 'AVAILABLE') return status;
  const observedAt = timestamp(resource.observedAt);
  if (!observedAt) return 'UNKNOWN';
  const staleSeconds = number(state.config?.staleSeconds);
  if (staleSeconds > 0 && serverNow() - observedAt >= staleSeconds * 1000) return 'STALE';
  return status;
}
function durationLabel(seconds) {
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
function announce(message, error = false) {
  text(byId(error ? 'error-announcer' : 'polite-announcer'), message);
}
let feedbackTimer;
let feedbackMotion;
const feedbackReducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function hideFeedback() {
  clearTimeout(feedbackTimer);
  feedbackMotion?.cancel();
  feedbackMotion = null;
  visible(byId('feedback'), false);
}
function scheduleFeedbackDismissal() {
  const notice = byId('feedback');
  if (notice.hidden || !notice.hasAttribute('data-toast')) return;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    if (notice.matches(':hover, :focus-within')) return;
    if (feedbackReducedMotion.matches || !notice.animate) { hideFeedback(); return; }
    feedbackMotion = notice.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 160, easing: 'ease-in' });
    feedbackMotion.onfinish = () => { if (!notice.matches(':hover, :focus-within')) hideFeedback(); };
  }, notice.dataset.kind === 'error' ? 7000 : 4000);
}
function feedback(message, kind = 'success') {
  const notice = byId('feedback');
  clearTimeout(feedbackTimer);
  feedbackMotion?.cancel();
  feedbackMotion = null;
  notice.dataset.kind = kind;
  notice.setAttribute('data-toast', '');
  text(byId('feedback-message'), message);
  visible(notice, true);
  announce(message, kind === 'error');
  if (!feedbackReducedMotion.matches) feedbackMotion = notice.animate?.([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' });
  scheduleFeedbackDismissal();
}
function formMessage(idOrNode, message, kind = 'error') {
  const node = typeof idOrNode === 'string' ? byId(idOrNode) : idOrNode;
  node.dataset.kind = kind;
  text(node, message);
}

// Lista cerrada de preferencias no sensibles. Nunca se persisten respuestas API,
// identidad de cuenta, claves, contraseñas, cookies, CSRF o disponibilidad.
function cleanPreferences(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const vehicle = input.vehicle && typeof input.vehicle === 'object' ? input.vehicle : {};
  const choice = (candidate, allowed, fallback) => allowed.includes(candidate) ? candidate : fallback;
  const string = (candidate, limit) => typeof candidate === 'string' ? candidate.trim().slice(0, limit) : '';
  const capacity = Number(vehicle.capacityKwh);
  const duration = Number(vehicle.plannedMinutes);
  return {
    version: 1,
    theme: choice(input.theme, ['system', 'light', 'dark'], 'system'),
    density: choice(input.density, ['comfortable', 'compact'], 'comfortable'),
    zoneView: choice(input.zoneView, ['cards', 'list'], 'cards'),
    onlyFollowing: input.onlyFollowing === true,
    vehicle: {
      alias: string(vehicle.alias, 60), make: string(vehicle.make, 60), model: string(vehicle.model, 80),
      capacityKwh: Number.isFinite(capacity) && capacity > 0 && capacity <= 1000 ? capacity : null,
      connector: choice(vehicle.connector, Object.keys(CONNECTORS), 'ANY'),
      plannedMinutes: Number.isInteger(duration) && duration >= 1 && duration <= 720 ? duration : null,
    },
  };
}
function readPreferences() {
  let stored;
  try {
    stored = localStorage.getItem(PREFERENCES_KEY);
  } catch { preferenceStorageAvailable = false; return cleanPreferences(); }
  try { return cleanPreferences(stored ? JSON.parse(stored) : {}); }
  catch { return cleanPreferences(); }
}
function savePreferences() {
  try { localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)); preferenceStorageAvailable = true; return true; }
  catch { preferenceStorageAvailable = false; return false; }
}
function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme === 'system' ? systemTheme.matches ? 'dark' : 'light' : preferences.theme;
  root.dataset.density = preferences.density;
  root.dataset.zoneView = preferences.zoneView;
  $('meta[name="theme-color"]').content = getComputedStyle(root).getPropertyValue('--page').trim();
  const vehicle = preferences.vehicle;
  const label = vehicle.alias || [vehicle.make, vehicle.model].filter(Boolean).join(' ');
  const preferred = vehicle.connector !== 'ANY' ? `Preferido: ${CONNECTORS[vehicle.connector]}` : '';
  visible(byId('vehicle-preference'), Boolean(label || preferred));
  text(byId('vehicle-preference-text'), [label, preferred, 'Perfil local, declarado por ti'].filter(Boolean).join(' · '));
}
function fillPreferencesForm(value) {
  byId('preference-theme').value = value.theme;
  byId('preference-density').value = value.density;
  byId('vehicle-alias').value = value.vehicle.alias;
  byId('vehicle-make').value = value.vehicle.make;
  byId('vehicle-model').value = value.vehicle.model;
  byId('vehicle-capacity').value = value.vehicle.capacityKwh ?? '';
  byId('vehicle-connector').value = value.vehicle.connector;
  byId('vehicle-duration').value = value.vehicle.plannedMinutes ?? '';
}
function openPreferences() {
  fillPreferencesForm(preferences);
  formMessage('preferences-message', preferenceStorageAvailable ? '' : 'El almacenamiento local no está disponible. Puedes personalizar esta sesión sin guardar datos.');
  byId('settings-dialog').showModal();
  byId('preference-theme').focus();
}

class ApiError extends Error {
  constructor(message, status = 0, code = 'NETWORK_ERROR') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function api(path, body) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  const sent = performance.now();
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  }
  try {
    // Origin lo añade el navegador. Nunca se simula ni se envía a otro origen.
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: controller.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const received = performance.now();
    const responseDate = Date.parse(response.headers.get('Date') || '');
    if (Number.isFinite(responseDate)) {
      // Date tiene precisión de segundos. La cuenta usa ese reloj de servidor
      // y un reloj monótono, no intervalos que inventen un nuevo vencimiento.
      state.clock = { time: responseDate + 500 + (received - sent) / 2, monotonic: received };
    }
    let data;
    try { data = await response.json(); } catch { throw new ApiError('El servidor no devolvió una respuesta válida. Reintenta más tarde.', response.status, 'BAD_RESPONSE'); }
    if (!response.ok) {
      throw new ApiError(typeof data.error === 'string' ? data.error : 'No se pudo completar la solicitud.', response.status, data.code || 'API_ERROR');
    }
    if (!data || typeof data !== 'object') throw new ApiError('La respuesta del servidor no es válida.', response.status, 'BAD_RESPONSE');
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'AbortError' ? 'El servidor tardó demasiado. Comprueba tu conexión y reintenta.' : 'No se puede conectar con el servidor. No hemos confirmado ningún cambio.');
  } finally { window.clearTimeout(timeout); }
}

function resetEVsareAccount() {
  accountRevision += 1; // Invalida respuestas privadas de una sesión anterior.
  state.evsareProfile = { status: 'idle', data: null, message: '', readAt: null, officialAction: false };
  state.evsareRecharges = { status: 'idle', data: null, message: '', readAt: null, officialAction: false };
  rechargeSignature = '';
  stopRechargeCurves();
  for (const id of ['profile-name', 'profile-email', 'profile-privacy', 'profile-status', 'recharges-status']) text(byId(id), '');
  byId('recharges-list').replaceChildren();
  byId('recharges-history').open = false;
  visible(byId('recharges-history'), false);
  renderRechargeChart([]);
  visible(byId('recharges-list'), false);
  visible(byId('profile-details'), false);
  visible(byId('profile-official-action'), false);
  visible(byId('profile-reconnect'), false);
  resetChargers();
}

function applySession(session, { renewed = false } = {}) {
  const firstVerification = !state.sessionKnown;
  const changed = identityKey(state.user) !== identityKey(session.user);
  const reconnected = renewed || (state.sessionKnown && state.csrfToken !== session.csrfToken);
  // En el primer GET de una recarga de página el resumen aún puede pertenecer
  // a esta sesión. Su sello se comprueba antes de mostrarlo.
  if (session.user?.provider !== 'evsare' || !session.csrfToken || reconnected || (state.sessionKnown && changed)) clearRecentLocations();
  state.user = session.user || null;
  state.csrfToken = typeof session.csrfToken === 'string' ? session.csrfToken : null;
  state.sessionKnown = true;
  if (changed || reconnected) resetEVsareAccount();
  if (firstVerification && !renewed && state.user?.provider === 'evsare' && state.csrfToken) {
    const revision = accountRevision;
    recentLocationsRestore = restoreRecentLocations(session, () => revision === accountRevision && sameSession(session, state));
  }
  if (changed) {
    state.me = null;
    state.pushRegisteredFor = null;
    state.estimateQueueId = null;
    notificationSignature = '';
    lastAnnouncement = '';
    lastExpiryRefresh = '';
    byId('estimate-form').reset();
    byId('expected-release').dataset.dirty = 'false';
    // No basta con ocultar un panel: retirar también sus datos del DOM.
    for (const id of ['turn-zone', 'turn-resource', 'turn-planned-duration', 'turn-position', 'turn-people-ahead', 'turn-wait-time', 'turn-wait-reason', 'turn-kicker', 'turn-explanation', 'turn-timer', 'turn-deadline', 'current-estimate', 'turn-announcement', 'estimate-message', 'polite-announcer', 'error-announcer', 'feedback-message']) text(byId(id), '');
    byId('notification-list').replaceChildren();
    byId('admin-panel').open = false;
    byId('admin-resource-list').replaceChildren();
    adminNodes.clear();
    for (const name of ['zone', 'resource']) { byId(`create-${name}-form`).reset(); formMessage(`create-${name}-message`, ''); }
    hideFeedback();
  }
  if (changed || renewed) {
    byId('login-form').reset();
    formMessage('login-message', '');
    if (state.user && byId('auth-dialog').open) byId('auth-dialog').close();
  }
  if (changed || reconnected) render();
}

async function readSnapshot(revision = state.revision) {
  const needsConfig = !state.config || performance.now() - state.configReadAt > 60000;
  const [initialSession, zonesResponse, config] = await Promise.all([
    api('/api/session').then((session) => {
      // Limpiar la cuenta anterior incluso si la lectura pública falla después.
      if (revision === state.revision) applySession(session);
      return session;
    }),
    api('/api/zones'), needsConfig ? api('/api/config') : state.config,
  ]);
  if (revision !== state.revision) return null;
  if (!Array.isArray(zonesResponse.zones)) throw new ApiError('La lista de zonas no es válida.', 200, 'BAD_RESPONSE');
  let session = initialSession;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let me = null;
    let failure = null;
    if (session.user) {
      try { me = await api('/api/me'); }
      catch (error) { failure = error; }
    }
    // Otra pestaña puede cambiar la cookie entre /session y /me, incluso sin
    // un 401. Publicar datos privados solo tras verificar la misma sesión.
    const verifiedSession = await api('/api/session');
    if (revision !== state.revision) return null;
    applySession(verifiedSession);
    if (!sameSession(session, verifiedSession)) { session = verifiedSession; continue; }
    if (failure) throw failure;
    return { session: verifiedSession, zones: zonesResponse.zones, config, me, needsConfig };
  }
  throw new ApiError('La sesión ha cambiado. Estamos verificando la cuenta actual.', 409, 'SESSION_CHANGED');
}

async function refresh(force = false) {
  if (!force && state.busy.has('auth')) return false;
  if (currentRefresh) {
    if (!force) return currentRefresh;
    await currentRefresh;
    return refresh(false);
  }
  const revision = state.revision;
  disabled(byId('retry-button'), true);
  currentRefresh = (async () => {
    try {
      const snapshot = await readSnapshot(revision);
      if (!snapshot || revision !== state.revision) return false;
      applySession(snapshot.session);
      state.zones = snapshot.zones;
      state.config = snapshot.config;
      if (snapshot.needsConfig) state.configReadAt = performance.now();
      state.me = state.user ? snapshot.me : null;
      state.zonesLoaded = true;
      state.connection = 'online';
      state.lastSuccess = serverNow();
      state.lastSuccessClock = performance.now();
      render();
      // Una consulta por conexión de cuenta, nunca una consulta del perfil por poll.
      if (state.user?.provider === 'evsare' && state.evsareProfile.status === 'idle' && state.evsareRecharges.status === 'idle') void loadEVsareAccount();
      if (privateChargersEnabled() && !document.hidden && performance.now() >= chargers.nextCheck) void loadChargers();
      return true;
    } catch (error) {
      if (revision !== state.revision) return false;
      state.connection = navigator.onLine === false ? 'offline' : 'error';
      render();
      return false;
    } finally {
      currentRefresh = null;
      disabled(byId('retry-button'), false);
    }
  })();
  return currentRefresh;
}

async function mutate(path, body = {}) {
  // Descarta lecturas iniciadas antes de una escritura. Una respuesta tardía
  // de polling nunca restaura un turno anterior ni una sesión cerrada.
  state.revision += 1;
  const owner = identityKey(state.user);
  try {
    const response = await api(path, body);
    if (path !== LOGIN_PATH && path !== '/api/logout' && owner !== identityKey(state.user)) throw new ApiError('La cuenta ha cambiado. Consulta el estado de tu sesión actual antes de continuar.', 409, 'SESSION_CHANGED');
    return response;
  }
  finally { state.revision += 1; }
}

async function runAction(key, callback, { form = null, message = null } = {}) {
  if (state.busy.has(key) || (key !== 'auth' && state.busy.has('auth'))) return;
  state.busy.add(key);
  if (form) { form.setAttribute('aria-busy', 'true'); disabled($('fieldset', form), true); }
  if (message) formMessage(message, '');
  renderControls();
  try { await callback(); }
  catch (error) {
    const usefulMessage = isEVsareError(error) ? evsareErrorMessage(error) : error instanceof ApiError || error.name === 'UserInputError' ? error.message : friendlyBrowserError(error);
    if (message) formMessage(message, usefulMessage);
    feedback(usefulMessage, 'error');
    if (error instanceof ApiError && error.status === 0) state.connection = navigator.onLine === false ? 'offline' : 'error';
    // Un 401 del operador no invalida la cookie local ni cancela la cola.
    // Solo /api/session determina si hay que retirar la cuenta local.
    if (error instanceof ApiError && error.status > 0 && !isEVsareError(error)) await refresh(true);
  } finally {
    state.busy.delete(key);
    if (form) { form.removeAttribute('aria-busy'); disabled($('fieldset', form), false); }
    render();
  }
}

function inputError(message) { const error = new Error(message); error.name = 'UserInputError'; return error; }
function requireUser() {
  if (!state.user) { openAuth(); return false; }
  if (!canWrite()) { feedback('Necesitas una conexión verificada y una sesión válida para hacer este cambio. Pulsa Reintentar.', 'error'); return false; }
  return true;
}

function renderConnection() {
  const fresh = dataFresh();
  const connection = fresh ? 'online' : navigator.onLine === false ? 'offline' : state.connection === 'loading' ? 'loading' : 'error';
  byId('connection-chip').dataset.state = connection;
  text(byId('connection-label'), { online: 'Conectado', offline: 'Sin conexión', loading: 'Conectando', error: 'Sin verificar' }[connection]);
  visible(byId('connection-banner'), connection !== 'online' && connection !== 'loading');
  text(byId('connection-banner-title'), connection === 'offline' ? 'Estás sin conexión.' : 'No podemos verificar la información del servidor.');
  text(byId('connection-banner-copy'), state.zonesLoaded ? 'Lo que ves es la última consulta, no disponibilidad actual. Los cambios están desactivados hasta reconectar.' : 'Puedes recorrer la interfaz, pero no consultar disponibilidad ni gestionar turnos. Reintentaremos automáticamente.');
  text(byId('last-sync'), fresh ? `Consulta ${shortTime(state.lastSuccess)}` : state.lastSuccess ? `Sin verificar · ${shortTime(state.lastSuccess)}` : connection === 'loading' ? 'Consultando…' : 'Sin datos verificados');
}

function renderAccount() {
  const loggedIn = Boolean(state.user);
  const ownAccount = state.user?.provider === 'evsare';
  text(byId('account-button-label'), loggedIn ? 'Mi cuenta' : 'Iniciar sesión');
  byId('account-open').setAttribute('aria-label', loggedIn ? 'Ver mi cuenta' : 'Iniciar sesión');
  visible(byId('account-card'), loggedIn);
  text(byId('account-heading'), ownAccount ? 'Mi perfil' : 'Administración local');
  visible(byId('my-recharges'), ownAccount);
  text(byId('account-username'), state.user?.username);
  text(byId('account-role'), isAdmin() ? 'Cuenta local · admin' : '');
  visible(byId('account-role'), isAdmin());
  visible(byId('admin-section'), isAdmin());
  visible(byId('activity-panel'), loggedIn);
  renderEVsareAccount();
}

function evsareAccountLoading() { return [state.evsareProfile, state.evsareRecharges].some((part) => part.status === 'loading'); }
function renderEVsareControls() {
  const allowed = state.user?.provider === 'evsare' && dataFresh() && !state.busy.has('auth');
  const accountLoading = evsareAccountLoading();
  const rechargesLoading = state.evsareRecharges.status === 'loading';
  disabled(byId('profile-refresh'), !allowed || accountLoading);
  disabled(byId('profile-reconnect'), !allowed || accountLoading);
  disabled(byId('recharges-refresh'), !allowed || rechargesLoading);
  byId('profile-refresh').setAttribute('aria-busy', String(accountLoading));
  byId('recharges-refresh').setAttribute('aria-busy', String(rechargesLoading));
}

function renderEVsareAccount() {
  const ownAccount = state.user?.provider === 'evsare';
  visible(byId('evsare-profile'), ownAccount);
  const cardArea = byId('profile-rfid');
  const showCards = ownAccount && state.config?.rfidMode === 'read-only';
  if (showCards && !cardArea.firstChild) cardArea.append(rfidCardsPanel());
  if (!showCards && cardArea.firstChild) { closeRfidCards(); cardArea.replaceChildren(); }
  if (!ownAccount) return;
  const profile = state.evsareProfile;
  const recharges = state.evsareRecharges;
  text(byId('profile-status'), profile.status === 'loading' ? 'Consultando tu perfil de EVsare…' : profile.status === 'ready' ? `Perfil consultado · ${shortTime(profile.readAt)}` : profile.status === 'error' ? profile.message : 'Tu perfil aún no se ha consultado. Pulsa «Actualizar cuenta» si no se carga al conectar.');
  byId('profile-status').dataset.kind = profile.status === 'error' ? 'error' : 'info';
  visible(byId('profile-details'), Boolean(profile.data));
  byId('profile-details').setAttribute('aria-busy', String(profile.status === 'loading'));
  text(byId('profile-name'), profile.data ? profile.data.name || 'No facilitado' : '');
  text(byId('profile-email'), profile.data ? profile.data.email || 'No facilitado' : '');
  text(byId('profile-privacy'), profile.data ? profile.data.privacyAccepted === true ? 'Aceptada en EVsare' : profile.data.privacyAccepted === false ? 'Pendiente en la app oficial' : 'Sin información' : '');
  text(byId('recharges-status'), recharges.status === 'loading' ? 'Consultando tus recargas de IBILSARE…' : recharges.status === 'ready' ? recharges.data.length ? `${recharges.data.length} ${recharges.data.length === 1 ? 'recarga consultada' : 'recargas consultadas'} · ${shortTime(recharges.readAt)}` : 'No hay recargas en este resultado de IBILSARE. No incluye otras redes.' : recharges.status === 'error' ? recharges.message : 'Tus últimas recargas aún no se han consultado.');
  byId('recharges-status').dataset.kind = recharges.status === 'error' ? 'error' : 'info';
  byId('recharges-list').setAttribute('aria-busy', String(recharges.status === 'loading'));
  visible(byId('recharges-list'), Boolean(recharges.data?.length));
  visible(byId('recharges-history'), Boolean(recharges.data?.length));
  text(byId('recharges-history-count'), recharges.data?.length);
  const signature = JSON.stringify(recharges.data);
  if (signature !== rechargeSignature) {
    rechargeSignature = signature;
    stopRechargeCurves();
    renderRechargeChart(recharges.data || []);
    const fragment = document.createDocumentFragment();
    const curves = new Map();
    for (const recharge of recharges.data || []) {
      const item = document.createElement('li');
      item.id = rechargeRowId(recharge.id);
      item.tabIndex = -1;
      const site = document.createElement('strong');
      const terminal = document.createElement('p');
      const dates = document.createElement('dl');
      dates.className = 'recharge-dates';
      text(site, recharge.siteName || 'Ubicación no informada');
      text(terminal, recharge.terminalName || 'Terminal no informado');
      item.setAttribute('aria-label', rechargeIdentity(recharge));
      for (const [label, value] of [['Inicio', recharge.startedAt], ['Fin', recharge.endedAt]]) {
        const row = document.createElement('div');
        const term = document.createElement('dt');
        const detail = document.createElement('dd');
        text(term, label);
        if (value) {
          const time = document.createElement('time');
          time.dateTime = value;
          text(time, new Intl.DateTimeFormat('es-ES', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)));
          detail.append(time);
        } else text(detail, `${label} no informado`);
        row.append(term, detail);
        dates.append(row);
      }
      const cost = document.createElement('strong');
      cost.className = 'recharge-amount';
      const amount = rechargeCost(recharge);
      text(cost, amount === null ? 'Coste no informado' : `Importe: ${rechargeEuros.format(amount)}`);
      const curve = createRechargeCurve(recharge);
      curves.set(curve.node, curve);
      const detail = document.createElement('div');
      detail.append(site, terminal, dates);
      const chartSide = document.createElement('div');
      chartSide.className = 'recharge-chart-side';
      chartSide.append(cost, curve.node);
      item.append(detail, chartSide);
      fragment.append(item);
    }
    byId('recharges-list').replaceChildren(fragment);
    if (curves.size) observeRechargeCurves(curves);
  }
  visible(byId('profile-official-action'), profile.data?.privacyAccepted === false || profile.officialAction || recharges.officialAction || rechargeCurves?.officialAction);
  visible(byId('profile-reconnect'), profile.status === 'error' || recharges.status === 'error' || rechargeCurves?.blocked);
  renderEVsareControls();
  void drainRechargeCurves();
}

let rechargeMetric = 'energy';
let rechargeCurves;
let rechargeCurveLoading = false;
const rechargeEuros = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

function rechargeRowId(id) { return `recharge-row-${id}`; }

function rechargeIdentity(recharge) {
  return [recharge.siteName || 'Ubicación no informada', recharge.terminalName, recharge.startedAt && fullTime(recharge.startedAt)].filter(Boolean).join(' · ');
}

function revealRecharge(id) {
  const row = byId(rechargeRowId(id));
  const history = byId('recharges-history');
  if (!row || history.hidden) return;
  history.open = true;
  row.focus({ preventScroll: true });
  // Jump directly to the row so the lazy observer does not load curves passed en route.
  row.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
}

function rechargeCost(recharge) {
  // EVsare reports this amount in euros; energy verification is separate.
  return [recharge.costEur, recharge.reportedCost].find(value => Number.isFinite(value) && value >= 0) ?? null;
}

function createRechargeCurve(recharge) {
  const node = document.createElement('div');
  node.className = 'recharge-curve';
  const status = document.createElement('p');
  status.className = 'fine-print';
  status.setAttribute('role', 'status');
  text(status, 'Curva de carga pendiente de consulta.');
  const chart = document.createElement('div');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'text-button';
  text(retry, 'Cargar curva');
  retry.setAttribute('aria-label', `Cargar curva de ${recharge.siteName || 'la recarga'}${recharge.startedAt ? ` · ${fullTime(recharge.startedAt)}` : ''}`);
  retry.hidden = typeof IntersectionObserver === 'function';
  const curve = { id: recharge.id, node, status, chart, retry, phase: 'idle' };
  retry.addEventListener('click', () => {
    const batch = rechargeCurves;
    if (!batch?.curves.has(node) || !['idle', 'error'].includes(curve.phase)) return;
    batch.requested.add(node);
    void drainRechargeCurves();
  });
  node.append(status, chart, retry);
  return curve;
}

function stopRechargeCurves() {
  rechargeCurves?.observer?.disconnect();
  rechargeCurves = null;
}

function observeRechargeCurves(curves) {
  const batch = rechargeCurves = { curves, visible: new Set(), requested: new Set(), owner: { user: state.user, csrfToken: state.csrfToken } };
  if (typeof IntersectionObserver !== 'function') return;
  // The default root also clips to the scrolling history list and the viewport.
  batch.observer = new IntersectionObserver(entries => {
    if (rechargeCurves !== batch) return;
    for (const entry of entries) {
      if (entry.isIntersecting && entry.intersectionRatio > 0 && batch.curves.get(entry.target)?.phase === 'idle') batch.visible.add(entry.target);
      else batch.visible.delete(entry.target);
    }
    void drainRechargeCurves();
  }, { threshold: [0, 0.01] });
  for (const node of curves.keys()) batch.observer.observe(node);
}

async function drainRechargeCurves() {
  const batch = rechargeCurves;
  if (!batch || batch.blocked || batch.cooldownUntil > Date.now() || rechargeCurveLoading || batch.owner.user?.provider !== 'evsare' || !batch.owner.csrfToken ||
      !sameSession(batch.owner, state) || state.busy.has('auth') || !dataFresh()) return;
  const history = byId('recharges-history');
  if (!history.open || history.hidden || byId('my-recharges').hidden) return;
  const list = byId('recharges-list').getBoundingClientRect();
  const inView = node => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > Math.max(0, list.top) && rect.top < Math.min(window.innerHeight, list.bottom);
  };
  const node = [...batch.requested, ...batch.visible].find(node => node.isConnected && inView(node));
  if (!node) return;
  const curve = batch.curves.get(node);
  const { status, chart, retry, id } = curve;
  const current = () => rechargeCurves === batch && node.isConnected && sameSession(batch.owner, state);
  batch.visible.delete(node);
  batch.requested.delete(node);
  batch.observer?.unobserve(node);
  rechargeCurveLoading = true;
  curve.phase = 'loading';
  node.setAttribute('aria-busy', 'true');
  disabled(retry, true);
  text(status, 'Consultando la curva de carga de EVsare…');
  try {
    let response, failure;
    try { response = await api(`/api/evsare/recharges/${id}/curve`); }
    catch (error) { failure = error; }
    if (!current()) return;
    const session = await api('/api/session');
    if (!current()) return;
    if (!sameSession(batch.owner, session)) {
      applySession(session);
      void refresh(true);
      return;
    }
    if (failure) throw failure;
    if (!Array.isArray(response.points)) throw new Error('Invalid recharge curve');
    const points = response.points.slice(0, 500).filter(p => Number.isFinite(p?.time) && Number.isFinite(p.energyKwh) && p.energyKwh >= 0);
    if (points.length) chart.replaceChildren(drawRechargeCurve(points));
    curve.phase = 'loaded';
    visible(retry, false);
    text(status, points.length ? `Curva de carga · ${points.length} ${points.length === 1 ? 'lectura' : 'lecturas'} de EVsare · energía en kWh` : 'EVsare no ha devuelto lecturas para esta recarga.');
  } catch (error) {
    if (!current()) return;
    curve.phase = 'error';
    // Let the minute-long server rate limit recover before sending more rows.
    if (error.status === 429) batch.cooldownUntil = Date.now() + 60000;
    if (error.status === 401 || error.status === 403 || needsOfficialAction(error)) {
      batch.blocked = true;
      batch.officialAction = needsOfficialAction(error);
      renderEVsareAccount();
    }
    text(status, error.status === 429 ? 'Demasiadas consultas. Espera un minuto antes de reintentar.'
      : isEVsareError(error) ? evsareErrorMessage(error) : batch.blocked ? 'Para consultar la curva, vuelve a conectar con EVsare en Mi perfil.' : 'No se pudo consultar la curva de carga.');
    text(retry, 'Reintentar curva');
    retry.setAttribute('aria-label', retry.getAttribute('aria-label').replace(/^Cargar/, 'Reintentar'));
    visible(retry, !batch.blocked);
    disabled(retry, false);
  } finally {
    node.removeAttribute('aria-busy');
    rechargeCurveLoading = false;
    void drainRechargeCurves();
  }
}

function drawRechargeCurve(points) {
  const start = points[0].time, end = points.at(-1).time;
  const max = Math.max(1, ...points.map(point => point.energyKwh));
  const format = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 480 164');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Curva de energía: comienza en ${format.format(points[0].energyKwh)} kWh y termina en ${format.format(points.at(-1).energyKwh)} kWh.`);
  const add = (tag, values, value) => {
    const node = document.createElementNS(ns, tag);
    for (const [key, val] of Object.entries(values)) node.setAttribute(key, val);
    if (value !== undefined) node.textContent = value;
    svg.append(node);
  };
  for (const f of [0, 0.5, 1]) {
    const y = 138 - f * 120;
    add('line', { x1: 58, x2: 469, y1: y, y2: y, class: 'curve-gridline' });
    add('text', { x: 4, y: y + 4, class: 'curve-axis-label' }, `${format.format(max * f)} kWh`);
  }
  const positions = points.map(p => [58 + 411 * (p.time - start) / Math.max(1, end - start), 138 - 120 * p.energyKwh / max]);
  add('polyline', { points: positions.map(pair => pair.join(',')).join(' '), class: 'curve-series' });
  const [lastX, lastY] = positions.at(-1);
  add('circle', { cx: lastX, cy: lastY, r: 3, class: 'curve-point' });
  add('text', { x: 58, y: 158, class: 'curve-axis-label' }, 'Inicio');
  if (end !== start) add('text', { x: 469, y: 158, 'text-anchor': 'end', class: 'curve-axis-label' }, `+${format.format((end - start) / 60000)} min`);
  return svg;
}

function renderRechargeChart(recharges) {
  const mode = rechargeMetric;
  const verified = mode !== 'energy' || recharges.some(r => Number.isFinite(r.energyKwh));
  const unit = mode === 'time' ? 'min' : verified ? 'kWh' : '';
  const rows = recharges.flatMap(r => {
    const start = Date.parse(r.startedAt), end = Date.parse(r.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
    const value = mode === 'time' ? Math.round((end - start) / 60000) : mode === 'cost' ? rechargeCost(r) : r[verified ? 'energyKwh' : 'reportedEnergy'];
    return Number.isFinite(value) && value >= 0 ? [{ recharge: r, start, value }] : [];
  }).sort((a, b) => a.start - b.start).slice(-8);
  const plot = byId('recharges-plot');
  plot.replaceChildren();
  visible(byId('recharges-chart'), recharges.length > 0);
  for (const button of $$('[data-recharge-metric]')) button.setAttribute('aria-pressed', String(button.dataset.rechargeMetric === mode));
  const format = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 3 });
  const fmt = value => mode === 'cost' ? rechargeEuros.format(value) : mode === 'time' && value >= 60
    ? `${Math.floor(value / 60)} h${value % 60 ? ` ${value % 60} min` : ''}`
    : [format.format(value), unit].filter(Boolean).join(' ');
  text(byId('recharges-total'), rows.length ? (verified ? fmt(rows.reduce((total, r) => total + r.value, 0)) : 'Valores de EVsare') : 'No hay datos para esta vista.');
  text(byId('recharges-unit-note'), rows.length ? (verified ? `Últimas ${rows.length} recargas finalizadas con datos.` : 'Unidad de energía no confirmada por EVsare. Los valores se muestran sin convertir.') : '');
  const max = Math.max(0.001, ...rows.map(r => r.value));
  const date = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short' });
  const list = document.createElement('ul');
  for (const row of rows) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recharge-bar';
    button.setAttribute('aria-controls', rechargeRowId(row.recharge.id));
    button.setAttribute('aria-label', `Ver recarga: ${fmt(row.value)} · ${rechargeIdentity(row.recharge)}`);
    button.addEventListener('click', () => revealRecharge(row.recharge.id));
    const label = document.createElement('time');
    label.dateTime = new Date(row.start).toISOString();
    text(label, date.format(row.start));
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 100 8');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const bar = document.createElementNS(ns, 'rect');
    bar.setAttribute('height', '8');
    bar.setAttribute('width', String(100 * row.value / max));
    svg.append(bar);
    const number = document.createElement('strong');
    text(number, fmt(row.value));
    button.append(number, svg, label);
    item.append(button);
    list.append(item);
  }
  plot.append(list);
}

byId('recharges-chart').addEventListener('click', event => {
  const metric = event.target.closest('[data-recharge-metric]')?.dataset.rechargeMetric;
  if (!['energy', 'cost', 'time'].includes(metric)) return;
  rechargeMetric = metric;
  renderRechargeChart(state.evsareRecharges.data || []);
});

function readEVsareData(kind, response) {
  const nullableString = (value) => value === null || typeof value === 'string';
  const invalid = () => new ApiError('La respuesta de EVsare no tiene el formato esperado. Puedes volver a consultar tu cuenta.', 200, 'BAD_RESPONSE');
  if (kind === 'profile') {
    const profile = response.profile;
    if (!profile || !nullableString(profile.name) || !nullableString(profile.email) || !(profile.privacyAccepted === null || typeof profile.privacyAccepted === 'boolean')) throw invalid();
    // Lista cerrada: nunca renderizar ni guardar en estado campos de tokens.
    return { name: profile.name, email: profile.email, privacyAccepted: profile.privacyAccepted };
  }
  if (response.source !== 'evsare' || response.scope !== 'own-IBILSARE' || response.coverage !== 'partial' || response.unitsVerified !== false || response.limit !== 20 || !Array.isArray(response.recharges)) throw invalid();
  const nullableDate = (value) => value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
  const seen = new Set();
  return response.recharges.slice(0, 20).flatMap((recharge) => {
    if (!recharge || !Number.isSafeInteger(recharge.id) || !nullableString(recharge.siteName) || !nullableString(recharge.terminalName) || !nullableDate(recharge.startedAt) || !nullableDate(recharge.endedAt)) throw invalid();
    if (seen.has(recharge.id)) return [];
    seen.add(recharge.id);
    return [{ id: recharge.id, siteName: recharge.siteName, terminalName: recharge.terminalName, startedAt: recharge.startedAt, endedAt: recharge.endedAt,
      ...Object.fromEntries(['reportedCost', 'reportedEnergy', 'energyKwh', 'costEur'].map(key => [key, Number.isFinite(recharge[key]) ? recharge[key] : null])) }];
  });
}

async function loadEVsareData(kind, fresh = false) {
  const key = kind === 'profile' ? 'evsareProfile' : 'evsareRecharges';
  const revision = accountRevision;
  const owner = { user: state.user, csrfToken: state.csrfToken };
  if (owner.user?.provider !== 'evsare' || !owner.csrfToken || state[key].status === 'loading') return;
  const recharges = kind === 'recharges';
  const stillCurrent = () => revision === accountRevision && sameSession(owner, state);
  state[key] = { ...state[key], status: 'loading', data: state[key].data ?? null, message: '', officialAction: false };
  renderEVsareAccount();
  if (recharges && chargers.data) renderChargerResults();
  const verifyOwner = async () => {
    const session = await api('/api/session');
    if (!stillCurrent()) return false;
    if (sameSession(owner, session)) return true;
    applySession(session);
    // La cuenta cambió fuera de esta pestaña. No asociar esta respuesta a ella.
    void refresh(true);
    return false;
  };
  try {
    if (!await verifyOwner() || !stillCurrent()) return;
    if (recharges && recentLocationsRestore) {
      await recentLocationsRestore;
      if (!stillCurrent()) return;
      if (cachedRecentLocations && chargers.data) renderChargerResults();
    }
    let response;
    let failure;
    try { response = await api((kind === 'profile' ? '/api/evsare/profile' : '/api/evsare/recharges') + (fresh ? '?fresh=1' : '')); }
    catch (error) { failure = error; }
    if (!await verifyOwner() || !stillCurrent()) return;
    if (failure) throw failure;
    const data = readEVsareData(kind, response);
    state[key] = { status: 'ready', data, message: '', readAt: Date.now(), officialAction: false };
    if (recharges) void saveRecentLocations(owner, summarizeRecentLocations(data, serverNow()), stillCurrent);
  } catch (error) {
    if (!stillCurrent()) return;
    if (recharges && (error?.code === 'EVSARE_REAUTH_REQUIRED' || needsOfficialAction(error))) clearRecentLocations();
    // Errores upstream independientes: no retirar /api/me, cookie o seguimientos.
    state[key] = { status: 'error', data: null, message: error instanceof ApiError ? evsareErrorMessage(error) : 'No se pudieron consultar estos datos. Inténtalo de nuevo.', readAt: null, officialAction: needsOfficialAction(error) };
  } finally {
    if (stillCurrent()) {
      renderEVsareAccount();
      if (recharges && chargers.data) renderChargerResults();
    }
  }
}

async function loadEVsareAccount(fresh = false) {
  if (state.user?.provider !== 'evsare' || !dataFresh() || evsareAccountLoading()) return;
  // Los dos resultados son independientes. Un fallo no oculta el otro éxito.
  await Promise.allSettled([loadEVsareData('profile', fresh), loadEVsareData('recharges', fresh)]);
}

function privateChargersEnabled() { return state.config?.mapStatus === 'private' && state.user?.provider === 'evsare'; }
function chargerSnapshotFresh() { return Boolean(chargers.data && !chargers.data.stale && dataFresh() && serverNow() - chargers.data.observedAt < 40000); }

function resetChargers() {
  closeRfidCards();
  if (byId('charge-dialog').open) byId('charge-dialog').close();
  chargers = emptyChargers();
  byId('chargers-search').value = '';
  for (const id of ['chargers-status', 'chargers-count']) text(byId(id), '');
  clearChargerResults();
}

function clearChargerResults() {
  chargerMap.clear();
  closeRfidCards();
  chargers.view = 'list';
  chargers.parkingSelection = null;
  chargers.actions = [];
  chargers.turnLink = null;
  chargers.results = [];
  for (const id of ['charger-sites', 'charger-site-details']) byId(id).replaceChildren();
  byId('charger-site-details').chargerSite = null;
  visible(byId('chargers-results'), false);
}

function chargerOwnerGuard() {
  const owner = { user: state.user, csrfToken: state.csrfToken };
  const panel = chargers;
  const own = () => panel === chargers && privateChargersEnabled() && sameSession(owner, state);
  const current = () => own() && !state.busy.has('auth');
  return { own, current, verify: async () => {
    if (!current()) return false;
    const session = await api('/api/session');
    if (!current()) return false;
    if (sameSession(owner, session)) return true;
    applySession(session);
    void refresh(true);
    return false;
  } };
}

function readChargers(response) {
  const observedAt = timestamp(response.observedAt) || timestamp(Date.parse(response.observedAt));
  if (!observedAt || !Number.isFinite(new Date(observedAt).getTime()) || !Array.isArray(response.sites)) throw new ApiError('EVsare no devolvió una lista de cargadores válida.', 200, 'BAD_RESPONSE');
  const array = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  const label = (value) => typeof value === 'string' ? value.trim() : '';
  const integer = (value) => Number.isSafeInteger(value) ? value : null;
  const status = (value) => typeof value === 'string' && Object.hasOwn(RESOURCE_STATES, value) ? value : 'UNKNOWN';
  // Conservar únicamente los datos de presentación y el identificador local de las acciones.
  const sites = array(response.sites).map((site) => ({
    id: typeof site.id === 'string' && site.id ? site.id : integer(site.id),
    zoneId: integer(site.zoneId) > 0 ? site.zoneId : null,
    name: label(site.name) || 'Ubicación sin nombre', unnamed: !label(site.name), address: label(site.address),
    mapGroup: site.mapGroup && label(site.mapGroup.id) && label(site.mapGroup.name) && label(site.mapGroup.label)
      ? { id: label(site.mapGroup.id), name: label(site.mapGroup.name), label: label(site.mapGroup.label) } : null,
    latitude: validCoordinates(site) ? site.latitude : null, longitude: validCoordinates(site) ? site.longitude : null,
    openingHours: label(site.openingHours),
    terminals: array(site.terminals).map((terminal) => ({
      id: typeof terminal.id === 'string' && /^t[1-9]\d*$/.test(terminal.id) ? terminal.id : null,
      name: label(terminal.name) || 'Terminal sin nombre', state: status(terminal.state),
      comingSoon: terminal.comingSoon === true,
      parcels: Array.isArray(terminal.parcels) ? [...new Set(terminal.parcels.filter(parcel => typeof parcel === 'string' && parcel.trim()))] : [],
      connectors: array(terminal.connectors).map((connector) => ({
        id: integer(connector.id),
        name: label(connector.name), label: label(connector.label), state: status(connector.state),
        remoteEnabled: connector.remoteEnabled ?? Number.isSafeInteger(connector.id),
        powerKw: Number.isFinite(connector.powerKw) && connector.powerKw > 0 ? connector.powerKw : null,
      })),
    })),
  }));
  return { observedAt, sites, stale: response.status === 'stale' };
}

async function loadChargers() {
  if (!privateChargersEnabled() || !dataFresh() || state.busy.has('auth') || chargers.inFlight) return;
  const guard = chargerOwnerGuard();
  chargers.inFlight = true;
  chargers.nextCheck = performance.now() + 14000;
  if (!chargers.data) chargers.status = 'loading';
  chargers.reconnect = false;
  renderChargers();
  try {
    if (!await guard.verify()) return;
    let response;
    let failure;
    try { response = await api('/api/evsare/chargers'); }
    catch (error) { failure = error; }
    if (!await guard.verify()) return;
    if (failure) throw failure;
    if (response.status === 'syncing') {
      chargers.status = 'syncing'; chargers.nextCheck = performance.now() + 4000;
      chargers.data = null; chargers.selected = null; clearChargerResults();
      return;
    }
    const previous = chargers.selected;
    const next = readChargers(response);
    const shape = sites => JSON.stringify(sites, (key, value) => key === 'state' ? undefined : value);
    // Una lectura de estado no sustituye nodos interactivos ni mueve el foco.
    if (chargers.data && shape(chargers.data.sites) === shape(next.sites)) {
      chargers.data.sites.forEach((site, i) => site.terminals.forEach((terminal, j) => {
        const update = next.sites[i].terminals[j];
        terminal.state = update.state;
        terminal.connectors.forEach((connector, k) => { connector.state = update.connectors[k].state; });
      }));
      next.sites = chargers.data.sites;
      chargers.data = next;
    } else {
      chargers.data = next;
      chargers.selected = previous?.id != null ? next.sites.find((site) => site.id === previous.id) : null;
      // Los índices de terminal solo identifican un terminal dentro de la misma lista.
      if (!chargers.selected || typeof chargers.parkingSelection === 'number') chargers.parkingSelection = null;
      renderChargerResults();
    }
    chargers.status = 'ready';
  } catch (error) {
    if (!guard.current()) return;
    chargers.status = 'error';
    chargers.data = null;
    chargers.selected = null;
    chargers.message = error instanceof ApiError ? evsareErrorMessage(error) : 'No se pudieron consultar tus cargadores. Inténtalo de nuevo.';
    chargers.reconnect = needsOfficialAction(error) || error.code === 'EVSARE_REAUTH_REQUIRED';
    clearChargerResults();
  } finally {
    if (guard.own()) chargers.inFlight = false;
    if (guard.current()) renderChargers();
    // Si el cierre de sesión falla mientras había una lectura en curso, permitir reintentar.
    else if (guard.own() && chargers.status === 'loading') chargers.status = 'idle';
  }
}

function chargerElement(tag, className, label) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  text(node, label);
  return node;
}

function chargerDistance(site) {
  const distance = distanceMeters(proximityPosition, site);
  if (distance == null) return '';
  if (distance < 1000) return `≈ ${Math.round(distance)} m`;
  return `≈ ${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(distance / 1000)} km`;
}

const normalizeSiteText = value => value.toLocaleLowerCase('es').normalize('NFD').replace(/\p{M}/gu, '');
const historySiteName = value => normalizeSiteText(value || '').trim().replace(/\s+/g, ' ');

const RECENT_LOCATIONS_KEY = 'alacarga.recent-locations.v1';
const RECENT_LOCATIONS_TTL = 15 * 60 * 1000;
const RECENT_LOCATIONS_LIMIT = 20; // /api/evsare/recharges
let cachedRecentLocations = null;
let recentLocationsExpiry;
let recentLocationsRestore;

function summarizeRecentLocations(recharges, now) {
  const entries = new Map(), seen = new Set();
  for (const charge of recharges.slice(0, RECENT_LOCATIONS_LIMIT)) {
    const name = historySiteName(charge.siteName);
    const endedAt = Date.parse(charge.endedAt), startedAt = Date.parse(charge.startedAt);
    if (!name || !Number.isFinite(endedAt) || endedAt <= 0 || endedAt > now || endedAt < startedAt || seen.has(charge.id)) continue;
    seen.add(charge.id);
    const previous = entries.get(name);
    entries.set(name, [name, (previous?.[1] || 0) + 1, Math.max(previous?.[2] || 0, endedAt)]);
  }
  return [...entries.values()];
}

function clearRecentLocations() {
  cachedRecentLocations = null;
  recentLocationsRestore = null;
  clearTimeout(recentLocationsExpiry);
  try { sessionStorage.removeItem(RECENT_LOCATIONS_KEY); }
  catch { /* El almacenamiento puede estar bloqueado. */ }
}

function showRecentLocationsCache([writtenAt, entries]) {
  clearTimeout(recentLocationsExpiry);
  const cache = cachedRecentLocations = { expiresAt: writtenAt + RECENT_LOCATIONS_TTL, entries };
  recentLocationsExpiry = setTimeout(() => {
    if (cachedRecentLocations !== cache) return;
    clearRecentLocations();
    if (chargers.data && chargers.usingRecentCache) renderChargerResults();
  }, Math.max(0, cache.expiresAt - Date.now()));
}

async function sealRecentLocations(owner, payload) {
  // La sesión emite un CSRF aleatorio por login. Solo se persiste un sello
  // HMAC limitado a este propósito, nunca el CSRF ni un identificador de cuenta.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(owner.csrfToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const tag = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify([RECENT_LOCATIONS_KEY, identityKey(owner.user), payload])));
  return Array.from(new Uint8Array(tag), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function restoreRecentLocations(owner, stillCurrent) {
  try {
    const raw = sessionStorage.getItem(RECENT_LOCATIONS_KEY);
    if (raw === null) return;
    if (raw.length > 16_384) throw new Error('Invalid cache');
    const { payload, tag } = JSON.parse(raw);
    if (!Array.isArray(payload) || payload.length !== 2 || typeof tag !== 'string' || !/^[a-f0-9]{64}$/.test(tag)) throw new Error('Invalid cache');
    const [writtenAt, entries] = payload;
    const age = Date.now() - writtenAt;
    if (!Number.isSafeInteger(writtenAt) || age < 0 || age >= RECENT_LOCATIONS_TTL || !Array.isArray(entries) || entries.length > RECENT_LOCATIONS_LIMIT ||
        entries.some(row => !Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string' || !row[0] || row[0].length > 256 || !Number.isSafeInteger(row[1]) || row[1] < 1 || row[1] > RECENT_LOCATIONS_LIMIT || !Number.isSafeInteger(row[2]) || row[2] <= 0) ||
        tag !== await sealRecentLocations(owner, payload)) throw new Error('Invalid cache');
    if (stillCurrent() && Date.now() < writtenAt + RECENT_LOCATIONS_TTL) showRecentLocationsCache(payload);
  } catch {
    if (stillCurrent()) clearRecentLocations();
  }
}

async function saveRecentLocations(owner, entries, stillCurrent) {
  clearRecentLocations(); // Un resultado vacío también reemplaza al resumen anterior.
  const safeEntries = entries.filter(([name]) => name.length <= 256);
  if (!safeEntries.length) return;
  const payload = [Date.now(), safeEntries];
  showRecentLocationsCache(payload);
  const cache = cachedRecentLocations;
  try {
    const tag = await sealRecentLocations(owner, payload);
    if (stillCurrent() && cachedRecentLocations === cache) sessionStorage.setItem(RECENT_LOCATIONS_KEY, JSON.stringify({ payload, tag }));
  } catch { /* Sin Web Crypto/almacenamiento no se restaura tras recargar. */ }
}

function usingRecentLocationsCache() {
  return Boolean(cachedRecentLocations && state.evsareRecharges.status !== 'ready' && Date.now() < cachedRecentLocations.expiresAt && dataFresh());
}

function chargerUseScores() {
  const byName = new Map(), completed = new Map(), lastCharge = new Map();
  for (const site of chargers.data.sites) {
    const name = historySiteName(site.name);
    if (name && !site.unnamed) byName.set(name, byName.has(name) ? null : site);
  }
  // Resolver coincidencias contra todo el catálogo, nunca contra el filtro visible.
  const entries = state.evsareRecharges.status === 'ready' ? summarizeRecentLocations(state.evsareRecharges.data, serverNow()) :
    usingRecentLocationsCache() ? cachedRecentLocations.entries : [];
  for (const [name, count, endedAt] of entries) {
    const site = byName.get(name);
    if (!site) continue;
    completed.set(site, count);
    lastCharge.set(site, endedAt);
  }
  const recent = [...lastCharge.keys()].sort((a, b) => lastCharge.get(b) - lastCharge.get(a));
  return { completed, recent };
}

function chargerSiteItem(site) {
  const item = chargerElement('li');
  const button = chargerElement('button', 'charger-site-button');
  button.type = 'button';
  button.chargerSite = site;
  button.setAttribute('aria-controls', 'charger-site-details');
  button.setAttribute('aria-pressed', String(site === chargers.selected));
  button.append(chargerElement('strong', '', site.name), chargerElement('span', 'charger-site-subtitle', chargerSiteSubtitle(site)));
  button.addEventListener('click', () => openChargerSite(site));
  item.append(button);
  return item;
}

function chargerSiteSubtitle(site) {
  return [site.address, chargerDistance(site)].filter(Boolean).join(' · ') || 'Dirección no informada';
}

function renderChargerList({ recent } = chargerUseScores()) {
  const matching = new Set(chargers.results);
  const favorites = chargers.results.filter(site => isFavoriteCharger(site.zoneId));
  const recentSites = recent.filter(site => matching.has(site) && !isFavoriteCharger(site.zoneId)).slice(0, 5);
  const grouped = new Set([...favorites, ...recentSites]);
  const otherSites = byProximity(chargers.results.filter(site => !grouped.has(site)), proximityPosition);
  const groups = [['Favoritos', favorites], ['Recientes', recentSites], ['Otras ubicaciones', otherSites]];
  const sites = groups.flatMap(([, entries]) => entries);
  const order = proximityPosition && otherSites.some(validCoordinates) ? ' · otras ubicaciones por distancia' : '';
  if (sites.length) text(byId('chargers-count'), `${sites.length} ${sites.length === 1 ? 'ubicación' : 'ubicaciones'}${order}`);
  const list = byId('charger-sites');
  const existing = new Map($$('.charger-site-button', list).map(button => [button.chargerSite, button.parentElement]));
  const oldGroups = [...list.children];
  const focus = list.contains(document.activeElement) ? document.activeElement : null;
  const scroll = list.scrollTop;
  const nextGroups = groups.filter(([, entries]) => entries.length).map(([label, entries]) => {
    let group = oldGroups.find(node => node.dataset.siteGroup === label);
    if (!group) {
      group = chargerElement('li', 'charger-sites-group');
      group.dataset.siteGroup = label;
      const heading = chargerElement('h4', 'charger-sites-label', label);
      heading.id = `charger-sites-${normalizeSiteText(label).replaceAll(' ', '-')}`;
      const nested = chargerElement('ul', 'charger-sites-entries');
      nested.setAttribute('role', 'list');
      nested.setAttribute('aria-labelledby', heading.id);
      group.append(heading, nested);
    }
    const rows = group.lastElementChild;
    const items = entries.map(site => existing.get(site) || chargerSiteItem(site));
    if (items.length !== rows.children.length || items.some((item, i) => item !== rows.children[i])) rows.replaceChildren(...items);
    return group;
  });
  if (nextGroups.length !== oldGroups.length || nextGroups.some((group, i) => group !== oldGroups[i])) list.replaceChildren(...nextGroups);
  for (const button of [...$$('.charger-site-button', list), ...$$('.charger-site-button', byId('charger-map-members'))])
    text(button.lastElementChild, chargerSiteSubtitle(button.chargerSite));
  list.scrollTop = scroll;
  if (focus && list.contains(focus) && document.activeElement !== focus) focus.focus({ preventScroll: true });
  return sites;
}

function renderChargerResults(openMap = false) {
  if (!chargers.data) return;
  const requestedZone = chargers.requestedZone;
  const requestedSite = requestedZone == null ? null : chargers.data.sites.find(site => site.zoneId === requestedZone);
  if (requestedZone != null) {
    chargers.requestedZone = null;
    if (requestedSite) {
      byId('chargers-search').value = '';
      chargers.onlyFavorites = false;
      chargers.selectionTouched = true;
    } else {
      feedback('La ubicación del turno ya no aparece en tus cargadores.', 'error');
    }
  }
  const query = normalizeSiteText(byId('chargers-search').value.trim());
  chargers.favoriteFilterKey = favoriteFilterKey();
  chargers.results = chargers.data.sites.filter(site => normalizeSiteText(`${site.name} ${site.address}`).includes(query) &&
    (!chargers.onlyFavorites || isFavoriteCharger(site.zoneId)));
  const favoritesFilter = byId('chargers-only-favorites');
  favoritesFilter.setAttribute('aria-pressed', String(Boolean(chargers.onlyFavorites)));
  const map = chargers.view === 'map';
  if (!map) chargers.mapSearchOpen = false;
  const searchOpen = Boolean(chargers.mapSearchOpen || query);
  visible(byId('charger-map-search'), map);
  visible(byId('charger-search-row'), !map || searchOpen);
  byId('charger-map-search').setAttribute('aria-expanded', String(map && searchOpen));
  text(byId('charger-map-search'), map && searchOpen ? 'Ocultar búsqueda' : 'Buscar en el mapa');
  byId('chargers-map-view').setAttribute('aria-expanded', String(map));
  text(byId('chargers-map-view').lastElementChild, map ? 'Cerrar mapa' : 'Ver mapa');
  const scores = chargerUseScores();
  chargers.usingRecentCache = usingRecentLocationsCache();
  const sites = renderChargerList(scores);
  if (!sites.length) text(byId('chargers-count'), query ? 'No hay ubicaciones que coincidan con la búsqueda.' : 'EVsare no muestra ubicaciones para esta cuenta.');
  visible(byId('charger-sites'), Boolean(sites.length));
  visible(byId('charger-map-list-heading'), map && Boolean(sites.length));
  visible(byId('charger-map'), map);
  if (map) {
    chargerMap.show(chargers.results);
    // Solo una acción explícita carga teselas; el encuadre general ignora el filtro y la posición.
    if (openMap === true && chargers.data.sites.some(validCoordinates)) chargerMap.open(chargers.data.sites);
  }
  const previous = sites.includes(chargers.selected) &&
    (!chargers.historyDefaultFromCache || chargers.usingRecentCache || chargers.selectionTouched) ? chargers.selected : null;
  let preferred;
  if (!chargers.selectionTouched && !chargers.historyDefaultResolved && sites.length && !query) {
    const charges = site => scores.completed.get(site) || 0;
    const rank = new Map(scores.recent.map((site, index) => [site, index]));
    preferred = sites.filter(site => charges(site))
      .sort((a, b) => charges(b) - charges(a) || rank.get(a) - rank.get(b))[0];
    chargers.historyDefaultResolved = state.evsareRecharges.status === 'ready';
  }
  const selected = requestedSite || preferred || previous || sites[0] || null;
  chargers.historyDefaultFromCache = Boolean(!chargers.selectionTouched && chargers.usingRecentCache && (preferred || (previous && chargers.historyDefaultFromCache)));
  if (byId('charger-site-details').chargerSite !== selected) selectChargerSite(selected);
}

function openChargerSite(site) {
  if (!privateChargersEnabled() || !chargers.results.includes(site)) return;
  chargers.selectionTouched = true;
  selectChargerSite(site);
}

function selectChargerSite(site) {
  if (site !== chargers.selected) chargers.parkingSelection = null;
  closeRfidCards();
  chargers.selected = site || null;
  for (const button of $$('.charger-site-button', byId('charger-sites'))) button.setAttribute('aria-pressed', String(button.chargerSite === site));
  chargerMap.select(site);
  const container = byId('charger-site-details');
  container.chargerSite = chargers.selected;
  container.replaceChildren();
  chargers.actions = [];
  chargers.turnLink = null;
  if (!site) return;
  const headline = chargerElement('div', 'charger-detail-heading');
  headline.append(chargerElement('p', 'eyebrow section-eyebrow', 'UBICACIÓN EVSARE'), chargerElement('h3', '', site.name));
  if (site.address) headline.append(chargerElement('p', 'subtle', site.address));
  if (site.openingHours) headline.append(chargerElement('p', 'fine-print charger-hours', `Horario: ${site.openingHours}`));
  const localTurn = chargerElement('a', 'text-link', 'Gestionar en Mi turno');
  localTurn.href = '#my-turn';
  headline.append(localTurn);
  chargers.turnLink = localTurn;
  container.append(headline);
  if (site.zoneId != null) {
    const actions = chargerElement('div', 'charger-actions');
    const favorite = chargerElement('button', 'button button-outline button-small favorite-button charger-favorite-heart');
    const heart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const heartShape = document.createElementNS(heart.namespaceURI, 'use');
    heart.classList.add('icon');
    heart.setAttribute('aria-hidden', 'true');
    heartShape.setAttribute('href', '#i-heart');
    heart.append(heartShape);
    favorite.append(heart, chargerElement('span'));
    const follow = chargerElement('button', 'button button-outline button-small follow-button');
    const join = chargerElement('button', 'button button-primary button-small', 'Ponerme en cola');
    favorite.type = follow.type = join.type = 'button';
    join.setAttribute('aria-label', `Ponerme en cola en ${site.name}`);
    favorite.addEventListener('click', () => chargerFavorite(site.zoneId));
    follow.addEventListener('click', () => chargerAction(site.zoneId, false));
    join.addEventListener('click', () => chargerAction(site.zoneId, true));
    actions.append(favorite, follow, join);
    headline.append(actions);
    chargers.actions.push({ zoneId: site.zoneId, name: site.name, favorite, follow, join });
  } else headline.append(chargerElement('p', 'fine-print', 'Esta ubicación aún no admite favoritos, avisos ni cola comunitaria.'));
  container.append(renderParking(site));
  renderChargerControls();
}

function renderChargerTerminal(terminal, terminalIndex) {
  const article = chargerElement('article', 'charger-terminal');
  const header = chargerElement('div', 'charger-terminal-heading');
  header.append(chargerElement('h5', '', terminal.name));
  article.append(header);
  if (terminal.parcels.length) article.append(chargerElement('p', 'fine-print charger-terminal-parcels', `${terminal.parcels.length === 1 ? 'Plaza' : 'Plazas'}: ${terminal.parcels.join(', ')}`));
  if (terminal.connectors.length) {
    const connectors = chargerElement('ul', 'charger-connector-list');
    connectors.setAttribute('aria-label', `Cargadores de ${terminal.name}`);
    for (const [connectorIndex, connector] of terminal.connectors.entries()) {
      const name = connector.label ? `Cargador ${connector.label}${connector.name && connector.name !== connector.label ? ` · ${connector.name}` : ''}` : connector.name || 'Cargador';
      const power = connector.powerKw == null ? '' : ` · ${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 3 }).format(connector.powerKw)} kW`;
      const row = chargerElement('li', '', `${name}${power}`);
      const stateText = chargerElement('span', '', RESOURCE_STATES[connector.state]);
      stateText.dataset.chargerState = connector.state;
      stateText.dataset.terminalIndex = terminalIndex;
      stateText.dataset.connectorIndex = connectorIndex;
      row.append(stateText); connectors.append(row);
    }
    article.append(connectors);
  } else article.append(chargerElement('p', 'fine-print', 'Conectores no informados.'));
  return article;
}

function chargerTone(status) {
  return status === 'AVAILABLE' ? 'free' : ['BUSY', 'RECHARGING', 'RESERVED', 'MAINTENANCE'].includes(status) ? 'blocked' : 'unknown';
}

function renderChargerIndicator(node, status, surface = node.parentElement) {
  const description = RESOURCE_STATES[status] || 'Sin verificar';
  surface.dataset.tone = chargerTone(status);
  surface.classList.add('charger-state-surface');
  if (surface === node) return;
  surface.title = description;
  if (surface.matches('button[aria-label]')) surface.setAttribute('aria-description', description);
  node.classList.add('sr-only');
  text(node, description);
}

function renderParking(site) {
  const parking = chargerElement('section', 'charger-parking');
  const heading = chargerElement('h4', '', 'Estacionamiento de recarga');
  heading.id = 'charger-parking-heading';
  parking.setAttribute('aria-labelledby', heading.id);
  parking.append(heading);
  if (!site.terminals.length) {
    parking.append(chargerElement('p', 'subtle', 'EVsare no informa de terminales para esta ubicación.'));
    return parking;
  }
  const legend = chargerElement('div', 'charger-state-legend');
  for (const [status, name] of [['AVAILABLE', 'Libre'], ['BUSY', 'Ocupado o no disponible'], ['UNVERIFIED', 'Sin verificar']]) {
    const item = chargerElement('span');
    const indicator = chargerElement('span', 'charger-state-swatch');
    renderChargerIndicator(indicator, status, indicator);
    indicator.setAttribute('aria-hidden', 'true');
    item.append(indicator, chargerElement('span', '', name));
    legend.append(item);
  }
  parking.append(legend);
  const sort = new Intl.Collator('es', { numeric: true });
  const mapped = site.terminals.filter(terminal => terminal.parcels.length)
    .sort((a, b) => sort.compare(a.parcels[0], b.parcels[0]));
  const parcels = mapped.flatMap(terminal => terminal.parcels);
  const unmapped = site.terminals.flatMap((terminal, index) => terminal.parcels.length ? [] : [index]);
  const pairs = site.terminals.flatMap((terminal, index) => {
    if (!/^IN\d+\b/i.test(terminal.name)) return [];
    const a = terminal.connectors.map((c, connector) => ({ c, connector })).filter(({ c }) => c.label === 'A');
    const b = terminal.connectors.map((c, connector) => ({ c, connector })).filter(({ c }) => c.label === 'B');
    return a.length === 1 && b.length === 1 ? [{ name: terminal.name, values: [...a, ...b].map(({ connector }) => `connector:${index}:${connector}`) }] : [];
  });
  const connectorSelection = value => {
    const match = typeof value === 'string' && /^connector:(\d+):(\d+)$/.exec(value);
    return match ? { terminalIndex: Number(match[1]), connectorIndex: Number(match[2]) } : null;
  };
  // Un identificador de plaza es una cadena; un terminal sin plaza se selecciona por índice.
  if (![...parcels, ...unmapped, ...pairs.flatMap(pair => pair.values)].includes(chargers.parkingSelection)) chargers.parkingSelection = null;
  const details = chargerElement('details', 'charger-terminal-details');
  details.id = 'charger-parking-terminals';
  const summary = chargerElement('summary');
  const terminals = chargerElement('div');
  details.append(summary, terminals);
  const bays = chargerElement('div', 'charger-parking-bays');
  const buttons = [];
  function drawTerminals() {
    closeRfidCards();
    const selection = chargers.parkingSelection;
    for (const [button, value] of buttons) button.setAttribute('aria-pressed', String(value === selection));
    visible(allTerminals, selection !== null);
    const direct = connectorSelection(selection);
    text(summary, direct ? `${site.terminals[direct.terminalIndex].name} · ${site.terminals[direct.terminalIndex].connectors[direct.connectorIndex].label}` : selection == null ? 'Todos los cargadores de la ubicación' : typeof selection === 'string' ? `Cargadores de la plaza ${selection}` : site.terminals[selection].name);
    terminals.replaceChildren(...site.terminals.flatMap((terminal, index) =>
      selection == null || selection === index || direct?.terminalIndex === index || terminal.parcels.includes(selection) ? [renderChargerTerminal(terminal, index)] : []));
  }

  function selectionButton(value, className, label, accessibleName) {
    const button = chargerElement('button', className, label);
    button.type = 'button';
    if (accessibleName) button.setAttribute('aria-label', accessibleName);
    button.setAttribute('aria-controls', details.id);
    button.addEventListener('click', () => {
      chargers.parkingSelection = value;
      drawTerminals();
      renderChargerControls();
      details.open = true;
      if (value !== null) openChargeDialog(site, value, connectorSelection(value));
      else summary.focus();
    });
    buttons.push([button, value]);
    return button;
  }

  const note = chargerElement('p', 'fine-print', 'Esquema orientativo, no es un plano real. Las plazas se agrupan por terminal.');
  note.id = 'charger-parking-note';
  const lanes = chargerElement('div', 'charger-parking-lanes');
  lanes.setAttribute('role', 'region');
  lanes.setAttribute('aria-label', 'Cuadrícula de plazas y terminales de recarga');
  lanes.setAttribute('aria-describedby', note.id);
  // Recorrer las filas de izquierda a derecha sin dividir los grupos de un terminal.
  function addLanes(label, groups, limit, makeButton) {
    if (!groups.length) return;
    lanes.append(chargerElement('h5', 'charger-parking-group', label));
    const track = chargerElement('div', 'charger-parking-track');
    const columns = groups.reduce((max, group) => Math.max(max, group.values.length), limit);
    track.style.setProperty('--parking-columns', columns);
    let row, used = 0, rowCount = 0;
    for (const { name, values } of groups) {
      if (!row || used + values.length > limit) {
        if (rowCount && rowCount % 2 === 0 && !/\btecnologia\s*-?\s*1b\b/.test(normalizeSiteText(site.name))) {
          const aisle = chargerElement('div', 'charger-parking-aisle', 'Pasillo');
          aisle.setAttribute('aria-hidden', 'true');
          track.append(aisle);
        }
        row = chargerElement('div', 'charger-parking-row');
        track.append(row);
        used = 0;
        rowCount++;
      }
      const group = chargerElement('div', 'charger-parking-terminal-group');
      if (name) {
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', name);
      }
      group.style.setProperty('--parking-span', values.length);
      group.append(...values.map(makeButton));
      row.append(group);
      used += values.length;
    }
    lanes.append(track);
  }
  const allTerminals = selectionButton(null, 'text-button', 'Ver todos los cargadores');
  bays.append(allTerminals, lanes);
  addLanes('Cargadores A y B', pairs, 4, value => {
    const { terminalIndex, connectorIndex } = connectorSelection(value);
    const terminal = site.terminals[terminalIndex], connector = terminal.connectors[connectorIndex];
    const label = `${terminal.name.split(/\s/)[0]} · ${connector.label}`;
    const button = selectionButton(value, 'charger-bay charger-bay-terminal', label, label);
    const stateText = chargerElement('small');
    stateText.dataset.chargerState = connector.state;
    stateText.dataset.terminalIndex = terminalIndex;
    stateText.dataset.connectorIndex = connectorIndex;
    button.append(stateText);
    return button;
  });
  addLanes('Plazas verificadas', mapped.map(terminal => ({ name: terminal.name, values: terminal.parcels })), 6,
    parcel => {
      const button = selectionButton(parcel, 'charger-bay charger-bay-parcel', parcel, `Plaza ${parcel}`);
      const matches = site.terminals.flatMap((terminal, index) => terminal.parcels.includes(parcel) ? [index] : []);
      const stateText = chargerElement('small');
      stateText.dataset.chargerState = 'UNKNOWN';
      if (matches.length === 1) {
        const [index] = matches;
        const terminal = site.terminals[index];
        // A pair of parcel labels is not evidence of a per-plaza connector mapping.
        if (terminal.parcels.length === 1 || terminal.connectors.length > 1) {
          stateText.dataset.terminalIndex = index;
          if (terminal.parcels.length !== 1) stateText.dataset.sharedTerminal = 'true';
        }
      }
      button.append(stateText);
      return button;
    });
  addLanes('Otros cargadores', unmapped.filter(index => !pairs.some(pair => pair.values.some(value => connectorSelection(value).terminalIndex === index))).map(index => ({ values: [index] })), 3, (index) => {
    const { name, connectors } = site.terminals[index];
    const button = selectionButton(index, 'charger-bay charger-bay-terminal');
    const labels = [...new Set(connectors.map(connector => connector.label).filter(Boolean))];
    button.append(chargerElement('span', '', name));
    if (labels.length) button.append(chargerElement('small', '', labels.join(' · ')));
    const stateText = chargerElement('span');
    stateText.dataset.chargerState = site.terminals[index].state;
    stateText.dataset.terminalIndex = index;
    button.append(stateText);
    return button;
  });
  drawTerminals();
  parking.append(note, bays, details);
  return parking;
}

function closeRfidCards() {
  chargers.rfid?.close();
  chargers.rfid = null;
}

const RFID_REVEAL_TTL_MS = 120000;

function rfidCardsPanel() {
  const panel = chargerElement('div', 'charger-rfid');
  panel.hidden = state.config?.rfidMode !== 'read-only';
  const result = chargerElement('div', 'charger-rfid-result');
  result.id = 'profile-rfid-result';
  const status = chargerElement('p', 'fine-print');
  status.setAttribute('role', 'status');
  const cards = chargerElement('ul');
  result.append(status, cards);
  panel.append(chargerElement('h3', '', 'Tarjetas de recarga'), result);
  panel.loadCards = async (fresh = false) => {
    if (chargers.rfid || state.config?.rfidMode !== 'read-only' || !privateChargersEnabled() || !dataFresh() || state.busy.has('auth')) return;
    const guard = chargerOwnerGuard();
    const clearReveals = [];
    const request = { close() {
      for (const clear of clearReveals) clear();
      text(status, '');
      cards.replaceChildren();
    } };
    chargers.rfid = request;
    const current = () => chargers.rfid === request && guard.current() && state.config?.rfidMode === 'read-only';
    text(status, 'Consultando tus tarjetas…');
    try {
      if (!await guard.verify() || !current()) return;
      const response = await api('/api/evsare/rfid-cards' + (fresh ? '?fresh=1' : ''));
      if (!current() || !await guard.verify() || !current()) return;
      if (!Array.isArray(response.cards)) throw new Error('Respuesta RFID no válida.');
      for (const card of response.cards) {
        if (card?.label !== 'Tarjeta RFID' || typeof card.ending !== 'string' || !/^[0-9A-Za-z]{4}$/.test(card.ending)) continue;
        const item = chargerElement('li', 'rfid-card');
        const masked = `•••• ${card.ending}`;
        const number = chargerElement('strong', '', masked);
        const reveal = chargerElement('button', 'text-button rfid-reveal', 'Mostrar número');
        reveal.type = 'button';
        reveal.setAttribute('aria-pressed', 'false');
        let cachedNumber = null, expiresAt = 0, expiryTimer;
        const hide = () => {
          text(number, masked); text(reveal, 'Mostrar número'); reveal.setAttribute('aria-pressed', 'false');
        };
        const clear = () => {
          clearTimeout(expiryTimer);
          cachedNumber = null;
          expiresAt = 0;
          hide();
        };
        clearReveals.push(clear);
        const show = value => {
          text(number, value); text(reveal, 'Ocultar número'); reveal.setAttribute('aria-pressed', 'true');
        };
        reveal.addEventListener('click', async () => {
          if (reveal.getAttribute('aria-pressed') === 'true') {
            hide(); return;
          }
          if (!current() || document.body.dataset.privatePage !== 'account-card') return;
          if (cachedNumber !== null && performance.now() < expiresAt) { show(cachedNumber); return; }
          clear();
          disabled(reveal, true);
          try {
            if (!await guard.verify() || !current()) return;
            const response = await mutate('/api/evsare/rfid-cards/reveal', { ending: card.ending });
            if (!current() || !await guard.verify() || !current() || document.body.dataset.privatePage !== 'account-card') return;
            if (typeof response.number !== 'string' || !/^[A-Z0-9]{5,64}$/i.test(response.number)) throw new Error();
            cachedNumber = response.number;
            expiresAt = performance.now() + RFID_REVEAL_TTL_MS;
            expiryTimer = setTimeout(clear, RFID_REVEAL_TTL_MS);
            show(cachedNumber);
          } catch (error) { if (current()) text(status, error?.code === 'RFID_NUMBER_UNAVAILABLE' ? 'EVsare no ha facilitado el número RFID de esta tarjeta.' : 'No se pudo mostrar el número de esta tarjeta.'); }
          finally { if (current()) disabled(reveal, false); }
        });
        item.append(chargerElement('small', '', 'EVSARE · RFID'), number, reveal);
        cards.append(item);
      }
      text(status, cards.childElementCount ? '' : 'EVsare no devolvió tarjetas para esta cuenta.');
    } catch {
      if (current()) text(status, 'No se pudieron consultar tus tarjetas. Vuelve a intentarlo.');
    }
  };
  return panel;
}

let chargeIntent = null;
const chargeDialog = byId('charge-dialog');

function chargeMessage(id, message, kind = 'info') {
  const node = byId(id);
  node.dataset.kind = kind;
  text(node, message);
}

function openChargeDialog(site, selection, direct = null) {
  const options = byId('charge-options');
  options.replaceChildren();
  chargeMessage('charge-result', '');
  resetChargeRecovery();
  const parcel = direct ? ` · ${site.terminals[direct.terminalIndex].name} · Conector ${site.terminals[direct.terminalIndex].connectors[direct.connectorIndex].label}` : typeof selection === 'string' ? ` · Parcela ${selection}` : '';
  text(byId('charge-place'), `${site.name}${parcel}`);
  const terminals = direct ? [site.terminals[direct.terminalIndex]] : site.terminals.filter((terminal, index) => index === selection || terminal.parcels.includes(selection));
  const enabled = state.config?.remoteCharge === true && chargerSnapshotFresh() && Number.isSafeInteger(site.zoneId);
  const connectors = terminals.flatMap(terminal => terminal.connectors.filter((connector, index) =>
    (!direct || direct.connectorIndex === index) && connector.label && terminal.connectors.filter(c => c.label === connector.label).length === 1)
    .map(connector => ({ terminal, connector, selectable: Boolean(enabled && terminal.id && Number.isSafeInteger(connector.id) && connector.state === 'AVAILABLE') })));
  const guard = chargerOwnerGuard();
  chargeIntent = { site, guard, choice: null, pending: false, attempted: false };
  const choose = (choice) => {
    chargeIntent.choice = choice;
    for (const option of options.children) option.setAttribute('aria-pressed', String(option.choice === choice));
    disabled(byId('charge-submit'), !choice.selectable || chargeIntent.pending);
  };
  for (const choice of connectors) {
    const { terminal, connector } = choice;
    const label = [terminal.name.split(/\s+Parcelas?\b/i)[0].trim(), `Conector ${connector.label}`, connector.name].filter(Boolean).join(' · ');
    const button = chargerElement('button', 'button button-outline', label);
    button.type = 'button';
    button.choice = choice;
    button.setAttribute('aria-pressed', 'false');
    const indicator = chargerElement('span');
    button.append(indicator);
    renderChargerIndicator(indicator, chargerSnapshotFresh() ? connector.state : 'UNVERIFIED');
    button.addEventListener('click', () => choose(choice));
    options.append(button);
  }
  const available = connectors.filter(choice => choice.selectable);
  const missingLabel = terminals.some(terminal => terminal.connectors.length > 0) && connectors.length === 0;
  chargeMessage('charge-help', missingLabel ? 'La plaza está seleccionada, pero EVsare no indica cuál de las tomas le corresponde. No se puede iniciar la carga desde aquí.'
    : state.config?.remoteCharge !== true ? 'El inicio de carga desde esta web no está habilitado.'
    : terminals.length && terminals.every(terminal => terminal.comingSoon) ? 'Próxima apertura: EVsare todavía no permite cargar en este punto.'
    : !chargerSnapshotFresh() ? 'Actualiza los cargadores para comprobar el estado antes de iniciar la carga.'
    : !available.length && connectors.some(choice => choice.connector.remoteEnabled && ['UNKNOWN', 'UNVERIFIED', 'STALE'].includes(choice.connector.state)) ? 'EVsare no confirma que esta toma esté libre.'
    : !available.length && connectors.some(choice => choice.connector.remoteEnabled) ? 'En este momento no hay una toma libre confirmada.'
    : !available.length ? 'Esta toma no admite inicio desde la web.'
    : 'Antes de pulsar Cargar, comprueba que tu coche esté enchufado al conector indicado. Se enviará la orden a EVsare con la tarjeta vinculada a tu cuenta.');
  disabled(byId('charge-close'), false);
  disabled(byId('charge-submit'), true);
  // Solo un clic explícito sobre A/B confirma cuál es el conector físico.
  if (direct && connectors.length === 1) choose(connectors[0]);
  if (!chargeDialog.open) chargeDialog.showModal();
  byId('charge-close').focus();
  if (state.config?.remoteCharge === true) void readChargeGuard(chargeIntent);
}

function resetChargeRecovery(visibleRecovery = false) {
  visible(byId('charge-recovery'), visibleRecovery);
  text(byId('charge-check'), 'Actualizar estado');
  visible(byId('charge-finish-area'), false);
  disabled(byId('charge-check'), false);
  byId('charge-finish-confirm').checked = false;
  disabled(byId('charge-finish'), true);
  chargeMessage('charge-check-result', '');
}

function isChargeDialogCurrent(intent) {
  return Boolean(intent && chargeIntent === intent && chargeDialog.open && intent.guard.current());
}

function applyChargeReconciliation(intent, result) {
  resetChargeRecovery(true);
  intent.reconciliation = result;
  chargeMessage('charge-result', ({ NONE: '', ACTIVE: 'EVsare muestra una recarga en curso.',
    FINISHED: 'La recarga ha finalizado.',
    NOT_FOUND: 'Inicio sin confirmar. Comprueba si el coche está cargando.',
    AMBIGUOUS: 'No se pudo confirmar la carga. Comprueba el coche.' })[result.state] ?? 'No se pudo comprobar la carga.');
  if (result.state === 'NONE') resetChargeRecovery();
  visible(byId('charge-finish-area'), result.state === 'ACTIVE' && result.canFinish !== false && Number.isInteger(result.rechargeId));
  if (result.state === 'ACTIVE' && result.canFinish === false) chargeMessage('charge-check-result', 'Hay una orden de finalización pendiente de comprobar. No vuelvas a enviarla; consulta EVsare.');
}

async function checkChargeRecovery(intent) {
  if (!isChargeDialogCurrent(intent) || intent.pending || intent.checking) return;
  const check = (intent.recoveryCheck ?? 0) + 1;
  intent.recoveryCheck = check;
  intent.checking = true;
  intent.reconciliation = null;
  resetChargeRecovery(true);
  disabled(byId('charge-check'), true);
  chargeMessage('charge-result', 'Comprobando la carga…', 'pending');
  try {
    const result = await api('/api/evsare/start-charge/check');
    if (isChargeDialogCurrent(intent) && !intent.pending && intent.recoveryCheck === check) applyChargeReconciliation(intent, result);
  } catch (error) {
    if (isChargeDialogCurrent(intent) && !intent.pending && intent.recoveryCheck === check) chargeMessage('charge-result', 'No se pudo comprobar la carga. Comprueba el coche.');
  } finally {
    intent.checking = false;
    if (isChargeDialogCurrent(intent) && !intent.pending) disabled(byId('charge-check'), false);
  }
}

byId('charge-check').addEventListener('click', () => void checkChargeRecovery(chargeIntent));
{
  const confirm = byId('charge-finish-confirm');
  const button = byId('charge-finish');
  confirm.addEventListener('change', () => disabled(button, !confirm.checked || !chargeIntent?.reconciliation || chargeIntent.pending));
  button.addEventListener('click', async () => {
    const intent = chargeIntent;
    const result = intent?.reconciliation;
    if (!isChargeDialogCurrent(intent) || !confirm.checked || intent.pending || intent.checking || !result) return;
    if (result.state !== 'ACTIVE' || result.canFinish === false || !Number.isInteger(result.rechargeId)) return;
    intent.pending = true;
    resetChargeRecovery(true);
    disabled(byId('charge-check'), true);
    disabled(byId('charge-close'), true);
    disabled(byId('charge-submit'), true);
    chargeMessage('charge-check-result', 'Enviando a EVsare la orden de finalizar…', 'pending');
    try {
      if (!await intent.guard.verify() || !isChargeDialogCurrent(intent)) return;
      await mutate('/api/evsare/start-charge/finish', { rechargeId: result.rechargeId });
      if (!isChargeDialogCurrent(intent)) return;
      intent.reconciliation = null;
      chargeMessage('charge-check-result', 'Solicitud de fin enviada. Consulta la última orden para ver el resultado.', 'success');
    } catch (error) {
      if (isChargeDialogCurrent(intent)) chargeMessage('charge-check-result', error instanceof ApiError ? error.message : 'No se pudo confirmar el resultado. Comprueba con EVsare antes de repetir.', 'error');
    } finally {
      intent.pending = false;
      if (isChargeDialogCurrent(intent)) { disabled(byId('charge-check'), false); disabled(byId('charge-close'), false); disabled(byId('charge-submit'), !intent.choice?.selectable); }
    }
  });
}

async function readChargeGuard(intent) {
  const still = () => chargeIntent === intent && chargeDialog.open && intent.guard.current();
  try {
    const { status } = await api('/api/evsare/start-charge/status');
    if (!still() || intent.pending || intent.attempted || intent.checking) return;
    resetChargeRecovery(status !== null);
    chargeMessage('charge-result', status === 'UNCONFIRMED' ? 'Inicio sin confirmar. Comprueba si el coche está cargando.'
      : status === 'ACCEPTED' ? 'Última orden: inicio confirmado por EVsare.'
      : status === 'REJECTED' ? 'EVsare rechazó la orden anterior y confirmó que no se inició la carga.'
      : '');
    if (status === 'UNCONFIRMED' || status === 'ACCEPTED') await checkChargeRecovery(intent);
  } catch {
    if (!still() || intent.pending || intent.attempted || intent.checking) return;
    resetChargeRecovery(true);
    chargeMessage('charge-result', 'No se pudo consultar el registro de la orden anterior.', 'error');
  }
}

byId('charge-close').addEventListener('click', () => chargeDialog.close());
chargeDialog.addEventListener('cancel', event => { if (chargeIntent?.pending) event.preventDefault(); });
chargeDialog.addEventListener('close', () => { chargeIntent = null; });
byId('charge-submit').addEventListener('click', async () => {
  const intent = chargeIntent;
  if (!intent?.choice?.selectable || intent.pending || state.config?.remoteCharge !== true || !chooserStillValid(intent)) return;
  intent.pending = intent.attempted = true;
  intent.recoveryCheck = (intent.recoveryCheck ?? 0) + 1;
  intent.reconciliation = null;
  resetChargeRecovery();
  disabled(byId('charge-submit'), true);
  disabled(byId('charge-close'), true);
  for (const option of byId('charge-options').children) disabled(option, true);
  chargeMessage('charge-result', 'Comprobando la sesión de EVsare…', 'pending');
  let dispatched = false, checkAfter = false;
  try {
    if (!await intent.guard.verify() || !chooserStillValid(intent)) return;
    const { terminal, connector } = intent.choice;
    dispatched = true;
    chargeMessage('charge-result', 'Enviando la orden de carga a EVsare…', 'pending');
    const result = await mutate('/api/evsare/start-charge', { zoneId: intent.site.zoneId, terminalId: terminal.id, connectorId: connector.id });
    if (chargeIntent !== intent || !intent.guard.current()) return;
    resetChargeRecovery(true);
    checkAfter = true;
    chargeMessage('charge-result', result.started === true ? 'EVsare ha confirmado el inicio. Comprueba que tu coche esté cargando.' : 'EVsare no ha confirmado el inicio. Comprueba el coche antes de repetir la solicitud.', result.started === true ? 'success' : 'info');
  } catch (error) {
    if (chargeIntent !== intent || !intent.guard.current()) return;
    if (dispatched) resetChargeRecovery(true);
    const uncertain = error?.code === 'REMOTE_CHARGE_UNCONFIRMED' || (dispatched && error?.status === 0);
    checkAfter = uncertain;
    chargeMessage('charge-result', uncertain ? 'Inicio sin confirmar. Comprueba si el coche está cargando.'
      : error instanceof ApiError && /^(REMOTE_CHARGE_|EVSARE_CHARGE_)/.test(error.code || '') ? error.message
      : dispatched ? 'Inicio sin confirmar. Comprueba si el coche está cargando.' : 'No se ha enviado la orden.', uncertain ? 'info' : 'error');
  } finally {
    intent.pending = false;
    if (chargeIntent === intent && intent.guard.current()) {
      if (byId('charge-result').dataset.kind === 'pending') chargeMessage('charge-result', 'No se ha enviado la orden.');
      disabled(byId('charge-close'), false);
      disabled(byId('charge-submit'), !intent.choice?.selectable || !chooserStillValid(intent));
      for (const option of byId('charge-options').children) disabled(option, false);
      if (checkAfter) void checkChargeRecovery(intent);
    }
  }
});

function chooserStillValid(intent) {
  return chargeDialog.open && chargeIntent === intent && intent.guard.current() && chargerSnapshotFresh() && chargers.selected === intent.site && intent.choice.connector.state === 'AVAILABLE';
}

function isFollowingCharger(zoneId) { return (state.me?.subscriptions || []).some((id) => Number(id) === zoneId); }
function chargerFavorites() { return Array.isArray(state.me?.favorites) ? state.me.favorites : []; }
function favoriteFilterKey() { return JSON.stringify(chargerFavorites()); }
function isFavoriteCharger(zoneId) { return zoneId != null && chargerFavorites().some((id) => Number(id) === zoneId); }

function renderChargerControls() {
  renderRejoinControl();
  const loading = chargers.status === 'loading';
  const readBlocked = !privateChargersEnabled() || !dataFresh() || state.busy.has('auth');
  disabled(byId('chargers-refresh'), readBlocked || chargers.inFlight);
  byId('chargers-refresh').setAttribute('aria-busy', String(chargers.inFlight));
  disabled(byId('chargers-reconnect'), readBlocked || loading);
  visible(byId('chargers-map-view'), chargers.view === 'map' || Boolean(chargers.data?.sites.some(validCoordinates)));
  const current = chargerSnapshotFresh();
  const writeBlocked = !canWrite() || readBlocked || loading || !current;
  if (state.config?.rfidMode !== 'read-only' || readBlocked) closeRfidCards();
  for (const panel of $$('.charger-rfid', byId('charger-site-details'))) {
    panel.hidden = state.config?.rfidMode !== 'read-only';
    disabled($('button', panel), readBlocked);
  }
  for (const node of $$('[data-charger-state]', byId('charger-site-details'))) {
    const terminal = chargers.selected?.terminals[node.dataset.terminalIndex];
    let status = (node.dataset.connectorIndex === undefined ? terminal?.state : terminal?.connectors[node.dataset.connectorIndex]?.state) ?? 'UNKNOWN';
    if (node.dataset.sharedTerminal === 'true' && !terminal?.connectors.every(c => chargerTone(c.state) === chargerTone(status))) status = 'UNKNOWN';
    renderChargerIndicator(node, current ? status : 'UNVERIFIED');
  }
  const active = hasActiveTurn();
  visible(chargers.turnLink, active);
  for (const { zoneId, name, favorite, follow, join } of chargers.actions) {
    const saved = isFavoriteCharger(zoneId);
    const favoriteLabel = saved ? 'Quitar favorito' : 'Guardar favorito';
    text(favorite.lastElementChild, favoriteLabel);
    favorite.setAttribute('aria-label', `${favoriteLabel}: ${name}`);
    favorite.setAttribute('aria-pressed', String(saved));
    disabled(favorite, !canWrite() || readBlocked || state.busy.has('favorite'));
    const following = isFollowingCharger(zoneId);
    const label = following ? 'Quitar aviso' : 'Avísame cuando quede libre';
    text(follow, label);
    follow.setAttribute('aria-label', `${label}: ${name}`);
    follow.setAttribute('aria-pressed', String(following));
    const free = siteHasFreeConnector(zoneId);
    disabled(follow, (following ? !canWrite() || readBlocked || loading : writeBlocked || free) || state.busy.has(`follow:${zoneId}`));
    disabled(join, free || writeBlocked || active || state.busy.has('queue'));
  }
}

function renderChargers() {
  const enabled = privateChargersEnabled();
  renderPrivateNavigation();
  for (const id of ['my-chargers', 'desktop-chargers-link', 'mobile-chargers-link']) visible(byId(id), enabled);
  if (!enabled) { if (chargers.status !== 'idle' || chargers.data) resetChargers(); return; }
  const loading = chargers.status === 'loading';
  const failed = chargers.status === 'error';
  byId('chargers-status').dataset.kind = failed ? 'error' : 'info';
  byId('chargers-status').dataset.live = String(chargerSnapshotFresh());
  text(byId('chargers-status'), loading || chargers.status === 'syncing' ? 'Sincronizando con EVsare…' : failed ? chargers.message : chargers.data ? `${chargerSnapshotFresh() ? 'Actualizado' : 'Estado sin verificar · actualizando'} · ${fullTime(chargers.data.observedAt)}` : 'Preparando tus cargadores…');
  visible(byId('chargers-reconnect'), failed && chargers.reconnect);
  visible(byId('chargers-results'), Boolean(chargers.data));
  byId('chargers-results').setAttribute('aria-busy', String(loading));
  maybeLocateNearby();
  if (chargers.data && (chargers.favoriteFilterKey !== favoriteFilterKey() || Boolean(chargers.usingRecentCache) !== usingRecentLocationsCache())) {
    const previous = chargers.selected;
    const restoreFocus = byId('charger-site-details').contains(document.activeElement);
    renderChargerResults();
    if (restoreFocus && previous !== chargers.selected) byId('chargers-search').focus();
  }
  renderChargerControls();
}

function renderPrivateNavigation() {
  const enabled = privateChargersEnabled();
  document.body.classList.toggle('catalog-workspace', enabled);
  visible(byId('workspace-nav'), enabled);
  const target = location.hash.slice(1);
  const page = PRIVATE_PAGES.includes(target) ? target : target === 'notifications' ? 'my-turn' : 'my-chargers';
  if (!enabled || page !== 'account-card') closeRfidCards();
  if (!enabled || page !== 'my-chargers') {
    if (chargeDialog.open && !chargeIntent?.pending) chargeDialog.close();
    if (chargers.view === 'map') {
      chargerMap.clear();
      chargers.view = 'list';
      if (enabled) renderChargerResults();
    }
  }
  if (enabled) document.body.dataset.privatePage = page;
  else delete document.body.dataset.privatePage;
  if (enabled && page === 'account-card') void byId('profile-rfid').firstElementChild?.loadCards();
  for (const link of $$('#workspace-nav a')) {
    if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  return enabled ? page : null;
}

function openPrivatePage(page) {
  if (location.hash !== `#${page}`) history.pushState(null, '', `#${page}`);
  renderPrivateNavigation();
  byId(page).focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

byId('workspace-nav').addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link || event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  openPrivatePage(link.hash.slice(1));
});
window.addEventListener('hashchange', renderPrivateNavigation);

byId('new-turn-link').addEventListener('click', event => {
  const zoneId = state.me?.queue?.zoneId;
  if (!privateChargersEnabled() || !Number.isSafeInteger(zoneId) || zoneId <= 0 ||
      event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  chargers.requestedZone = zoneId;
  openPrivatePage('my-chargers');
  if (chargers.data) renderChargerResults();
  else void loadChargers();
});

function siteHasFreeConnector(zoneId) {
  if (!chargerSnapshotFresh()) return false;
  return Boolean(chargers.data.sites.find(site => site.zoneId === zoneId)?.terminals.some(terminal =>
    !terminal.comingSoon && terminal.connectors.some(connector => connector.state === 'AVAILABLE')));
}

function chargerAction(zoneId, join) {
  if (join) {
    if (!siteHasFreeConnector(zoneId)) openQueuePlan(zoneId);
    return;
  }
  submitChargerAction(zoneId, false);
}

function submitChargerAction(zoneId, join, plannedMinutes = null) {
  if (!privateChargersEnabled() || chargers.status !== 'ready' || !requireUser() || (join && hasActiveTurn())) return;
  const guard = chargerOwnerGuard();
  void runAction(join ? 'queue' : `follow:${zoneId}`, async () => {
    try {
      if (!await guard.verify() || !canWrite() || chargers.status !== 'ready') return;
      const enabled = !isFollowingCharger(zoneId);
      if ((join || enabled) && !chargerSnapshotFresh() || join && hasActiveTurn()) return;
      if ((join || enabled) && siteHasFreeConnector(zoneId)) {
        feedback('Ya hay una toma libre en esta ubicación.');
        return;
      }
      const response = await (join ? mutate('/api/queue', { zoneId, connector: 'ANY', plannedMinutes }) : mutate('/api/subscriptions', { zoneId, enabled }));
      if (!await guard.verify()) return;
      if (join) {
        acceptQueueResponse(response);
        feedback('Ya estás en la cola comunitaria. Consulta tu posición y las posibles ofertas en Mi turno.');
        scrollToTurn();
      } else feedback(enabled ? 'Ahora sigues esta ubicación. Esto no te pone en cola.' : 'Has dejado de seguir esta ubicación. Tu turno no ha cambiado.');
      await refresh(true);
    } catch (error) {
      if (!guard.current() || error.code === 'SESSION_CHANGED') return;
      throw error;
    }
  });
}

let queuePlan = null;
const queuePlanDialog = byId('queue-plan-dialog');
function renderQueuePlan() {
  const percent = Number(byId('queue-plan-percent').value);
  const scenario = chargingScenario(queuePlan?.capacity, 0, percent, queuePlan?.nominalPower);
  const format = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
  const minutes = scenario?.minutes;
  const usable = minutes >= 1 && minutes <= 720;
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
  text(byId('queue-plan-calculation'), usable ? `≈ ${duration} a ${format.format(queuePlan.nominalPower)} kW nominales. El tiempo real puede ser mayor.`
    : scenario ? 'La estimación supera 12 horas: entrarás sin previsión.'
    : 'Puedes entrar sin previsión.');
  return usable ? minutes : null;
}
function openQueuePlan(zoneId) {
  if (!privateChargersEnabled() || chargers.status !== 'ready' || !requireUser() || !canWrite() || hasActiveTurn() || !chargerSnapshotFresh()) return;
  const site = chargers.data?.sites.find(site => site.zoneId === zoneId);
  if (!site || queuePlanDialog.open) return;
  const powers = site.terminals.flatMap(t => t.connectors.map(c => c.powerKw)).filter(p => Number.isFinite(p) && p > 0);
  const lowestNominal = powers.length ? Math.min(...powers) : null;
  queuePlan = { zoneId, capacity: preferences.vehicle.capacityKwh, nominalPower: lowestNominal, owner: { user: state.user, csrfToken: state.csrfToken } };
  text(byId('queue-plan-site'), site.name);
  const hasEstimateInputs = Boolean(queuePlan.capacity && lowestNominal);
  visible(byId('queue-plan-input'), hasEstimateInputs);
  byId('queue-plan-percent').value = '';
  disabled(byId('queue-plan-percent'), !hasEstimateInputs);
  renderQueuePlan();
  queuePlanDialog.showModal();
  (hasEstimateInputs ? byId('queue-plan-percent') : byId('queue-plan-close')).focus();
}
byId('queue-plan-close').addEventListener('click', () => queuePlanDialog.close());
queuePlanDialog.addEventListener('close', () => { if (!queuePlanDialog.open) queuePlan = null; });
byId('queue-plan-form').addEventListener('input', renderQueuePlan);
byId('queue-plan-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!queuePlan || !sameSession(queuePlan.owner, state) || !event.currentTarget.reportValidity()) return;
  const minutes = renderQueuePlan();
  const zoneId = queuePlan.zoneId;
  queuePlanDialog.close();
  submitChargerAction(zoneId, true, minutes);
});

function chargerFavorite(zoneId) {
  if (!privateChargersEnabled() || !canWrite()) return;
  const guard = chargerOwnerGuard();
  void runAction('favorite', async () => {
    try {
      if (!await guard.verify() || !canWrite()) return;
      const enabled = !isFavoriteCharger(zoneId);
      const response = await mutate('/api/evsare/favorites', { zoneId, enabled });
      if (!await guard.verify()) return;
      const updated = chargerFavorites().filter((id) => Number(id) !== zoneId);
      if (enabled) updated.push(zoneId);
      state.me = { ...state.me, favorites: Array.isArray(response?.favorites) ? response.favorites : updated };
      feedback(enabled ? 'Ubicación guardada en Favoritos. No se han activado avisos ni solicitado un turno.' : 'Ubicación retirada de Favoritos. Tus avisos y turnos no han cambiado.');
      await refresh(true);
    } catch (error) {
      if (!guard.current() || error.code === 'SESSION_CHANGED') return;
      throw error;
    }
  });
}

function setProximityPosition(coords) {
  if (!validCoordinates(coords) && !proximityPosition) return;
  proximityPosition = validCoordinates(coords) ? { latitude: coords.latitude, longitude: coords.longitude } : null;
  if (privateChargersEnabled() && chargers.data) renderChargerList();
  renderZones();
}

function maybeLocateNearby() {
  if (document.hidden || !navigator.permissions?.query || !navigator.geolocation) return;
  if (!state.zones.some(validCoordinates) && !chargers.data?.sites.some(validCoordinates)) return;
  // Sin confirmación explícita de un permiso existente, no se pide ubicación.
  proximityPermission ??= Promise.resolve().then(() => navigator.permissions.query({ name: 'geolocation' })).then(permission => {
    permission.addEventListener('change', () => {
      proximityAttempt = null;
      if (permission.state !== 'granted') setProximityPosition(null);
      else maybeLocateNearby();
    });
    return permission;
  }).catch(() => null);
  void proximityPermission.then(permission => {
    if (permission?.state !== 'granted' || proximityAttempt || document.hidden) return;
    const attempt = {};
    proximityAttempt = attempt;
    try {
      navigator.geolocation.getCurrentPosition(({ coords }) => {
        if (proximityAttempt === attempt && permission.state === 'granted') setProximityPosition(coords);
      }, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 8000 });
    } catch { /* Se conserva el orden habitual si el navegador no puede localizar. */ }
  });
}

function createZone(zone) {
  const node = cloneTemplate('zone-template');
  node.dataset.zoneId = String(zone.id);
  field(node, 'name').id = `zone-title-${zone.id}`;
  node.setAttribute('aria-labelledby', `zone-title-${zone.id}`);
  const select = $('.join-form select', node);
  select.id = `queue-connector-${zone.id}`;
  $('.join-form label', node).htmlFor = select.id;
  select.value = byId('connector-filter').value !== 'ANY' ? byId('connector-filter').value : preferences.vehicle.connector;
  select.addEventListener('change', () => { select.dataset.dirty = 'true'; });
  const duration = $('input[name="plannedMinutes"]', node);
  duration.id = `queue-duration-${zone.id}`;
  $('.join-options label', node).htmlFor = duration.id;
  duration.value = preferences.vehicle.plannedMinutes ?? '';
  duration.addEventListener('input', () => { duration.dataset.dirty = 'true'; });
  node.resourceNodes = new Map();
  $('.join-form', node).addEventListener('submit', (event) => {
    event.preventDefault();
    if (!requireUser()) return;
    runAction('queue', async () => {
      const plannedMinutes = duration.value.trim() ? Number(duration.value) : null;
      if (plannedMinutes != null && (!Number.isInteger(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 720)) throw inputError('La duración prevista debe estar entre 1 y 720 minutos, o quedar vacía.');
      const response = await mutate('/api/queue', { zoneId: Number(zone.id), connector: select.value, plannedMinutes });
      acceptQueueResponse(response);
      feedback('Ya estás en la cola comunitaria. Consulta tu posición y las posibles ofertas en Mi turno.');
      scrollToTurn();
      await refresh(true);
    });
  });
  $('[data-action="follow"]', node).addEventListener('click', () => {
    if (!requireUser()) return;
    runAction(`follow:${zone.id}`, async () => {
      const enabled = !(state.me?.subscriptions || []).some((id) => Number(id) === Number(zone.id));
      await mutate('/api/subscriptions', { zoneId: Number(zone.id), enabled });
      feedback(enabled ? 'Ahora sigues esta zona. Esto no te pone en cola. Activa las notificaciones si quieres recibir avisos.' : 'Has dejado de seguir esta zona. Tu turno no ha cambiado.');
      await refresh(true);
    });
  });
  return node;
}

function createResource(resource) {
  const node = cloneTemplate('resource-template');
  node.dataset.resourceId = String(resource.id);
  $('[data-action="claim"]', node).addEventListener('click', () => {
    if (!requireUser()) return;
    runAction('queue', async () => {
      const response = await mutate(`/api/resources/${resource.id}/claim`);
      acceptQueueResponse(response);
      feedback('Has comunicado que ya estás cargando aquí. Puedes añadir tu hora prevista; no se liberará la plaza hasta que lo confirmes.');
      scrollToTurn();
      await refresh(true);
    });
  });
  return node;
}

function renderResource(node, resource, zone) {
  text(field(node, 'name'), resource.name);
  const power = Number(resource.powerKw);
  text(field(node, 'spec'), `${CONNECTORS[resource.connector] || 'Conector desconocido'}${Number.isFinite(power) && power > 0 ? ` · ${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(power)} kW` : ''}`);
  const status = effectiveResourceStatus(resource);
  field(node, 'status').dataset.state = status;
  text(field(node, 'status-label'), RESOURCE_STATES[status]);
  const observation = field(node, 'observed');
  text(observation, ageLabel(resource.observedAt));
  if (timestamp(resource.observedAt)) {
    observation.dateTime = new Date(resource.observedAt).toISOString();
    observation.title = fullTime(resource.observedAt);
  } else { observation.removeAttribute('datetime'); observation.removeAttribute('title'); }
  text(field(node, 'source'), resource.source === 'community' ? 'Comunicado por usuario' : 'Observación manual · administración');
  const expected = timestamp(resource.expectedReleaseAt);
  visible(field(node, 'estimate'), Boolean(expected));
  if (expected) text(field(node, 'estimate'), expected <= serverNow() ? `Hora prevista alcanzada (${fullTime(expected)}). Plaza aún no declarada libre.` : `Liberación prevista: ${fullTime(expected)} · estimación, no garantía.`);
  visible(field(node, 'finished'), Boolean(timestamp(resource.chargeFinishedAt)));
  const claim = $('[data-action="claim"]', node);
  // El servidor valida todas las restricciones y puede rechazar una carrera.
  const showClaim = Boolean(state.user && !hasActiveTurn() && number(zone.waitingCount) === 0 && !['MAINTENANCE', 'RESERVED'].includes(resource.status) && !(resource.source === 'community' && resource.status === 'RECHARGING'));
  visible(claim, showClaim);
  visible($('.claim-hint', node), showClaim);
  claim.setAttribute('aria-label', `Ya estoy cargando aquí: ${resource.name}`);
  disabled(claim, !canWrite() || state.busy.has('queue'));
}

function reconcileNodes(parent, items, map, create, update) {
  const present = new Set(items.map((item) => String(item.id)));
  for (const [id, node] of map) if (!present.has(id)) { node.remove(); map.delete(id); }
  let cursor = parent.firstElementChild;
  for (const item of items) {
    const id = String(item.id);
    let node = map.get(id);
    if (!node) { node = create(item); map.set(id, node); }
    update(node, item);
    // No mover nodos existentes si el orden no cambió: conserva foco, select y edición.
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
  }
}

function updateZone(node, zone) {
  text(field(node, 'name'), zone.name);
  text(field(node, 'description'), zone.description || 'Zona de recarga de la comunidad. Revisa sus recursos antes de entrar en cola.');
  const hasCoordinates = zone.latitude != null && zone.longitude != null;
  const location = [];
  const meters = distanceMeters(proximityPosition, zone);
  if (meters !== null) location.push(`${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(meters / 1000)} km en línea recta`);
  if (hasCoordinates) location.push(`${Number(zone.latitude).toFixed(5)}, ${Number(zone.longitude).toFixed(5)}`);
  if (zone.radiusMeters != null) location.push(`Radio de ${new Intl.NumberFormat('es-ES').format(zone.radiusMeters)} m`);
  text(field(node, 'location'), location.join(' · '));
  visible(field(node, 'location'), location.length > 0);
  const resources = Array.isArray(zone.resources) ? zone.resources : [];
  const recentAvailable = resources.filter((resource) => effectiveResourceStatus(resource) === 'AVAILABLE').length;
  const available = Math.max(0, Math.min(number(zone.availableCount), recentAvailable));
  const badge = field(node, 'available');
  text(badge, dataFresh() ? `${available} ${available === 1 ? 'disponible' : 'disponibles'}` : 'Sin verificar');
  badge.className = `badge ${dataFresh() && available > 0 ? 'badge-green' : 'badge-neutral'}`;
  badge.title = 'Recursos disponibles para la cola, excluyendo los que ya tienen un turno asignado. No es una reserva física.';
  text($('.source-label', node), resources.some((resource) => resource.source === 'community') ? 'Fuentes identificadas abajo' : 'Fuente manual');
  reconcileNodes($('.resource-list', node), resources, node.resourceNodes, createResource, (resourceNode, resource) => renderResource(resourceNode, resource, zone));
  visible($('.zone-no-resources', node), resources.length === 0);
  const waiting = Math.max(0, number(zone.waitingCount));
  text(field(node, 'waiting'), dataFresh() ? `${waiting} ${waiting === 1 ? 'persona esperando' : 'personas esperando'} en esta zona` : 'Cola sin verificar · última consulta disponible');
  const following = (state.me?.subscriptions || []).some((id) => Number(id) === Number(zone.id));
  const follow = $('[data-action="follow"]', node);
  follow.setAttribute('aria-pressed', String(following));
  const followLabel = state.busy.has(`follow:${zone.id}`) ? 'Guardando…' : following ? 'Siguiendo zona' : 'Seguir zona';
  follow.setAttribute('aria-label', `${followLabel}: ${zone.name}${following ? '. Dejar de seguir' : ''}`);
  text(field(node, 'follow-label'), followLabel);
  disabled(follow, !dataFresh() || state.busy.has(`follow:${zone.id}`) || state.busy.has('auth'));
  const active = hasActiveTurn();
  const inThisZone = active && Number(state.me.queue.zoneId) === Number(zone.id);
  text(field(node, 'join-label'), state.busy.has('queue') ? 'Un momento…' : active ? inThisZone ? 'Tu turno está aquí' : 'Ya tienes un turno' : 'Ponerme a la cola');
  disabled($('[data-action="join"]', node), !dataFresh() || active || state.busy.has('queue') || state.busy.has('auth') || resources.length === 0);
}

function filterZones(announceCount = false) {
  const query = byId('zone-search').value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const connector = byId('connector-filter').value;
  const onlyFollowing = byId('following-filter').checked;
  const subscriptions = new Set((state.me?.subscriptions || []).map(Number));
  let count = 0;
  for (const zone of state.zones) {
    const haystack = `${zone.name} ${zone.description || ''}`.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const matches = haystack.includes(query) && (connector === 'ANY' || (zone.resources || []).some((resource) => resource.connector === connector)) && (!onlyFollowing || subscriptions.has(Number(zone.id)));
    visible(zoneNodes.get(String(zone.id)), matches);
    if (matches) count += 1;
  }
  text(byId('zones-count'), state.zonesLoaded ? count : '—');
  visible(byId('zones-empty'), count === 0);
  const filtering = Boolean(query || connector !== 'ANY' || onlyFollowing);
  visible(byId('clear-filters'), count === 0 && filtering && state.zonesLoaded);
  visible(byId('empty-admin-link'), count === 0 && state.zonesLoaded && state.zones.length === 0 && isAdmin());
  if (!state.zonesLoaded && state.connection === 'loading') {
    text(byId('empty-eyebrow'), 'UN MOMENTO');
    text(byId('empty-title'), 'Buscando zonas publicadas…');
    text(byId('empty-description'), 'Estamos consultando la información del servidor.');
  } else if (!dataFresh() && !state.zonesLoaded) {
    text(byId('empty-eyebrow'), 'SIN DATOS VERIFICADOS');
    text(byId('empty-title'), 'Conectemos primero.');
    text(byId('empty-description'), 'No podemos consultar las zonas. No mostraremos disponibilidad almacenada ni puntos de ejemplo.');
  } else if (state.zones.length === 0) {
    text(byId('empty-eyebrow'), 'ESTO ACABA DE EMPEZAR');
    text(byId('empty-title'), 'Todavía no hay zonas publicadas.');
    text(byId('empty-description'), 'Cuando se añada una zona, aquí aparecerán sus plazas y su cola. Por ahora, sin datos inventados.');
  } else {
    text(byId('empty-eyebrow'), onlyFollowing ? 'TUS ZONAS' : 'PRUEBA OTRA BÚSQUEDA');
    text(byId('empty-title'), onlyFollowing && !state.user ? 'Inicia sesión para seguir zonas.' : 'No hay zonas con estos filtros.');
    text(byId('empty-description'), onlyFollowing ? 'Seguir una zona la guarda en tu lista de avisos. No te apunta a su cola.' : 'Cambia el nombre o el conector, o limpia los filtros para ver todas las zonas.');
  }
  if (announceCount) text(byId('filter-results'), `${count} ${count === 1 ? 'zona encontrada' : 'zonas encontradas'}.`);
}

function renderZones() {
  const show = Boolean(state.user) && (state.zones.length > 0 || (!privateChargersEnabled() && state.config?.mapStatus !== 'private') || state.user.role === 'admin');
  visible(byId('zones'), show);
  for (const link of $$('[data-community-nav]')) visible(link, show);
  if (show) maybeLocateNearby();
  byId('zone-list').setAttribute('aria-busy', String(!state.zonesLoaded && state.connection === 'loading'));
  reconcileNodes(byId('zone-list'), byProximity(state.zones, proximityPosition), zoneNodes, createZone, updateZone);
  filterZones();
}

document.addEventListener('visibilitychange', maybeLocateNearby);

function terminalExplanation(queue) {
  const reason = String(queue.reason || '').toLowerCase();
  if (queue.state === 'EXPIRED') {
    if (reason.includes('arrival')) return 'Se agotó el plazo de llegada. El recurso queda sin verificar. No has vuelto a la cola automáticamente.';
    if (reason.includes('resource') || reason.includes('stale') || reason.includes('unavailable')) return 'Cambió la información del recurso y el servidor cerró la oferta. No has vuelto a la cola automáticamente.';
    return 'El servidor ha cerrado este turno. La oferta o su plazo dejaron de ser válidos. No has vuelto a la cola automáticamente.';
  }
  if (queue.state === 'CANCELLED') return reason.includes('admin') ? 'Administración corrigió el estado y cerró tu ocupación. Consulta el recurso; no fue una liberación declarada por ti.' : 'Has salido de este turno. Puedes elegir otra zona cuando lo necesites.';
  if (reason.includes('release')) return 'Has comunicado que retiraste el coche y liberaste la plaza. La cola puede avanzar a la siguiente persona compatible.';
  return 'Tu participación ha terminado. Este cierre no confirma por sí solo que una plaza esté libre.';
}

function renderTurn() {
  const queue = state.user ? state.me?.queue : null;
  const queueState = queue?.state || 'EMPTY';
  const privateDirectory = privateChargersEnabled();
  const explore = byId('turn-explore');
  explore.href = privateDirectory ? '#my-chargers' : '#zones';
  text(explore.firstElementChild, privateDirectory ? 'Ver cargadores' : 'Explorar zonas');
  const nextTurn = byId('new-turn-link');
  nextTurn.href = explore.href;
  text(nextTurn, privateDirectory ? 'Ver cargadores' : 'Volver a las zonas');
  const turnPanel = byId('my-turn');
  if (turnPanel.dataset.state !== queueState && turnPanel.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    turnPanel.animate([{ opacity: .75, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 190, easing: 'ease-out' });
  }
  turnPanel.dataset.state = queueState;
  const active = Boolean(queue && ACTIVE_STATES.has(queueState));
  document.body.classList.toggle('has-active-turn', active);
  visible(byId('active-turn-summary'), active);
  text(byId('active-turn-summary-text'), active ? `${!dataFresh() ? 'Último estado: ' : ''}${QUEUE_STATES[queueState]}${queueState === 'WAITING' && queue.position ? ` · posición ${queue.position}` : ''} · ${queue.zoneName}` : '');
  byId('mobile-turn-link').classList.toggle('has-offer', queueState === 'OFFERED');
  byId('mobile-turn-link').setAttribute('aria-label', queueState === 'OFFERED' ? 'Mi turno: tienes una oferta' : 'Mi turno');
  text(byId('turn-state-badge'), queue ? QUEUE_STATES[queueState] || 'Sin verificar' : state.user && (!dataFresh() || !state.me) ? 'Sin verificar' : 'Sin turno');
  byId('turn-state-badge').className = `badge ${['OFFERED', 'ACCEPTED', 'CHARGING'].includes(queueState) ? 'badge-green' : queueState === 'EXPIRED' ? 'badge-amber' : 'badge-neutral'}`;
  visible(byId('turn-state-badge'), Boolean(queue));
  visible(byId('turn-empty'), !queue);
  visible(byId('turn-details'), Boolean(queue));
  visible(byId('turn-login'), !state.user);
  visible(byId('turn-explore'), Boolean(state.user));
  text(byId('turn-empty-title'), !state.user ? 'Consulta tu turno' : !dataFresh() || !state.me ? 'Turno sin verificar' : 'No estás en cola');
  text(byId('turn-empty-copy'), !state.user ? 'Inicia sesión para apuntarte a una cola.' : !dataFresh() || !state.me ? 'Vuelve a consultar cuando se restablezca la conexión.' : 'Elige una ubicación y pulsa «Ponerme en cola». Aquí verás tu posición.');
  if (!queue) { lastAnnouncement = ''; return; }
  text(byId('turn-zone'), queue.zoneName || 'Zona de recarga');
  text(byId('turn-resource'), [queue.resourceName, CONNECTORS[queue.connector]].filter(Boolean).join(' · '));
  visible(byId('turn-planned-duration'), number(queue.plannedMinutes) > 0 && queueState !== 'CHARGING');
  text(byId('turn-planned-duration'), number(queue.plannedMinutes) > 0 ? `Duración prevista: ${queue.plannedMinutes} min · declarada por ti` : '');
  visible(byId('turn-position-block'), queueState === 'WAITING');
  text(byId('turn-position'), queue.position != null && number(queue.position) > 0 ? String(queue.position).padStart(2, '0') : '—');
  visible(byId('turn-people-ahead'), queueState === 'WAITING');
  visible(byId('turn-wait-estimate'), queueState === 'WAITING');
  if (queueState === 'WAITING') {
    const peopleAhead = queue.peopleAhead;
    text(byId('turn-people-ahead'), Number.isInteger(peopleAhead) && peopleAhead >= 0 ? `${peopleAhead} ${peopleAhead === 1 ? 'persona delante' : 'personas delante'}` : 'Personas delante: pendiente de confirmar');
    const estimated = timestamp(queue.estimatedTurnAt);
    const usableEstimate = dataFresh() && estimated && queue.estimateBasis !== 'insufficient';
    text(byId('turn-wait-time'), usableEstimate ? estimated > serverNow() ? `Turno orientativo sobre las ${shortTime(estimated)} · ~${Math.max(1, Math.ceil((estimated - serverNow()) / 60000))} min` : 'Hora orientativa alcanzada; esperando una oferta.' : !dataFresh() ? 'Estimación sin verificar' : 'Sin estimación suficiente');
    const estimateReasons = {
      no_compatible_space: 'No hay plazas publicadas compatibles con tu conector.',
      missing_duration: 'Falta la duración prevista de una participación anterior. No inventamos una duración por defecto.',
      missing_release_estimate: 'Faltan horas futuras de liberación o datos recientes de plazas compatibles.',
      partial_declared_schedule: 'Solo se consideran plazas con previsiones útiles; otras no tienen datos suficientes.',
      declared_schedule: 'Incluye horas declaradas y ventanas de aceptación y llegada. Las previsiones pueden cambiar.',
    };
    const reason = estimateReasons[queue.estimateReason] || (typeof queue.estimateReason === 'string' && !/^[a-zA-Z_\d-]+$/.test(queue.estimateReason) ? queue.estimateReason : '');
    text(byId('turn-wait-reason'), usableEstimate ? `Según previsiones declaradas${new Date(estimated).toDateString() !== new Date(serverNow()).toDateString() ? ` · ${fullTime(estimated)}` : ''}.${reason ? ` ${reason}` : ''}` : reason || 'Faltan horas de liberación o duraciones declaradas para calcular una hora útil. La cola sigue funcionando sin estimación.');
  }
  text(byId('turn-kicker'), { WAITING: 'TU LUGAR ESTÁ EN LA COLA', ACCEPTED: 'VOY · TURNO ACEPTADO', CHARGING: 'ESTOY CARGANDO', EXPIRED: 'ESTE TURNO HA VENCIDO', CANCELLED: 'HAS SALIDO DE LA COLA', COMPLETED: 'GRACIAS POR DAR PASO' }[queueState] || '');
  const explanations = {
    WAITING: 'La cola avanza por orden y compatibilidad de conector. No necesitas dejar abierta esta página; activa los avisos y comprueba tu turno si no recibes notificación.',
    OFFERED: 'Acepta si vas a usar la plaza. No es una reserva de EVsare.',
    ACCEPTED: 'Has dicho «voy». Cuando estés usando esta plaza, confirma «Ya estoy cargando». Completar sin cargar cierra el turno, pero no declara la plaza libre.',
    CHARGING: 'Tu ocupación está comunicada. Comparte cuándo prevés retirar el coche y confirma la liberación física para dar paso a la siguiente persona.',
  };
  text(byId('turn-explanation'), explanations[queueState] || terminalExplanation(queue));
  visible(byId('turn-unverified'), !dataFresh());
  visible(byId('accept-turn'), queueState === 'OFFERED');
  visible(byId('start-turn'), queueState === 'ACCEPTED');
  visible(byId('complete-turn'), queueState === 'ACCEPTED');
  visible(byId('release-turn'), queueState === 'CHARGING');
  visible(byId('leave-turn'), ['WAITING', 'OFFERED', 'ACCEPTED', 'CHARGING'].includes(queueState));
  text(byId('leave-turn'), queueState === 'OFFERED' ? 'Rechazar oferta' : queueState === 'CHARGING' ? 'Cerrar sin declarar plaza libre' : 'Cancelar turno');
  visible(byId('new-turn-link'), !ACTIVE_STATES.has(queueState));
  visible(byId('turn-server-note'), queueState === 'ACCEPTED');
  visible(byId('charge-finished-notice'), queueState === 'CHARGING' && Boolean(timestamp(queue.chargeFinishedAt)));
  visible(byId('estimate-form'), queueState === 'CHARGING');
  const estimateInput = byId('expected-release');
  if (queueState === 'CHARGING') {
    if (state.estimateQueueId !== queue.id) {
      state.estimateQueueId = queue.id;
      estimateInput.dataset.dirty = 'false';
      formMessage('estimate-message', '');
    }
    if (estimateInput.dataset.dirty !== 'true' && document.activeElement !== estimateInput) {
      const value = localInputTime(queue.expectedReleaseAt);
      if (estimateInput.value !== value) estimateInput.value = value;
    }
    const expected = timestamp(queue.expectedReleaseAt);
    text(byId('current-estimate'), !expected ? 'Sin hora prevista. Puedes añadirla cuando lo sepas.' : expected <= serverNow() ? 'Hora prevista alcanzada. ¿Has terminado? Si retiraste el coche, confirma la liberación.' : `Previsión guardada: ${fullTime(expected)}. No se libera automáticamente.`);
    visible(byId('clear-estimate'), Boolean(expected));
  }
  const announcement = `${queue.id}:${queueState}:${queue.position ?? ''}:${queue.chargeFinishedAt ?? ''}`;
  if (announcement !== lastAnnouncement) {
    lastAnnouncement = announcement;
    text(byId('turn-announcement'), `${QUEUE_STATES[queueState] || queueState} en ${queue.zoneName}.${queueState === 'WAITING' && queue.position ? ` Posición ${queue.position}.` : ''}${queueState === 'CHARGING' && queue.chargeFinishedAt ? ' Carga finalizada; plaza pendiente de liberar.' : ''}`);
  }
  renderTimer();
}

function renderTimer() {
  const queue = state.me?.queue;
  const timed = Boolean(queue && ['OFFERED', 'ACCEPTED'].includes(queue.state));
  visible(byId('turn-timer-block'), timed);
  if (!timed) return;
  const expiry = timestamp(queue.state === 'OFFERED' ? queue.expiresAt : queue.arrivalExpiresAt);
  text(byId('turn-timer-label'), queue.state === 'OFFERED' ? 'Tiempo para responder' : 'Plazo para confirmar tu llegada');
  const configuredSeconds = number(queue.state === 'OFFERED' ? state.config?.offerSeconds : state.config?.arrivalSeconds);
  const seconds = expiry ? Math.min(configuredSeconds || Infinity, Math.max(0, Math.ceil((expiry - serverNow()) / 1000))) : null;
  text(byId('turn-timer'), seconds == null ? '—' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
  byId('turn-timer').dataset.urgent = String(seconds != null && seconds <= 30);
  text(byId('turn-deadline'), !expiry ? 'Esperando el plazo del servidor.' : !dataFresh() ? 'Plazo del último estado. Requiere conexión para confirmar.' : seconds === 0 ? 'Plazo agotado. Comprobando estado con el servidor…' : `Hasta ${fullTime(expiry)} · reloj del servidor`);
  const blocked = !canWrite() || state.busy.has('queue') || seconds == null || seconds === 0;
  disabled(byId('accept-turn'), blocked);
  disabled(byId('start-turn'), blocked);
  disabled(byId('complete-turn'), blocked);
  if (seconds === 0 && dataFresh() && lastExpiryRefresh !== `${queue.id}:${expiry}`) {
    lastExpiryRefresh = `${queue.id}:${expiry}`;
    void refresh();
  }
}

function acceptQueueResponse(response) {
  if (response.queue && state.user) {
    state.me = { ...(state.me || {}), queue: response.queue };
    renderTurn();
    renderZones();
  }
}
function scrollToTurn() {
  if (privateChargersEnabled()) { openPrivatePage('my-turn'); return; }
  byId('my-turn').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
function queueAction(action, successMessage) {
  if (!requireUser() || !state.me?.queue) return;
  const id = state.me.queue.id;
  return runAction('queue', async () => {
    const response = await mutate(`/api/queue/${id}/${action}`);
    acceptQueueResponse(response);
    feedback(successMessage);
    await refresh(true);
  });
}

function renderNotifications() {
  const notifications = Array.isArray(state.me?.notifications) ? state.me.notifications : [];
  text(byId('notification-count'), notifications.length);
  visible(byId('notification-count'), notifications.length > 0);
  visible(byId('notifications-empty'), notifications.length === 0);
  const signature = JSON.stringify(notifications);
  if (signature === notificationSignature) return;
  notificationSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const notification of notifications.slice(0, 20)) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    const body = document.createElement('p');
    const time = document.createElement('time');
    text(title, notification.title);
    text(body, notification.body);
    if (timestamp(notification.createdAt)) {
      time.dateTime = new Date(notification.createdAt).toISOString();
      text(time, fullTime(notification.createdAt));
    }
    item.append(title, body, time);
    fragment.append(item);
  }
  byId('notification-list').replaceChildren(fragment);
}

function createAdminResource(resource) {
  const node = cloneTemplate('admin-resource-template');
  node.dataset.resourceId = String(resource.id);
  const select = $('select', node);
  select.id = `admin-status-${resource.id}`;
  $('label', node).htmlFor = select.id;
  select.addEventListener('change', () => { select.dataset.dirty = 'true'; });
  node.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!requireUser()) return;
    runAction(`admin-status:${resource.id}`, async () => {
      await mutate(`/api/admin/resources/${resource.id}/status`, { status: select.value });
      select.dataset.dirty = 'false';
      formMessage($('.form-message', node), 'Observación manual guardada con la hora del servidor.', 'success');
      await refresh(true);
    }, { message: $('.form-message', node) });
  });
  $('[data-action="charge-finished"]', node).addEventListener('click', () => {
    if (!requireUser()) return;
    runAction(`admin-status:${resource.id}`, async () => {
      await mutate(`/api/admin/resources/${resource.id}/charge-finished`);
      formMessage($('.form-message', node), 'Fin de carga confirmado manualmente. Se ha solicitado el aviso al ocupante; la plaza sigue ocupada.', 'success');
      feedback('Fin de carga registrado. El aviso no garantiza entrega y no libera la plaza.');
      await refresh(true);
    }, { message: $('.form-message', node) });
  });
  return node;
}

function renderAdmin() {
  if (!isAdmin()) return;
  const select = byId('resource-zone');
  const options = new Map([...select.options].filter((option) => option.value).map((option) => [option.value, option]));
  const zoneIds = new Set(state.zones.map((zone) => String(zone.id)));
  for (const [id, option] of options) if (!zoneIds.has(id)) option.remove();
  for (const zone of state.zones) {
    let option = options.get(String(zone.id));
    if (!option) { option = document.createElement('option'); option.value = String(zone.id); select.append(option); }
    text(option, zone.name);
  }
  const resources = state.zones.flatMap((zone) => (zone.resources || []).map((resource) => ({ ...resource, zoneName: zone.name })));
  visible(byId('admin-resources-empty'), resources.length === 0);
  reconcileNodes(byId('admin-resource-list'), resources, adminNodes, createAdminResource, (node, resource) => {
    text(field(node, 'name'), resource.name);
    text(field(node, 'zone'), `${resource.zoneName} · ${CONNECTORS[resource.connector] || resource.connector}`);
    text(field(node, 'current'), `Estado consultado: ${RESOURCE_STATES[effectiveResourceStatus(resource)]} · ${resource.source === 'community' ? 'Comunicado por usuario' : 'Manual'}${resource.chargeFinishedAt ? ' · Fin de carga confirmado' : ''}`);
    const status = $('select', node);
    if (status.dataset.dirty !== 'true' && document.activeElement !== status) status.value = ['STALE', 'UNVERIFIED'].includes(resource.status) ? '' : Object.hasOwn(RESOURCE_STATES, resource.status) ? resource.status : 'UNKNOWN';
    status.setAttribute('aria-label', `Nuevo estado manual de ${resource.name}`);
    const busy = state.busy.has(`admin-status:${resource.id}`);
    disabled($('button[type="submit"]', node), !canWrite() || busy);
    disabled($('[data-action="charge-finished"]', node), !canWrite() || busy || Boolean(resource.chargeFinishedAt));
  });
}

function pushSupport() {
  if (!window.isSecureContext) return 'Los avisos requieren HTTPS o localhost. Abre la dirección segura de A la caaarga!!.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'Este navegador no ofrece Web Push aquí. En iPhone o iPad, añade la app a inicio; en otros equipos prueba un navegador compatible.';
  if (Notification.permission === 'denied') return 'El navegador bloqueó los avisos. Cambia el permiso de notificaciones en los ajustes de este sitio y vuelve a intentarlo.';
  return '';
}
function renderPush() {
  const unsupported = pushSupport();
  const permissionDenied = 'Notification' in window && Notification.permission === 'denied';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const needsInstall = isIOS && !standalone;
  const linked = Boolean(state.user && state.pushRegisteredFor === state.user.id && state.browserSubscription && state.me?.pushEnabled);
  const configured = Boolean(state.config?.vapidPublicKey);
  const ready = !unsupported && !needsInstall && configured && !state.serviceWorkerError && Boolean(state.registration?.pushManager);
  const busy = state.busy.has('push');
  let status = 'Inicia sesión para configurar tus notificaciones.';
  let badge = 'Sin activar';
  let unavailable = false;
  if (needsInstall && !permissionDenied) { status = 'Para recibir avisos en este dispositivo, abre A la caaarga!! desde la pantalla de inicio.'; badge = 'Requiere instalación'; unavailable = true; }
  else if (unsupported) { status = unsupported; badge = permissionDenied ? 'Bloqueadas' : 'No disponibles'; unavailable = true; }
  else if (state.user) {
    if (!dataFresh()) { status = 'Conéctate para configurar los avisos. No se guardarán acciones pendientes.'; badge = 'Sin conexión verificada'; unavailable = true; }
    else if (!configured) { status = 'Los avisos aparecen aquí. El envío al navegador aún no está configurado.'; badge = 'Solo en la web'; unavailable = true; }
    else if (state.serviceWorkerError || (state.registration && !state.registration.pushManager)) { status = 'No se pudieron preparar los avisos del navegador. Prueba a recargar la página; tu turno no ha cambiado.'; badge = 'No disponibles'; unavailable = true; }
    else if (!state.registration || !state.me) status = 'Preparando las notificaciones…';
    else if (linked) { status = 'Este dispositivo está vinculado a tu cuenta. Puedes solicitar una prueba; recibirla depende del navegador y del servicio push.'; badge = 'Activadas aquí'; }
    else if (state.browserSubscription) { status = 'Hay una suscripción del navegador. Pulsa Activar notificaciones para vincularla explícitamente a tu cuenta.'; badge = 'Por confirmar'; }
    else if (state.me?.pushEnabled) status = 'Tu cuenta tiene una suscripción registrada. Puedes activar también este navegador.';
    else status = 'Tú decides: el navegador pedirá permiso solo al pulsar Activar notificaciones.';
  }
  text(byId('push-status'), status);
  text(byId('push-state'), badge);
  byId('notifications').dataset.state = unavailable ? 'unavailable' : linked ? 'linked' : 'inactive';
  byId('push-state').className = `badge ${unavailable ? 'badge-amber' : linked ? 'badge-green' : 'badge-neutral'}`;
  visible(byId('push-description'), !unavailable);
  visible(byId('push-delivery-note'), ready && Boolean(state.user) && !unavailable);
  visible(byId('enable-push'), ready && !linked && (canWrite() || (busy && Boolean(state.user))));
  disabled(byId('enable-push'), busy);
  visible(byId('test-push'), Boolean(state.user && state.me?.pushEnabled && configured && dataFresh()));
  disabled(byId('test-push'), !canWrite() || busy);
  visible(byId('disable-push'), Boolean(state.user && state.browserSubscription));
  disabled(byId('disable-push'), !canWrite() || state.busy.has('push'));
  visible(byId('ios-notice'), needsInstall);
}

function friendlyBrowserError(error) {
  if (error.name === 'NotAllowedError') return 'No se concedió permiso para los avisos. Revisa el permiso del sitio; en iPhone o iPad abre la app desde la pantalla de inicio.';
  if (error.name === 'InvalidStateError') return 'La suscripción de este navegador no coincide con la configuración actual. Desactiva los avisos de este dispositivo y vuelve a activarlos.';
  if (error.name === 'NotSupportedError') return 'Este navegador no admite esta opción de notificaciones. Puedes seguir comprobando tu turno en la app.';
  if (error.name === 'AbortError' || error.name === 'NetworkError') return 'El servicio del navegador no pudo registrar los avisos. Comprueba la conexión y vuelve a intentarlo.';
  return 'No se pudo completar la acción. Reintenta y comprueba el estado actual antes de repetirla.';
}

function base64PublicKey(value) {
  const padded = (value + '='.repeat((4 - value.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
function bounded(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = window.setTimeout(() => reject(inputError(message)), milliseconds); })]).finally(() => window.clearTimeout(timer));
}
async function prepareServiceWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) { renderPush(); return; }
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    state.registration = await bounded(navigator.serviceWorker.ready, 20000, 'No se pudo activar el servicio de avisos.');
    if ('pushManager' in state.registration) state.browserSubscription = await state.registration.pushManager.getSubscription();
  } catch { state.serviceWorkerError = true; }
  renderPush();
}

function enablePush() {
  if (!requireUser() || pushSupport() || state.serviceWorkerError || !state.registration?.pushManager || !state.config?.vapidPublicKey) return;
  return runAction('push', async () => {
    // Primera llamada asíncrona dentro del gesto: Safari exige activación del usuario.
    // subscribe pide permiso; no se llama requestPermission durante el arranque.
    const subscription = await state.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64PublicKey(state.config.vapidPublicKey) });
    state.browserSubscription = subscription;
    await mutate('/api/push/subscribe', subscription.toJSON());
    state.pushRegisteredFor = state.user.id;
    feedback('Dispositivo registrado para recibir avisos. Usa Probar aviso para comprobar la recepción; no podemos garantizar la entrega.');
    await refresh(true);
  });
}
async function removeDeviceSubscription() {
  const subscription = state.browserSubscription;
  if (!subscription) return;
  try { await mutate('/api/push/unsubscribe', { endpoint: subscription.endpoint }); }
  catch (error) {
    // Una suscripción residual de otra cuenta no debe impedir que su dueño
    // actual revoque el permiso local ni cerrar sesión en este navegador.
    if (error.status !== 404) throw error;
  }
  const unsubscribed = await subscription.unsubscribe();
  if (!unsubscribed && await state.registration?.pushManager.getSubscription()) throw inputError('La suscripción se retiró de tu cuenta, pero el navegador no pudo desactivarla. Revisa sus permisos de notificación.');
  state.browserSubscription = null;
  state.pushRegisteredFor = null;
}

function renderControls() {
  renderPush();
  renderChargerControls();
  const blocked = !canWrite();
  for (const id of ['leave-turn', 'release-turn']) disabled(byId(id), blocked || state.busy.has('queue'));
  disabled($('#estimate-form button[type="submit"]'), blocked || state.busy.has('queue'));
  disabled(byId('clear-estimate'), blocked || state.busy.has('queue'));
  disabled(byId('logout-button'), blocked || state.busy.size > 0);
  disabled($('#login-form button[type="submit"]'), !dataFresh() || !state.sessionKnown || state.busy.has('auth'));
  for (const [name, key] of [['zone', 'admin-zone'], ['resource', 'admin-resource']]) disabled($(`#create-${name}-form button[type="submit"]`), blocked || state.busy.has(key) || (name === 'resource' && state.zones.length === 0));
  // Las tarjetas se actualizan por identidad, nunca reconstruimos un formulario.
  for (const zone of state.zones) {
    const node = zoneNodes.get(String(zone.id));
    if (node) updateZone(node, zone);
  }
  for (const [id, node] of adminNodes) {
    const busy = state.busy.has(`admin-status:${id}`);
    disabled($('button[type="submit"]', node), blocked || busy);
    const finished = state.zones.flatMap((zone) => zone.resources || []).find((resource) => String(resource.id) === id)?.chargeFinishedAt;
    disabled($('[data-action="charge-finished"]', node), blocked || busy || Boolean(finished));
  }
  renderTimer();
}

function renderRejoinControl() {
  const queue = state.me?.queue;
  const privateDirectory = privateChargersEnabled();
  const siteExists = privateDirectory ? chargers.data?.sites.some(site => site.zoneId === queue?.zoneId)
    : state.zones.some(zone => zone.id === queue?.zoneId);
  const button = byId('rejoin-turn');
  const free = privateDirectory && siteHasFreeConnector(queue?.zoneId);
  visible(button, queue?.state === 'CANCELLED' && queue.reason === 'USER_LEFT' && siteExists);
  disabled(button, free || !canWrite() || state.busy.has('queue') || (privateDirectory && (chargers.status !== 'ready' || !chargerSnapshotFresh())));
}

function render() {
  for (const panel of $$('[data-session-only]')) visible(panel, Boolean(state.user));
  visible(byId('landing-sign-in'), !state.user);
  renderConnection();
  renderAccount();
  renderChargers();
  renderZones();
  renderTurn();
  renderNotifications();
  renderAdmin();
  renderControls();
  if (number(state.config?.offerSeconds) > 0) text(byId('offer-instructions'), `Responde a la oferta en ${durationLabel(number(state.config.offerSeconds))}. Confirma que estás cargando y comparte tu previsión. Solo al retirar el coche, pulsa «He liberado la plaza».`);
}

function openAuth({ reconnect = false } = {}) {
  if (state.user && privateChargersEnabled()) { openPrivatePage('account-card'); return; }
  if (state.user) { byId('account-card').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); return; }
  formMessage('login-message', '');
  visible(byId('auth-reconnect-note'), reconnect);
  if (!dataFresh()) formMessage('login-message', 'No hay conexión verificada. Puedes preparar el formulario, pero para enviarlo debes reconectar.');
  if (!byId('auth-dialog').open) byId('auth-dialog').showModal();
  byId('login-username').focus();
}
function handleAuthentication(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const values = new FormData(form);
  void runAction('auth', async () => {
    // El usuario se recorta; la contraseña se envía exactamente como se escribió.
    const session = await mutate(LOGIN_PATH, { username: String(values.get('username')).trim(), password: String(values.get('password')) });
    applySession(session, { renewed: !byId('auth-reconnect-note').hidden });
    byId('login-form').reset();
    visible(byId('auth-reconnect-note'), false);
    byId('auth-dialog').close();
    feedback('Sesión de EVsare iniciada. Ya puedes consultar tu cuenta y gestionar tu turno.');
    await refresh(true);
  }, { form, message: 'login-message' }).then(() => {
    if (privateChargersEnabled() && chargers.status === 'idle') void loadChargers();
  });
}

// Eventos de formularios: nunca se registran de nuevo durante el polling.
$$('[data-open-auth]').forEach((button) => button.addEventListener('click', () => openAuth()));
byId('auth-close').addEventListener('click', () => byId('auth-dialog').close());
byId('auth-dialog').addEventListener('close', () => {
  // No conservar contraseñas después de cerrar el formulario.
  byId('login-password').value = '';
  visible(byId('auth-reconnect-note'), false);
});
byId('profile-refresh').addEventListener('click', () => {
  void loadEVsareAccount(true);
  closeRfidCards();
  void byId('profile-rfid').firstElementChild?.loadCards(true);
});
byId('recharges-refresh').addEventListener('click', () => { void loadEVsareData('recharges', true); });
byId('chargers-refresh').addEventListener('click', () => { void loadChargers(); });
byId('chargers-reconnect').addEventListener('click', reconnectEVsare);
byId('chargers-search').addEventListener('input', () => {
  chargers.selectionTouched = true;
  renderChargerResults();
});
byId('chargers-only-favorites').addEventListener('click', () => {
  chargers.onlyFavorites = !chargers.onlyFavorites;
  chargers.selectionTouched = true;
  renderChargerResults();
});
for (const event of ['click', 'focusin']) byId('charger-site-details').addEventListener(event, () => { chargers.selectionTouched = true; });
byId('charger-map-search').addEventListener('click', () => {
  if (chargers.view !== 'map') return;
  const open = byId('charger-map-search').getAttribute('aria-expanded') === 'true';
  chargers.mapSearchOpen = !open;
  if (open) byId('chargers-search').value = '';
  renderChargerResults();
  if (!open) byId('chargers-search').focus();
});
byId('charger-map-markers').addEventListener('click', event => {
  if (event.target.closest('.charger-map-pin')) chargers.selectionTouched = true;
});
byId('charger-map-overview').addEventListener('click', () => {
  if (!privateChargersEnabled() || !chargers.data || chargers.view !== 'map') return;
  byId('chargers-map-view').focus({ preventScroll: true });
  chargerMap.open(chargers.data.sites);
});
byId('chargers-map-view').addEventListener('click', () => {
  if (!privateChargersEnabled() || !chargers.data) return;
  const opening = chargers.view !== 'map';
  chargers.view = opening ? 'map' : 'list';
  if (!opening) chargerMap.clear();
  renderChargerResults(opening);
});
// Reconectar vuelve a pedir la contraseña de EVsare. La cola y las zonas
// seguidas de A la caaarga!! no se borran: solo se sustituye la sesión de acceso.
byId('profile-reconnect').addEventListener('click', reconnectEVsare);
async function reconnectEVsare() {
  if (!state.user || state.busy.has('auth')) return;
  state.busy.add('auth');
  renderControls();
  try {
    await mutate('/api/logout', {});
    applySession({ user: null, csrfToken: null }, { renewed: true });
    await refresh(true);
  } catch (error) {
    feedback(error instanceof ApiError ? error.message : friendlyBrowserError(error), 'error');
    return;
  } finally {
    state.busy.delete('auth');
    render();
  }
  openAuth({ reconnect: true });
}
byId('login-form').addEventListener('submit', handleAuthentication);
byId('filter-form').addEventListener('submit', (event) => event.preventDefault());
byId('zone-search').addEventListener('input', () => filterZones(true));
byId('connector-filter').addEventListener('change', () => filterZones(true));
byId('following-filter').addEventListener('change', () => { preferences.onlyFollowing = byId('following-filter').checked; savePreferences(); filterZones(true); });
byId('clear-filters').addEventListener('click', () => {
  byId('filter-form').reset();
  byId('following-filter').checked = false;
  preferences.onlyFollowing = false;
  savePreferences();
  filterZones(true);
  byId('zone-search').focus();
});
byId('empty-admin-link').addEventListener('click', () => { byId('admin-panel').open = true; });
byId('feedback-dismiss').addEventListener('click', hideFeedback);
byId('feedback').addEventListener('pointerleave', scheduleFeedbackDismissal);
byId('feedback').addEventListener('focusout', scheduleFeedbackDismissal);
byId('retry-button').addEventListener('click', () => void refresh(true));
byId('accept-turn').addEventListener('click', () => queueAction('accept', 'Has aceptado: «Voy». Confirma tu llegada dentro del plazo. No es una reserva oficial.'));
byId('start-turn').addEventListener('click', () => queueAction('start', 'Has comunicado que estás cargando. Puedes añadir una previsión; recuerda liberar la plaza solo después de retirar el coche.'));
byId('complete-turn').addEventListener('click', () => queueAction('complete', 'Turno completado sin declarar la plaza libre. El recurso queda sin verificar.'));
byId('release-turn').addEventListener('click', () => queueAction('release', 'Has confirmado la liberación física de la plaza. El servidor puede ofrecerla a la siguiente persona compatible.'));
byId('leave-turn').addEventListener('click', () => queueAction('leave', state.me?.queue?.state === 'CHARGING' ? 'Participación cerrada sin declarar la plaza libre. El recurso necesita una nueva observación.' : 'Has salido del turno. No volverás a la cola automáticamente.'));
byId('rejoin-turn').addEventListener('click', () => {
  const queue = state.me?.queue;
  if (!queue || queue.state !== 'CANCELLED' || queue.reason !== 'USER_LEFT' || !canWrite() || state.busy.has('queue')) return;
  if (privateChargersEnabled()) { chargerAction(queue.zoneId, true); return; }
  void runAction('queue', async () => {
    const response = await mutate('/api/queue', { zoneId: queue.zoneId, connector: queue.connector, plannedMinutes: queue.plannedMinutes ?? null });
    acceptQueueResponse(response);
    feedback('Has vuelto a la cola.');
    await refresh(true);
  });
});
byId('expected-release').addEventListener('input', () => { byId('expected-release').dataset.dirty = 'true'; });
byId('estimate-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!requireUser() || state.me?.queue?.state !== 'CHARGING') return;
  runAction('queue', async () => {
    const value = byId('expected-release').value;
    const expectedReleaseAt = value ? new Date(value).getTime() : null;
    if (value && (!Number.isFinite(expectedReleaseAt) || expectedReleaseAt <= serverNow() || expectedReleaseAt > serverNow() + 7 * 86400000)) throw inputError('Elige una fecha y hora futuras, dentro de los próximos 7 días. La previsión no libera la plaza automáticamente.');
    const response = await mutate(`/api/queue/${state.me.queue.id}/estimate`, { expectedReleaseAt });
    byId('expected-release').dataset.dirty = 'false';
    acceptQueueResponse(response);
    formMessage('estimate-message', expectedReleaseAt ? 'Previsión guardada. Es un recordatorio, no telemetría de batería.' : 'Previsión retirada. La plaza sigue ocupada.', 'success');
    await refresh(true);
  }, { message: 'estimate-message' });
});
byId('clear-estimate').addEventListener('click', () => {
  if (!requireUser() || state.me?.queue?.state !== 'CHARGING') return;
  runAction('queue', async () => {
    const response = await mutate(`/api/queue/${state.me.queue.id}/estimate`, { expectedReleaseAt: null });
    byId('expected-release').dataset.dirty = 'false';
    acceptQueueResponse(response);
    formMessage('estimate-message', 'Previsión retirada. La plaza sigue ocupada.', 'success');
    await refresh(true);
  }, { message: 'estimate-message' });
});

byId('enable-push').addEventListener('click', enablePush);
byId('disable-push').addEventListener('click', () => {
  if (!requireUser()) return;
  runAction('push', async () => { await removeDeviceSubscription(); feedback('Avisos desactivados en este dispositivo. Sigues conservando tus zonas y tu turno.'); await refresh(true); });
});
byId('test-push').addEventListener('click', () => {
  if (!requireUser()) return;
  runAction('push', async () => { await mutate('/api/push/test'); feedback('Prueba solicitada. Comprueba si recibes el aviso en tus dispositivos; la entrega no está garantizada.'); await refresh(true); });
});
byId('logout-button').addEventListener('click', () => {
  if (!requireUser()) return;
  runAction('auth', async () => {
    let pushWarning = false;
    try { await removeDeviceSubscription(); }
    catch {
      pushWarning = true;
      // Cerrar sesión nunca queda bloqueado por un proveedor push averiado.
      try {
        if (await state.browserSubscription?.unsubscribe()) {
          state.browserSubscription = null;
          state.pushRegisteredFor = null;
        }
      } catch { /* Se informa del permiso local pendiente tras el logout. */ }
    }
    await mutate('/api/logout');
    applySession({ user: null, csrfToken: null });
    state.me = null;
    feedback(pushWarning ? 'Sesión cerrada; tu turno no se cancela. No se pudo verificar la baja completa de avisos: revisa el permiso de notificaciones de este sitio.' : 'Sesión cerrada. Tu turno no se ha cancelado; puedes volver a entrar para gestionarlo.', pushWarning ? 'error' : 'success');
    await refresh(true);
  });
});

byId('create-zone-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!requireUser() || state.user.role !== 'admin') return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  // FormData debe leerse antes de desactivar fieldset.
  const values = new FormData(form);
  runAction('admin-zone', async () => {
    const body = { name: String(values.get('name')).trim(), description: String(values.get('description')).trim() };
    const latitude = String(values.get('latitude')).trim();
    const longitude = String(values.get('longitude')).trim();
    if (Boolean(latitude) !== Boolean(longitude)) throw inputError('Indica latitud y longitud juntas, o deja ambas vacías.');
    if (latitude && longitude) { body.latitude = Number(latitude); body.longitude = Number(longitude); }
    const radius = String(values.get('radiusMeters')).trim();
    if (radius) body.radiusMeters = Number(radius);
    await mutate('/api/admin/zones', body);
    form.reset();
    formMessage('create-zone-message', 'Zona creada. Añade sus recursos físicos para que aparezcan en la lista.', 'success');
    await refresh(true);
  }, { form, message: 'create-zone-message' });
});
byId('create-resource-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!requireUser() || state.user.role !== 'admin') return;
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const values = new FormData(form);
  runAction('admin-resource', async () => {
    await mutate('/api/admin/resources', { zoneId: Number(values.get('zoneId')), name: String(values.get('name')).trim(), connector: String(values.get('connector')), powerKw: Number(values.get('powerKw')) });
    const zoneId = form.elements.zoneId.value;
    form.reset();
    form.elements.zoneId.value = zoneId;
    formMessage('create-resource-message', 'Recurso añadido con estado desconocido. Registra una observación manual cuando lo verifiques.', 'success');
    await refresh(true);
  }, { form, message: 'create-resource-message' });
});

window.addEventListener('offline', () => { state.connection = 'offline'; render(); });
window.addEventListener('online', () => { void refresh(true); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { render(); void refresh(true); }
});
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.installPrompt = event;
  visible(byId('install-app'), true);
});
byId('install-app').addEventListener('click', async () => {
  if (!state.installPrompt) return;
  const prompt = state.installPrompt;
  state.installPrompt = null;
  disabled(byId('install-app'), true);
  try { await prompt.prompt(); await prompt.userChoice; }
  catch { feedback('Usa el menú de tu navegador para instalar A la caaarga!!.', 'error'); }
  finally { visible(byId('install-app'), false); disabled(byId('install-app'), false); }
});
window.addEventListener('appinstalled', () => { state.installPrompt = null; visible(byId('install-app'), false); });
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (event) => {
  if (event.data?.type === 'ALACARGA_REFRESH') {
    void refresh(true);
    if (event.data.focusTurn) scrollToTurn();
  }
});

byId('settings-open').addEventListener('click', openPreferences);
byId('vehicle-settings-open').addEventListener('click', openPreferences);
byId('settings-close').addEventListener('click', () => byId('settings-dialog').close());
const preferencesForm = byId('preferences-form');
let preferencesSaveTimer = null;
byId('reset-preferences').addEventListener('click', () => {
  fillPreferencesForm(cleanPreferences());
  applyPreferencesForm();
});
function applyPreferencesForm() {
  clearTimeout(preferencesSaveTimer);
  preferencesSaveTimer = null;
  if (!preferencesForm.checkValidity()) {
    formMessage('preferences-message', 'Revisa los campos no válidos para guardar los cambios.');
    return;
  }
  const form = new FormData(preferencesForm);
  const previousConnector = preferences.vehicle.connector;
  const previousDuration = preferences.vehicle.plannedMinutes;
  preferences = cleanPreferences({
    theme: form.get('theme'), density: form.get('density'), zoneView: preferences.zoneView,
    onlyFollowing: preferences.onlyFollowing,
    vehicle: { alias: form.get('vehicleAlias'), make: form.get('vehicleMake'), model: form.get('vehicleModel'), capacityKwh: form.get('vehicleCapacity'), connector: form.get('vehicleConnector'), plannedMinutes: form.get('vehicleDuration') },
  });
  const saved = savePreferences();
  applyAppearance();
  byId('following-filter').checked = preferences.onlyFollowing;
  if (previousConnector !== preferences.vehicle.connector) {
    byId('connector-filter').value = preferences.vehicle.connector;
    for (const node of zoneNodes.values()) {
      const select = $('.join-form select', node);
      if (select.dataset.dirty !== 'true') select.value = preferences.vehicle.connector;
    }
  }
  if (previousDuration !== preferences.vehicle.plannedMinutes) for (const node of zoneNodes.values()) {
    const input = $('input[name="plannedMinutes"]', node);
    if (input.dataset.dirty !== 'true') input.value = preferences.vehicle.plannedMinutes ?? '';
  }
  filterZones(true);
  formMessage('preferences-message', saved ? 'Guardado en este dispositivo.' : 'Aplicado a esta sesión; el navegador no permite guardarlo.', saved ? 'success' : 'error');
}
preferencesForm.addEventListener('input', (event) => {
  if (event.isComposing) return;
  clearTimeout(preferencesSaveTimer);
  preferencesSaveTimer = setTimeout(applyPreferencesForm, 550);
});
preferencesForm.addEventListener('compositionend', () => {
  clearTimeout(preferencesSaveTimer);
  preferencesSaveTimer = setTimeout(applyPreferencesForm, 550);
});
preferencesForm.addEventListener('change', applyPreferencesForm);
preferencesForm.addEventListener('submit', (event) => { event.preventDefault(); applyPreferencesForm(); });
byId('settings-dialog').addEventListener('close', () => {
  if (preferencesSaveTimer !== null) applyPreferencesForm();
});
systemTheme.addEventListener('change', () => { if (preferences.theme === 'system') applyAppearance(); });

window.setInterval(() => { if (!document.hidden) void refresh(); }, POLL_MS);
window.setInterval(() => {
  renderTimer();
  if (state.connection === 'online' && !dataFresh()) { state.connection = navigator.onLine === false ? 'offline' : 'error'; render(); }
}, 1000);
applyAppearance();
byId('connector-filter').value = preferences.vehicle.connector;
byId('following-filter').checked = preferences.onlyFollowing;
render();
void refresh();
void prepareServiceWorker();
