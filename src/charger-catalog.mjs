import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { fail } from './errors.mjs';
import { safeText } from './evsare.mjs';

const PROJECT = 'ibil-pro';
const DATABASE = 'https://ibil-pro.firebaseio.com/emplazamientosv3/cpo1/';
const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const TYPES = { 0: 'CCS2', 1: 'SCHUKO', 2: 'TYPE2', 3: 'TYPE2', 6: 'CCS2', 8: 'TYPE2', 9: 'CHADEMO' };
const LABELS = { CCS2: 'CCS2', SCHUKO: 'Schuko', TYPE2: 'Tipo 2', CHADEMO: 'CHAdeMO' };
const STATES = { 1: 'AVAILABLE', 2: 'BUSY', 3: 'RESERVED', 5: 'RECHARGING', 6: 'MAINTENANCE' };
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const entries = v => record(v) ? Object.entries(v) : [];
const str = (v, max = 200) => safeText(v, max)?.trim() || null;
const unavailable = () => fail(503, 'CHARGER_CATALOG_UNAVAILABLE', 'No se pudieron actualizar tus cargadores. Inténtalo más tarde.');

export function parcelNumbers(value) {
  // Solo referencias explícitas; el guion separa etiquetas, nunca genera parcelas intermedias.
  const match = /\bparcelas?\s*[:#]?\s*(\d{1,6}[a-z]?(?:\s*(?:[-–—,/]|\by\b)\s*\d{1,6}[a-z]?)*)(?=$|[^\w])/i.exec(value ?? '');
  return match ? [...new Set(match[1].match(/\d{1,6}[a-z]?/gi).map(label => label.toUpperCase()))] : [];
}

function displayParcelNumbers(description, moreInformation) {
  // Formatos explícitos del catálogo: «Plaza N-N» al final de la descripción,
  // o «Parcela(s) N-N» como texto completo del campo moreInformation.
  const pair = /(?<![\p{L}\p{N}_])plaza\s+(\d{1,6})\s*-\s*(\d{1,6})$/iu.exec(description ?? '')
    ?? /^parcelas?\s+(\d{1,6})\s*-\s*(\d{1,6})$/i.exec(moreInformation ?? '');
  return pair ? [...new Set(pair.slice(1))] : [];
}

export function loadCatalogCredentials(path) {
  if (!path) return null;
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192) throw new Error();
      const { username, password, firebase_api_key: key } = JSON.parse(readFileSync(fd, 'utf8'));
      if (!str(username, 254) || typeof password !== 'string' || !password || password.length > 1024 || !/^AIza[\w-]{35}$/.test(key ?? '')) throw new Error();
      return { email: username, password, key };
    } finally { closeSync(fd); }
  } catch { throw new Error('EVSARE_CATALOG_CREDENTIALS debe apuntar a un JSON privado y válido (0600).'); }
}

export function normalizeCatalog(emplacements, terminals, rates) {
  const rateById = new Map(entries(rates).filter(([, rate]) => Number.isSafeInteger(rate?.id)).map(([, rate]) => [rate.id, rate]));
  const sites = [], permissions = new Map();
  for (const [siteKey, site] of entries(emplacements)) {
    const name = str(site?.name);
    if (!name || !/^e[1-9]\d{0,14}$/.test(siteKey) || !Array.isArray(site.terminalsId)) continue;
    const validCoordinates = Number.isFinite(site.lat) && Math.abs(site.lat) <= 90 && Number.isFinite(site.long) && Math.abs(site.long) <= 180;
    const place = { id: siteKey, name, address: str(site.address, 300), openingHours: str(site.opening_hours, 400), latitude: validCoordinates ? site.lat : null,
      longitude: validCoordinates ? site.long : null, terminals: [] };
    for (const key of new Set(site.terminalsId)) {
      if (typeof key !== 'string' || !/^t[1-9]\d{0,14}$/.test(key) || permissions.has(key)) continue;
      const terminal = terminals[key];
      if (!record(terminal) || key !== `t${terminal.id}` || terminal.emplacementId !== site.id || !Array.isArray(terminal.userId)) continue;
      const members = new Set(terminal.userId.filter(u => typeof u === 'string' && /^u?[1-9]\d{0,14}$/.test(u)).map(u => u.replace(/^u/, '')));
      if (!members.size) continue;
      permissions.set(key, members);
      const connectors = entries(terminal.connectors).filter(([, c]) => Number.isSafeInteger(c?.id)).map(([, c]) => ({ id: c.id, kind: TYPES[c.type] ?? null,
        label: /^[A-Z]$/i.test(str(c.idphysical, 8) ?? '') ? str(c.idphysical, 8).toUpperCase() : null,
        name: LABELS[TYPES[c.type]] ?? (c.type === 7 ? 'Tipo 1' : str(c.description, 80) ?? 'Conector'), power: Number.isFinite(c.power) && c.power > 0 ? c.power : null }));
      const tariffSegments = entries(rateById.get(terminal.idRate)?.rateSegments).map(([, s]) => ({ description: str(s?.description), start: str(s?.start, 32), end: str(s?.end, 32) }))
        .filter(s => s.description || s.start || s.end);
      const description = str(terminal.description, 200);
      const namedParcels = parcelNumbers(description);
      const providerName = description && /^IN\d{3,8}$/i.test(description) ? description : null;
      const name = namedParcels.length ? description : providerName ?? str(terminal.internalName, 100) ?? description ?? 'Cargador';
      const originalParcels = namedParcels.length ? namedParcels : parcelNumbers(name);
      const displayParcels = originalParcels.length ? [] : displayParcelNumbers(description, str(terminal.moreInformation, 200));
      place.terminals.push({ id: key, name, connectors, parcels: originalParcels.length ? originalParcels : displayParcels,
        // La rama nativa no Bluetooth no usa connectedToIbilsare; las parcelas solo son etiquetas.
        remoteCompatible: Number.isSafeInteger(site.id) && siteKey === `e${site.id}` &&
          (terminal.isBluetooth == null || terminal.isBluetooth === false) && terminal.isInteroperable !== true &&
          (terminal.broker_interop == null || terminal.broker_interop === 'IBILSARE'),
        tariffSegments, comingSoon: site.comingSoon === true || terminal.comingSoon === true,
        blocked: site.maintenance === true || terminal.maintenance === true ? 'MAINTENANCE' :
          [site.comingSoon, site.restricted, terminal.comingSoon, terminal.restricted].includes(true) ? 'UNKNOWN' : null });
    }
    if (place.terminals.length) sites.push(place);
  }
  return { sites, permissions };
}

