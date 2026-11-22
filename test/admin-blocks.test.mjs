import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, isCode } from './helpers.mjs';

for (const status of ['MAINTENANCE', 'RESERVED']) {
  test(`${status} administrativo cancela un ACCEPTED y no permite reabrir la plaza`, t => {
    const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), owner = f.user(), next = f.user();
    f.available(r);
    const q = s.join(owner, { zoneId: z, connector: 'TYPE2' }).queue;
    s.accept(owner, q.id);
    s.join(next, { zoneId: z, connector: 'TYPE2' });
    s.setStatus(r, { status });
    assert.equal(s.me(owner).queue.state, 'CANCELLED');
    assert.equal(s.me(owner).queue.reason, 'ADMIN_CORRECTION');
    assert.throws(() => s.start(owner, q.id, {}), isCode('NOT_ACCEPTED'));
    assert.throws(() => s.release(owner, q.id), isCode('NOT_CHARGING'));
    s.leave(owner, q.id);
    f.advance(600001); s.tick();
    assert.equal(f.db.prepare('SELECT status FROM resources WHERE id=?').get(r).status, status);
    assert.equal(s.me(next).queue.state, 'WAITING');
    assert.equal(s.zones().zones[0].availableCount, 0);
    s.setStatus(r, { status: 'AVAILABLE' });
    assert.equal(s.me(next).queue.state, 'OFFERED');
  });

  for (const action of ['start', 'leave', 'complete', 'expiry']) {
    test(`snapshot previo ACCEPTED + ${status}: ${action} conserva el bloqueo`, t => {
      const f = fixture(t), s = f.service, z = f.zone(), r = f.resource(z), owner = f.user();
      f.available(r);
      const q = s.join(owner, { zoneId: z, connector: 'TYPE2' }).queue;
      s.accept(owner, q.id);
      // Representa un snapshot creado por una versión anterior, exclusivamente en DB temporal.
      f.db.prepare('UPDATE resources SET status=? WHERE id=?').run(status, r);
      if (action === 'start') assert.throws(() => s.start(owner, q.id, {}), isCode('RESOURCE_BLOCKED'));
      else if (action === 'expiry') { f.advance(600001); s.tick(); }
      else s[action](owner, q.id);
      assert.equal(f.db.prepare('SELECT status FROM resources WHERE id=?').get(r).status, status);
      assert.equal(s.zones().zones[0].availableCount, 0);
    });
  }
}
