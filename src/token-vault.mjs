import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { Queries } from './db.mjs';
import { fail } from './errors.mjs';

export function reauthenticate() {
  fail(401, 'EVSARE_REAUTH_REQUIRED', 'La sesión de EVsare necesita renovarse. Vuelve a entrar con tu cuenta; tu turno de A la caaarga!! se conserva.');
}

// La clave permanece fuera del código y nunca se genera de nuevo sobre sesiones cifradas.
// Cifrado en reposo: no protege contra un atacante con acceso al proceso/host o a clave+DB.
export class TokenVault extends Queries {
  #key;
  constructor(db, dataDir, clock = Date.now) {
    super(db); this.clock = clock;
    const path = join(dataDir, 'evsare-token.key');
    let fd;
    try {
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if (error.code !== 'ENOENT' || this.get('SELECT count(*) AS n FROM provider_sessions').n) throw error;
        const key = randomBytes(32);
        try {
          const writer = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { writeFileSync(writer, key); fsyncSync(writer); } finally { closeSync(writer); }
        } finally { key.fill(0); }
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      }
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw new Error();
      this.#key = readFileSync(fd);
      if (this.#key.length !== 32) throw new Error();
    } catch { throw new Error('EVSARE_KEY_UNAVAILABLE: restaurar la clave privada original; no regenerarla sobre sesiones existentes.'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  aad(session) { return Buffer.from(`alacarga:evsare:v1:${session.tokenHash}:${session.user.id}`); }
  seal(token, session) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv, { authTagLength: 16 });
    cipher.setAAD(this.aad(session));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return 'v1.' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }
  active(session) {
    if (!session || session.user.provider !== 'evsare') reauthenticate();
    if (!this.get('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?', session.tokenHash, session.user.id, this.clock())) reauthenticate();
  }
  put(token, session) {
    this.active(session);
    this.run('INSERT INTO provider_sessions(token_hash,token_cipher) VALUES (?,?) ON CONFLICT(token_hash) DO UPDATE SET token_cipher=excluded.token_cipher', session.tokenHash, this.seal(token, session));
  }
  getToken(session) {
    this.active(session);
    const row = this.get('SELECT token_cipher FROM provider_sessions WHERE token_hash=?', session.tokenHash);
    if (!row) reauthenticate();
    try {
      if (!/^v1\.[\w-]+$/.test(row.token_cipher) || row.token_cipher.length > 12000) throw new Error();
      const payload = Buffer.from(row.token_cipher.slice(3), 'base64url');
      if (payload.length < 29) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, payload.subarray(0, 12), { authTagLength: 16 });
      decipher.setAAD(this.aad(session)); decipher.setAuthTag(payload.subarray(12, 28));
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
    } catch { this.forget(session); reauthenticate(); }
  }
  forget(session) { this.run('DELETE FROM provider_sessions WHERE token_hash=?', session.tokenHash); }
  destroy() { this.#key.fill(0); }
}
