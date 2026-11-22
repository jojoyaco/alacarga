import { randomBytes } from 'node:crypto';
import { Queries, transaction } from './db.mjs';
import { AppError, fail, id, object, text } from './errors.mjs';
import { digest } from './auth.mjs';
import { validateSubscription, validateEndpoint } from './push.mjs';
import { estimateTurn } from './wait-estimate.mjs';
import { evsareMapGroup } from './evsare-map-groups.mjs';
import { START_CHARGE_NOT_STARTED, validRechargeId } from './evsare.mjs';

export const CONNECTORS = ['TYPE2', 'CCS2', 'CHADEMO', 'SCHUKO'];
const STATUSES = ['AVAILABLE', 'BUSY', 'RESERVED', 'RECHARGING', 'MAINTENANCE', 'UNKNOWN'];
const ACTIVE = ['WAITING', 'OFFERED', 'ACCEPTED', 'CHARGING'];
const usableConnector = t => t.connectors.find(c => CONNECTORS.includes(c.kind) && Number.isFinite(c.power) && c.power > 0);
const providerConnectorId = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;
const providerTerminalId = value => typeof value === 'string' && /^t[1-9]\d{0,9}$/.test(value) && providerConnectorId(Number(value.slice(1)));
const CHARGE_MATCH_WINDOW = 120000;
const CHARGE_PROOF_MAX_AGE = 30000;
const ambiguousCharge = () => ({ state: 'AMBIGUOUS' });
const QUEUE_SELECT = `SELECT q.*,z.name AS zone_name,r.name AS resource_name FROM queue q
  JOIN zones z ON z.id=q.zone_id LEFT JOIN resources r ON r.id=q.resource_id`;

export class Service extends Queries {
  #chargeAccounts = new Set();
  #chargeTerminals = new Set();
  constructor(db, config, clock = Date.now) { super(db); this.config = config; this.clock = clock; }

