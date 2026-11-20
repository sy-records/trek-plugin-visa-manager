'use strict';

const { randomUUID } = require('node:crypto');
const { InputError, id, date, validate, summarize, normalizeRecord } = require('./domain');
const { createTranslator, errorMessage } = require('./i18n');
const TABLES = { passports: 'passports', visas: 'visas', stays: 'stays', applications: 'applications' };
const schema = `
CREATE TABLE IF NOT EXISTS passports (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS visas (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, passport_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, passport_id) REFERENCES passports(user_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS stays (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, passport_id TEXT NOT NULL, visa_id TEXT, data TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, passport_id) REFERENCES passports(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, visa_id) REFERENCES visas(user_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS visas_passport ON visas(user_id, passport_id);
CREATE INDEX IF NOT EXISTS stays_passport ON stays(user_id, passport_id);
CREATE INDEX IF NOT EXISTS stays_visa ON stays(user_id, visa_id);
`;

const applicationSchema = `
CREATE TABLE IF NOT EXISTS applications (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, passport_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, passport_id) REFERENCES passports(user_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS applications_passport ON applications(user_id, passport_id);
CREATE UNIQUE INDEX IF NOT EXISTS visas_application ON visas(user_id, json_extract(data, '$.applicationId'))
  WHERE json_extract(data, '$.applicationId') IS NOT NULL;
`;

function json(body, status = 200) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
}

async function readData(userId, ctx) {
  const { results } = await ctx.db.tx(Object.values(TABLES).map(table => ({ sql: `SELECT id, data FROM ${table} WHERE user_id = ? ORDER BY rowid DESC`, args: [userId] })));
  return Object.fromEntries(Object.keys(TABLES).map((key, i) => [key, results[i].rows.map(row => (normalizeRecord({ ...JSON.parse(row.data), id: row.id })))]));
}

function route(method, path, handler) {
  return { method, path, auth: true, async handler(req, ctx) {
    const t = createTranslator(req.query?.lang);
    if (!Number.isSafeInteger(req.user?.id) || req.user.id <= 0) return json({ error: t('errors.login') }, 401);
    try { return await handler(req, ctx, req.user.id); }
    catch (error) {
      if (error instanceof InputError) return json({ error: errorMessage(error, req.query?.lang) }, error.status);
      // Do not expose SQL errors or personal document data in logs or responses.
      return json({ error: t('errors.storage') }, 500);
    }
  } };
}

async function save(kind, req, ctx, userId) {
  const record = validate(kind, req.body);
  const updating = req.body.id != null;
  const recordId = updating ? id(req.body.id, 'fields.recordId') : randomUUID();
  const references = [];
  const refArgs = [];
  if (kind !== 'passports') {
    references.push('EXISTS (SELECT 1 FROM passports WHERE user_id = ? AND id = ?)');
    refArgs.push(userId, record.passportId);
  }
  if (kind === 'stays' && record.visaId) {
    references.push('EXISTS (SELECT 1 FROM visas WHERE user_id = ? AND id = ?)');
    refArgs.push(userId, record.visaId);
  }
  if (kind === 'visas' && record.applicationId) {
    references.push("EXISTS (SELECT 1 FROM applications WHERE user_id = ? AND id = ? AND json_extract(data, '$.status') = 'approved' AND passport_id = ? AND json_extract(data, '$.destination') = ?)");
    refArgs.push(userId, record.applicationId, record.passportId, record.destination);
    references.push("NOT EXISTS (SELECT 1 FROM visas WHERE user_id = ? AND json_extract(data, '$.applicationId') = ? AND id != ?)");
    refArgs.push(userId, record.applicationId, recordId);
  }
  if (kind === 'applications') {
    references.push("NOT EXISTS (SELECT 1 FROM visas WHERE user_id = ? AND json_extract(data, '$.applicationId') = ? AND (? != 'approved' OR passport_id != ? OR json_extract(data, '$.destination') != ?))");
    refArgs.push(userId, recordId, record.status, record.passportId, record.destination);
  }
  const guard = references.length ? references.join(' AND ') : '1 = 1';
  const columns = ['data'];
  const values = [JSON.stringify(record)];
  if (kind !== 'passports') { columns.push('passport_id'); values.push(record.passportId); }
  if (kind === 'stays') { columns.push('visa_id'); values.push(record.visaId); }
  const result = updating
    ? await ctx.db.exec(`UPDATE ${TABLES[kind]} SET ${columns.map(col => `${col} = ?`).join(', ')} WHERE user_id = ? AND id = ? AND ${guard}`, ...values, userId, recordId, ...refArgs)
    : await ctx.db.exec(`INSERT INTO ${TABLES[kind]} (${columns.join(', ')}, user_id, id) SELECT ${columns.map(() => '?').join(', ')}, ?, ? WHERE ${guard}`, ...values, userId, recordId, ...refArgs);
  if (!result.changes) {
    if (kind === 'applications' && updating) {
      const existing = await ctx.db.query('SELECT id FROM applications WHERE user_id = ? AND id = ?', userId, recordId);
      if (existing.length) throw new InputError('errors.applicationLinked', {}, 409);
    }
    throw new InputError('errors.missingReference', {}, 404);
  }
  return json({ id: recordId }, updating ? 200 : 201);
}

async function remove(kind, req, ctx, userId) {
  const recordId = id(req.query?.id, 'fields.recordId');
  const conditions = [];
  const args = [userId, recordId];
  const dependents = kind === 'passports' ? [['visas', 'passport_id'], ['stays', 'passport_id'], ['applications', 'passport_id']] : kind === 'visas' ? [['stays', 'visa_id']] : [];
  for (const [table, column] of dependents) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND ${column} = ?)`);
    args.push(userId, recordId);
  }
  if (kind === 'applications') {
    conditions.push("NOT EXISTS (SELECT 1 FROM visas WHERE user_id = ? AND json_extract(data, '$.applicationId') = ?)");
    args.push(userId, recordId);
  }
  const result = await ctx.db.exec(`DELETE FROM ${TABLES[kind]} WHERE user_id = ? AND id = ?${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}`, ...args);
  if (!result.changes) {
    const rows = await ctx.db.query(`SELECT id FROM ${TABLES[kind]} WHERE user_id = ? AND id = ?`, userId, recordId);
    if (rows.length) throw new InputError('errors.linkedRecords', {}, 409);
    throw new InputError('errors.notFound', {}, 404);
  }
  return json({ deleted: true });
}

module.exports = {
  async onLoad(ctx) {
    await ctx.db.migrate('001_personal_documents', schema);
    await ctx.db.migrate('002_visa_applications', applicationSchema);
  },
  routes: [
    route('GET', '/records', async (req, ctx, userId) => {
      // The client supplies its local calendar date. It affects display calculations only.
      const today = date(req.query?.today ?? new Date().toISOString().slice(0, 10), 'fields.today', true);
      return json(summarize(await readData(userId, ctx), today));
    }),
    ...Object.keys(TABLES).flatMap(kind => [
      route('POST', `/${kind}/save`, (req, ctx, userId) => save(kind, req, ctx, userId)),
      route('DELETE', `/${kind}`, (req, ctx, userId) => remove(kind, req, ctx, userId)),
    ]),
  ],
  async exportUserData({ userId }, ctx) { return readData(userId, ctx); },
  async deleteUserData({ userId }, ctx) {
    await ctx.db.tx(['stays', 'visas', 'applications', 'passports'].map(table => ({ sql: `DELETE FROM ${table} WHERE user_id = ?`, args: [userId] })));
  },
};
