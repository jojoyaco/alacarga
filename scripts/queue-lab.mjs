import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { AppError, fail } from '../src/errors.mjs';
import { Service } from '../src/service.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3115;

function seed() {
  const directory = mkdtempSync(join(tmpdir(), 'alacarga-queue-lab-'));
  let db;
  let now = Date.now();
  const close = () => {
    if (db?.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    // Never load process.env or wire the live HTTP app, catalog, push or charge workers.
    const config = loadConfig({ DATA_DIR: directory, STALE_SECONDS: '3600' });
    db = openDatabase(config.dataDir);
    const service = new Service(db, config, () => now);
    const insert = db.prepare("INSERT INTO users(username,password_hash,created_at) VALUES (?,'!queue-lab-disabled',?)");
    const people = Object.fromEntries(['first', 'you', 'follower']
      .map(name => [name, Number(insert.run(name, now).lastInsertRowid)]));
    const zoneId = service.createZone({ name: 'Estación de prueba' }).zone.id;
    const resources = ['TYPE2', 'CCS2'].map((connector, index) => {
      const id = service.createResource({ zoneId, connector, name: `Cargador ${index === 0 ? 'A' : 'B'}`, powerKw: index === 0 ? 22 : 50 }).resource.id;
      service.setStatus(id, { status: 'BUSY' });
      return id;
    });
    const joinQueue = user => service.join(user, { zoneId, connector: 'TYPE2' });
    joinQueue(people.first);
    service.subscribeZone(people.follower, { zoneId, enabled: true });

    function act(action) {
      if (action === 'join') { joinQueue(people.you); return; }
      if (action === 'free-a' || action === 'free-b') {
        const index = Number(action === 'free-b');
        const resource = service.zones().zones[0].resources[index];
        if (!['BUSY', 'UNKNOWN', 'STALE'].includes(resource.status)) {
          fail(409, 'NOT_OCCUPIED', 'La plaza ya tiene una observación vigente.');
        }
        service.setStatus(resources[index], { status: 'AVAILABLE' });
        return;
      }
      const [operation, person] = action.split('-');
      const user = people[person];
      const q = service.me(user).queue;
      if (!q) fail(409, 'NO_PARTICIPATION', 'Primero entra en la cola.');
      if (operation === 'accept') service.accept(user, q.id);
      if (operation === 'decline') service.leave(user, q.id);
      // Service.start/release here only record local occupancy of a synthetic resource.
      if (operation === 'occupy') service.start(user, q.id, {});
      if (operation === 'release') service.release(user, q.id);
      if (operation === 'expire') {
        const deadline = q.state === 'OFFERED' ? q.expiresAt : q.state === 'ACCEPTED' ? q.arrivalExpiresAt : null;
        if (deadline === null) fail(409, 'NO_DEADLINE', 'No hay un plazo activo.');
        now = deadline;
        service.tick();
      }
    }

    return {
      close, act,
      state: () => ({ now, zone: service.zones().zones[0],
        people: Object.fromEntries(Object.entries(people).map(([key, user]) => [key, service.me(user)])) }),
    };
  } catch (error) { close(); throw error; }
}

const actions = new Set(['join', 'free-a', 'free-b', 'reset',
  ...['first', 'you'].flatMap(person => ['accept', 'decline', 'expire', 'occupy', 'release'].map(action => `${action}-${person}`)),
]);

export async function startQueueLab({ port = DEFAULT_PORT } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Puerto no válido.');
  let lab = seed();
  let origin;
  const server = createServer((req, res) => {
    function send(status, data, type = 'application/json') {
      res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    }
    if (`http://${req.headers.host}` !== origin) return send(403, { message: 'Usa la dirección local indicada.' });
    if (req.method === 'GET' && req.url === '/') return send(200, HTML, 'text/html');
    if (req.method === 'GET' && req.url === '/lab.js') return send(200, UI, 'text/javascript');
    if (req.method === 'GET' && req.url === '/lab.css') return send(200, CSS, 'text/css');
    try {
      if (req.method === 'GET' && req.url === '/state') return send(200, lab.state());
      const action = /^\/action\/([a-z-]+)$/.exec(req.url)?.[1];
      if (req.method !== 'POST' || !actions.has(action)) return send(404, { message: 'Ruta no encontrada.' });
      if (req.headers.origin !== origin) return send(403, { message: 'Origen no permitido.' });
      if (action === 'reset') {
        const fresh = seed();
        lab.close();
        lab = fresh;
      } else lab.act(action);
      return send(200, lab.state());
    } catch (error) {
      if (error instanceof AppError) return send(error.status, { code: error.code, message: error.message });
      console.error('Error del laboratorio de cola.', error);
      return send(500, { message: 'Error del laboratorio de cola.' });
    }
  });
  server.once('close', () => lab.close());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        origin = `http://${HOST}:${server.address().port}`;
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) { lab.close(); throw error; }
  return { origin, close: () => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }) };
}

const HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Laboratorio de cola · A la caaarga!!</title><link rel="stylesheet" href="/lab.css"><script defer src="/lab.js"></script></head>
<body><main>
  <header><span class="tag">ALACARGA / DEMO LOCAL</span><h1>Laboratorio de cola</h1>
    <p>Dos cargadores ficticios, una cola real. Sin conexión al operador, recargas reales ni envío de notificaciones.</p></header>
  <noscript>Activa JavaScript para usar el laboratorio.</noscript>
  <p id="toast" role="status">Cargando escenario…</p>
  <section class="panel" aria-labelledby="chargers-title"><h2 id="chargers-title">Cargadores</h2>
    <p>Entra detrás de Alex. Libera A para ofrecerle el turno y B para generar un aviso de disponibilidad sin turno.</p>
    <div id="chargers" class="grid two"></div></section>
  <section class="panel" aria-labelledby="people-title"><h2 id="people-title">Participantes y actividad</h2>
    <p>Los mensajes se guardan en la base de datos temporal y se muestran solo aquí.</p><div id="people" class="grid three"></div></section>
  <footer><p>El reloj simulado solo avanza al vencer un plazo.</p><button type="button" id="reset" disabled>Reiniciar escenario</button></footer>
</main></body></html>`;

const CSS = `:root { color-scheme: light; font: 1rem/1.5 system-ui, sans-serif; color: #142a27; background: #edf4f0 }
* { box-sizing: border-box } body { margin: 0 } main { max-width: 71rem; margin: auto; padding: clamp(1rem, 4vw, 3rem) }
h1,h2,h3,p { margin: 0 } h1 { font-size: clamp(2rem, 5vw, 3.25rem); line-height: 1.15; margin: .5rem 0 } h2 { font-size: 1.35rem }
.tag { color: #1b5d4b; font-weight: 800; letter-spacing: .09em; font-size: .8rem }
.panel, #toast { margin-top: 1.1rem; padding: 1rem; background: #fff; border: 1px solid #bdcec5; border-radius: .75rem }
#toast { border-left: .4rem solid #157856; background: #e0f1e8; font-weight: 650 }
#toast.error { border-color: #a82e26; background: #fff0ee }
.grid { display: grid; gap: .75rem; margin-top: .75rem }
.two { grid-template-columns: repeat(2, minmax(0, 1fr)) } .three { grid-template-columns: repeat(3, minmax(0, 1fr)) }
.card { padding: .85rem; border-radius: .65rem; border: 1px solid #bdcec5; background: #f7faf8; min-width: 0 }
.state { font-weight: 700; margin: .35rem 0 } .buttons { display: flex; gap: .45rem; flex-wrap: wrap; margin-top: .65rem }
button { border: 1px solid #1d5748; border-radius: .45rem; background: white; color: #174639; min-height: 2.75rem; padding: .4rem .65rem; font: inherit; font-weight: 650; cursor: pointer }
button.primary { background: #145e49; color: white } button:disabled { opacity: .55; cursor: default }
button:hover:not(:disabled) { box-shadow: inset 0 0 0 1px currentColor } button:focus-visible { outline: 3px solid #145e49; outline-offset: 2px }
ul { list-style: none; margin: .7rem 0 0; padding: 0 } li { border-top: 1px solid #bdcec5; padding: .55rem 0 }
li p { font-size: .93rem } footer { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-top: 1rem; flex-wrap: wrap }
@media (max-width: 49rem) { .three { grid-template-columns: 1fr } } @media (max-width: 29rem) { .two { grid-template-columns: 1fr } }`;

const UI = `
const names = { first: 'Alex · primera persona', you: 'Tú · participante', follower: 'Sam · solo sigue la zona' };
const labels = { BUSY: 'Ocupado', AVAILABLE: 'Libre observado', UNKNOWN: 'Sin observación', STALE: 'Observación caducada',
  RECHARGING: 'Ocupación declarada', WAITING: 'En espera', OFFERED: 'Oferta de turno', ACCEPTED: 'Turno aceptado',
  CHARGING: 'Ocupación declarada', EXPIRED: 'Vencido', CANCELLED: 'Cancelado', COMPLETED: 'Liberado' };
const get = id => document.getElementById(id);
const toast = get('toast');
let seen = new Set();
let current;
let pending = false;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, action, primary = false) {
  const node = element('button', label, primary ? 'primary' : '');
  node.type = 'button';
  node.dataset.action = action;
  node.onclick = () => update(action, label);
  return node;
}
function show(data) {
  const chargers = data.zone.resources.map((resource, index) => {
    const card = element('article', '', 'card');
    const assigned = Object.values(data.people).some(({ queue: q }) => q?.resourceId === resource.id && ['OFFERED', 'ACCEPTED'].includes(q.state));
    card.append(element('h3', resource.name + ' · ' + (resource.connector === 'TYPE2' ? 'Tipo 2' : 'CCS2')),
      element('p', assigned ? 'Asignado a un turno' : labels[resource.status], 'state'));
    if (['BUSY', 'UNKNOWN', 'STALE'].includes(resource.status)) {
      card.append(button(resource.status === 'BUSY' ? 'Liberar ' + resource.name : 'Marcar libre · ' + resource.name, index === 0 ? 'free-a' : 'free-b'));
    }
    return card;
  });
  get('chargers').replaceChildren(...chargers);
  get('people').replaceChildren(...Object.entries(data.people).map(([person, { queue: q, notifications }]) => {
    const card = element('article', '', 'card');
    const state = labels[q?.state] || 'Sin turno';
    card.append(element('h3', names[person]), element('p', q?.position ? state + ' · posición ' + q.position : state, 'state'));
    if (q?.resourceName && ['OFFERED', 'ACCEPTED', 'CHARGING'].includes(q.state)) card.append(element('p', q.resourceName));
    const deadline = q?.state === 'OFFERED' ? q.expiresAt : q?.state === 'ACCEPTED' ? q.arrivalExpiresAt : null;
    if (deadline !== null) card.append(element('p', 'Restan ' + Math.ceil((deadline - data.now) / 1000) + ' s simulados.'));
    const controls = element('div', '', 'buttons');
    if (person === 'you' && !['WAITING', 'OFFERED', 'ACCEPTED', 'CHARGING'].includes(q?.state)) controls.append(button('Entrar en cola · Tipo 2', 'join', true));
    if (q?.state === 'OFFERED') controls.append(button('Aceptar oferta', 'accept-' + person, true), button('Rechazar oferta', 'decline-' + person), button('Vencer oferta', 'expire-' + person));
    if (q?.state === 'WAITING') controls.append(button('Salir de la cola', 'decline-' + person));
    if (q?.state === 'ACCEPTED') controls.append(button('Declarar ocupación simulada', 'occupy-' + person, true), button('Cancelar turno', 'decline-' + person), button('Vencer llegada', 'expire-' + person));
    if (q?.state === 'CHARGING') controls.append(button('Liberar plaza', 'release-' + person, true));
    if (controls.childElementCount) card.append(controls);
    const activity = element('ul');
    if (!notifications.length) activity.append(element('li', 'Sin mensajes todavía.'));
    for (const note of notifications) {
      const row = element('li');
      row.append(element('strong', note.title), element('p', note.body));
      activity.append(row);
    }
    card.append(activity);
    return card;
  }));
}
async function update(action, label) {
  if (pending) return;
  pending = true;
  const restoreFocus = action && document.activeElement?.tagName === 'BUTTON';
  toast.classList.remove('error');
  try {
    const url = action ? '/action/' + action : '/state';
    const response = await fetch(url, action ? { method: 'POST' } : {});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    current = data;
    if (action === 'reset') seen.clear();
    const titles = [];
    for (const [person, { notifications }] of Object.entries(data.people)) {
      for (const note of notifications) {
        if (!seen.has(note.id)) titles.push(names[person].split(' · ')[0] + ': ' + note.title);
        seen.add(note.id);
      }
    }
    show(data);
    toast.textContent = titles.join(' · ') || (action ? 'Acción aplicada: ' + label + '.' : 'Escenario listo.');
  } catch (error) {
    toast.classList.add('error');
    toast.textContent = error.message || 'No se pudo actualizar. Recarga la página.';
  } finally {
    pending = false;
    get('reset').disabled = !current;
    if (restoreFocus && document.activeElement === document.body) {
      const next = document.querySelector('button[data-action="' + action + '"]');
      (next || toast).focus();
    }
  }
}
toast.tabIndex = -1;
get('reset').onclick = () => update('reset', 'reiniciar escenario');
update();`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawPort = process.argv[2];
  const port = rawPort === undefined ? DEFAULT_PORT : /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
  startQueueLab({ port }).then(({ origin, close }) => {
    console.log(`Laboratorio de cola: ${origin} (Ctrl+C para cerrar)`);
    let closing = false;
    const stop = async () => {
      if (closing) return;
      closing = true;
      try { await close(); } catch (error) { console.error(error.message); process.exitCode = 1; }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => { console.error(`No se pudo iniciar el laboratorio: ${error.message}`); process.exitCode = 1; });
}
