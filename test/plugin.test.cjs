'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const plugin = require('../server');
const { summarize } = require('../server/domain');

async function setup(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  t.after(() => db.close());
  const ctx = { db: {
    async migrate(_id, sql) { db.exec(sql); },
    async exec(sql, ...args) { return db.prepare(sql).run(...args); },
    async query(sql, ...args) { return db.prepare(sql).all(...args); },
    async tx(ops) {
      db.exec('BEGIN');
      try {
        const results = ops.map(({ sql, args = [] }) => sql.startsWith('SELECT') ? { rows: db.prepare(sql).all(...args) } : db.prepare(sql).run(...args));
        db.exec('COMMIT'); return { results };
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } };
  await plugin.onLoad(ctx);
  async function call(method, path, body = undefined, userId = 1, query = {}) {
    const route = plugin.routes.find(route => route.method === method && route.path === path);
    assert.ok(route, `${method} ${path}`);
    const result = await route.handler({ user: userId === null ? null : { id: userId }, body, query }, ctx);
    assert.equal(result.headers['cache-control'], 'no-store');
    return { status: result.status, body: JSON.parse(result.body) };
  }
  async function add(kind, body, userId = 1) {
    const result = await call('POST', `/${kind}/save`, body, userId);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body.id;
  }
  return { ctx, call, add };
}
const passport = { holder: '本人', number: 'E12345678', country: '中国', issuedOn: '2018-01-01', expiresOn: '2028-01-01', status: 'current' };
const visa = { destination: '日本', type: '旅游', validFrom: '2026-01-01', validUntil: '2029-01-01', totalEntries: 2 };
const stay = { destination: '日本', entryDate: '2026-11-01', exitDate: '2026-11-04' };

test('initialization can repeat without losing existing personal records', async t => {
  const { ctx, call, add } = await setup(t);
  await add('passports', passport);
  await plugin.onLoad(ctx);
  assert.equal((await call('GET', '/records')).body.passports.length, 1);
});

test('new passport can travel with a visa in an archived passport; CRUD persists manual values', async t => {
  const { call, add } = await setup(t);
  const oldId = await add('passports', { ...passport, status: 'archived' });
  const newId = await add('passports', { ...passport, number: 'NEW123' });
  const visaId = await add('visas', { ...visa, passportId: oldId });
  const stayId = await add('stays', { ...stay, passportId: newId, visaId, stayDaysOverride: 3, adjustmentReason: '以盖章记录为准' });
  let response = await call('GET', '/records', undefined, 1, { today: '2026-11-20' });
  assert.equal(response.body.visas[0].passportId, oldId);
  assert.equal(response.body.stays[0].passportId, newId);
  assert.equal(response.body.stays[0].calculatedDays, 4);
  assert.equal(response.body.stays[0].effectiveDays, 3);
  assert.equal(response.body.visas[0].effectiveRemaining, 1);
  assert.equal((await call('POST', '/visas/save', { ...visa, id: visaId, passportId: oldId, remainingEntriesOverride: 0 })).status, 200);
  response = await call('GET', '/records');
  assert.equal(response.body.visas[0].effectiveRemaining, 0);
  assert.equal((await call('DELETE', '/passports', undefined, 1, { id: oldId })).status, 409);
  assert.equal((await call('DELETE', '/passports', undefined, 1, { id: newId })).status, 409);
  assert.equal((await call('DELETE', '/visas', undefined, 1, { id: visaId })).status, 409);
  assert.equal((await call('DELETE', '/stays', undefined, 1, { id: stayId })).status, 200);
  assert.equal((await call('DELETE', '/visas', undefined, 1, { id: visaId })).status, 200);
  assert.equal((await call('DELETE', '/passports', undefined, 1, { id: oldId })).status, 200);
});

test('authentication and ownership gate every CRUD action and document reference', async t => {
  const { call, add } = await setup(t);
  const p1 = await add('passports', passport);
  const p2 = await add('passports', passport, 2);
  const v1 = await add('visas', { ...visa, passportId: p1 });
  const s1 = await add('stays', { ...stay, passportId: p1, visaId: v1 });
  for (const route of plugin.routes) assert.equal((await call(route.method, route.path, {}, null)).status, 401);
  assert.deepEqual((await call('GET', '/records', undefined, 2)).body.visas, []);
  assert.deepEqual((await call('GET', '/records', undefined, 2)).body.stays, []);
  for (const [kind, recordId, input] of [['passports', p1, passport], ['visas', v1, { ...visa, passportId: p2 }], ['stays', s1, { ...stay, passportId: p2 }]]) {
    assert.equal((await call('POST', `/${kind}/save`, { ...input, id: recordId }, 2)).status, 404);
    assert.equal((await call('DELETE', `/${kind}`, undefined, 2, { id: recordId })).status, 404);
  }
  assert.equal((await call('POST', '/visas/save', { ...visa, passportId: p1 }, 2)).status, 404);
  assert.equal((await call('POST', '/stays/save', { ...stay, passportId: p1 }, 2)).status, 404);
  assert.equal((await call('POST', '/stays/save', { ...stay, passportId: p2, visaId: v1 }, 2)).status, 404);
  // A forged owner in the body has no effect.
  await add('passports', { ...passport, user_id: 1 }, 2);
  assert.equal((await call('GET', '/records')).body.passports.length, 1);
});

test('rejects malformed dates, inverted ranges, missing fields, invalid numbers and SQL ids', async t => {
  const { call, add } = await setup(t);
  const p = await add('passports', passport);
  for (const patch of [{ expiresOn: '2026-02-30' }, { expiresOn: '2017-01-01' }, { number: '' }, { status: 'invalid' }, { holder: 123 }, { notes: 123 }, { notes: 'x'.repeat(5001) }]) {
    assert.equal((await call('POST', '/passports/save', { ...passport, ...patch })).status, 400);
  }
  for (const patch of [{ totalEntries: -1 }, { totalEntries: '2' }, { totalEntries: 1.2 }, { remainingEntriesOverride: -2 }, { maxStayDays: 1000001 }, { validUntil: '2025-01-01' }]) {
    assert.equal((await call('POST', '/visas/save', { ...visa, passportId: p, ...patch })).status, 400);
  }
  assert.equal((await call('POST', '/stays/save', { ...stay, passportId: p, exitDate: '2026-10-31' })).status, 400);
  assert.equal((await call('DELETE', '/passports', undefined, 1, { id: "' OR 1=1 --" })).status, 400);
  assert.equal((await call('GET', '/records', undefined, 1, { today: '2026-02-30' })).status, 400);
});

test('calendar days include both endpoints, survive DST, support missing exit and manual zero', () => {
  const result = summarize({ passports: [], visas: [{ id: 'v', totalEntries: 1, remainingEntriesOverride: null }, { id: 'unlimited', totalEntries: null, remainingEntriesOverride: null }], stays: [
    { id: 'a', visaId: 'v', entryDate: '2026-03-07', exitDate: '2026-03-09' },
    { id: 'b', visaId: 'v', entryDate: '2026-11-20', exitDate: null, stayDaysOverride: 0 },
    { id: 'c', visaId: 'v', entryDate: '2026-12-01', exitDate: null },
    { id: 'd', entryDate: '2026-11-19', exitDate: '2026-12-01' },
  ] }, '2026-11-20');
  assert.equal(result.stays[0].effectiveDays, 3);
  assert.equal(result.stays[1].calculatedDays, 1);
  assert.equal(result.stays[1].effectiveDays, 0);
  assert.equal(result.stays[1].phase, 'ongoing');
  assert.equal(result.stays[2].effectiveDays, 0);
  assert.equal(result.stays[2].phase, 'planned');
  assert.equal(result.stays[3].effectiveDays, 2);
  assert.equal(result.visas[0].usedEntries, 2);
  assert.equal(result.visas[0].calculatedRemaining, 0);
  assert.equal(result.visas[1].effectiveRemaining, null);
});

test('clearing overrides restores calculated results, including unlimited entries and visa-free stays', async t => {
  const { call, add } = await setup(t);
  const p = await add('passports', passport);
  const v = await add('visas', { ...visa, passportId: p, totalEntries: null, remainingEntriesOverride: 0 });
  assert.equal((await call('POST', '/visas/save', { ...visa, id: v, passportId: p, totalEntries: null, remainingEntriesOverride: null })).status, 200);
  const s = await add('stays', { ...stay, passportId: p, stayDaysOverride: 0 });
  assert.equal((await call('POST', '/stays/save', { ...stay, id: s, passportId: p, stayDaysOverride: null })).status, 200);
  const response = await call('GET', '/records', undefined, 1, { today: '2026-11-20' });
  assert.equal(response.body.visas[0].effectiveRemaining, null);
  assert.equal(response.body.stays[0].effectiveDays, 4);
  assert.equal(response.body.stays[0].visaId, null);
});

test('user export and idempotent account erasure cover only that user', async t => {
  const { ctx, call, add } = await setup(t);
  const p1 = await add('passports', passport);
  await add('passports', passport, 2);
  const v = await add('visas', { ...visa, passportId: p1 });
  await add('stays', { ...stay, passportId: p1, visaId: v });
  await add('applications', { passportId: p1, destination: 'Japan', type: 'Tourist', status: 'refused', submittedOn: '2026-01-01', applicationLocation: 'Online' });
  const exported = await plugin.exportUserData({ userId: 1 }, ctx);
  assert.equal(exported.passports.length, 1);
  assert.equal(exported.visas.length, 1);
  assert.equal(exported.stays.length, 1);
  assert.equal(exported.applications.length, 1);
  await plugin.deleteUserData({ userId: 1 }, ctx);
  await plugin.deleteUserData({ userId: 1 }, ctx);
  const response = await call('GET', '/records');
  assert.deepEqual(response.body.passports, []);
  assert.deepEqual(response.body.visas, []);
  assert.deepEqual(response.body.stays, []);
  assert.deepEqual(response.body.applications, []);
  assert.equal((await call('GET', '/records', undefined, 2)).body.passports.length, 1);
});

test('API validation errors follow the requested language and default to English', async t => {
  const { call, add } = await setup(t);
  const invalid = { ...passport, expiresOn: '2017-01-01' };
  assert.equal((await call('POST', '/passports/save', invalid)).body.error, 'Passport expiry must not precede its issue date');
  assert.equal((await call('POST', '/passports/save', invalid, 1, { lang: 'zh-CN' })).body.error, '护照到期日期不能早于签发日期');
  assert.equal((await call('POST', '/passports/save', invalid, 1, { lang: 'fr-FR' })).body.error, 'Passport expiry must not precede its issue date');
  assert.equal((await call('POST', '/passports/save', { ...passport, number: '' })).body.error, 'Passport number is required');
  assert.equal((await call('POST', '/passports/save', { ...passport, number: '' }, 1, { lang: 'zh-CN' })).body.error, '护照号码不能为空');
  assert.equal((await call('GET', '/records', undefined, null, { lang: 'zh-CN' })).body.error, '请先登录 TREK');
  const p = await add('passports', passport);
  await add('visas', { ...visa, passportId: p });
  assert.match((await call('DELETE', '/passports', undefined, 1, { id: p })).body.error, /still has linked records/);
  assert.match((await call('DELETE', '/passports', undefined, 1, { id: p, lang: 'zh-CN' })).body.error, /仍有关联记录/);
});

test('storage errors are localized without disclosing database details', async t => {
  const { ctx, call } = await setup(t);
  ctx.db.tx = async () => { throw new Error('sensitive database path'); };
  assert.equal((await call('GET', '/records')).body.error, 'Unable to save or load records. Please try again later.');
  assert.equal((await call('GET', '/records', undefined, 1, { lang: 'zh-CN' })).body.error, '保存或读取失败，请稍后重试');
});

const application = { destination: '日本', type: '旅游', status: 'submitted', submittedOn: '2026-01-01', applicationLocation: '上海签证中心', notes: '申请备注' };

test('multiple application attempts keep their outcomes and remain private', async t => {
  const { call, add } = await setup(t);
  const p1 = await add('passports', passport);
  const p2 = await add('passports', passport, 2);
  for (const status of ['submitted', 'reviewing', 'approved', 'refused', 'withdrawn']) await add('applications', { ...application, passportId: p1, status });
  const response = await call('GET', '/records');
  assert.equal(response.body.applications.length, 5);
  assert.equal(response.body.visas.length, 0, 'an outcome alone must not invent a usable visa');
  assert.deepEqual((await call('GET', '/records', undefined, 2)).body.applications, []);
  const first = response.body.applications[0];
  assert.equal((await call('POST', '/applications/save', { ...application, id: first.id, passportId: p2 }, 2)).status, 404);
  assert.equal((await call('DELETE', '/applications', undefined, 2, { id: first.id })).status, 404);
  assert.equal((await call('POST', '/applications/save', { ...application, passportId: p1 }, 2)).status, 404);
  assert.equal((await call('POST', '/applications/save', { ...application, passportId: p1, status: 'draft' })).status, 400);
  assert.equal((await call('POST', '/applications/save', { ...application, passportId: p1, decidedOn: '2025-12-31' })).status, 400);
  assert.equal((await call('DELETE', '/passports', undefined, 1, { id: p1 })).status, 409);
});

test('only approved applications can create a linked visa, once and for the same owner/passport/country', async t => {
  const { call, add } = await setup(t);
  const p1 = await add('passports', passport);
  const p2 = await add('passports', { ...passport, number: 'OTHER' });
  const foreignPassport = await add('passports', passport, 2);
  for (const status of ['submitted', 'reviewing', 'refused', 'withdrawn']) {
    const appId = await add('applications', { ...application, passportId: p1, status });
    assert.equal((await call('POST', '/visas/save', { ...visa, passportId: p1, applicationId: appId })).status, 404);
  }
  const appId = await add('applications', { ...application, passportId: p1, status: 'approved' });
  for (const input of [{ ...visa, passportId: p2 }, { ...visa, passportId: p1, destination: 'Canada' }]) {
    assert.equal((await call('POST', '/visas/save', { ...input, applicationId: appId })).status, 404);
  }
  assert.equal((await call('POST', '/visas/save', { ...visa, passportId: foreignPassport, applicationId: appId }, 2)).status, 404);
  const attempts = await Promise.all([1, 2].map(() => call('POST', '/visas/save', { ...visa, passportId: p1, applicationId: appId })));
  assert.deepEqual(attempts.map(result => result.status).sort(), [201, 404]);
  assert.equal((await call('GET', '/records')).body.visas.length, 1);
  for (const change of [{ status: 'refused' }, { passportId: p2 }, { destination: 'Canada' }]) {
    assert.equal((await call('POST', '/applications/save', { ...application, id: appId, passportId: p1, status: 'approved', ...change })).status, 409);
  }
  assert.equal((await call('DELETE', '/applications', undefined, 1, { id: appId })).status, 409);
  const visaId = attempts.find(result => result.status === 201).body.id;
  assert.equal((await call('POST', '/visas/save', { ...visa, id: visaId, passportId: p1, applicationId: null })).status, 200);
  assert.equal((await call('POST', '/applications/save', { ...application, id: appId, passportId: p1, status: 'refused' })).status, 200);
});

test('entry and departure locations accept different countries and legacy destinations still open', async t => {
  const { call, add } = await setup(t);
  const p = await add('passports', passport);
  const id = await add('stays', { passportId: p, entryDate: '2026-11-01', exitDate: '2026-11-04', entryLocation: 'Paris, France', exitLocation: 'Brussels, Belgium' });
  const response = await call('GET', '/records');
  assert.equal(response.body.stays[0].entryLocation, 'Paris, France');
  assert.equal(response.body.stays[0].exitLocation, 'Brussels, Belgium');
  assert.equal((await call('POST', '/stays/save', { ...stay, id, passportId: p })).status, 200);
  assert.equal((await call('GET', '/records')).body.stays[0].entryLocation, '日本');
});

test('legacy adjustment reasons are retained in Notes and survive editing', async t => {
  const { ctx, call, add } = await setup(t);
  const p = await add('passports', passport);
  await ctx.db.exec('INSERT INTO visas (user_id, id, passport_id, data) VALUES (?, ?, ?, ?)', 1, 'legacy-visa', p, JSON.stringify({ ...visa, passportId: p, notes: 'Original note', adjustmentReason: 'Old adjustment', remainingEntriesOverride: null, maxStayDays: null }));
  const record = (await call('GET', '/records')).body.visas[0];
  assert.equal(record.notes, 'Original note\n\nOld adjustment');
  assert.equal('adjustmentReason' in record, false);
  assert.equal((await call('POST', '/visas/save', record)).status, 200);
  assert.equal((await call('GET', '/records')).body.visas[0].notes, 'Original note\n\nOld adjustment');
});
