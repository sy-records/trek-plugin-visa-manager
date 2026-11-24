'use strict';

const { randomUUID } = require('node:crypto');
const { InputError, id, date, validate, summarize, summarizePermits, normalizeRecord, PERMIT_DESTINATIONS } = require('./domain');
const { createTranslator, errorMessage } = require('./i18n');
const TABLES = { passports: 'passports', visas: 'visas', stays: 'stays', applications: 'applications', permits: 'permits', permitStays: 'permit_stays' };
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

const permitSchema = `
CREATE TABLE IF NOT EXISTS permits (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS permit_stays (
  user_id INTEGER NOT NULL, id TEXT NOT NULL, permit_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, permit_id) REFERENCES permits(user_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS permit_stays_permit ON permit_stays(user_id, permit_id);
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
    try {
      if ((path.startsWith('/permits') || path.startsWith('/permit-stays')) && ctx.config?.hong_kong_macau_enabled !== true) {
        throw new InputError('errors.featureDisabled', {}, 403);
      }
      return await handler(req, ctx, req.user.id);
    }
    catch (error) {
      if (error instanceof InputError) return json({ error: errorMessage(error, req.query?.lang) }, error.status);
      // Do not expose SQL errors or personal document data in logs or responses.
      return json({ error: t('errors.storage') }, 500);
    }
  } };
}

async function save(kind, req, ctx, userId) {
  let record = validate(kind, req.body);
  const updating = req.body.id != null;
  const recordId = updating ? id(req.body.id, 'fields.recordId') : randomUUID();
  if (kind === 'permits') {
    const rows = updating ? await ctx.db.query('SELECT data FROM permits WHERE user_id = ? AND id = ?', userId, recordId) : [];
    const previous = rows[0] ? JSON.parse(rows[0].data) : null;
    record.endorsements = Object.fromEntries(PERMIT_DESTINATIONS.map(destination => {
      const current = record.endorsements[destination];
      if (!current) return [destination, null];
      const old = previous?.endorsements?.[destination];
      const sameEndorsement = old && old.type === current.type && old.validFrom === current.validFrom && old.validUntil === current.validUntil && old.totalEntries === current.totalEntries;
      return [destination, { ...current, id: sameEndorsement ? old.id : randomUUID() }];
    }));
  }
  if (kind === 'permitStays') {
    const permitRows = await ctx.db.query('SELECT data FROM permits WHERE user_id = ? AND id = ?', userId, record.permitId);
    if (!permitRows.length) throw new InputError('errors.missingReference', {}, 404);
    const permit = JSON.parse(permitRows[0].data);
    const currentEndorsement = permit.endorsements?.[record.destination];
    const rows = updating ? await ctx.db.query('SELECT data FROM permit_stays WHERE user_id = ? AND id = ?', userId, recordId) : [];
    const previous = rows[0] ? JSON.parse(rows[0].data) : null;
    const sameLink = previous?.permitId === record.permitId && previous?.destination === record.destination;
    const keepLink = sameLink && previous.endorsementId && currentEndorsement?.id === previous.endorsementId;
    const withinValidity = currentEndorsement && record.entryDate >= currentEndorsement.validFrom && record.entryDate <= currentEndorsement.validUntil;
    record.endorsementId = keepLink ? previous.endorsementId : withinValidity ? currentEndorsement.id : null;
  }
  const references = [];
  const refArgs = [];
  if (['visas', 'stays', 'applications'].includes(kind)) {
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
  if (kind === 'permitStays') {
    references.push('EXISTS (SELECT 1 FROM permits WHERE user_id = ? AND id = ?)');
    refArgs.push(userId, record.permitId);
  }
  const guard = references.length ? references.join(' AND ') : '1 = 1';
  const columns = ['data'];
  const values = [JSON.stringify(record)];
  if (['visas', 'stays', 'applications'].includes(kind)) { columns.push('passport_id'); values.push(record.passportId); }
  if (kind === 'stays') { columns.push('visa_id'); values.push(record.visaId); }
  if (kind === 'permitStays') { columns.push('permit_id'); values.push(record.permitId); }
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
  const dependents = kind === 'passports' ? [['visas', 'passport_id'], ['stays', 'passport_id'], ['applications', 'passport_id']] : kind === 'visas' ? [['stays', 'visa_id']] : kind === 'permits' ? [['permit_stays', 'permit_id']] : [];
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
    await ctx.db.migrate('003_hong_kong_macao_permits', permitSchema);
  },
  routes: [
    route('GET', '/records', async (req, ctx, userId) => {
      // The client supplies its local calendar date. It affects display calculations only.
      const today = date(req.query?.today ?? new Date().toISOString().slice(0, 10), 'fields.today', true);
      const data = await readData(userId, ctx);
      const enabled = ctx.config?.hong_kong_macau_enabled === true;
      return json({
        ...summarize(data, today),
        hongKongMacaoEnabled: enabled,
        ...(enabled ? summarizePermits(data, today) : { permits: [], permitStays: [] }),
      });
    }),
    ...Object.keys(TABLES).flatMap(kind => [
      route('POST', `/${kind === 'permitStays' ? 'permit-stays' : kind}/save`, (req, ctx, userId) => save(kind, req, ctx, userId)),
      route('DELETE', `/${kind === 'permitStays' ? 'permit-stays' : kind}`, (req, ctx, userId) => remove(kind, req, ctx, userId)),
    ]),
  ],
  async exportUserData({ userId }, ctx) { return readData(userId, ctx); },
  async deleteUserData({ userId }, ctx) {
    await ctx.db.tx(['permit_stays', 'permits', 'stays', 'visas', 'applications', 'passports'].map(table => ({ sql: `DELETE FROM ${table} WHERE user_id = ?`, args: [userId] })));
  },
};
