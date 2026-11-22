import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/db.mjs';
import { loadConfig } from '../../src/config.mjs';
import { Service } from '../../src/service.mjs';

const config = loadConfig({ DATA_DIR: workerData.dataDir });
const db = openDatabase(config.dataDir);
const service = new Service(db, config, () => workerData.now);
parentPort.postMessage({ type: 'ready' });
Atomics.wait(new Int32Array(workerData.gate), 0, 0, 10000);
try {
  const { method, args } = workerData.operation;
  parentPort.postMessage({ type: 'result', value: service[method](...args) });
} catch (error) { parentPort.postMessage({ type: 'result', code: error.code }); }
finally { db.close(); }
