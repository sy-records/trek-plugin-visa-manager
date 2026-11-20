'use strict';

const { errorMessage } = require('./i18n');

class InputError extends Error {
  constructor(key, params = {}, status = 400) {
    super(errorMessage({ key, params }, 'en'));
    this.key = key; this.params = params; this.status = status;
  }
}

function text(value, label, required = false, max = 160) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new InputError('errors.invalidFormat', { field: label });
  const result = value.trim();
  if (required && !result) throw new InputError('errors.required', { field: label });
  if (result.length > max) throw new InputError('errors.tooLong', { field: label, max });
  return result;
}

function integer(value, label, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1000000) throw new InputError('errors.invalidInteger', { field: label });
  return value;
}

function date(value, label, required = false) {
  if ((value == null || value === '') && !required) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2199-12-31') throw new InputError('errors.invalidDate', { field: label });
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new InputError('errors.invalidDate', { field: label });
  return value;
}

function id(value, label, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value)) throw new InputError('errors.invalidId', { field: label });
  return value;
}

const APPLICATION_STATUSES = ['submitted', 'reviewing', 'approved', 'refused', 'withdrawn'];

// Older versions stored a separate adjustment reason. Keep that text in Notes.
function normalizeRecord(record) {
  const { adjustmentReason, ...rest } = record;
  const notes = typeof record.notes === 'string' ? record.notes : '';
  const reason = typeof adjustmentReason === 'string' ? adjustmentReason.trim() : '';
  return { ...rest, notes: reason && !notes.includes(reason) ? [notes, reason].filter(Boolean).join('\n\n') : notes };
}

function validate(kind, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('errors.invalidRecord');
  const notes = text(body.notes, 'fields.notes', false, 5000);
  const legacyReason = text(body.adjustmentReason, 'fields.notes', false, 500);
  const common = { notes: text(normalizeRecord({ notes, adjustmentReason: legacyReason }).notes, 'fields.notes', false, 5000) };
  if (kind === 'applications') {
    if (!APPLICATION_STATUSES.includes(body.status)) throw new InputError('errors.applicationStatus');
    const submittedOn = date(body.submittedOn, 'fields.submittedOn', true);
    const decidedOn = date(body.decidedOn, 'fields.decidedOn');
    if (decidedOn && decidedOn < submittedOn) throw new InputError('errors.applicationDateOrder');
    return { ...common, passportId: id(body.passportId, 'fields.passportId'), destination: text(body.destination, 'fields.destination', true), type: text(body.type, 'fields.type', true), status: body.status, submittedOn, decidedOn, applicationLocation: text(body.applicationLocation, 'fields.applicationLocation', true) };
  }
  if (kind === 'passports') {
    const issuedOn = date(body.issuedOn, 'fields.issuedOn');
    const expiresOn = date(body.expiresOn, 'fields.passportExpiry', true);
    if (issuedOn && issuedOn > expiresOn) throw new InputError('errors.passportDateOrder');
    if (!['current', 'archived'].includes(body.status)) throw new InputError('errors.passportStatus');
    return { ...common, holder: text(body.holder, 'fields.holder', true), number: text(body.number, 'fields.number', true, 40).toUpperCase(), country: text(body.country, 'fields.country', true), issuedOn, expiresOn, status: body.status };
  }
  if (kind === 'visas') {
    const validFrom = date(body.validFrom, 'fields.validFrom', true);
    const validUntil = date(body.validUntil, 'fields.validUntil', true);
    if (validFrom > validUntil) throw new InputError('errors.visaDateOrder');
    return { ...common, passportId: id(body.passportId, 'fields.passportId'), destination: text(body.destination, 'fields.destination', true), type: text(body.type, 'fields.type', true), number: text(body.number, 'fields.visaNumber', false, 80), validFrom, validUntil, totalEntries: integer(body.totalEntries, 'fields.totalEntries', true), maxStayDays: integer(body.maxStayDays, 'fields.maxStayDays', true), remainingEntriesOverride: integer(body.remainingEntriesOverride, 'fields.remainingEntriesOverride', true), applicationId: id(body.applicationId, 'fields.applicationId', true) };
  }
  const entryDate = date(body.entryDate, 'fields.entryDate', true);
  const exitDate = date(body.exitDate, 'fields.exitDate');
  if (exitDate && exitDate < entryDate) throw new InputError('errors.stayDateOrder');
  const entryLocation = text(body.entryLocation ?? body.destination, 'fields.entryLocation', true);
  const exitLocation = text(body.exitLocation, 'fields.exitLocation');
  return { ...common, entryLocation, exitLocation, passportId: id(body.passportId, 'fields.travelPassport'), visaId: id(body.visaId, 'fields.visaId', true), destination: entryLocation, entryDate, exitDate, stayDaysOverride: integer(body.stayDaysOverride, 'fields.stayDaysOverride', true) };
}

// Calendar days, inclusive of entry and exit. UTC arithmetic avoids DST drift.
function staySummary(stay, today) {
  const end = stay.exitDate && stay.exitDate < today ? stay.exitDate : today;
  const calculatedDays = stay.entryDate > today ? 0 : Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${stay.entryDate}T00:00:00Z`)) / 86400000) + 1;
  return { ...stay, calculatedDays, effectiveDays: stay.stayDaysOverride ?? calculatedDays, phase: stay.entryDate > today ? 'planned' : stay.exitDate && stay.exitDate <= today ? 'completed' : 'ongoing' };
}

function summarize(data, today) {
  return {
    passports: data.passports,
    applications: data.applications ?? [],
    visas: data.visas.map(visa => {
      const usedEntries = data.stays.filter(stay => stay.visaId === visa.id && stay.entryDate <= today).length;
      const calculatedRemaining = visa.totalEntries === null ? null : Math.max(0, visa.totalEntries - usedEntries);
      return { ...visa, usedEntries, calculatedRemaining, effectiveRemaining: visa.remainingEntriesOverride ?? calculatedRemaining };
    }),
    stays: data.stays.map(stay => staySummary(stay, today)), today,
  };
}

module.exports = { InputError, id, date, validate, summarize, normalizeRecord, APPLICATION_STATUSES };