  subject(userId) { return this.get("SELECT subject FROM external_identities WHERE user_id=? AND provider='evsare'", userId)?.subject; }
  providerZone(zoneId) { return this.get('SELECT zone_id FROM private_provider_zones WHERE zone_id=?', zoneId); }
  providerSite(zoneId) { return this.get('SELECT * FROM provider_sites WHERE zone_id=?', zoneId); }
  siteIndex() {
    const sites = this.catalog?.sites;
    if (!this.catalogIndex || this.indexedSites !== sites) {
      this.indexedSites = sites;
      this.catalogIndex = { byId: new Map(), byTerminal: new Map() };
      for (const site of sites ?? []) {
        this.catalogIndex.byId.set(site.id, site);
        for (const t of site.terminals) this.catalogIndex.byTerminal.set(t.id, site);
      }
    }
    return this.catalogIndex;
  }
  allowedZone(userId, zoneId, options) {
    if (!this.providerZone(zoneId)) return true;
    const subject = this.subject(userId);
    if (!subject) return false;
    const site = this.providerSite(zoneId);
    if (site) return Boolean(this.siteIndex().byId.get(site.site_key)?.terminals.some(t => this.catalog.allows(t.id, subject, options)));
    const binding = this.get('SELECT terminal_key FROM provider_zones WHERE zone_id=?', zoneId);
    const alias = this.get('SELECT terminal_key FROM provider_zone_aliases WHERE zone_id=?', zoneId);
    return Boolean((binding || alias) && this.catalog?.allows((binding ?? alias).terminal_key, subject, options));
  }
  allowedResource(userId, resource, options) {
    if (!resource.terminal_key) return !this.providerZone(resource.zone_id);
    const site = this.providerSite(resource.zone_id);
    if (site && this.siteIndex().byTerminal.get(resource.terminal_key)?.id !== site.site_key) return false;
    return Boolean(this.catalog?.allows(resource.terminal_key, this.subject(userId), options));
  }
  queuePermission(entry, options) {
    if (entry.resource_id === null) return this.allowedZone(entry.user_id, entry.zone_id, options);
    const resource = this.get('SELECT r.zone_id,p.terminal_key FROM resources r LEFT JOIN provider_zones p ON p.resource_id=r.id WHERE r.id=?', entry.resource_id);
    return Boolean(resource && this.allowedResource(entry.user_id, resource, options));
  }
  ensureSite(site) {
    let zoneId = this.get('SELECT zone_id FROM provider_sites WHERE site_key=?', site.id)?.zone_id;
    if (!zoneId) {
      zoneId = Number(this.run("INSERT INTO zones(name,description) VALUES ('Ubicación EVsare','')").lastInsertRowid);
      this.run('INSERT INTO provider_sites(zone_id,site_key) VALUES (?,?)', zoneId, site.id);
    }
    for (const t of site.terminals) {
      const binding = this.get('SELECT p.*,s.site_key FROM provider_zones p LEFT JOIN provider_sites s ON s.zone_id=p.zone_id WHERE p.terminal_key=?', t.id);
      if (binding && !binding.site_key) {
        // Mantener identidad, FIFO, estado, plazos y notificaciones de los turnos ya emitidos.
        const old = binding.zone_id;
        this.run('INSERT INTO provider_zone_aliases VALUES (?,?,?)', old, zoneId, t.id);
        for (const table of ['charger_favorites', 'subscriptions']) {
          this.run(`INSERT INTO ${table}(user_id,zone_id) SELECT user_id,? FROM ${table} WHERE zone_id=? ON CONFLICT DO NOTHING`, zoneId, old);
          this.run(`DELETE FROM ${table} WHERE zone_id=?`, old);
        }
        for (const table of ['resources', 'provider_zones', 'queue', 'notifications']) this.run(`UPDATE ${table} SET zone_id=? WHERE zone_id=?`, zoneId, old);
      } else if (!binding) {
        const connector = usableConnector(t);
        if (!connector) continue; // No inventar conector ni potencia para un terminal no reconocido.
        const resourceId = Number(this.run("INSERT INTO resources(zone_id,name,connector,power_kw) VALUES (?,'Cargador EVsare',?,?)", zoneId, connector.kind, connector.power).lastInsertRowid);
        this.run('INSERT INTO provider_zones(zone_id,terminal_key,resource_id) VALUES (?,?,?)', zoneId, t.id, resourceId);
      }
    }
    return zoneId;
  }
  privateChargers(userId) {
    const view = this.catalog.view(this.subject(userId));
    return transaction(this.db, () => ({ ...view, sites: view.sites.map(site => ({ ...site,
      mapGroup: evsareMapGroup(site.id),
      zoneId: this.ensureSite(this.siteIndex().byId.get(site.id) ?? site),
      terminals: site.terminals.map(t => ({ id: t.id, name: t.name, state: t.state, comingSoon: t.comingSoon === true,
        connectors: t.connectors.map(c => {
          const remoteEnabled = this.chargeTargetVerified(site.id, t, c);
          return { name: c.name, state: c.state, label: c.label ?? null, remoteEnabled,
            ...(view.status === 'fresh' && c.state === 'AVAILABLE' && c.chargeAvailable === true && remoteEnabled ? { id: c.id } : {}),
            powerKw: Number.isFinite(c.power) && c.power > 0 ? Number(c.power.toFixed(2)) : null };
        }),
        tariffSegments: t.tariffSegments, ...(t.parcels === undefined ? {} : { parcels: t.parcels }) })),
    })) }));
  }
  remoteChargeEnabled() { return this.config.remoteCharge === true && Boolean(this.config.remoteChargeTargets?.size && this.catalog); }
  chargeTargetVerified(siteKey, terminal, connector) {
    // El conductor debe poder distinguir el conector en el cargador. Ni el tipo de toma ni el orden relacionan plaza y conector.
    return this.remoteChargeEnabled() && terminal.remoteCompatible === true && providerTerminalId(terminal.id) &&
      providerConnectorId(connector.id) && this.config.remoteChargeTargets.has(`${siteKey}:${terminal.id}:${connector.id}`) &&
      typeof connector.label === 'string' && /^[A-Z]$/.test(connector.label) &&
      terminal.connectors.filter(c => c.id === connector.id).length === 1 &&
      terminal.connectors.filter(c => c.label === connector.label).length === 1;
  }
  remoteChargeTarget(userId, zoneId, terminalId, connectorId) {
    const unavailable = () => fail(404, 'REMOTE_CHARGE_TARGET_NOT_FOUND', 'No hay un conector físico de carga remota verificado para este terminal.');
    const site = this.providerSite(zoneId);
    const subject = this.subject(userId);
    if (!site || !subject || !this.catalog.allows(terminalId, subject, { requireFresh: false }) ||
        this.siteIndex().byTerminal.get(terminalId)?.id !== site.site_key) unavailable();
    // El feed no provee timestamp por conector: solo conocemos la hora de nuestra lectura.
    if (!Number.isSafeInteger(this.catalog.observedAt) || this.catalog.observedAt > this.clock() ||
        !this.catalog.fresh() || !this.catalog.allows(terminalId, subject)) {
      fail(409, 'REMOTE_CHARGE_STALE', 'No hay disponibilidad reciente de EVsare. Actualiza los cargadores antes de volver a solicitar la carga.');
    }
    const terminal = this.catalog.terminals.get(terminalId);
    const connector = terminal?.connectors.find(c => c.id === connectorId);
    if (!connector || !this.chargeTargetVerified(site.site_key, terminal, connector)) unavailable();
    if (connector.state !== 'AVAILABLE' || connector.chargeAvailable !== true || terminal.blocked) {
      fail(409, 'REMOTE_CHARGE_NOT_AVAILABLE', 'EVsare no muestra este conector como libre. No se ha enviado la orden.');
    }
    return connector.label;
  }
  async withRemoteChargeRequest(userId, terminalId, action) {
    if (this.#chargeAccounts.has(userId) || this.#chargeTerminals.has(terminalId)) {
      fail(409, 'REMOTE_CHARGE_IN_PROGRESS', 'Se está enviando o comprobando otra orden para esta cuenta o terminal. Comprueba el resultado antes de volver a solicitarla.');
    }
    this.#chargeAccounts.add(userId);
    this.#chargeTerminals.add(terminalId);
    try { return await action(); }
    finally {
      this.#chargeAccounts.delete(userId);
      this.#chargeTerminals.delete(terminalId);
    }
  }
  latestChargeOrder(session) {
    if (session.user.provider !== 'evsare') fail(403, 'REMOTE_CHARGE_ACCOUNT_REQUIRED', 'Entra con tu cuenta EVsare para gestionar tu solicitud.');
    // Attempt IDs may exceed JS's safe integer range. Keep exact identity as text.
    return this.get(`SELECT CAST(attempt_id AS TEXT) AS attempt_id, terminal_key, user_id, started_at, status
      FROM remote_charge_attempts WHERE user_id=? ORDER BY sequence DESC LIMIT 1`, session.user.id);
  }
  remoteChargeStatus(session) {
    // The account's latest dispatch record, not live charger availability or a start prerequisite.
    return { status: this.latestChargeOrder(session)?.status ?? null };
  }
  chargeLifecycle(order) {
    return this.get('SELECT recharge_id, finished_seen, finish_requested_at FROM remote_charge_lifecycle WHERE attempt_id=?', order.attempt_id);
  }
  recordChargeEvidence(session, order, rechargeId) {
    if (rechargeId === null) return false;
    return transaction(this.db, () => {
      const current = this.latestChargeOrder(session);
      if (current?.attempt_id !== order.attempt_id || current.status === 'REJECTED') return false;
      this.run(`INSERT INTO remote_charge_lifecycle(attempt_id,user_id,terminal_key,started_at) VALUES (?,?,?,?)
        ON CONFLICT(attempt_id) DO NOTHING`, order.attempt_id, order.user_id, order.terminal_key, order.started_at);
      // Bind once. A different ID (or an ID already bound to another order) is not a safe finish target.
      this.run(`UPDATE OR IGNORE remote_charge_lifecycle SET recharge_id=?
        WHERE attempt_id=? AND recharge_id IS NULL`, rechargeId, order.attempt_id);
      return this.chargeLifecycle(order).recharge_id === rechargeId;
    });
  }
  async inspectChargeOrder(session, order, evsare) {
    if (order.status === 'REJECTED') return { state: 'NOT_FOUND' };
    const now = this.clock();
    if (!providerTerminalId(order.terminal_key) || !Number.isSafeInteger(order.started_at) || order.started_at > now) return ambiguousCharge();
    let evidence;
    try {
      evidence = await evsare.terminalChargeEvidence(session, { terminal: Number(order.terminal_key.slice(1)),
        earliest: Math.floor(order.started_at / 1000) * 1000, latest: order.started_at + CHARGE_MATCH_WINDOW, now },
      rechargeId => this.recordChargeEvidence(session, order, rechargeId));
    } catch (error) {
      if (!(error instanceof AppError) || error.code === 'EVSARE_REAUTH_REQUIRED') throw error;
      // Provider failure is inconclusive, not an empty history.
      return ambiguousCharge();
    }
    return transaction(this.db, () => {
      const current = this.latestChargeOrder(session);
      if (current?.attempt_id !== order.attempt_id || current.status === 'REJECTED') return ambiguousCharge();
      const lifecycle = this.chargeLifecycle(order);
      const fresh = this.clock() >= now && this.clock() - now <= CHARGE_PROOF_MAX_AGE;
      if (!fresh) return ambiguousCharge();
      if (evidence.state === 'NOT_FOUND') {
        // A previously observed possible match disappearing does not prove absence.
        return lifecycle?.recharge_id != null ? ambiguousCharge() : { state: 'NOT_FOUND' };
      }
      if (evidence.state === 'FINISHED' && lifecycle?.recharge_id === evidence.rechargeId) {
        this.run('UPDATE remote_charge_lifecycle SET finished_seen=1 WHERE attempt_id=?', order.attempt_id);
        return { state: 'FINISHED', rechargeId: evidence.rechargeId };
      }
      if (evidence.state === 'ACTIVE' && lifecycle?.recharge_id === evidence.rechargeId && !lifecycle.finished_seen) {
        return { state: 'ACTIVE',
          ...(this.config.remoteCharge === true && lifecycle.finish_requested_at === null ? { rechargeId: evidence.rechargeId } : {}) };
      }
      return ambiguousCharge();
    });
  }
  async remoteChargeCheck(session, evsare) {
    const order = this.latestChargeOrder(session);
    return order ? this.inspectChargeOrder(session, order, evsare) : { state: 'NONE' };
  }
  async remoteChargeFinish(session, body, evsare) {
    const order = this.latestChargeOrder(session);
    if (this.config.remoteCharge !== true) fail(404, 'REMOTE_CHARGE_DISABLED', 'El control remoto de carga no está habilitado.');
    object(body);
    const { rechargeId } = body;
    if (Object.keys(body).length !== 1 || !validRechargeId(rechargeId)) fail(400, 'REMOTE_CHARGE_INVALID_RECHARGE', 'Selecciona una recarga válida.');
    const blocked = () => fail(409, 'REMOTE_CHARGE_FINISH_BLOCKED', 'No se ha podido verificar una recarga activa que pueda finalizarse. Comprueba la app oficial de EVsare.');
    if (!order || order.status === 'REJECTED') blocked();
    return this.withRemoteChargeRequest(order.user_id, order.terminal_key, async () => {
      if (this.chargeLifecycle(order)?.finish_requested_at != null) blocked();
      const evidence = await this.inspectChargeOrder(session, order, evsare);
      if (evidence.state !== 'ACTIVE' || evidence.rechargeId !== rechargeId) blocked();
      let committed = false;
      try {
        await evsare.finishCharge(session, rechargeId, () => {
          transaction(this.db, () => {
            const current = this.latestChargeOrder(session);
            // This marker deduplicates only this exact finish; it never inhibits a start.
            if (current?.attempt_id !== order.attempt_id || current.status === 'REJECTED' ||
                this.run(`UPDATE remote_charge_lifecycle SET finish_requested_at=?
                  WHERE attempt_id=? AND recharge_id=? AND finish_requested_at IS NULL AND finished_seen=0`,
                this.clock(), order.attempt_id, rechargeId).changes !== 1) blocked();
          });
          committed = true;
        });
        if (!committed) blocked();
        return { submitted: true };
      } catch (error) {
        if (!committed) throw error;
        fail(409, 'REMOTE_CHARGE_FINISH_UNCONFIRMED', 'No se pudo confirmar la solicitud de fin. No la repitas: comprueba el vehículo y la app oficial de EVsare.');
      }
    });
  }
  async remoteCharge(session, body, evsare) {
    if (!this.remoteChargeEnabled()) fail(404, 'REMOTE_CHARGE_DISABLED', 'El inicio de carga desde la web no está habilitado.');
    const userId = session.user.id;
    if (session.user.provider !== 'evsare') fail(403, 'REMOTE_CHARGE_ACCOUNT_REQUIRED', 'Entra con tu cuenta EVsare para iniciar la carga.');
    object(body);
    const { zoneId, terminalId, connectorId } = body;
    if (Object.keys(body).length !== 3 || !Number.isSafeInteger(zoneId) || zoneId < 1 ||
        !providerTerminalId(terminalId) || !providerConnectorId(connectorId)) {
      fail(400, 'REMOTE_CHARGE_INVALID_TARGET', 'Selecciona una ubicación, un terminal y un conector válidos.');
    }
    const verify = () => this.remoteChargeTarget(userId, zoneId, terminalId, connectorId);
    const physicalLabel = verify();
    return this.withRemoteChargeRequest(userId, terminalId, async () => {
      const card = await evsare.chargeCard(session);
      const attemptId = randomBytes(8).readBigUInt64BE() & 0x7fffffffffffffffn;
      let committed = false;
      let started;
      try {
        const target = { terminal: Number(terminalId.slice(1)), connector: connectorId };
        started = await evsare.startCharge(session, { ...target, card }, () => {
          if (verify() !== physicalLabel) fail(409, 'REMOTE_CHARGE_TARGET_CHANGED', 'Ha cambiado el identificador físico del conector. No se ha enviado la orden.');
          this.run("INSERT INTO remote_charge_attempts (attempt_id,terminal_key,user_id,connector_id,started_at,status) VALUES (?,?,?,?,?,'UNCONFIRMED')",
            attemptId, terminalId, userId, connectorId, this.clock());
          committed = true;
        });
        if (!committed) throw new Error('Missing charge order');
        const status = started === true ? 'ACCEPTED' : started === START_CHARGE_NOT_STARTED ? 'REJECTED' : null;
        if (!status || this.run('UPDATE remote_charge_attempts SET status=? WHERE attempt_id=?', status, attemptId).changes !== 1) {
          throw new Error('Unconfirmed charge');
        }
      } catch (error) {
        if (!committed) throw error;
        // Uncertainty is recorded but does not hold a lock or automatically retry an order.
        fail(409, 'REMOTE_CHARGE_UNCONFIRMED', 'No se pudo confirmar el inicio. No repitas la orden: comprueba el vehículo y la app oficial de EVsare.');
      }
      if (started === true) return { started: true };
      fail(409, 'REMOTE_CHARGE_REJECTED', 'EVsare rechazó la solicitud e indicó que no se inició la carga. Consulta la app oficial antes de volver a solicitarla.');
    });
  }
  syncProvider(now) {
    const fresh = this.catalog?.fresh();
    if (fresh) {
      const { byId, byTerminal } = this.siteIndex();
      const bindings = new Map(this.all(`SELECT p.terminal_key,s.site_key FROM provider_zones p LEFT JOIN provider_sites s ON s.zone_id=p.zone_id`)
        .map(row => [row.terminal_key, row.site_key]));
      const sites = new Set();
      for (const row of this.all('SELECT site_key FROM provider_sites')) {
        const site = byId.get(row.site_key);
        if (site?.terminals.some(t => !bindings.has(t.id) && usableConnector(t))) sites.add(site);
      }
      for (const [key, siteKey] of bindings) if (siteKey === null) sites.add(byTerminal.get(key));
      for (const site of sites) if (site) this.ensureSite(site);
    }
    for (const row of this.all(`SELECT p.*,r.status,r.observed_at,s.site_key FROM provider_zones p JOIN resources r ON r.id=p.resource_id
      LEFT JOIN provider_sites s ON s.zone_id=p.zone_id`)) {
      const site = this.siteIndex().byTerminal.get(row.terminal_key);
      const terminal = fresh && (!row.site_key || site?.id === row.site_key) ? this.catalog.terminals.get(row.terminal_key) : null;
      const status = terminal && usableConnector(terminal) && this.catalog.observedAt > row.free_after ? terminal.state : 'UNKNOWN';
      const at = terminal ? this.catalog.observedAt : null;
      if (row.status !== status || row.observed_at !== at) {
        this.run('UPDATE resources SET status=?,observed_at=?,revision=revision+? WHERE id=?', status, at, Number(row.status !== status), row.resource_id);
      }
    }
    if (fresh) for (const q of this.all(`SELECT q.* FROM queue q JOIN private_provider_zones p ON p.zone_id=q.zone_id
      WHERE q.state IN ('WAITING','OFFERED','ACCEPTED','CHARGING')`)) {
      if (this.queuePermission(q)) continue;
      if (['ACCEPTED', 'CHARGING'].includes(q.state)) this.consume(q.resource_id, now);
      this.run("UPDATE queue SET state='CANCELLED',reason='ACCESS_REVOKED',updated_at=? WHERE id=?", now, q.id);
    }
  }

