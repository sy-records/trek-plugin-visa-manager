'use strict';

const { errorMessage } = require('./i18n');
const { REGION_CODES } = require('./regions');

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
const PERMIT_DESTINATIONS = ['hongKong', 'macao'];
const PERMIT_PORTS = {
  hongKong: ['luohu', 'futian', 'huanggang', 'shenzhenBay', 'liantang', 'westKowloon', 'hongKongAirport', 'hzmbHongKong', 'shekouFerry'],
  macao: ['gongbei', 'hengqin', 'qingmao', 'hzmbMacao', 'macaoAirport', 'outerHarbourFerry', 'taipaFerry'],
};
const ENDORSEMENT_TYPES = ['personalTravel', 'groupTravel', 'familyVisit', 'business', 'stay', 'other'];

// Older versions stored a separate adjustment reason. Keep that text in Notes.
function normalizeRecord(record) {
  const { adjustmentReason, ...rest } = record;
  const notes = typeof record.notes === 'string' ? record.notes : '';
  const reason = typeof adjustmentReason === 'string' ? adjustmentReason.trim() : '';
  return { ...rest, notes: reason && !notes.includes(reason) ? [notes, reason].filter(Boolean).join('\n\n') : notes };
}

function region(value, field) {
  const code = text(value ?? '', field, true).toUpperCase();
  if (!REGION_CODES.includes(code)) throw new InputError('errors.invalidRegion', { field });
  return code;
}

function validateCrossing(body, common) {
  const departureCountry = region(body.departureCountry, 'fields.departureCountry');
  const arrivalCountry = region(body.arrivalCountry, 'fields.arrivalCountry');
  if (departureCountry === arrivalCountry) throw new InputError('errors.sameCrossingCountry');
  const crossingDate = date(body.crossingDate, 'fields.crossingDate', true);
  const passportId = id(body.passportId, 'fields.travelPassport');
  const crossing = {
    ...common,
    departureCountry,
    arrivalCountry,
    crossingDate,
    departurePlace: text(body.departurePlace, 'fields.departurePlace'),
    arrivalPlace: text(body.arrivalPlace, 'fields.arrivalPlace'),
    passportId,
    visaId: id(body.visaId, 'fields.visaId', true),
  };

  const returnDate = date(body.returnDate, 'fields.returnDate');
  if (!returnDate) return crossing;
  if (body.id != null) throw new InputError('errors.invalidRecord');
  if (returnDate < crossingDate) throw new InputError('errors.returnDateOrder');
  return {
    ...crossing,
    returnCrossing: {
      departureCountry: arrivalCountry,
      arrivalCountry: departureCountry,
      crossingDate: returnDate,
      departurePlace: text(body.returnDeparturePlace, 'fields.departurePlace'),
      arrivalPlace: text(body.returnArrivalPlace, 'fields.arrivalPlace'),
      passportId,
      visaId: null,
      notes: '',
    },
  };
}

