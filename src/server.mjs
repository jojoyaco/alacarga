import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApplication } from './http.mjs';

export async function startServer() {
  process.umask(0o077);
  const app = createApplication();
  try {
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(app.config.port, app.config.host, resolve);
    });
    app.startWorkers();
  } catch (error) { await app.close(); throw error; }
  console.log(`A la caaarga!! HTTP iniciado. Catálogo de EVsare ${app.config.catalogCredentialsPath ? 'habilitado en modo lectura' : 'deshabilitado'}.`);
  if (!app.config.vapidSubject) console.log('Push deshabilitado: configura VAPID_SUBJECT o APP_ORIGIN HTTPS.');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => { console.error('SHUTDOWN_TIMEOUT'); process.exit(1); }, 20000);
    timeout.unref();
    try { await app.close(); clearTimeout(timeout); }
    catch { console.error('SHUTDOWN_ERROR'); process.exitCode = 1; }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch(() => { console.error('STARTUP_ERROR: verifica configuración, permisos y datos. No se imprimen secretos.'); process.exitCode = 1; });
}