export function terminalState(terminal, telemetry) {
  const live = telemetry?.[terminal.id]?.connectors;
  const statesById = new Map(entries(live).map(([, c]) => [c?.id, STATES[c?.state] ?? 'UNKNOWN']));
  const chargeStates = new Map();
  for (const [, c] of entries(live)) {
    if (Number.isSafeInteger(c?.id)) chargeStates.set(c.id, !chargeStates.has(c.id) && c.state === 1);
  }
  const connectors = terminal.connectors.map(c => ({ ...c, state: terminal.blocked ?? statesById.get(c.id) ?? 'UNKNOWN',
    chargeAvailable: !terminal.blocked && chargeStates.get(c.id) === true }));
  // No asumir que varios conectores equivalen a varias plazas independientes.
  const state = terminal.blocked ?? (connectors.length && connectors.every(c => c.state === 'AVAILABLE') ? 'AVAILABLE' :
    ['RECHARGING', 'BUSY', 'RESERVED', 'MAINTENANCE'].find(s => connectors.some(c => c.state === s)) ?? 'UNKNOWN');
  return { ...terminal, state, connectors };
}

export class ChargerCatalog {
  constructor(credentials, { fetchImpl = fetch, clock = Date.now } = {}) {
    Object.assign(this, { credentials, fetchImpl, clock, nextRead: 0, metadataAt: 0, observedAt: null, token: null, pending: null });
  }
  async json(url, body, cap = 8 * 1024 * 1024) {
    try {
      const response = await this.fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > cap) { await response.body?.cancel(); unavailable(); }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) { size += chunk.length; if (size > cap) unavailable(); chunks.push(chunk); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!record(result)) unavailable();
      return result;
    } catch { unavailable(); }
  }
  async signIn() {
    if (this.token && this.tokenUntil > this.clock()) return this.token;
    const { email, password, key } = this.credentials;
    const { idToken, expiresIn } = await this.json(`${AUTH}?${new URLSearchParams({ key })}`, { email, password, returnSecureToken: true }, 32768);
    try {
      if (typeof idToken !== 'string' || idToken.length > 8192) unavailable();
      const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
      if (claims.aud !== PROJECT || claims.iss !== `https://securetoken.google.com/${PROJECT}` || !Number.isFinite(claims.exp) || !/^\d+$/.test(expiresIn)) unavailable();
      this.tokenUntil = Math.min(claims.exp * 1000, this.clock() + Number(expiresIn) * 1000) - 60000;
      if (this.tokenUntil <= this.clock()) unavailable();
      return (this.token = idToken);
    } catch { unavailable(); }
  }
  refresh() {
    if (this.pending) return this.pending;
    if (this.clock() < this.nextRead) return Promise.resolve();
    this.nextRead = this.clock() + 15000;
    this.pending = (async () => {
      const token = await this.signIn();
      const read = name => this.json(`${DATABASE}${name}.json?${new URLSearchParams({ auth: token })}`);
      const started = this.clock();
      const metadata = !this.metadata || started - this.metadataAt >= 120000;
      const [telemetry, emplacements, terminals, rates] = await Promise.all([read('connectors'), ...(metadata ? ['emplacements', 'terminal', 'rates'].map(read) : [])]);
      if (metadata) { this.metadata = normalizeCatalog(emplacements, terminals, rates); this.metadataAt = started; }
      // No conservar los userId de ocupantes del feed de estado.
      this.sites = this.metadata.sites.map(site => ({ ...site, terminals: site.terminals.map(t => terminalState(t, telemetry)) }));
      this.terminals = new Map(this.sites.flatMap(site => site.terminals.map(t => [t.id, t])));
      this.observedAt = started;
      this.failed = false;
    })().catch(error => { this.failed = true; this.token = null; this.nextRead = this.clock() + 30000; throw error; })
      .finally(() => { this.pending = null; });
    return this.pending;
  }
  readable() { return Boolean(this.sites && this.metadata && this.clock() - this.metadataAt < 150000); }
  fresh() { return !this.failed && this.readable() && this.observedAt !== null && this.clock() - this.observedAt < 40000; }
  allows(key, subject, { requireFresh = true } = {}) {
    return Boolean((requireFresh ? this.fresh() : this.readable()) && this.metadata.permissions.get(key)?.has(subject));
  }
  view(subject) {
    if (!this.readable()) unavailable();
    const fresh = this.fresh();
    return { status: fresh ? 'fresh' : 'stale', observedAt: this.observedAt, sites: this.sites.map(site => ({ ...site,
      terminals: site.terminals.filter(t => this.metadata.permissions.get(t.id)?.has(subject)).map(t => fresh ? t : { ...t, state: 'UNKNOWN', connectors: t.connectors.map(c => ({ ...c, state: 'UNKNOWN' })) }),
    })).filter(site => site.terminals.length) };
  }
}