  mutate(action) {
    let failure;
    const value = transaction(this.db, () => {
      const now = this.clock();
      this.reconcile(now);
      this.db.exec('SAVEPOINT user_action');
      try {
        const result = action(now);
        this.reconcile(now);
        const value = typeof result === 'function' ? result() : result;
        this.db.exec('RELEASE user_action');
        return value;
      } catch (error) {
        // Una aceptación tardía rechazada NO revierte vencimientos ni el paso al siguiente.
        if (!(error instanceof AppError)) throw error;
        this.db.exec('ROLLBACK TO user_action; RELEASE user_action');
        failure = error;
      }
    });
    if (failure) throw failure;
    return value;
  }

  tick() {
    return transaction(this.db, () => {
      const now = this.clock();
      this.reconcile(now);
      const last = Number(this.get("SELECT value FROM settings WHERE key='last_cleanup'")?.value ?? 0);
      if (now - last >= 3600000) {
        this.run('DELETE FROM sessions WHERE expires_at<=?', now);
        this.run('DELETE FROM rate_limits WHERE reset_at<=?', now);
        this.run('DELETE FROM push_subscriptions WHERE expiration_time IS NOT NULL AND expiration_time<=?', now);
        this.run(`DELETE FROM notifications WHERE expires_at<? AND (queue_id IS NULL OR NOT EXISTS
          (SELECT 1 FROM queue q WHERE q.id=notifications.queue_id AND q.state IN ('WAITING','OFFERED','ACCEPTED','CHARGING')))`, now - 7 * 86400000);
        this.run("INSERT INTO settings(key,value) VALUES ('last_cleanup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(now));
      }
    });
  }

  consume(resourceId, now = this.clock()) {
    this.run('UPDATE provider_zones SET free_after=? WHERE resource_id=?', now, resourceId);
    // Un turno anterior nunca elimina una exclusión administrativa, incluso tras restaurar un snapshot antiguo.
    this.run("UPDATE resources SET status='UNKNOWN',observed_at=NULL,revision=revision+1 WHERE id=? AND status NOT IN ('MAINTENANCE','RESERVED')", resourceId);
  }

  notify({ userId, kind, title, body, now, expiresAt = now + 300000, queueId = null, zoneId = null, resourceId = null, revision = null, expectedReleaseAt = null, dedupeKey = null }) {
    const queueState = queueId === null ? null : this.get('SELECT state FROM queue WHERE id=?', queueId)?.state ?? null;
    const inserted = this.run(`INSERT INTO notifications
      (user_id,kind,title,body,queue_id,queue_state,zone_id,resource_id,resource_revision,created_at,expires_at,expected_release_at,dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`,
    userId, kind, title, body, queueId, queueState, zoneId, resourceId, revision, now, expiresAt, expectedReleaseAt, dedupeKey);
    if (inserted.changes === 0) return null;
    const notificationId = Number(inserted.lastInsertRowid);
    this.run(`INSERT INTO outbox(notification_id,subscription_id,next_attempt_at,expires_at)
      SELECT ?,id,?,? FROM push_subscriptions WHERE user_id=? AND (expiration_time IS NULL OR expiration_time>?)`,
    notificationId, now, expiresAt, userId, now);
    return notificationId;
  }

  reconcile(now) {
    this.syncProvider(now);
    const catalogFresh = Boolean(this.catalog?.fresh());
    // No descartar una oferta persistida mientras el proceso nuevo carga su primer snapshot.
    const providerSnapshotSeen = catalogFresh || Boolean(this.catalog?.sites);
    for (const entry of this.all("SELECT * FROM queue WHERE state='ACCEPTED' AND arrival_expires_at<=?", now)) {
      this.consume(entry.resource_id);
      this.run("UPDATE queue SET state='EXPIRED',reason='ARRIVAL_EXPIRED',updated_at=? WHERE id=?", now, entry.id);
      this.notify({ userId: entry.user_id, kind: 'QUEUE', title: 'Turno vencido', body: 'Venció el plazo de llegada. No se te ha vuelto a poner en cola.', now, queueId: entry.id, zoneId: entry.zone_id });
    }
    for (const entry of this.all(`SELECT q.*,r.status,r.observed_at FROM queue q JOIN resources r ON r.id=q.resource_id
      WHERE q.state='OFFERED' AND (q.expires_at<=? OR ((? OR NOT EXISTS (SELECT 1 FROM private_provider_zones p WHERE p.zone_id=q.zone_id))
        AND (r.status!='AVAILABLE' OR r.observed_at IS NULL OR r.observed_at<=?)))`, now, Number(providerSnapshotSeen), now - this.config.staleSeconds * 1000)) {
      const reason = entry.expires_at <= now ? 'OFFER_EXPIRED' : entry.status !== 'AVAILABLE' || entry.observed_at === null ? 'RESOURCE_UNAVAILABLE' : 'DATA_STALE';
      this.run("UPDATE queue SET state='EXPIRED',reason=?,updated_at=? WHERE id=?", reason, now, entry.id);
      this.notify({ userId: entry.user_id, kind: 'QUEUE', title: 'Oferta no disponible', body: reason === 'OFFER_EXPIRED' ? 'Venció tu oferta. Puedes volver a entrar en cola cuando estés disponible.' : 'La disponibilidad cambió o quedó obsoleta. La oferta ya no es válida.', now, queueId: entry.id, zoneId: entry.zone_id });
    }

    // La secuencia persistida manda para cada plaza compatible y autorizada.
    for (const entry of this.all("SELECT * FROM queue WHERE state='WAITING' ORDER BY id")) {
      const resource = this.all(`SELECT r.*,p.terminal_key FROM resources r LEFT JOIN provider_zones p ON p.resource_id=r.id
        WHERE r.zone_id=? AND r.status='AVAILABLE' AND r.observed_at>?
        AND (?='ANY' OR r.connector=?) AND NOT EXISTS
        (SELECT 1 FROM queue q WHERE q.resource_id=r.id AND q.state IN ('OFFERED','ACCEPTED','CHARGING')) ORDER BY r.id`,
      entry.zone_id, now - this.config.staleSeconds * 1000, entry.connector, entry.connector)
        .find(r => this.allowedResource(entry.user_id, r));
      if (!resource) continue;
      const expiresAt = now + this.config.offerSeconds * 1000;
      this.run("UPDATE queue SET state='OFFERED',resource_id=?,expires_at=?,reason=NULL,updated_at=? WHERE id=?", resource.id, expiresAt, now, entry.id);
      this.notify({ userId: entry.user_id, kind: 'OFFER', title: 'Tu turno está disponible', body: `Tienes una oferta para ${resource.name}. Abre A la caaarga!! y acepta antes de que venza. No es una reserva del operador.`, now,
        expiresAt: Math.min(expiresAt, resource.observed_at + this.config.staleSeconds * 1000), queueId: entry.id, zoneId: entry.zone_id, resourceId: resource.id, revision: resource.revision });
    }

    // Avisos de seguimiento independientes de la cola, solo después de atender a quienes esperan.
    const alertedSites = new Set();
    for (const resource of this.all(`SELECT r.*,z.name AS zone_name,p.terminal_key FROM resources r JOIN zones z ON z.id=r.zone_id
      LEFT JOIN provider_zones p ON p.resource_id=r.id
      WHERE r.status='AVAILABLE' AND r.observed_at>? AND r.notified_revision!=r.revision AND NOT EXISTS
      (SELECT 1 FROM queue q WHERE q.resource_id=r.id AND q.state IN ('OFFERED','ACCEPTED','CHARGING')) ORDER BY r.id`, now - this.config.staleSeconds * 1000)) {
      for (const subscriber of this.all('SELECT user_id FROM subscriptions WHERE zone_id=?', resource.zone_id)) {
        if (!this.allowedResource(subscriber.user_id, resource)) continue;
        const key = `${resource.zone_id}:${subscriber.user_id}`;
        if (resource.terminal_key && alertedSites.has(key)) continue;
        if (resource.terminal_key) alertedSites.add(key);
        const description = resource.terminal_key ? 'indicada por EVsare en una ubicación que sigues' : `${resource.source === 'community' ? 'declarada por la comunidad' : 'manual'} en ${resource.zone_name}`;
        this.notify({ userId: subscriber.user_id, kind: 'AVAILABILITY', title: 'Disponibilidad observada', body: `Hay disponibilidad ${description}. Este aviso no te otorga un turno ni te pone en cola.`,
          now, expiresAt: resource.observed_at + this.config.staleSeconds * 1000, zoneId: resource.zone_id, resourceId: resource.id, revision: resource.revision });
      }
      this.run('UPDATE resources SET notified_revision=revision WHERE id=?', resource.id);
    }

    for (const entry of this.all("SELECT * FROM queue WHERE state='CHARGING' AND expected_release_at<=? AND charge_finished_at IS NULL", now)) {
      this.notify({ userId: entry.user_id, kind: 'REMINDER', title: 'Hora prevista alcanzada', body: '¿Has terminado? Si ya has retirado el coche, confirma la liberación. Es una previsión, no una señal del cargador.',
        now, expiresAt: now + 86400000, queueId: entry.id, zoneId: entry.zone_id, resourceId: entry.resource_id, expectedReleaseAt: entry.expected_release_at, dedupeKey: `eta:${entry.id}:${entry.expected_release_at}` });
    }

    this.run(`UPDATE outbox SET state='expired',lease_token=NULL,lease_until=NULL WHERE state IN ('pending','sending') AND
      (expires_at<=? OR notification_id IN (SELECT n.id FROM notifications n WHERE
        (n.kind='OFFER' AND NOT EXISTS (SELECT 1 FROM queue q WHERE q.id=n.queue_id AND q.state='OFFERED')) OR
        (n.kind='QUEUE' AND NOT EXISTS (SELECT 1 FROM queue q WHERE q.id=n.queue_id AND q.state=n.queue_state)) OR
        (n.kind='AVAILABILITY' AND (NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id=n.user_id AND s.zone_id=n.zone_id)
          OR NOT EXISTS (SELECT 1 FROM resources r WHERE r.id=n.resource_id AND r.status='AVAILABLE' AND r.revision=n.resource_revision AND r.observed_at>?)
          OR EXISTS (SELECT 1 FROM queue q WHERE q.resource_id=n.resource_id AND q.state IN ('OFFERED','ACCEPTED','CHARGING')))) OR
        (n.kind='REMINDER' AND NOT EXISTS (SELECT 1 FROM queue q WHERE q.id=n.queue_id AND q.state='CHARGING' AND q.expected_release_at=n.expected_release_at AND q.charge_finished_at IS NULL)) OR
        (n.kind='FINISHED' AND NOT EXISTS (SELECT 1 FROM queue q WHERE q.id=n.queue_id AND q.state='CHARGING' AND q.charge_finished_at IS NOT NULL))
      ))`, now, now - this.config.staleSeconds * 1000);
    if (catalogFresh) for (const n of this.all(`SELECT DISTINCT n.id,n.zone_id,n.user_id,COALESCE(n.resource_id,q.resource_id) AS resource_id
      FROM outbox o JOIN notifications n ON n.id=o.notification_id LEFT JOIN queue q ON q.id=n.queue_id
      JOIN private_provider_zones p ON p.zone_id=n.zone_id WHERE o.state IN ('pending','sending')`)) {
      if (!this.queuePermission(n)) this.run("UPDATE outbox SET state='expired',lease_token=NULL,lease_until=NULL WHERE notification_id=? AND state IN ('pending','sending')", n.id);
    }
  }

  zoneExists(zoneId, userId) {
    id(zoneId);
    if (!this.get('SELECT id FROM zones WHERE id=?', zoneId) || !this.allowedZone(userId ?? 0, zoneId)) fail(404, 'ZONE_NOT_FOUND', 'Zona no encontrada.');
  }
  siteZoneId(zoneId) {
    return this.get('SELECT site_zone_id FROM provider_zone_aliases WHERE zone_id=?', zoneId)?.site_zone_id ?? zoneId;
  }
  resourceView(resource, now = this.clock()) {
    const charging = this.get("SELECT expected_release_at,charge_finished_at FROM queue WHERE resource_id=? AND state='CHARGING'", resource.id);
    const stale = !charging && resource.status !== 'UNKNOWN' && (resource.observed_at === null || resource.observed_at <= now - this.config.staleSeconds * 1000);
    return { id: resource.id, name: resource.name, connector: resource.connector, powerKw: resource.power_kw,
      // Mientras existe ocupante, la declaración comunitaria sigue vigente aunque un admin refresque RECHARGING.
      status: stale ? 'STALE' : resource.status, observedAt: resource.observed_at, source: charging ? 'community' : resource.source,
      expectedReleaseAt: charging?.expected_release_at ?? null, chargeFinishedAt: charging?.charge_finished_at ?? null };
  }
  zoneView(zone, now) {
    const rows = this.all('SELECT * FROM resources WHERE zone_id=? ORDER BY id', zone.id);
    const resources = rows.map(row => this.resourceView(row, now));
    const allocated = new Set(this.all("SELECT resource_id FROM queue WHERE zone_id=? AND state IN ('OFFERED','ACCEPTED','CHARGING')", zone.id).map(row => row.resource_id));
    return { id: zone.id, name: zone.name, description: zone.description, latitude: zone.latitude, longitude: zone.longitude, radiusMeters: zone.radius_meters,
      waitingCount: this.get("SELECT count(*) AS count FROM queue WHERE zone_id=? AND state='WAITING'", zone.id).count,
      availableCount: resources.filter(resource => resource.status === 'AVAILABLE' && !allocated.has(resource.id)).length, resources };
  }
  zones() {
    return this.mutate(now => () => ({ zones: this.all('SELECT z.* FROM zones z WHERE NOT EXISTS (SELECT 1 FROM private_provider_zones p WHERE p.zone_id=z.id) ORDER BY z.id').map(zone => this.zoneView(zone, now)) }));
  }
  queueView(queueId, now = this.clock()) {
    const entry = this.get(`${QUEUE_SELECT} WHERE q.id=?`, queueId);
    if (!entry) return null;
    const privateZone = this.providerZone(entry.zone_id);
    let estimate = { peopleAhead: 0, estimatedTurnAt: null, estimateReason: 'not_waiting', estimateBasis: 'insufficient' };
    if (entry.state === 'WAITING') {
      let mixed = false;
      const visible = this.all(`SELECT r.id,r.zone_id,p.terminal_key,r.connector,r.status,r.observed_at,q.state AS active_state,
        q.expires_at,q.arrival_expires_at,q.expected_release_at,q.planned_minutes FROM resources r
        LEFT JOIN queue q ON q.resource_id=r.id AND q.state IN ('OFFERED','ACCEPTED','CHARGING')
        LEFT JOIN provider_zones p ON p.resource_id=r.id WHERE r.zone_id=? ORDER BY r.id`, entry.zone_id)
        .filter(r => !privateZone || this.allowedResource(entry.user_id, r));
      const entries = this.all("SELECT id,user_id,connector,planned_minutes FROM queue WHERE zone_id=? AND state='WAITING' AND id<=? ORDER BY id", entry.zone_id, entry.id)
        .filter(row => {
          if (!privateZone || row.id === entry.id) return true;
          const shared = visible.filter(r => (row.connector === 'ANY' || row.connector === r.connector) && this.allowedResource(row.user_id, r));
          if (shared.length && shared.length !== visible.length) mixed = true;
          return shared.length > 0;
        }).map(row => ({ id: row.id, connector: row.connector, plannedMinutes: row.planned_minutes }));
      const resources = visible.map(row => ({
        id: row.id, connector: row.connector, status: row.status, observedAt: row.observed_at,
        ...(row.active_state ? { active: { state: row.active_state, expiresAt: row.expires_at, arrivalExpiresAt: row.arrival_expires_at,
          expectedReleaseAt: row.expected_release_at, plannedMinutes: row.planned_minutes } } : {}),
      }));
      estimate = estimateTurn({ now, targetId: entry.id, entries, resources,
        offerSeconds: this.config.offerSeconds, arrivalSeconds: this.config.arrivalSeconds, staleSeconds: this.config.staleSeconds });
      // El estimador de conectores no puede simular la asignación por permisos parciales.
      if (mixed) estimate = { ...estimate, estimatedTurnAt: null, estimateReason: 'missing_release_estimate', estimateBasis: 'insufficient' };
    }
    const position = entry.state === 'WAITING' ? estimate.peopleAhead + 1 : null;
    const readable = { requireFresh: false };
    const site = privateZone && this.providerSite(entry.zone_id);
    const zoneName = site && this.allowedZone(entry.user_id, entry.zone_id, readable) ? this.siteIndex().byId.get(site.site_key)?.name : entry.zone_name;
    const showResource = !privateZone || this.queuePermission(entry, readable);
    const binding = privateZone && showResource && entry.resource_id !== null && this.get('SELECT terminal_key FROM provider_zones WHERE resource_id=?', entry.resource_id);
    const resourceName = binding ? this.catalog.terminals.get(binding.terminal_key)?.name ?? entry.resource_name : entry.resource_name;
    return { id: entry.id, zoneId: entry.zone_id, zoneName, state: entry.state, position, connector: entry.connector,
      resourceId: showResource ? entry.resource_id : null, resourceName: showResource ? resourceName : null,
      expiresAt: showResource ? entry.expires_at : null, arrivalExpiresAt: showResource ? entry.arrival_expires_at : null,
      expectedReleaseAt: showResource ? entry.expected_release_at : null, chargeFinishedAt: showResource ? entry.charge_finished_at : null, reason: entry.reason,
      plannedMinutes: entry.planned_minutes, ...estimate };
  }
  me(userId) {
    return this.mutate(now => () => {
      const row = this.get("SELECT id FROM queue WHERE user_id=? ORDER BY CASE WHEN state IN ('WAITING','OFFERED','ACCEPTED','CHARGING') THEN 0 ELSE 1 END,id DESC LIMIT 1", userId);
      return { queue: row ? this.queueView(row.id, now) : null,
        subscriptions: this.all('SELECT zone_id FROM subscriptions WHERE user_id=? ORDER BY zone_id', userId).map(row => row.zone_id),
        favorites: this.all('SELECT zone_id FROM charger_favorites WHERE user_id=? ORDER BY zone_id', userId).map(row => row.zone_id),
        pushEnabled: Boolean(this.get('SELECT id FROM push_subscriptions WHERE user_id=? AND (expiration_time IS NULL OR expiration_time>?) LIMIT 1', userId, now)),
        notifications: this.all(`SELECT n.id,n.title,n.body,n.created_at AS createdAt,n.zone_id,n.user_id,COALESCE(n.resource_id,q.resource_id) AS resource_id
          FROM notifications n LEFT JOIN queue q ON q.id=n.queue_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 30`, userId)
          .filter(n => n.zone_id === null || this.queuePermission(n, { requireFresh: false }))
          .map(({ id, title, body, createdAt }) => ({ id, title, body, createdAt })) };
    });
  }
  join(userId, body) {
    object(body); id(body.zoneId);
    if (!['ANY', ...CONNECTORS].includes(body.connector)) fail(400, 'INVALID_CONNECTOR', 'Conector no válido.');
    const plannedMinutes = body.plannedMinutes ?? null;
    if (plannedMinutes !== null && (!Number.isSafeInteger(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 720)) {
      fail(400, 'INVALID_PLANNED_MINUTES', 'La duración declarada debe ser de 1 a 720 minutos enteros, o null.');
    }
    return this.mutate(now => {
      this.zoneExists(body.zoneId, userId);
      const zoneId = this.siteZoneId(body.zoneId);
      this.zoneExists(zoneId, userId);
      if (this.providerZone(zoneId) && body.connector !== 'ANY') fail(400, 'INVALID_CONNECTOR', 'El turno se asigna al cargador completo.');
      const existing = this.get("SELECT * FROM queue WHERE user_id=? AND state IN ('WAITING','OFFERED','ACCEPTED','CHARGING')", userId);
      if (existing) {
        if (existing.zone_id !== zoneId || existing.connector !== body.connector) fail(409, 'ACTIVE_QUEUE', 'Ya tienes una participación activa. Sal de ella antes de entrar en otra.');
        return () => ({ queue: this.queueView(existing.id, now) });
      }
      const queueId = Number(this.run("INSERT INTO queue(user_id,zone_id,connector,planned_minutes,state,created_at,updated_at) VALUES (?,?,?,?,'WAITING',?,?)", userId, zoneId, body.connector, plannedMinutes, now, now).lastInsertRowid);
      return () => ({ queue: this.queueView(queueId, now) });
    });
  }
  ownerQueue(userId, queueId) {
    id(queueId);
    const row = this.get('SELECT * FROM queue WHERE id=? AND user_id=?', queueId, userId);
    if (!row) fail(404, 'QUEUE_NOT_FOUND', 'Participación no encontrada.');
    return row;
  }
  accept(userId, queueId) {
    return this.mutate(now => {
      const row = this.ownerQueue(userId, queueId);
      this.zoneExists(row.zone_id, userId);
      if (!this.queuePermission(row)) fail(404, 'QUEUE_NOT_FOUND', 'Participación no encontrada.');
      if (['ACCEPTED', 'CHARGING'].includes(row.state)) return () => ({ queue: this.queueView(queueId, now) });
      if (row.state !== 'OFFERED') fail(409, 'OFFER_NOT_ACTIVE', 'La oferta ya no está vigente.');
      const resource = this.get('SELECT * FROM resources WHERE id=?', row.resource_id);
      if (row.expires_at <= now || resource.status !== 'AVAILABLE' || resource.observed_at === null || resource.observed_at <= now - this.config.staleSeconds * 1000) {
        fail(409, 'OFFER_NOT_ACTIVE', 'La oferta ya no está vigente.');
      }
      this.run("UPDATE queue SET state='ACCEPTED',arrival_expires_at=?,updated_at=? WHERE id=?", now + this.config.arrivalSeconds * 1000, now, queueId);
      this.notify({ userId, kind: 'QUEUE', title: 'Turno aceptado', body: 'El plazo de llegada está en marcha. Al terminar, libera tu turno. Esta cola no bloquea físicamente el cargador.', now, queueId, zoneId: row.zone_id, expiresAt: now + this.config.arrivalSeconds * 1000 });
      return () => ({ queue: this.queueView(queueId, now) });
    });
  }
  leave(userId, queueId) {
    return this.mutate(now => {
      const row = this.ownerQueue(userId, queueId);
      if (ACTIVE.includes(row.state)) {
        if (['ACCEPTED', 'CHARGING'].includes(row.state)) this.consume(row.resource_id);
        this.run("UPDATE queue SET state='CANCELLED',reason='USER_LEFT',updated_at=? WHERE id=?", now, queueId);
      }
      return () => ({ queue: this.queueView(queueId, now) });
    });
  }
  complete(userId, queueId) {
    return this.mutate(now => {
      const row = this.ownerQueue(userId, queueId);
      if (row.state === 'COMPLETED') return () => ({ queue: this.queueView(queueId, now) });
      if (row.state !== 'ACCEPTED') fail(409, 'NOT_ACCEPTED', 'Solo puedes completar un turno aceptado vigente.');
      this.consume(row.resource_id);
      this.run("UPDATE queue SET state='COMPLETED',reason='USER_COMPLETED',updated_at=? WHERE id=?", now, queueId);
      return () => ({ queue: this.queueView(queueId, now) });
    });
  }
  validateEstimate(value, now) {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value <= now || value > now + 7 * 86400000) fail(400, 'INVALID_ESTIMATE', 'La previsión debe ser una fecha futura, dentro de los próximos 7 días.');
    return value;
  }
  start(userId, queueId, body) {
    object(body);
    return this.mutate(now => {
      const row = this.ownerQueue(userId, queueId);
      this.zoneExists(row.zone_id, userId);
      if (!this.queuePermission(row)) fail(404, 'QUEUE_NOT_FOUND', 'Participación no encontrada.');
      if (row.state === 'CHARGING') return () => ({ queue: this.queueView(queueId, now) });
      if (row.state !== 'ACCEPTED') fail(409, 'NOT_ACCEPTED', 'Primero debes aceptar un turno vigente.');
      const resource = this.get('SELECT status FROM resources WHERE id=?', row.resource_id);
      if (['MAINTENANCE', 'RESERVED'].includes(resource.status)) fail(409, 'RESOURCE_BLOCKED', 'La administración ha bloqueado esta plaza. No se puede iniciar la ocupación.');
      const expected = body.expectedReleaseAt === undefined && row.planned_minutes !== null
        ? now + row.planned_minutes * 60000 : this.validateEstimate(body.expectedReleaseAt, now);
      this.run("UPDATE queue SET state='CHARGING',expected_release_at=?,updated_at=? WHERE id=?", expected, now, queueId);
      if (!this.providerZone(row.zone_id)) this.run("UPDATE resources SET status='RECHARGING',source='community',observed_at=?,revision=revision+1 WHERE id=?", now, row.resource_id);
      return () => ({ queue: this.queueView(queueId, now) });
    });
  }
  estimate(userId, queueId, body) {
    object(body);
    if (!Object.hasOwn(body, 'expectedReleaseAt')) fail(400, 'INVALID_ESTIMATE', 'Indica una previsión o null.');
    return this.mutate(now => {
      const row = this.ownerQueue(userId, queueId);
      if (row.state !== 'CHARGING') fail(409, 'NOT_CHARGING', 'Solo el ocupante puede actualizar la previsión.');
      const expected = this.validateEstimate(body.expectedReleaseAt, now);
      this.run('UPDATE queue SET expected_release_at=?,updated_at=? WHERE id=?', expected, now, queueId);
      return () => ({ queue: this.queueView(queueId, now) });
    });
  }
  release(userId, queueId) {
    return this.mutate(now => {
      const row = this.ownerQueue(userId, queueId);
      // No volver a escribir el recurso: podría tener un nuevo propietario tras la primera liberación.
      if (row.state === 'COMPLETED' && row.reason === 'USER_RELEASED') return () => ({ queue: this.queueView(queueId, now) });
      if (row.state !== 'CHARGING') fail(409, 'NOT_CHARGING', 'Solo el ocupante puede confirmar la liberación.');
      this.run("UPDATE queue SET state='COMPLETED',reason='USER_RELEASED',updated_at=? WHERE id=?", now, queueId);
      if (!this.providerZone(row.zone_id)) this.run("UPDATE resources SET status='AVAILABLE',source='community',observed_at=?,revision=revision+1 WHERE id=?", now, row.resource_id);
      else this.consume(row.resource_id);
      return () => ({ queue: this.queueView(queueId, now) });
    });
  }
  claim(userId, resourceId, body) {
    object(body); id(resourceId);
    return this.mutate(now => {
      const resource = this.get('SELECT * FROM resources WHERE id=?', resourceId);
      if (!resource || this.providerZone(resource.zone_id)) fail(404, 'RESOURCE_NOT_FOUND', 'Recurso no encontrado.');
      if (this.get("SELECT id FROM queue WHERE user_id=? AND state IN ('WAITING','OFFERED','ACCEPTED','CHARGING')", userId)) fail(409, 'ACTIVE_QUEUE', 'Ya tienes una participación activa.');
      if (this.get("SELECT id FROM queue WHERE resource_id=? AND state IN ('OFFERED','ACCEPTED','CHARGING')", resourceId)) fail(409, 'RESOURCE_OWNED', 'El recurso ya tiene propietario u oferta.');
      if (this.get("SELECT id FROM queue WHERE zone_id=? AND state IN ('WAITING','OFFERED','ACCEPTED')", resource.zone_id)) fail(409, 'QUEUE_PRIORITY', 'Hay personas esperando o en camino. Debes respetar la cola.');
      if (['MAINTENANCE', 'RESERVED'].includes(resource.status)) fail(409, 'RESOURCE_BLOCKED', 'No se puede reclamar un recurso reservado o en mantenimiento.');
      const expected = this.validateEstimate(body.expectedReleaseAt, now);
      const queueId = Number(this.run("INSERT INTO queue(user_id,zone_id,connector,state,resource_id,expected_release_at,created_at,updated_at) VALUES (?,?,?,'CHARGING',?,?,?,?)", userId, resource.zone_id, resource.connector, resource.id, expected, now, now).lastInsertRowid);
      this.run("UPDATE resources SET status='RECHARGING',source='community',observed_at=?,revision=revision+1 WHERE id=?", now, resource.id);
      return () => ({ queue: this.queueView(queueId, now) });
    });
  }
  favoriteCharger(userId, body) {
    object(body); id(body.zoneId);
    if (typeof body.enabled !== 'boolean') fail(400, 'INVALID_FIELD', 'enabled debe ser booleano.');
    return this.mutate(() => {
      const zoneId = this.siteZoneId(body.zoneId);
      if (body.enabled) {
        const readable = { requireFresh: false };
        if (!this.providerZone(zoneId) || !this.allowedZone(userId, body.zoneId, readable) || !this.allowedZone(userId, zoneId, readable)) fail(404, 'ZONE_NOT_FOUND', 'Ubicación no encontrada.');
        this.run('INSERT INTO charger_favorites(user_id,zone_id) VALUES (?,?) ON CONFLICT DO NOTHING', userId, zoneId);
      } else this.run('DELETE FROM charger_favorites WHERE user_id=? AND zone_id=?', userId, zoneId);
      return { ok: true };
    });
  }
  subscribeZone(userId, body) {
    object(body);
    if (typeof body.enabled !== 'boolean') fail(400, 'INVALID_FIELD', 'enabled debe ser booleano.');
    return this.mutate(() => {
      if (body.enabled) this.zoneExists(body.zoneId, userId);
      else id(body.zoneId);
      const zoneId = this.siteZoneId(body.zoneId);
      if (body.enabled) {
        this.zoneExists(zoneId, userId);
        this.run('INSERT INTO subscriptions(user_id,zone_id) VALUES (?,?) ON CONFLICT DO NOTHING', userId, zoneId);
      } else this.run('DELETE FROM subscriptions WHERE user_id=? AND zone_id=?', userId, zoneId);
      return { ok: true };
    });
  }
  subscribePush(userId, body) {
    const subscription = validateSubscription(body, this.clock());
    return this.mutate(now => {
      const current = this.get('SELECT * FROM push_subscriptions WHERE endpoint=?', subscription.endpoint);
      if (current && current.user_id !== userId) fail(409, 'PUSH_OWNERSHIP', 'Esta suscripción no pertenece a tu cuenta. Desactívala desde la cuenta original.');
      if (!current && this.get('SELECT count(*) AS count FROM push_subscriptions WHERE user_id=?', userId).count >= 10) fail(409, 'PUSH_LIMIT', 'Se alcanzó el límite de dispositivos.');
      this.run(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,expiration_time,created_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,expiration_time=excluded.expiration_time`,
      userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, subscription.expirationTime, now);
      return { ok: true };
    });
  }
  unsubscribePush(userId, body) {
    object(body);
    const endpoint = validateEndpoint(body.endpoint);
    return this.mutate(() => {
      const row = this.get('SELECT user_id FROM push_subscriptions WHERE endpoint=?', endpoint);
      if (row && row.user_id !== userId) fail(404, 'PUSH_NOT_FOUND', 'Suscripción no encontrada.');
      this.run('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?', userId, endpoint);
      return { ok: true };
    });
  }
  testPush(userId) {
    return this.mutate(now => {
      if (!this.get('SELECT id FROM push_subscriptions WHERE user_id=? AND (expiration_time IS NULL OR expiration_time>?)', userId, now)) fail(409, 'PUSH_DISABLED', 'Activa las notificaciones en este dispositivo primero.');
      this.notify({ userId, kind: 'TEST', title: 'Prueba de A la caaarga!!', body: 'Notificación de prueba. No has entrado en ninguna cola.', now });
      return { ok: true };
    });
  }
  createZone(body) {
    object(body);
    const name = text(body.name, 'name', 1, 100);
    const description = text(body.description ?? '', 'description', 0, 1000);
    const latitude = body.latitude ?? null, longitude = body.longitude ?? null, radius = body.radiusMeters ?? null;
    if ((latitude === null) !== (longitude === null) ||
      (latitude !== null && (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
      (longitude !== null && (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180)) ||
      (radius !== null && (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius > 100000))) fail(400, 'INVALID_LOCATION', 'Ubicación o radio no válidos.');
    return this.mutate(now => {
      if (this.get('SELECT count(*) AS count FROM zones z WHERE NOT EXISTS (SELECT 1 FROM private_provider_zones p WHERE p.zone_id=z.id)').count >= 1000) fail(409, 'ZONE_LIMIT', 'Se alcanzó el límite de zonas.');
      const zoneId = Number(this.run('INSERT INTO zones(name,description,latitude,longitude,radius_meters) VALUES (?,?,?,?,?)', name, description, latitude, longitude, radius).lastInsertRowid);
      return () => ({ zone: this.zoneView(this.get('SELECT * FROM zones WHERE id=?', zoneId), now) });
    });
  }
  createResource(body) {
    object(body);
    const name = text(body.name, 'name', 1, 100);
    if (!CONNECTORS.includes(body.connector)) fail(400, 'INVALID_CONNECTOR', 'Conector no válido.');
    if (typeof body.powerKw !== 'number' || !Number.isFinite(body.powerKw) || body.powerKw <= 0 || body.powerKw > 2000) fail(400, 'INVALID_POWER', 'Potencia no válida.');
    return this.mutate(() => {
      this.zoneExists(body.zoneId);
      if (this.get('SELECT count(*) AS count FROM resources WHERE zone_id=?', body.zoneId).count >= 1000) fail(409, 'RESOURCE_LIMIT', 'Se alcanzó el límite de recursos de la zona.');
      const resourceId = Number(this.run('INSERT INTO resources(zone_id,name,connector,power_kw) VALUES (?,?,?,?)', body.zoneId, name, body.connector, body.powerKw).lastInsertRowid);
      return () => ({ resource: this.resourceView(this.get('SELECT * FROM resources WHERE id=?', resourceId)) });
    });
  }
  setStatus(resourceId, body) {
    object(body); id(resourceId);
    if (!STATUSES.includes(body.status)) fail(400, 'INVALID_STATUS', 'Estado no válido. STALE se calcula automáticamente.');
    return this.mutate(now => {
      const resource = this.get('SELECT zone_id FROM resources WHERE id=?', resourceId);
      if (!resource || this.providerZone(resource.zone_id)) fail(404, 'RESOURCE_NOT_FOUND', 'Recurso no encontrado.');
      const active = this.get("SELECT * FROM queue WHERE resource_id=? AND state IN ('ACCEPTED','CHARGING')", resourceId);
      if (active && ((active.state === 'CHARGING' && body.status !== 'RECHARGING') ||
          (active.state === 'ACCEPTED' && ['MAINTENANCE', 'RESERVED'].includes(body.status)))) {
        this.run("UPDATE queue SET state='CANCELLED',reason='ADMIN_CORRECTION',updated_at=? WHERE id=?", now, active.id);
        this.notify({ userId: active.user_id, kind: 'QUEUE', title: 'Estado corregido por administración',
          body: active.state === 'CHARGING' ? 'La administración actualizó la plaza y cerró tu ocupación declarada.' : 'La administración bloqueó la plaza y canceló tu turno aceptado.',
          now, queueId: active.id, zoneId: active.zone_id });
      }
      this.run("UPDATE resources SET status=?,source='manual',observed_at=?,revision=revision+1 WHERE id=?", body.status, now, resourceId);
      return { ok: true };
    });
  }
  chargeFinished(resourceId) {
    id(resourceId);
    return this.mutate(now => {
      const row = this.get("SELECT * FROM queue WHERE resource_id=? AND state='CHARGING'", resourceId);
      if (!row || this.providerZone(row.zone_id)) fail(409, 'NOT_CHARGING', 'No hay ocupante cargando al que avisar.');
      if (row.charge_finished_at !== null) return { ok: true };
      this.run('UPDATE queue SET charge_finished_at=?,updated_at=? WHERE id=?', now, now, row.id);
      this.notify({ userId: row.user_id, kind: 'FINISHED', title: 'Carga finalizada (señal manual)', body: 'Carga finalizada; retira el coche y confirma liberación. La administración ha confirmado el fin; la plaza sigue ocupada hasta que la liberes.',
        now, expiresAt: now + 86400000, queueId: row.id, zoneId: row.zone_id, resourceId, dedupeKey: `finished:${row.id}` });
      return { ok: true };
    });
  }

  rateLimit(category, key, limit, windowMs) {
    const now = this.clock();
    const identifier = `${category}:${digest(key)}`;
    const allowed = transaction(this.db, () => {
      this.run('DELETE FROM rate_limits WHERE reset_at<=?', now);
      const row = this.get('SELECT * FROM rate_limits WHERE key=?', identifier);
      if (row && row.count >= limit) return false;
      if (!row && this.get('SELECT count(*) AS count FROM rate_limits').count >= 50000) return false;
      this.run('INSERT INTO rate_limits(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1', identifier, now + windowMs);
      return true;
    });
    if (!allowed) fail(429, 'RATE_LIMITED', 'Demasiadas solicitudes. Espera antes de volver a intentar.');
  }

  claimPush() {
    return transaction(this.db, () => {
      const now = this.clock();
      this.reconcile(now);
      this.run('DELETE FROM push_subscriptions WHERE expiration_time IS NOT NULL AND expiration_time<=?', now);
      this.run("UPDATE outbox SET state='failed',lease_token=NULL,lease_until=NULL WHERE attempts>=5 AND (state='pending' OR (state='sending' AND lease_until<=?))", now);
      const row = this.get(`SELECT o.*,n.user_id,n.kind,n.title,n.body,n.queue_id,n.zone_id,n.resource_id,
        s.endpoint,s.p256dh,s.auth FROM outbox o JOIN notifications n ON n.id=o.notification_id
        JOIN push_subscriptions s ON s.id=o.subscription_id AND s.user_id=n.user_id
        WHERE o.expires_at>? AND o.attempts<5 AND ((o.state='pending' AND o.next_attempt_at<=?) OR (o.state='sending' AND o.lease_until<=?))
        AND (? OR NOT EXISTS (SELECT 1 FROM private_provider_zones p WHERE p.zone_id=n.zone_id)) ORDER BY o.id LIMIT 1`, now, now, now, Number(Boolean(this.catalog?.fresh())));
      if (!row) return null;
      const leaseToken = randomBytes(16).toString('hex');
      this.run("UPDATE outbox SET state='sending',attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?", now + 45000, leaseToken, row.id);
      return { ...row, attempts: row.attempts + 1, leaseToken, ttl: Math.max(0, Math.floor((row.expires_at - now) / 1000)) };
    });
  }
  finishPush(job, result = {}) {
    return transaction(this.db, () => {
      const now = this.clock();
      const current = this.get("SELECT * FROM outbox WHERE id=? AND state='sending' AND lease_token=?", job.id, job.leaseToken);
      if (!current) return;
      const status = Number(result.statusCode);
      if (status === 404 || status === 410) {
        this.run('DELETE FROM push_subscriptions WHERE id=? AND user_id=? AND endpoint=? AND p256dh=? AND auth=?', job.subscription_id, job.user_id, job.endpoint, job.p256dh, job.auth);
        this.run("UPDATE outbox SET state='failed',lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?", job.id, job.leaseToken);
        return;
      }
      let state, retryAt = now;
      if (now >= job.expires_at) state = 'expired';
      else if (status >= 200 && status < 300) state = 'provider_accepted'; // No equivale a entrega al navegador.
      else if ((status >= 400 && status < 500 && status !== 408 && status !== 429) || current.attempts >= 5) state = 'failed';
      else {
        state = 'pending';
        let delay = Math.min(60000, 5000 * 2 ** (current.attempts - 1));
        const retryAfter = result.headers?.['retry-after'];
        if (typeof retryAfter === 'string' && /^\d{1,6}$/.test(retryAfter)) delay = Math.max(delay, Math.min(3600000, Number(retryAfter) * 1000));
        retryAt = now + delay;
        if (retryAt >= job.expires_at) state = 'expired';
      }
      this.run('UPDATE outbox SET state=?,next_attempt_at=?,lease_until=NULL,lease_token=NULL WHERE id=? AND lease_token=?', state, retryAt, job.id, job.leaseToken);
    });
  }
}
