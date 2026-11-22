import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id,created_at);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  radius_meters REAL
) STRICT;
CREATE TABLE resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  name TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector IN ('TYPE2','CCS2','CHADEMO','SCHUKO')),
  power_kw REAL NOT NULL CHECK (power_kw > 0),
  status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('AVAILABLE','BUSY','RESERVED','RECHARGING','MAINTENANCE','UNKNOWN')),
  observed_at INTEGER,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','community')),
  revision INTEGER NOT NULL DEFAULT 0,
  notified_revision INTEGER NOT NULL DEFAULT -1
) STRICT;
CREATE INDEX resources_zone ON resources(zone_id);
CREATE TABLE queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  connector TEXT NOT NULL CHECK (connector IN ('ANY','TYPE2','CCS2','CHADEMO','SCHUKO')),
  planned_minutes INTEGER CHECK (planned_minutes IS NULL OR planned_minutes BETWEEN 1 AND 720),
  state TEXT NOT NULL CHECK (state IN ('WAITING','OFFERED','ACCEPTED','CHARGING','EXPIRED','CANCELLED','COMPLETED')),
  resource_id INTEGER REFERENCES resources(id),
  expires_at INTEGER,
  arrival_expires_at INTEGER,
  expected_release_at INTEGER,
  charge_finished_at INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state NOT IN ('OFFERED','ACCEPTED') OR (resource_id IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK (state != 'ACCEPTED' OR arrival_expires_at IS NOT NULL)
  ,CHECK (state != 'CHARGING' OR resource_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX queue_one_active_user ON queue(user_id) WHERE state IN ('WAITING','OFFERED','ACCEPTED','CHARGING');
CREATE UNIQUE INDEX queue_one_active_resource ON queue(resource_id) WHERE state IN ('OFFERED','ACCEPTED','CHARGING');
CREATE INDEX queue_fifo ON queue(zone_id,state,id);
CREATE INDEX queue_user ON queue(user_id,id);
CREATE TABLE subscriptions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id,zone_id)
) STRICT;
CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX push_user ON push_subscriptions(user_id);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('OFFER','QUEUE','AVAILABILITY','TEST','REMINDER','FINISHED')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  queue_id INTEGER REFERENCES queue(id),
  queue_state TEXT,
  zone_id INTEGER REFERENCES zones(id),
  resource_id INTEGER REFERENCES resources(id),
  resource_revision INTEGER,
  expected_release_at INTEGER,
  dedupe_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notifications_user ON notifications(user_id,id);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','provider_accepted','expired','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_until INTEGER,
  lease_token TEXT,
  UNIQUE (notification_id,subscription_id)
) STRICT;
CREATE INDEX outbox_pending ON outbox(state,next_attempt_at);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) STRICT;
CREATE INDEX rate_expiry ON rate_limits(reset_at);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
PRAGMA user_version = 2;
`;

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const path = join(dataDir, 'alacarga.sqlite');
  const db = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false });
  chmodSync(path, 0o600);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    transaction(db, () => {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > 9) throw new Error('Versión de base de datos no soportada.');
      if (version === 0) db.exec(SCHEMA);
      // Migración aditiva: las participaciones existentes conservan duración desconocida, nunca un default inventado.
      const queueColumns = db.prepare('PRAGMA table_info(queue)').all();
      if (!queueColumns.some(column => column.name === 'planned_minutes')) {
        db.exec('ALTER TABLE queue ADD COLUMN planned_minutes INTEGER CHECK (planned_minutes IS NULL OR planned_minutes BETWEEN 1 AND 720)');
      }
      if (version < 2) db.exec('PRAGMA user_version=2');
      if (version < 3) db.exec(`
        CREATE TABLE external_identities (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK (provider='evsare'),
          subject TEXT NOT NULL,
          display_name TEXT NOT NULL,
          UNIQUE(provider,subject)
        ) STRICT;
        CREATE TABLE provider_sessions (
          token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
          token_cipher TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version=3;
      `);
      if (version < 4) db.exec(`
        CREATE TABLE IF NOT EXISTS provider_zones (
          zone_id INTEGER PRIMARY KEY REFERENCES zones(id),
          terminal_key TEXT NOT NULL UNIQUE,
          resource_id INTEGER NOT NULL UNIQUE REFERENCES resources(id),
          free_after INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        PRAGMA user_version=4;
      `);
      if (version < 5) db.exec(`
        CREATE TABLE IF NOT EXISTS charger_favorites (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          zone_id INTEGER NOT NULL REFERENCES provider_zones(zone_id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, zone_id)
        ) STRICT;
        PRAGMA user_version=5;
      `);
      if (version < 6) db.exec(`
        CREATE TABLE provider_sites (
          zone_id INTEGER PRIMARY KEY REFERENCES zones(id),
          site_key TEXT NOT NULL UNIQUE
        ) STRICT;
        -- Las claves de emplazamiento llegan con el catálogo; conservar aquí las vinculaciones antiguas.
        CREATE TABLE provider_bindings_v6 (
          zone_id INTEGER NOT NULL REFERENCES zones(id),
          terminal_key TEXT PRIMARY KEY NOT NULL,
          resource_id INTEGER NOT NULL UNIQUE REFERENCES resources(id),
          free_after INTEGER NOT NULL DEFAULT 0
        ) STRICT;
        INSERT INTO provider_bindings_v6 SELECT zone_id, terminal_key, resource_id, free_after FROM provider_zones;
        CREATE TABLE charger_favorites_v6 (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, zone_id)
        ) STRICT;
        INSERT INTO charger_favorites_v6 SELECT user_id, zone_id FROM charger_favorites;
        DROP TABLE charger_favorites;
        DROP TABLE provider_zones;
        ALTER TABLE provider_bindings_v6 RENAME TO provider_zones;
        ALTER TABLE charger_favorites_v6 RENAME TO charger_favorites;
        CREATE INDEX provider_bindings_zone ON provider_zones(zone_id);
        CREATE TABLE provider_zone_aliases (
          zone_id INTEGER PRIMARY KEY REFERENCES zones(id),
          site_zone_id INTEGER NOT NULL REFERENCES provider_sites(zone_id),
          terminal_key TEXT NOT NULL REFERENCES provider_zones(terminal_key)
        ) STRICT;
        CREATE VIEW private_provider_zones AS
          SELECT zone_id FROM provider_sites UNION SELECT zone_id FROM provider_zones UNION SELECT zone_id FROM provider_zone_aliases;
        PRAGMA user_version=6;
      `);
      if (version < 7) db.exec(`
        -- Una solicitud posiblemente enviada bloquea la cuenta y el terminal, incluso tras reiniciar.
        -- No se conservan tarjeta, token ni datos de respuesta de EVsare.
        CREATE TABLE remote_charge_attempts (
          terminal_key TEXT PRIMARY KEY NOT NULL,
          user_id INTEGER NOT NULL UNIQUE,
          connector_id INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('UNCONFIRMED','ACCEPTED'))
        ) STRICT;
        PRAGMA user_version=7;
      `);
      if (version < 8) db.exec(`
        -- Survives release and process restart. No credentials or upstream response bodies.
        CREATE TABLE remote_charge_lifecycle (
          attempt_id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL,
          terminal_key TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          recharge_id INTEGER CHECK (recharge_id BETWEEN 1 AND 2147483647),
          finished_seen INTEGER NOT NULL DEFAULT 0 CHECK (finished_seen IN (0,1)),
          finish_requested_at INTEGER,
          released_at INTEGER,
          release_reason TEXT CHECK (release_reason IN ('FINISHED','USER_CONFIRMED_NO_MATCH')),
          UNIQUE(user_id,recharge_id)
        ) STRICT;
        PRAGMA user_version=8;
      `);
      if (version < 9) db.exec(`
        -- Record each dispatch in order, without exclusive ownership of the account or terminal.
        -- Preserve the old rowid as the lifecycle key (including any finish dispatch evidence).
        CREATE TABLE remote_charge_attempts_v9 (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          attempt_id INTEGER NOT NULL UNIQUE,
          terminal_key TEXT NOT NULL,
          user_id INTEGER NOT NULL,
          connector_id INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('UNCONFIRMED','ACCEPTED','REJECTED'))
        ) STRICT;
        INSERT INTO remote_charge_attempts_v9(attempt_id,terminal_key,user_id,connector_id,started_at,status)
          SELECT rowid,terminal_key,user_id,connector_id,started_at,status FROM remote_charge_attempts;
        DROP TABLE remote_charge_attempts;
        ALTER TABLE remote_charge_attempts_v9 RENAME TO remote_charge_attempts;
        CREATE INDEX remote_charge_attempts_user ON remote_charge_attempts(user_id,sequence DESC);
        PRAGMA user_version=9;
      `);
    });
    for (const suffix of ['-wal', '-shm']) {
      try { chmodSync(path + suffix, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Ninguna transacción debe cruzar un await: SQLite se usa sincronamente y con lock de escritura previo.
export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    if (result && typeof result.then === 'function') throw new Error('Transacción asíncrona no permitida.');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export class Queries {
  constructor(db) { this.db = db; this.statements = new Map(); }
  statement(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  get(sql, ...params) { return this.statement(sql).get(...params); }
  all(sql, ...params) { return this.statement(sql).all(...params); }
  run(sql, ...params) { return this.statement(sql).run(...params); }
}
