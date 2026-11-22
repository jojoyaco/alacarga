import { get as httpsGet } from 'node:https';
import { AppError, fail, object } from './errors.mjs';
import { reauthenticate } from './token-vault.mjs';

const ORIGIN = 'https://appkbs.ibilcloud.com';
const RECHARGES = '/recargas?broker_interop=IBILSARE&todosUsuarios=false&descripcionesLocalizacion=true&rowsLimit=20&rowsOffset=0';
const TERMINAL_HISTORY_LIMIT = 20;
const TERMINAL_HISTORY = `/recargas?broker_interop=IBILSARE&todosUsuarios=false&descripcionesLocalizacion=false&rowsLimit=${TERMINAL_HISTORY_LIMIT}&rowsOffset=0&idTerminal=`;
const terminalHistoryId = /^\/recargas\?broker_interop=IBILSARE&todosUsuarios=false&descripcionesLocalizacion=false&rowsLimit=20&rowsOffset=0&idTerminal=([1-9]\d{0,9})$/;
const RFID_CARDS = '/user/cards';
const ACTIVE_RFID_CARDS = '/user/cards?soloActivas=true';
const START_CHARGE = '/recargas/iniciarrecarga?broker_interop=IBILSARE';
export const START_CHARGE_NOT_STARTED = Symbol('EVsare explicitly rejected start');
const ROUTES = new Map([
  ['/user/login2', 'POST'], ['/user/renewtoken', 'POST'], ['/user/datosusuario', 'GET'],
  [RECHARGES, 'GET'], [RFID_CARDS, 'GET'], [ACTIVE_RFID_CARDS, 'GET'], [START_CHARGE, 'POST'],
]);
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 12 * 60_000;
const CACHE_SESSIONS = 64;
const CACHE_CURVES_PER_SESSION = 20;
const badResponse = () => fail(502, 'EVSARE_BAD_RESPONSE', 'EVsare devolvió una respuesta no reconocida. No se han supuesto datos.');
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const validRechargeId = value => Number.isInteger(value) && value >= 1 && value <= 2147483647;
export const safeText = (value, max = 254) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const date = value => {
  const str = safeText(value, 64);
  return str && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(str) && Number.isFinite(Date.parse(str)) ? str : null;
};
const knownTime = value => {
  const str = date(value);
  if (!str) return null;
  // Date.parse normalizes impossible dates such as February 31.
  const day = new Date(`${str.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(day.valueOf()) || day.toISOString().slice(0, 10) !== str.slice(0, 10)) return null;
  const time = Date.parse(str);
  return time >= 946684800000 && time <= 4102444800000 ? time : null;
};
function tokenFrom(data) {
  if (!record(data) || typeof data.token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(data.token)) badResponse();
  return data.token;
}
export function evsareCredentials(body) {
  object(body);
  if (!safeText(body.username) || !body.username.trim()) fail(400, 'INVALID_USERNAME', 'Introduce tu correo o usuario de EVsare (hasta 254 caracteres).');
  if (typeof body.password !== 'string' || !body.password.length || body.password.length > 1024) fail(400, 'INVALID_PASSWORD', 'Introduce tu contraseña de EVsare (hasta 1024 caracteres).');
  // No aplicar reglas de registro local, recortar contraseña, normalizar caso ni hashear antes de enviar.
  return { idUsuario: body.username, password: body.password, idsubop: 1 };
}

export class EvsareClient {
  #finishTransport;
  constructor({ fetchImpl, timeoutMs = 10000 } = {}) {
    this.fetch = fetchImpl ?? globalThis.fetch; this.timeoutMs = timeoutMs; this.inFlight = 0;
    // Native fetch may replay an idempotent GET on a stale connection. This GET
    // is not idempotent: use a dedicated one-shot connection in production.
    this.#finishTransport = fetchImpl ? async (url, options) => {
      const res = await fetchImpl(url, { ...options, method: 'GET', redirect: 'error' });
      await res.body?.cancel();
      return res.status;
    } : (url, options) => new Promise((resolve, reject) => {
      const req = httpsGet(url, { ...options, agent: false }, res => {
        res.destroy(); // Provider response text does not establish that charging ended.
        resolve(res.statusCode);
      });
      req.once('error', reject);
    });
  }
  async request(path, { token, body, beforeSend } = {}) {
    const curveId = typeof path === 'string' ? /^\/recargas\/lecturas\/([1-9]\d{0,9})$/.exec(path) : null;
    const terminalId = typeof path === 'string' ? terminalHistoryId.exec(path) : null;
    const method = ROUTES.get(path) ?? ((curveId && validRechargeId(Number(curveId[1]))) ||
      (terminalId && token !== undefined && body === undefined && validRechargeId(Number(terminalId[1]))) ? 'GET' : null);
    if (!method) fail(404, 'EVSARE_ROUTE_UNSUPPORTED', 'Lectura EVsare no disponible.');
    if (this.inFlight >= 4) fail(503, 'EVSARE_BUSY', 'Conexión con EVsare ocupada. Reintenta en unos segundos.');
    this.inFlight++;
    try {
      const headers = { Accept: 'application/json', 'AppVersion': 'EVsare 1.4.1', 'Ibil-Language': 'es' };
      if (token !== undefined) headers['X-IBIL-TOKEN'] = tokenFrom({ token });
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      // Start-charge has no generic unguarded request path.
      if (path === START_CHARGE) {
        if (typeof beforeSend !== 'function' || token === undefined) fail(404, 'EVSARE_ROUTE_UNSUPPORTED', 'Inicio de carga no disponible.');
        beforeSend(); // Commit the safety lock before attempting any transmission.
      }
      const res = await this.fetch(ORIGIN + path, { method, headers, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        ...(method === 'GET' ? { cache: 'no-store' } : {}),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 401) fail(401, 'EVSARE_TOKEN_REJECTED', 'EVsare rechazó la autenticación.');
        if (res.status === 403) fail(403, 'EVSARE_FORBIDDEN', 'Tu cuenta no tiene acceso a esta función en EVsare.');
        if (res.status === 429) fail(503, 'EVSARE_RATE_LIMITED', 'EVsare ha limitado temporalmente las consultas. Reintenta más tarde.');
        if (res.status >= 500) fail(503, 'EVSARE_UNAVAILABLE', 'EVsare no está disponible. Reintenta más tarde.');
        fail(502, 'EVSARE_REQUEST_REJECTED', 'EVsare no aceptó esta solicitud. Comprueba tu acceso en la aplicación oficial.');
      }
      if (path === START_CHARGE && res.status !== 201) { await res.body?.cancel(); badResponse(); }
      if (!/^application\/json(?:;|$)/i.test(res.headers.get('content-type') || '') || Number(res.headers.get('content-length')) > MAX_BYTES) {
        await res.body?.cancel(); badResponse();
      }
      const chunks = []; let size = 0;
      if (!res.body) badResponse();
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > MAX_BYTES) badResponse();
        chunks.push(chunk);
      }
      let data;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { badResponse(); }
      if (!record(data)) badResponse();
      return data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      // No propagar mensajes/redirecciones/cuerpos/headers del proveedor ni errores de transporte.
      fail(503, 'EVSARE_UNAVAILABLE', 'No se pudo conectar con EVsare. Reintenta más tarde.');
    } finally { this.inFlight--; }
  }
  async finishCharge(id, token, beforeSend) {
    // Not in request()/read(): no generic routing, token renewal, retries or redirects.
    if (!validRechargeId(id) || token === undefined || typeof beforeSend !== 'function') {
      fail(404, 'EVSARE_ROUTE_UNSUPPORTED', 'Fin de carga no disponible.');
    }
    if (this.inFlight >= 4) fail(503, 'EVSARE_BUSY', 'Conexión con EVsare ocupada.');
    const headers = { Accept: 'application/json', 'AppVersion': 'EVsare 1.4.1', 'Ibil-Language': 'es',
      'X-IBIL-TOKEN': tokenFrom({ token }), 'Cache-Control': 'no-store, no-cache' };
    const signal = AbortSignal.timeout(this.timeoutMs);
    this.inFlight++;
    try {
      beforeSend(); // Synchronous validation and durable dispatch marker before any I/O.
      let status;
      try { status = await this.#finishTransport(`${ORIGIN}/recargas/finalizarrecarga/${id}`, { headers, signal }); }
      catch { badResponse(); }
      if (status !== 200) badResponse();
    } finally { this.inFlight--; }
  }
  async login(body) {
    const credentials = evsareCredentials(body);
    let data;
    try { data = await this.request('/user/login2', { body: credentials }); }
    catch (error) {
      if (error.code === 'EVSARE_TOKEN_REJECTED') fail(401, 'INVALID_CREDENTIALS', 'EVsare no aceptó el usuario o la contraseña.');
      throw error;
    }
    if (data.changePassword === true) fail(409, 'EVSARE_ACTION_REQUIRED', 'EVsare solicita un cambio de contraseña. Complétalo en la aplicación oficial y vuelve a entrar.');
    if (data.valid === false) fail(401, 'INVALID_CREDENTIALS', 'EVsare no aceptó el usuario o la contraseña.');
    if (data.valid !== true || !record(data.user) || !Number.isSafeInteger(data.user.userId) || data.user.userId <= 0) badResponse();
    return { token: tokenFrom(data), subject: String(data.user.userId), displayName: safeText(data.user.firstName, 100) || safeText(data.user.screenName, 100) || 'Cuenta EVsare' };
  }
}

export class EvsareAccess {
  #sessions = new Map();
  #clock;
  constructor(client, vault, clock = Date.now) {
    this.client = client; this.vault = vault; this.renewals = new Map(); this.#clock = clock;
  }
  #sessionKey(session) {
    // The local session hash, never a cookie, provider token or RFID number.
    return session?.tokenHash && session.user?.id != null ? `${session.user.id}:${session.tokenHash}` : null;
  }
  invalidateSession(session) {
    this.#evictSession(this.#sessionKey(session));
  }
  #evictSession(key) {
    const bucket = this.#sessions.get(key);
    if (!bucket) return;
    this.#sessions.delete(key);
    for (const map of [bucket.display, bucket.curves]) for (const key of map.keys()) this.#drop(map, key);
  }
  #cacheFor(session) {
    try { tokenFrom({ token: this.vault.getToken(session) }); }
    catch (error) { this.invalidateSession(session); throw error; }
    const key = this.#sessionKey(session);
    if (key === null) return null;
    const bucket = this.#sessions.get(key) ?? { display: new Map(), curves: new Map(), pending: new Map() };
    this.#sessions.delete(key);
    this.#sessions.set(key, bucket);
    if (this.#sessions.size > CACHE_SESSIONS) this.#evictSession(this.#sessions.keys().next().value);
    return bucket;
  }
  #drop(map, key) {
    const entry = map?.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    map.delete(key);
  }
  #lookup(map, key) {
    const entry = map?.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#clock()) { this.#drop(map, key); return undefined; }
    map.delete(key);
    map.set(key, entry);
    return entry.value;
  }
  #store(session, bucket, map, key, value, limit) {
    // An evicted/logged-out bucket is never reinstalled by a pending request.
    if (!bucket || this.#sessions.get(this.#sessionKey(session)) !== bucket) return;
    this.#drop(map, key);
    map.set(key, { value: structuredClone(value), expiresAt: this.#clock() + CACHE_TTL_MS,
      timer: setTimeout(() => this.#drop(map, key), CACHE_TTL_MS).unref() });
    if (map.size > limit) this.#drop(map, map.keys().next().value);
  }
  async #display(session, key, fresh, load) {
    const bucket = this.#cacheFor(session);
    if (!bucket) return load();
    if (!fresh) {
      const hit = this.#lookup(bucket.display, key);
      if (hit !== undefined) return structuredClone(hit);
    }
    // A force refresh bypasses stored data, but can share an already live load.
    let work = bucket.pending.get(key);
    if (!work) {
      work = (async () => {
        try {
          const value = await load();
          this.vault.getToken(session);
          this.#store(session, bucket, bucket.display, key, value, 3);
          return value;
        } catch (error) {
          if (error.code === 'EVSARE_FORBIDDEN') this.#drop(bucket.display, key);
          throw error;
        } finally { bucket.pending.delete(key); }
      })();
      bucket.pending.set(key, work);
    }
    const value = await work;
    this.vault.getToken(session);
    return structuredClone(value);
  }
  async renew(session, rejected) {
    const current = this.vault.getToken(session);
    if (current !== rejected) return current;
    const existing = this.renewals.get(session.tokenHash);
    if (existing) return existing;
    const work = (async () => {
      try {
        const data = await this.client.request('/user/renewtoken', { token: current });
        const next = tokenFrom(data);
        this.vault.put(next, session); // Revalida sesión: logout durante await nunca resucita el token.
        return next;
      } catch (error) {
        if (['EVSARE_TOKEN_REJECTED', 'EVSARE_FORBIDDEN'].includes(error.code)) {
          this.invalidateSession(session); this.vault.forget(session); reauthenticate();
        }
        throw error;
      }
    })();
    this.renewals.set(session.tokenHash, work);
    try { return await work; } finally { this.renewals.delete(session.tokenHash); }
  }
  async read(session, path) {
    const token = this.vault.getToken(session);
    let data;
    try { data = await this.client.request(path, { token }); }
    catch (error) {
      if (error.code !== 'EVSARE_TOKEN_REJECTED') throw error;
      const renewed = await this.renew(session, token);
      try { data = await this.client.request(path, { token: renewed }); }
      catch (retryError) {
        if (retryError.code === 'EVSARE_TOKEN_REJECTED') { this.invalidateSession(session); this.vault.forget(session); reauthenticate(); }
        throw retryError;
      }
    }
    this.vault.active(session); // No entregar datos después de logout/expiración mientras llegaba upstream.
    return data;
  }
  async profile(session, { fresh = false } = {}) {
    return this.#display(session, 'profile', fresh, async () => {
      const data = await this.read(session, '/user/datosusuario');
      return { profile: { name: safeText(data.nombre, 100), email: safeText(data.email),
        privacyAccepted: data.politicaAceptada === 1 ? true : data.politicaAceptada === 0 ? false : null } };
    });
  }
  async rechargeCurve(session, id, { fresh = false } = {}) {
    const notFound = () => fail(404, 'EVSARE_RECHARGE_NOT_FOUND', 'La recarga no está en tu historial reciente de IBILSARE.');
    if (!validRechargeId(id)) notFound();
    // Never use the display cache to authorize a curve, even if its readings are cached.
    const { recharges } = await this.#liveRecharges(session);
    const bucket = this.#cacheFor(session);
    const matches = recharges.filter(item => item.id === id);
    if (!matches.length) { this.#drop(bucket?.curves, id); notFound(); }
    const [{ startedAt, endedAt }] = matches;
    const started = knownTime(startedAt), ended = knownTime(endedAt);
    const finalized = matches.length === 1 && started !== null && ended !== null && ended >= started && ended <= this.#clock();
    const cached = this.#lookup(bucket?.curves, id);
    const reusable = finalized && cached?.started === started && cached.ended === ended;
    if (!reusable) this.#drop(bucket?.curves, id);
    if (!fresh && reusable) return structuredClone(cached.result);
    let curve;
    try { curve = await this.read(session, `/recargas/lecturas/${id}`); }
    catch (error) {
      if (error.code === 'EVSARE_FORBIDDEN') this.#drop(bucket?.curves, id);
      throw error;
    }
    const { charges } = curve;
    if (!Array.isArray(charges) || charges.length > 10000) badResponse();
    const byDate = new Map();
    for (const point of charges) {
      // Android zb.g.b interpreta date como ms y convierte lecture de Wh a kWh.
      if (!Number.isSafeInteger(point?.date) || point.date < 946684800000 || point.date > 4102444800000 ||
          !Number.isSafeInteger(point.lecture) || point.lecture < 0 || point.lecture > 2147483647) continue;
      byDate.set(point.date, point.lecture / 1000);
    }
    const series = [...byDate].sort(([a], [b]) => a - b);
    const points = series.length <= 500 ? series : Array.from({ length: 500 }, (_, i) => series[Math.round(i * (series.length - 1) / 499)]);
    const result = { points: points.map(([time, energyKwh]) => ({ time, energyKwh })) };
    const cacheable = finalized && result.points.length && ['charging', 'isCharging'].every(key => !Object.hasOwn(curve, key) || curve[key] === false);
    this.vault.getToken(session);
    if (cacheable) this.#store(session, bucket, bucket?.curves, id, { started, ended, result }, CACHE_CURVES_PER_SESSION);
    else this.#drop(bucket?.curves, id);
    return result;
  }
  async rfidCards(session, subject, { fresh = false } = {}) {
    const owner = String(subject);
    if (!/^[1-9]\d*$/.test(owner)) badResponse();
    return this.#display(session, `rfid:${owner}`, fresh, async () => maskRfidCards(await this.read(session, RFID_CARDS), owner));
  }
  async revealRfidCard(session, subject, ending) {
    if (typeof ending !== 'string' || !/^[A-Z0-9]{4}$/i.test(ending)) fail(400, 'INVALID_CARD_ENDING', 'Selecciona una tarjeta válida.');
    const cards = projectRfidCards(await this.read(session, RFID_CARDS), subject);
    const matches = cards.filter(card => card.ending === ending);
    if (matches.length !== 1) fail(409, 'RFID_CARD_NOT_UNIQUE', 'No se pudo identificar una única tarjeta. Actualiza tu perfil.');
    if (!matches[0].number) fail(404, 'RFID_NUMBER_UNAVAILABLE', 'EVsare no ha facilitado el número RFID de esta tarjeta.');
    return { number: matches[0].number };
  }
  async chargeCard(session) {
    const data = await this.read(session, ACTIVE_RFID_CARDS);
    if (!Array.isArray(data.cards) || data.cards.length > 1000) badResponse();
    if (data.cards.length !== 1) fail(409, 'EVSARE_CHARGE_RFID_NOT_UNIQUE', 'Se necesita una única tarjeta RFID activa en tu cuenta EVsare. Comprueba tus tarjetas en la app oficial.');
    const card = data.cards[0];
    if (!record(card) || !Number.isInteger(card.idtarjetarfid) || card.idtarjetarfid < 1 || card.idtarjetarfid > 2147483647) badResponse();
    return card.idtarjetarfid;
  }
  async startCharge(session, { terminal, connector, card }, beforeSend) {
    const token = this.vault.getToken(session);
    // Never renew, retry or follow redirects on this mutation.
    // Native RequestChargeRFIDPost (III): numeric terminal, numeric conector, JSON idtarjetarfid. No parcel or physical label goes upstream.
    const data = await this.client.request(START_CHARGE, { token, beforeSend, body: { terminal, conector: connector, idtarjetarfid: card } });
    if (data.iniciada === true) return true;
    // The 201 IniciarRecargaResponseDTO reports explicit rejection through iniciada + motivoRechazo.
    // A missing reason or a session ID is not sufficiently clear to release the dispatch guard.
    if (data.iniciada === false && Number.isInteger(data.motivoRechazo) &&
        data.motivoRechazo >= -2147483648 && data.motivoRechazo <= 2147483647 &&
        (data.sessionid == null || data.sessionid === '')) return START_CHARGE_NOT_STARTED;
    badResponse();
  }
  async terminalChargeEvidence(session, { terminal, earliest, latest, now }, observe) {
    if (!validRechargeId(terminal)) badResponse();
    const inconclusive = { state: 'AMBIGUOUS' };
    const data = await this.read(session, TERMINAL_HISTORY + terminal);
    if (!Array.isArray(data.recargas) || data.recargas.length > TERMINAL_HISTORY_LIMIT ||
        (data.recharges != null && (!Array.isArray(data.recharges) || data.recharges.length))) badResponse();
    const matches = [], ids = new Set();
    let uncertain = data.recargas.length === TERMINAL_HISTORY_LIMIT;
    for (const row of data.recargas) {
      if (!record(row) || row.idTerminal !== terminal) { uncertain = true; continue; }
      const started = knownTime(row.iniciots), ended = knownTime(row.fints);
      const missingEnd = row.fints == null || row.fints === '';
      const finished = started !== null && ended !== null && ended >= started && ended <= now;
      const validId = validRechargeId(row.idRecarga) && !ids.has(row.idRecarga);
      ids.add(row.idRecarga);
      if (!validId || started === null || started > now) { uncertain = true; continue; }
      if (started >= earliest && started <= latest) matches.push({ id: row.idRecarga, finished, missingEnd });
      else if (!finished) uncertain = true; // Same terminal can still have an older/delayed active charge.
    }
    if (matches.length > 1 || uncertain) {
      observe(null);
      return inconclusive;
    }
    if (!matches.length) return { state: 'NOT_FOUND' };
    const [{ id, finished, missingEnd }] = matches;
    if (!observe(id)) return inconclusive;
    if (finished) return { state: 'FINISHED', rechargeId: id };
    if (!missingEnd) return inconclusive;
    const curve = await this.read(session, `/recargas/lecturas/${id}`);
    // Swagger documents `charging`; the native DTO uses `isCharging`. An
    // explicit true is required, and a malformed/conflicting alias vetoes it.
    const flags = ['charging', 'isCharging'].filter(key => Object.hasOwn(curve, key)).map(key => curve[key]);
    return flags.length && flags.every(value => value === true) ? { state: 'ACTIVE', rechargeId: id } : inconclusive;
  }
  async finishCharge(session, id, beforeSend) {
    return this.client.finishCharge(id, this.vault.getToken(session), beforeSend);
  }
  async recharges(session, { fresh = false } = {}) {
    // For display only. Charging/reconciliation instead use terminalChargeEvidence().
    return this.#display(session, 'history', fresh, () => this.#liveRecharges(session));
  }
  async #liveRecharges(session) {
    const data = await this.read(session, RECHARGES);
    if (!Array.isArray(data.recargas) || data.recargas.length > 1000) badResponse();
    const label = (dictionary, id) => record(dictionary) && Object.hasOwn(dictionary, String(id)) ? safeText(dictionary[String(id)], 200) : null;
    const recharges = data.recargas.slice(0, 20).map(item => {
      if (!record(item) || !Number.isSafeInteger(item.idRecarga) || item.idRecarga <= 0 || item.idRecarga > 2147483647) badResponse();
      const endedAt = date(item.fints);
      // EVsare Android 1.4.1: zb/e divide RechargeDTO.energy (consumo) entre 1000;
      // ed/c muestra ese valor en kWh. El histórico IBILSARE no usa RechargeDTO.ammount.
      const validEnergy = Number.isInteger(item.consumo) && item.consumo >= 0 && item.consumo <= 2147483647;
      return { id: item.idRecarga, siteName: label(data.emplazamiento, item.idEmplazamiento), terminalName: label(data.terminal, item.idTerminal),
        startedAt: date(item.iniciots), endedAt, ...(endedAt && validEnergy ? { energyKwh: item.consumo / 1000 } : {}),
        ...(endedAt && Number.isFinite(item.importe) ? { reportedCost: item.importe } : {}) };
    });
    // unitsVerified sigue siendo false: no se ha verificado la moneda o escala de reportedCost.
    return { source: 'evsare', scope: 'own-IBILSARE', recharges, limit: 20, coverage: 'partial', unitsVerified: false };
  }
}

export function maskRfidCards(data, subject) {
  return { cards: projectRfidCards(data, subject).map(({ label, ending }) => ({ label, ending })) };
}

function projectRfidCards(data, subject) {
  if (!Array.isArray(data?.cards) || data.cards.length > 1000 || !/^[1-9]\d*$/.test(String(subject))) badResponse();
  const cards = [];
  const seen = new Set();
  for (const card of data.cards) {
    // Solo proyectar tarjetas devueltas por GET /user/cards con la sesión propia.
    // Android muestra las tarjetas del listado sin comparar idUsuario; ese campo no acredita autorización de carga.
    if (!record(card) || !Number.isSafeInteger(card.idtarjetarfid) || card.idtarjetarfid <= 0 || seen.has(card.idtarjetarfid)) continue;
    const code = [card.codigotarjetaibil, card.codigotarjetarfid].find(value => typeof value === 'string' && /^[A-Z0-9]{5,64}$/i.test(value));
    if (!code) continue;
    seen.add(card.idtarjetarfid);
    const number = typeof card.codigotarjetarfid === 'string' && /^[A-Z0-9]{5,64}$/i.test(card.codigotarjetarfid) ? card.codigotarjetarfid : null;
    cards.push({ label: 'Tarjeta RFID', ending: code.slice(-4), number });
  }
  return cards;
}
