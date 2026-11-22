import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, copyFileSync, chmodSync, constants, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { createAdmin } from './auth.mjs';
import { AppError } from './errors.mjs';

export async function backupData(dataDir, destination) {
  const source = join(dataDir, 'alacarga.sqlite');
  if (!existsSync(source)) throw new Error('No existe la base de datos.');
  // Destino nuevo exclusivamente: una copia fallida nunca sobrescribe una anterior.
  mkdirSync(destination, { mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  try {
    const target = join(destination, 'alacarga.sqlite');
    await backup(db, target);
    chmodSync(target, 0o600);
    const verify = new DatabaseSync(target, { readOnly: true });
    try {
      if (verify.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('La copia no pasó la comprobación.');
    } finally { verify.close(); }
    if (existsSync(join(dataDir, 'vapid.json'))) {
      copyFileSync(join(dataDir, 'vapid.json'), join(destination, 'vapid.json'), constants.COPYFILE_EXCL);
      chmodSync(join(destination, 'vapid.json'), 0o600);
    }
  } finally { db.close(); }
}

async function stdinPassword() {
  if (process.stdin.isTTY) throw new Error('La contraseña debe llegar por stdin, nunca como argumento.');
  let length = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 1024) throw new Error('Entrada demasiado larga.');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).replace(/\r?\n$/, '');
}

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  const [command, target] = args;
  if (args.length !== 2 || !['create', 'backup'].includes(command)) {
    console.error('Uso: node src/admin.mjs create <username> (contraseña por stdin) | backup <directorio-nuevo>');
    process.exitCode = 1; return;
  }
  const config = loadConfig();
  if (command === 'backup') {
    await backupData(config.dataDir, resolve(target));
    console.log('Copia privada de SQLite y claves VAPID existentes verificada. Protege este directorio: contiene credenciales y sesiones.');
    return;
  }
  const password = await stdinPassword();
  const db = openDatabase(config.dataDir);
  try { await createAdmin(db, { username: target, password }); console.log('Administrador creado. No se muestra la contraseña.'); }
  finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof AppError ? error.message : 'ADMIN_ERROR: verifica argumentos, entrada, permisos y destino; no se sobrescribieron credenciales existentes.'); process.exitCode = 1; });
}