function validate(kind, body, { legacyStay = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('errors.invalidRecord');
  const notes = text(body.notes, 'fields.notes', false, 5000);
  const legacyReason = text(body.adjustmentReason, 'fields.notes', false, 500);
  const common = { notes: text(normalizeRecord({ notes, adjustmentReason: legacyReason }).notes, 'fields.notes', false, 5000) };
  if (kind === 'permits') {
    const issuedOn = date(body.issuedOn, 'fields.issuedOn');
    const expiresOn = date(body.expiresOn, 'fields.permitExpiry', true);
    if (issuedOn && issuedOn > expiresOn) throw new InputError('errors.permitDateOrder');
    if (!['current', 'archived'].includes(body.status)) throw new InputError('errors.passportStatus');
    const rawEndorsements = body.endorsements;
    if (!rawEndorsements || typeof rawEndorsements !== 'object' || Array.isArray(rawEndorsements)) throw new InputError('errors.invalidRecord');
    const endorsements = {};
    for (const destination of PERMIT_DESTINATIONS) {
      const raw = rawEndorsements[destination];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        endorsements[destination] = null;
        continue;
      }
      const hasValues = Object.values(raw).some(value => value != null && value !== '');
      if (!hasValues) {
        endorsements[destination] = null;
        continue;
      }
      const endorsementType = raw.type === 'tourism' ? 'personalTravel' : raw.type;
      if (!ENDORSEMENT_TYPES.includes(endorsementType)) throw new InputError('errors.endorsementType');
      const validFrom = date(raw.validFrom, 'fields.validFrom', true);
      const validUntil = date(raw.validUntil, 'fields.validUntil', true);
      if (validFrom > validUntil) throw new InputError('errors.visaDateOrder');
      const totalEntries = integer(raw.totalEntries, 'fields.totalEntries', true);
      if (totalEntries !== null && totalEntries < 1) throw new InputError('errors.invalidInteger', { field: 'fields.totalEntries' });
      endorsements[destination] = {
        type: endorsementType,
        validFrom,
        validUntil,
        totalEntries,
      };
    }
    return {
      ...common,
      holder: text(body.holder, 'fields.holder', true),
      number: text(body.number, 'fields.permitNumber', true, 40).toUpperCase(),
      issuedOn,
      expiresOn,
      status: body.status,
      endorsements,
    };
  }
  if (kind === 'permitStays') {
    const destination = text(body.destination, 'fields.destination', true, 20);
    if (!PERMIT_DESTINATIONS.includes(destination)) throw new InputError('errors.permitDestination');
    const entryDate = date(body.entryDate, 'fields.entryDate', true);
    const exitDate = date(body.exitDate, 'fields.exitDate');
    if (exitDate && exitDate < entryDate) throw new InputError('errors.stayDateOrder');
    const port = (value, otherValue, label, required) => {
      if ((value == null || value === '') && !required) return { code: null, other: '' };
      const code = text(value, label, required, 40);
      if (code === 'other') return { code, other: text(otherValue, 'fields.otherPort', true, 120) };
      if (!PERMIT_PORTS[destination].includes(code)) throw new InputError('errors.invalidPort', { field: label });
      return { code, other: '' };
    };
    const entryPort = port(body.entryPort, body.entryPortOther, 'fields.entryPort', true);
    const exitPort = port(body.exitPort, body.exitPortOther, 'fields.exitPort', !!exitDate);
    if (!exitDate && (body.exitPort || body.exitPortOther)) throw new InputError('errors.exitPortWithoutDate');
    return {
      ...common,
      permitId: id(body.permitId, 'fields.permitId'),
      destination,
      entryDate,
      exitDate,
      entryPort: entryPort.code,
      entryPortOther: entryPort.other,
      exitPort: exitPort.code,
      exitPortOther: exitPort.other,
    };
  }
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
  if (!legacyStay) return validateCrossing(body, common);
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
      const usedEntries = data.stays.filter(stay => stay.visaId === visa.id && (stay.crossingDate ?? stay.entryDate) <= today).length;
      const calculatedRemaining = visa.totalEntries === null ? null : Math.max(0, visa.totalEntries - usedEntries);
      return { ...visa, usedEntries, calculatedRemaining, effectiveRemaining: visa.remainingEntriesOverride ?? calculatedRemaining };
    }),
    stays: data.stays.map(stay => stay.crossingDate
      ? { ...stay, phase: stay.crossingDate > today ? 'planned' : 'crossed' }
      : staySummary(stay, today)),
    today,
  };
}

function permitStaySummary(stay, today) {
  const phase = stay.entryDate > today ? 'planned' : stay.exitDate && stay.exitDate <= today ? 'completed' : 'ongoing';
  return { ...stay, phase };
}

function summarizePermits(data, today) {
  const permitStays = (data.permitStays ?? []).map(stay => permitStaySummary(stay, today));
  const permits = (data.permits ?? []).map(permit => {
    const endorsements = {};
    for (const destination of PERMIT_DESTINATIONS) {
      const endorsement = permit.endorsements?.[destination];
      if (!endorsement) {
        endorsements[destination] = null;
        continue;
      }
      const usedEntries = permitStays.filter(stay =>
        stay.permitId === permit.id &&
        stay.destination === destination &&
        (stay.endorsementId === endorsement.id || stay.endorsementId == null) &&
        stay.entryDate >= endorsement.validFrom &&
        stay.entryDate <= endorsement.validUntil &&
        stay.entryDate <= today
      ).length;
      endorsements[destination] = {
        ...endorsement,
        type: endorsement.type === 'tourism' ? 'personalTravel' : endorsement.type,
        usedEntries,
        remainingEntries: endorsement.totalEntries === null ? null : Math.max(0, endorsement.totalEntries - usedEntries),
      };
    }
    return { ...permit, endorsements };
  });
  return { permits, permitStays };
}

module.exports = { InputError, id, date, validate, summarize, summarizePermits, normalizeRecord, APPLICATION_STATUSES, PERMIT_DESTINATIONS, PERMIT_PORTS, ENDORSEMENT_TYPES };
