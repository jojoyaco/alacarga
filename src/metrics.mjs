import { createServer } from 'node:http';
import { normalizeIp } from './config.mjs';

const events = ['favorite_added', 'alert_enabled', 'queue_joined', 'queue_accepted', 'queue_cancelled', 'queue_expired', 'queue_completed'];
const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const statusGroups = ['2xx', '3xx', '4xx', '5xx', 'other'];

export function createMetrics(db, catalog) {
  // TEMP lives in this connection only. Trigger counts roll back with their
  // business writes (including savepoints), and do not alter the disk schema.
  db.exec(`CREATE TEMP TABLE metric_events (kind TEXT PRIMARY KEY, count INTEGER NOT NULL) STRICT;
    ${events.map(event => `INSERT INTO metric_events VALUES ('${event}', 0);`).join('\n')}
    CREATE TEMP TRIGGER metric_favorite AFTER INSERT ON main.charger_favorites BEGIN
      UPDATE metric_events SET count=count+1 WHERE kind='favorite_added'; END;
    CREATE TEMP TRIGGER metric_alert AFTER INSERT ON main.subscriptions BEGIN
      UPDATE metric_events SET count=count+1 WHERE kind='alert_enabled'; END;
    CREATE TEMP TRIGGER metric_join AFTER INSERT ON main.queue WHEN NEW.state='WAITING' BEGIN
      UPDATE metric_events SET count=count+1 WHERE kind='queue_joined'; END;
    CREATE TEMP TRIGGER metric_queue AFTER UPDATE OF state ON main.queue WHEN OLD.state<>NEW.state BEGIN
      UPDATE metric_events SET count=count+1 WHERE kind=CASE NEW.state
        WHEN 'ACCEPTED' THEN 'queue_accepted' WHEN 'CANCELLED' THEN 'queue_cancelled'
        WHEN 'EXPIRED' THEN 'queue_expired' WHEN 'COMPLETED' THEN 'queue_completed' END; END;`);
  const readEvents = db.prepare('SELECT kind, count FROM temp.metric_events ORDER BY kind');
  const apiCounts = Object.fromEntries(statusGroups.map(group => [group, 0]));
  const buckets = bounds.map(() => 0);
  let apiCount = 0, apiDuration = 0, pageLoads = 0, loginOk = 0, loginFailed = 0;

  return {
    record(method, pathname, status, seconds) {
      if (method === 'GET' && (pathname === '/' || pathname === '/index.html') && (status === 200 || status === 304)) pageLoads++;
      if (method === 'POST' && pathname === '/api/login') {
        if (status >= 200 && status < 300) loginOk++;
        else if (status >= 400) loginFailed++;
      }
      if (!pathname.startsWith('/api/') || pathname === '/api/health') return;
      const group = status >= 200 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other';
      apiCounts[group]++;
      apiDuration += seconds;
      apiCount++;
      for (let i = 0; i < bounds.length; i++) if (seconds <= bounds[i]) buckets[i]++;
    },
    render() {
      const out = [];
      const metric = (name, type, help, samples) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
      const single = (name, type, help, value) => metric(name, type, help, [`${name} ${value}`]);
      single('alacarga_page_loads_total', 'counter', 'Successful HTTP GETs to the HTML entry point, not unique visitors.', pageLoads);
      metric('alacarga_logins_total', 'counter', 'Completed EVsare login HTTP attempts by outcome.', [
        `alacarga_logins_total{outcome="success"} ${loginOk}`, `alacarga_logins_total{outcome="failure"} ${loginFailed}`]);
      metric('alacarga_events_total', 'counter', 'Committed functional events; queue events are not physical charges.',
        readEvents.all().map(({ kind, count }) => `alacarga_events_total{event="${kind}"} ${count}`));
      metric('alacarga_api_requests_total', 'counter', 'API responses excluding health probes.',
        statusGroups.map(group => `alacarga_api_requests_total{status_class="${group}"} ${apiCounts[group]}`));
      const latency = 'alacarga_api_request_duration_seconds';
      metric(latency, 'histogram', 'Time to finish API responses excluding health probes.', [
        ...bounds.map((bound, i) => `${latency}_bucket{le="${bound}"} ${buckets[i]}`),
        `${latency}_bucket{le="+Inf"} ${apiCount}`, `${latency}_sum ${apiDuration}`, `${latency}_count ${apiCount}`]);
      single('alacarga_catalog_configured', 'gauge', 'Whether a private EVsare catalog is configured.', Number(Boolean(catalog)));
      single('alacarga_catalog_last_success_timestamp_seconds', 'gauge', 'Timestamp of last successful snapshot; zero if not yet available.', (catalog?.observedAt ?? 0) / 1000);
      single('alacarga_catalog_sync_failed', 'gauge', 'Whether the most recent attempted catalog refresh failed.', Number(Boolean(catalog?.failed)));
      return out.join('\n') + '\n';
    },
  };
}

export function createMetricsServer(metrics, allowedPeers) {
  return createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 4000, keepAliveTimeout: 1000 }, (request, response) => {
    // Direct socket only: never honor headers or application sessions here.
    if (!allowedPeers.has(normalizeIp(request.socket.remoteAddress)) || request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404, { 'Connection': 'close' }).end();
      return;
    }
    try {
      const body = metrics.render();
      response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(body);
    } catch {
      response.writeHead(503, { 'Connection': 'close' }).end();
    }
  });
}
