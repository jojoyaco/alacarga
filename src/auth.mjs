import { randomBytes, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Queries, transaction } from './db.mjs';
import { fail, object } from './errors.mjs';

const derive = promisify(scrypt);
const COST = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const DUMMY = `scrypt$32768$8$3$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(64).toString('base64url')}`;
let hashesInFlight = 0;

async function passwordKey(password, salt) {
  // Límite global de memoria: dos trabajos de ~32 MiB; nunca scryptSync en HTTP.
  if (hashesInFlight >= 2) fail(503, 'AUTH_BUSY', 'Autenticación ocupada. Intenta nuevamente.');
  hashesInFlight++;
  try { return await derive(password, salt, 64, COST); }
  finally { hashesInFlight--; }
}

export function credentials(body) {
  object(body);
  if (typeof body.username !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(body.username)) {
    fail(400, 'INVALID_USERNAME', 'El usuario debe tener entre 3 y 32 letras, números, guiones o guiones bajos.');
  }
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
    fail(400, 'INVALID_PASSWORD', 'La contraseña debe tener entre 12 y 128 caracteres.');
  }
  return { username: body.username, password: body.password };
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await passwordKey(password, salt);
  return `scrypt$32768$8$3$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, encoded = DUMMY) {
  const parts = encoded.split('$');
  const valid = parts.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$32768$8$3' && /^[\w-]{22}$/.test(parts[4]) && /^[\w-]{86}$/.test(parts[5]);
  const chosen = valid ? parts : DUMMY.split('$');
  const computed = await passwordKey(password, Buffer.from(chosen[4], 'base64url'));
  const expected = Buffer.from(chosen[5], 'base64url');
  return valid && expected.length === computed.length && timingSafeEqual(expected, computed);
}

export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Auth extends Queries {
  constructor(db, config, clock = Date.now) {
    super(db); this.config = config; this.clock = clock;
    this.cookieName = config.secureCookies ? '__Host-alacarga_session' : 'alacarga_session';
  }
  cookie(token, clear = false) {
    return `${this.cookieName}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : this.config.sessionSeconds}${this.config.secureCookies ? '; Secure' : ''}`;
  }
  cookieToken(header = '') {
    const cookies = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${this.cookieName}=`));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  }
  lookup(header) {
    const token = this.cookieToken(header);
    if (!token) return null;
    const row = this.get(`SELECT s.token_hash,s.csrf_token,u.id,COALESCE(e.display_name,u.username) AS username,u.role,e.provider FROM sessions s
      JOIN users u ON u.id=s.user_id LEFT JOIN external_identities e ON e.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?`, digest(token), this.clock());
    return row ? { user: { id: row.id, username: row.username, role: row.role, provider: row.provider ?? 'local' }, csrfToken: row.csrf_token, tokenHash: row.token_hash } : null;
  }
  sessionView(session) { return { user: session?.user ?? null, csrfToken: session?.csrfToken ?? null }; }
  issue(user, previousCookie) {
    const now = this.clock();
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const previous = this.cookieToken(previousCookie);
    if (previous) this.run('DELETE FROM sessions WHERE token_hash=?', digest(previous));
    this.run('DELETE FROM sessions WHERE expires_at<=?', now);
    this.run(`DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN
      (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 4)`, user.id, user.id);
    this.run('INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?)', digest(token), user.id, csrfToken, now, now + this.config.sessionSeconds * 1000);
    return { view: { user: { id: user.id, username: user.username, role: user.role, provider: user.provider ?? 'local' }, csrfToken }, cookie: this.cookie(token), tokenHash: digest(token) };
  }
  async register(body, previousCookie) {
    const { username, password } = credentials(body);
    const encoded = await hashPassword(password);
    return transaction(this.db, () => {
      if (this.get('SELECT id FROM users WHERE username=?', username)) fail(409, 'USERNAME_EXISTS', 'Ese usuario ya existe.');
      const result = this.run("INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,'user',?)", username, encoded, this.clock());
      return this.issue({ id: Number(result.lastInsertRowid), username, role: 'user' }, previousCookie);
    });
  }
  async login(body, previousCookie) {
    const { username, password } = credentials(body);
    const row = this.get('SELECT * FROM users WHERE username=?', username);
    const matches = await verifyPassword(password, row?.password_hash);
    if (!row || !matches || row.role !== 'admin' || this.get('SELECT 1 FROM external_identities WHERE user_id=?', row.id)) fail(401, 'INVALID_CREDENTIALS', 'Usuario o contraseña incorrectos.');
    return transaction(this.db, () => this.issue(row, previousCookie));
  }
  async loginEvsare(body, previousCookie, client, vault) {
    const identity = await client.login(body);
    return transaction(this.db, () => {
      let row = this.get("SELECT user_id FROM external_identities WHERE provider='evsare' AND subject=?", identity.subject);
      if (!row) {
        const created = this.run("INSERT INTO users(username,password_hash,role,created_at) VALUES (?,'external:evsare','user',?)", `evsare_${randomBytes(16).toString('hex')}`, this.clock());
        row = { user_id: Number(created.lastInsertRowid) };
        this.run("INSERT INTO external_identities(user_id,provider,subject,display_name) VALUES (?,'evsare',?,?)", row.user_id, identity.subject, identity.displayName);
      } else this.run('UPDATE external_identities SET display_name=? WHERE user_id=?', identity.displayName, row.user_id);
      // Roles upstream no conceden privilegios locales. No enlazar nunca por email, screenName o entrada de login.
      const signed = this.issue({ id: row.user_id, username: identity.displayName, role: 'user', provider: 'evsare' }, previousCookie);
      vault.put(identity.token, { tokenHash: signed.tokenHash, user: signed.view.user });
      return signed;
    });
  }
  logout(session) {
    transaction(this.db, () => this.run('DELETE FROM sessions WHERE token_hash=?', session.tokenHash));
    return this.cookie('', true);
  }
}

// Solo la CLI importa esta función; no hay ruta HTTP de promoción ni bootstrap público.
export async function createAdmin(db, body, clock = Date.now) {
  const { username, password } = credentials(body);
  const encoded = await hashPassword(password);
  return transaction(db, () => {
    const q = new Queries(db);
    if (q.get('SELECT id FROM users WHERE username=?', username)) fail(409, 'USERNAME_EXISTS', 'El usuario ya existe; no se modificó.');
    return Number(q.run("INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,'admin',?)", username, encoded, clock()).lastInsertRowid);
  });
}
