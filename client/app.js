'use strict';

const $ = id => document.getElementById(id);
const { createTranslator, resolveLanguage } = window.visaI18n;
const PERMIT_PORTS = {
  hongKong: ['luohu', 'futian', 'huanggang', 'shenzhenBay', 'liantang', 'westKowloon', 'hongKongAirport', 'hzmbHongKong', 'shekouFerry'],
  macao: ['gongbei', 'hengqin', 'qingmao', 'hzmbMacao', 'macaoAirport', 'outerHarbourFerry', 'taipaFerry'],
};
let language = 'en';
let t = createTranslator(language);
let data = null;
let kind = 'passports';
let editing = null;
let busy = false;
let loading = true;
let regionNames = new Intl.DisplayNames([language], { type: 'region' });
let loadVersion = 0;
let loadFailure = null;
let initialized = false;
let editorLanguage = null;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, variant = 'secondary') {
  const node = el('button', text, `trek-btn trek-btn--${variant}`);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
async function invoke(path, options) {
  const sub = `${path}${path.includes('?') ? '&' : '?'}lang=${encodeURIComponent(language)}`;
  let result;
  try { result = await trek.invoke(sub, options); }
  catch (error) {
    // The host bridge forwards HTTP status, but may omit a plugin's error body.
    const keys = { 400: 'errors.invalidRecord', 401: 'errors.login', 404: 'errors.missingReference', 409: 'errors.linkedRecords', 500: 'errors.storage' };
    throw new Error(t(keys[error.code] ?? 'errors.request'));
  }
  if (result && typeof result.error === 'string') throw new Error(result.error);
  return result;
}
function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function errorAt(target, message = '', retry = false) {
  $(target).textContent = message;
  $(target).hidden = !message;
  if (target === 'error') {
    $('retry').hidden = !retry;
    if (!retry) loadFailure = null;
  }
}
function masked(value) { return !value ? t('values.notProvided') : $('reveal').checked ? value : `•••• ${value.slice(-4)}`; }
function passportLabel(passport) { return passport ? `${passport.country} · ${masked(passport.number)}${passport.status === 'archived' ? t('values.archivedSuffix') : ''}` : t('values.notLinked'); }
function visaLabel(visa) { return visa ? `${visa.destination} · ${visa.type} · ${visa.validUntil}` : t('values.noVisa'); }
function detail(list, label, value, wide = false) {
  const group = el('div', null, wide ? 'detail-wide' : '');
  group.append(el('dt', label), el('dd', value ?? t('values.notProvided')));
  list.append(group);
}
function chip(text, tone = 'accent') { return el('span', text, `trek-chip trek-chip--${tone}`); }
function validity(from, until) { return until < data.today ? [t('status.expired'), 'danger'] : from && from > data.today ? [t('status.notYetValid'), 'info'] : [t('status.valid'), 'success']; }

async function load() {
  const version = ++loadVersion;
  loading = true;
  $('add').disabled = true;
  $('retry').disabled = true;
  $('records').setAttribute('aria-busy', 'true');
  errorAt('error');
  renderNotice();
  try {
    const result = await invoke(`/records?today=${localDate()}`);
    if (version !== loadVersion) return;
    data = result;
    data.applications ??= [];
    data.permits ??= [];
    data.permitStays ??= [];
    $('tab-permits').hidden = !data.hongKongMacaoEnabled;
    $('tab-permitStays').hidden = !data.hongKongMacaoEnabled;
    if (!data.hongKongMacaoEnabled && ['permits', 'permitStays'].includes(kind)) kind = 'passports';
    loading = false;
    render();
  } catch (error) {
    if (version !== loadVersion) return;
    loadFailure = error;
    errorAt('error', t('messages.loadFailed', { message: error.message }), true);
  } finally {
    if (version === loadVersion) {
      loading = false;
      $('add').disabled = !data;
      $('retry').disabled = false;
      renderNotice();
      $('records').setAttribute('aria-busy', 'false');
    }
  }
}

function renderNotice() {
  $('notice').textContent = t(loading
    ? (initialized ? 'page.loading' : 'page.connecting')
    : (data ? `notices.${kind}` : 'page.notLoaded'));
}

function render() {
  $('add').disabled = loading;
  $('add').textContent = t('actions.add');
  const validVisas = data.visas.filter(v => v.validFrom <= data.today && v.validUntil >= data.today).length;
  const metrics = [
    [t('metrics.passports'), data.passports.length, t('metrics.passportHint')],
    [t('metrics.visas'), validVisas, t('metrics.visaHint', { count: data.visas.length })],
    [t('metrics.stays'), data.stays.length, t('metrics.crossingHint')],
  ];
  if (data.hongKongMacaoEnabled) {
    metrics.push(
      [t('metrics.permits'), data.permits.length, t('metrics.permitHint')],
      [t('metrics.permitStays'), data.permitStays.length, t('metrics.permitStayHint')],
    );
  }
  $('overview').replaceChildren(...metrics.map(([label, count, hint]) => {
    const card = el('div', null, 'trek-card metric');
    card.append(el('span', label, 'metric-label'), el('strong', count), el('span', hint, 'trek-faint metric-label'));
    return card;
  }));
  for (const tab of $('tabs').children) {
    tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
    tab.tabIndex = tab.dataset.kind === kind ? 0 : -1;
  }
  $('records').setAttribute('aria-labelledby', `tab-${kind}`);
  renderNotice();
  const records = data[kind] ?? [];
  if (!records.length) {
    const empty = el('div', null, 'empty');
    const hint = ({ passports: 'empty.passportHint', visas: 'empty.visaHint', applications: 'empty.applicationHint', stays: 'empty.stayHint', permits: 'empty.permitHint', permitStays: 'empty.permitStayHint' })[kind];
    empty.append(el('h3', t(`empty.${kind}`)), el('p', t(hint), 'trek-muted'));
    if (kind === 'stays' && data.passports.length) {
      const add = button(t('actions.add'), () => openEditor(), 'primary');
      add.disabled = loading;
      empty.append(add);
    }
    $('records').replaceChildren(empty);
    return;
  }
  const list = el('div', null, 'record-list');
  const sorted = [...records].sort((a, b) => ['stays', 'permitStays'].includes(kind) ? (b.crossingDate ?? b.entryDate).localeCompare(a.crossingDate ?? a.entryDate) : kind === 'visas' ? b.validUntil.localeCompare(a.validUntil) : kind === 'applications' ? b.submittedOn.localeCompare(a.submittedOn) : b.status.localeCompare(a.status));
  for (const record of sorted) list.append(recordCard(record));
  $('records').replaceChildren(list);
}

function recordCard(record) {
  const card = el('article', null, 'trek-card record');
  const head = el('div', null, 'record-header');
  const title = el('div');
  let status;
  if (kind === 'passports') {
    title.append(el('h3', t('values.passportTitle', { country: record.country })), el('div', `${record.holder} · ${masked(record.number)}`, 'record-subtitle'));
    status = record.status === 'archived' ? [t('status.archived'), 'info'] : validity(record.issuedOn, record.expiresOn);
  } else if (kind === 'visas') {
    title.append(el('h3', record.destination), el('div', `${record.type} · ${masked(record.number)}`, 'record-subtitle'));
    status = validity(record.validFrom, record.validUntil);
  } else if (kind === 'applications') {
    title.append(el('h3', record.destination), el('div', `${record.type} · ${record.submittedOn}`, 'record-subtitle'));
    status = [t(`applicationStatus.${record.status}`), record.status === 'approved' ? 'success' : record.status === 'refused' ? 'danger' : record.status === 'withdrawn' ? 'info' : 'accent'];
  } else if (kind === 'permits') {
    title.append(el('h3', record.holder), el('div', masked(record.number), 'record-subtitle'));
    status = record.status === 'archived' ? [t('status.permitArchived'), 'info'] : record.expiresOn < data.today ? [t('status.expired'), 'danger'] : record.issuedOn && record.issuedOn > data.today ? [t('status.notYetValid'), 'info'] : [t('status.permitActive'), 'success'];
  } else if (kind === 'permitStays') {
    title.append(el('h3', t(`select.${record.destination}`)), el('div', `${portLabel(record, 'entryPort')} → ${record.exitDate ? portLabel(record, 'exitPort') : t('values.noDeparture')}`, 'record-subtitle'));
    status = record.phase === 'planned' ? [t('status.planned'), 'info'] : record.phase === 'ongoing' ? [t('status.ongoing'), 'accent'] : [t('status.completed'), 'success'];
  } else if (record.crossingDate) {
    title.append(
      el('h3', t('values.crossingRoute', { from: regionName(record.departureCountry), to: regionName(record.arrivalCountry) })),
      el('div', record.crossingDate, 'record-subtitle'),
    );
    status = record.phase === 'planned' ? [t('status.crossingPlanned'), 'info'] : [t('status.crossed'), 'success'];
  } else {
    title.append(el('h3', [record.entryLocation ?? record.destination, record.exitLocation].filter(Boolean).join(' → ')), el('div', `${record.entryDate} → ${record.exitDate ?? t('values.noDeparture')}`, 'record-subtitle'));
    status = record.phase === 'planned' ? [t('status.planned'), 'info'] : record.phase === 'ongoing' ? [t('status.ongoing'), 'accent'] : [t('status.completed'), 'success'];
  }
  head.append(title, chip(...status));
  const details = el('dl', null, 'details');
  if (kind === 'passports') {
    detail(details, t('fields.issuedOn'), record.issuedOn);
    detail(details, t('fields.expiresOn'), record.expiresOn);
    detail(details, t('fields.linkedRecords'), t('values.linkedRecords', { applications: data.applications.filter(a => a.passportId === record.id).length, visas: data.visas.filter(v => v.passportId === record.id).length, stays: data.stays.filter(s => s.passportId === record.id).length }), true);
  } else if (kind === 'visas') {
    detail(details, t('fields.visaValidity'), t('values.dateRange', { from: record.validFrom, until: record.validUntil }), true);
    detail(details, t('fields.passportId'), passportLabel(data.passports.find(p => p.id === record.passportId)), true);
    detail(details, t('fields.totalEntries'), record.totalEntries === null ? t('values.multiple') : t('values.entries', { count: record.totalEntries }));
    detail(details, t('fields.usedEntries'), t('values.entries', { count: record.usedEntries }));
    detail(details, t('fields.remainingEntriesOverride'), record.effectiveRemaining === null ? t('values.unlimited') : t('values.entries', { count: record.effectiveRemaining }));
    detail(details, t('fields.maxStayDays'), record.maxStayDays === null ? t('values.notProvided') : t('values.days', { count: record.maxStayDays }));
    if (record.remainingEntriesOverride !== null) detail(details, t('fields.calculatedRemaining'), record.calculatedRemaining === null ? t('values.unlimited') : t('values.entries', { count: record.calculatedRemaining }));
    if (record.applicationId) detail(details, t('fields.applicationId'), applicationLabel(data.applications.find(a => a.id === record.applicationId)), true);
  } else if (kind === 'applications') {
    detail(details, t('fields.applicationPassport'), passportLabel(data.passports.find(p => p.id === record.passportId)), true);
    detail(details, t('fields.applicationLocation'), record.applicationLocation, true);
    detail(details, t('fields.submittedOn'), record.submittedOn);
    detail(details, t('fields.decidedOn'), record.decidedOn);
    const linkedVisa = data.visas.find(v => v.applicationId === record.id);
    if (linkedVisa) detail(details, t('fields.linkedVisa'), visaLabel(linkedVisa), true);
  } else if (kind === 'permits') {
    detail(details, t('fields.issuedOn'), record.issuedOn);
    detail(details, t('fields.permitExpiry'), record.expiresOn);
    for (const destination of ['hongKong', 'macao']) {
      const endorsement = record.endorsements?.[destination];
      const label = t(destination === 'hongKong' ? 'fields.hkEndorsement' : 'fields.macaoEndorsement');
      if (!endorsement) detail(details, label, t('select.noEndorsement'));
      else {
        const total = endorsement.totalEntries === null ? t('values.unlimited') : t('values.entries', { count: endorsement.totalEntries });
        const remaining = endorsement.remainingEntries === null ? t('values.unlimited') : t('values.entries', { count: endorsement.remainingEntries });
        detail(details, label, `${endorsementLabel(endorsement.type)} · ${endorsement.validFrom} – ${endorsement.validUntil}`, true);
        detail(details, t('fields.usedEntries'), t('values.entries', { count: endorsement.usedEntries }));
        detail(details, t('fields.remainingEntries'), `${remaining} / ${total}`);
      }
    }
  } else if (kind === 'permitStays') {
    const permit = data.permits.find(item => item.id === record.permitId);
    detail(details, t('fields.permitId'), permit ? `${permit.holder} · ${masked(permit.number)}` : t('values.notLinked'), true);
    detail(details, t('fields.entryDate'), record.entryDate);
    detail(details, t('fields.exitDate'), record.exitDate || t('values.noDeparture'));
    detail(details, t('fields.entryPortDetail'), portLabel(record, 'entryPort'));
    detail(details, t('fields.exitPortDetail'), record.exitDate ? portLabel(record, 'exitPort') : t('values.notProvided'));
    const endorsement = permit?.endorsements?.[record.destination];
    detail(details, t('fields.currentEndorsement'), endorsement ? `${endorsementLabel(endorsement.type)} · ${t('values.entries', { count: endorsement.usedEntries })} / ${endorsement.totalEntries === null ? t('values.unlimited') : t('values.entries', { count: endorsement.totalEntries })}` : t('select.noEndorsement'), true);
  } else {
    if (record.crossingDate) {
      if (record.departurePlace) detail(details, t('fields.departurePlace'), record.departurePlace);
      if (record.arrivalPlace) detail(details, t('fields.arrivalPlace'), record.arrivalPlace);
    } else {
      detail(details, t('fields.entryLocation'), record.entryLocation ?? record.destination);
      detail(details, t('fields.exitLocation'), record.exitLocation || t('values.notProvided'));
      detail(details, t('fields.stayDaysOverride'), t('values.days', { count: record.effectiveDays }));
      if (record.stayDaysOverride !== null) detail(details, t('fields.calculatedDays'), t('values.days', { count: record.calculatedDays }));
    }
    detail(details, t('fields.travelPassport'), passportLabel(data.passports.find(p => p.id === record.passportId)), true);
    detail(details, t('fields.visaId'), visaLabel(data.visas.find(v => v.id === record.visaId)), true);
  }
  if (record.notes) detail(details, t('fields.notes'), record.notes, true);
  const actions = el('div', null, 'record-actions');
  const recordKind = kind;
  if (kind === 'applications' && record.status === 'approved' && !data.visas.some(v => v.applicationId === record.id)) {
    actions.append(button(t('actions.createVisa'), () => {
      selectTab('visas');
      openEditor(null, { passportId: record.passportId, destination: record.destination, type: record.type, applicationId: record.id });
    }, 'primary'));
  }
  actions.append(button(t('actions.edit'), () => openEditor(record)), button(t('actions.delete'), () => deleteRecord(recordKind, record), 'danger'));
  card.append(head, details, actions);
  return card;
}

function endorsementLabel(type) {
  const normalized = type === 'tourism' ? 'personalTravel' : type;
  return t(`select.${normalized === 'other' ? 'otherEndorsement' : normalized}`);
}

function regionName(code) { return regionNames.of(code) ?? code; }

function regionOptions() {
  return window.visaRegionCodes
    .map(code => [code, regionName(code)])
    .sort((a, b) => a[1].localeCompare(b[1], language));
}

function legacyStayEditor() { return kind === 'stays' && !!editing && !editing.crossingDate; }

function portLabel(record, field) {
  return record[field] === 'other' ? record[`${field}Other`] : t(`port.${record[field]}`);
}

function applicationLabel(application) {
  return application ? `${application.destination} · ${application.type} · ${application.submittedOn}` : t('values.notLinked');
}

function portOptions(destination) {
  return [...(PERMIT_PORTS[destination] ?? []), 'other'].map(code => [code, t(code === 'other' ? 'select.otherPort' : `port.${code}`)]);
}

function endorsementTypeOptions() {
  return ['personalTravel', 'groupTravel', 'familyVisit', 'business', 'stay', 'other'].map(type => [type, t(`select.${type === 'other' ? 'otherEndorsement' : type}`)]);
}

function fieldsFor(record = editing) {
  const isValid = passport => (!passport.issuedOn || passport.issuedOn <= data.today) && passport.expiresOn >= data.today;
  const passportOptions = [...data.passports]
    .sort((a, b) => Number(isValid(b)) - Number(isValid(a)))
    .map(p => [p.id, passportLabel(p)]);
  if (kind === 'passports') return [
    ['holder', t('fields.holder'), 'text', true], ['number', t('fields.number'), 'text', true, null, '', 40],
    ['country', t('fields.country'), 'text', true], ['status', t('fields.status'), 'select', true, [['current', t('fields.current')], ['archived', t('fields.archived')]]],
    ['issuedOn', t('fields.issuedOn'), 'date'], ['expiresOn', t('fields.expiresOn'), 'date', true],
    ['notes', t('fields.notes'), 'textarea'],
  ];
  if (kind === 'applications') return [
    ['passportId', t('fields.applicationPassport'), 'select', true, passportOptions],
    ['destination', t('fields.destination'), 'text', true], ['type', t('fields.type'), 'text', true],
    ['status', t('fields.applicationStatus'), 'select', true, ['submitted', 'reviewing', 'approved', 'refused', 'withdrawn'].map(status => [status, t(`applicationStatus.${status}`)])],
    ['applicationLocation', t('fields.applicationLocation'), 'text', true],
    ['submittedOn', t('fields.submittedOn'), 'date', true], ['decidedOn', t('fields.decidedOn'), 'date'],
    ['notes', t('fields.notes'), 'textarea'],
  ];
  if (kind === 'visas') return [
    ['applicationId', t('fields.applicationId'), 'select', false, data.applications.filter(a => a.status === 'approved' && !data.visas.some(v => v.applicationId === a.id && v.id !== editing?.id)).map(a => [a.id, applicationLabel(a)]), t('hints.applicationId')],
    ['passportId', t('fields.passportId'), 'select', true, passportOptions, t('hints.passportId')],
    ['destination', t('fields.destination'), 'text', true], ['type', t('fields.type'), 'text', true], ['number', t('fields.visaNumber'), 'text', false, null, '', 80],
    ['validFrom', t('fields.validFrom'), 'date', true], ['validUntil', t('fields.validUntil'), 'date', true],
    ['totalEntries', t('fields.totalEntries'), 'number', false, null, t('hints.totalEntries')],
    ['maxStayDays', t('fields.maxStayDays'), 'number', false, null, t('hints.maxStayDays')],
    ['remainingEntriesOverride', t('fields.remainingEntriesOverride'), 'number', false, null, t('hints.remainingEntriesOverride')],
    ['notes', t('fields.notes'), 'textarea'],
  ];
  if (kind === 'permits') return [
    ['holder', t('fields.holder'), 'text', true], ['number', t('fields.permitNumber'), 'text', true, null, '', 40],
    ['status', t('fields.permitStatus'), 'select', true, [['current', t('fields.currentPermit')], ['archived', t('fields.archivedPermit')]]],
    ['issuedOn', t('fields.issuedOn'), 'date'], ['expiresOn', t('fields.permitExpiry'), 'date', true],
    ['hkSection', t('fields.hkEndorsement'), 'section'],
    ['hkEndorsementType', t('fields.endorsementType'), 'select', false, endorsementTypeOptions()],
    ['hkEndorsementValidFrom', t('fields.validFrom'), 'date'], ['hkEndorsementValidUntil', t('fields.validUntil'), 'date'],
    ['hkEndorsementTotalEntries', t('fields.endorsementEntries'), 'number', false, null, t('hints.totalEntries')],
    ['macaoSection', t('fields.macaoEndorsement'), 'section'],
    ['macaoEndorsementType', t('fields.endorsementType'), 'select', false, endorsementTypeOptions()],
    ['macaoEndorsementValidFrom', t('fields.validFrom'), 'date'], ['macaoEndorsementValidUntil', t('fields.validUntil'), 'date'],
    ['macaoEndorsementTotalEntries', t('fields.endorsementEntries'), 'number', false, null, t('hints.totalEntries')],
    ['notes', t('fields.notes'), 'textarea'],
  ];
  if (kind === 'permitStays') {
    const destination = record?.destination ?? 'hongKong';
    return [
      ['permitId', t('fields.permitId'), 'select', true, [...data.permits].sort((a, b) => Number(a.status === 'archived') - Number(b.status === 'archived')).map(permit => [permit.id, `${permit.holder} · ${masked(permit.number)}`])],
      ['destination', t('fields.permitDestination'), 'select', true, [['hongKong', t('select.hongKong')], ['macao', t('select.macao')]]],
      ['entryDate', t('fields.entryDate'), 'date', true],
      ['entryPort', t('fields.entryPort'), 'select', true, portOptions(destination)],
      ['entryPortOther', t('fields.otherPort'), 'text', false],
      ['exitDate', t('fields.exitDate'), 'date'],
      ['exitPort', t('fields.exitPort'), 'select', false, portOptions(destination)],
      ['exitPortOther', t('fields.otherPort'), 'text', false],
      ['notes', t('fields.notes'), 'textarea'],
    ];
  }
  const passport = ['passportId', t('fields.travelPassport'), 'select', true, passportOptions];
  const visaOptions = data.visas.map(v => [v.id, `${visaLabel(v)} · ${passportLabel(data.passports.find(p => p.id === v.passportId))}`]);
  const visa = ['visaId', t('fields.visaId'), 'select', false, visaOptions, t('hints.visaId')];
  const notes = ['notes', t('fields.notes'), 'textarea'];
  if (legacyStayEditor()) return [
    passport,
    ['entryLocation', t('fields.entryLocation'), 'text', true], ['exitLocation', t('fields.exitLocation'), 'text'],
    ['entryDate', t('fields.entryDate'), 'date', true], ['exitDate', t('fields.exitDate'), 'date', false, null, t('hints.exitDate')],
    ['stayDaysOverride', t('fields.stayDaysOverride'), 'number', false, null, t('hints.stayDaysOverride')],
    visa, notes,
  ];

  const regions = regionOptions();
  return [
    ['departureCountry', t('fields.departureCountry'), 'select', true, regions],
    ['arrivalCountry', t('fields.arrivalCountry'), 'select', true, regions],
    ['departurePlace', t('fields.departurePlace'), 'text'],
    ['arrivalPlace', t('fields.arrivalPlace'), 'text'],
    ['crossingDate', t('fields.crossingDate'), 'date', true],
    passport, visa, notes,
    ...(editing ? [] : [
      ['returnSection', t('fields.returnSection'), 'section'],
      ['returnDate', t('fields.returnDate'), 'date', false, null, t('hints.returnDate')],
      ['returnDeparturePlace', t('fields.departurePlace'), 'text'],
      ['returnArrivalPlace', t('fields.arrivalPlace'), 'text'],
    ]),
  ];
}

function openEditor(record = null, defaults = {}) {
  if (busy || loading || !data) return;
  if (kind === 'permitStays' && !data.permits.length) { errorAt('error', t('messages.needPermit')); return; }
  if (!['passports', 'permits', 'permitStays'].includes(kind) && !data.passports.length) { errorAt('error', t('messages.needPassport')); return; }
  editing = record;
  renderEditor(record ?? defaults);
  $('editor').showModal();
}

function editorValue(record, key) {
  if (!record) return undefined;
  if (Object.hasOwn(record, key)) return record[key];
  const match = /^(hk|macao)Endorsement(Type|ValidFrom|ValidUntil|TotalEntries)$/.exec(key);
  if (!match) return undefined;
  const destination = match[1] === 'hk' ? 'hongKong' : 'macao';
  const endorsement = record.endorsements?.[destination];
  if (!endorsement) return '';
  const field = { Type: 'type', ValidFrom: 'validFrom', ValidUntil: 'validUntil', TotalEntries: 'totalEntries' }[match[2]];
  const value = endorsement[field];
  if (match[2] === 'Type' && value === 'tourism') return 'personalTravel';
  return value == null ? '' : value;
}

function setupPermitForm() {
  for (const prefix of ['hk', 'macao']) {
    const type = $(`field-${prefix}EndorsementType`);
    const validFrom = $(`field-${prefix}EndorsementValidFrom`);
    const validUntil = $(`field-${prefix}EndorsementValidUntil`);
    const totalEntries = $(`field-${prefix}EndorsementTotalEntries`);
    const update = () => {
      const enabled = !!type.value;
      for (const input of [validFrom, validUntil, totalEntries]) {
        input.parentElement.hidden = !enabled;
        input.required = enabled && input !== totalEntries;
        if (!enabled) input.value = '';
      }
    };
    type.addEventListener('change', update);
    update();
  }
}

function setupPermitStayForm() {
  const destination = $('field-destination');
  const entryPort = $('field-entryPort');
  const exitPort = $('field-exitPort');
  const entryOther = $('field-entryPortOther');
  const exitOther = $('field-exitPortOther');
  const exitDate = $('field-exitDate');
  // TREK wraps selects and updates their visible label on change.
  const exitPortField = exitPort.closest('.field');
  const notifySelectChange = select => select.dispatchEvent(new Event('change', { bubbles: true }));
  const replaceOptions = (select, options) => {
    const current = select.value;
    select.replaceChildren(new Option(t('select.placeholder'), ''), ...options.map(([value, label]) => new Option(label, value)));
    select.value = options.some(([value]) => value === current) ? current : '';
    notifySelectChange(select);
  };
  const updatePortField = (select, other, required) => {
    const show = select.value === 'other';
    other.parentElement.hidden = !show;
    other.required = show && required;
    if (!show) other.value = '';
  };
  const updateExitOther = () => updatePortField(exitPort, exitOther, !!exitDate.value);
  const updateExit = () => {
    const hasExit = !!exitDate.value;
    exitPortField.hidden = !hasExit;
    exitPort.required = hasExit;
    if (!hasExit && exitPort.value) {
      exitPort.value = '';
      notifySelectChange(exitPort);
    }
  };
  const updateDestination = () => {
    const options = portOptions(destination.value);
    replaceOptions(entryPort, options);
    replaceOptions(exitPort, options);
    updateExit();
  };
  destination.addEventListener('change', updateDestination);
  entryPort.addEventListener('change', () => updatePortField(entryPort, entryOther, true));
  exitPort.addEventListener('change', updateExitOther);
  exitDate.addEventListener('input', updateExit);
  exitDate.addEventListener('change', updateExit);
  updateDestination();
}

function setupReturnFields() {
  const returnDate = $('field-returnDate');
  if (!returnDate) return;
  const fields = ['returnDeparturePlace', 'returnArrivalPlace'].map(key => $(`field-${key}`).parentElement);
  const preview = el('small');
  preview.id = 'return-route';
  preview.setAttribute('aria-live', 'polite');
  returnDate.parentElement.append(preview);
  returnDate.setAttribute('aria-describedby', 'hint-returnDate return-route');
  const update = () => {
    const from = $('field-arrivalCountry').value;
    const to = $('field-departureCountry').value;
    const hasReturn = !!returnDate.value;
    for (const field of fields) field.hidden = !hasReturn;
    preview.textContent = hasReturn && from && to && from !== to
      ? t('values.crossingRoute', { from: regionName(from), to: regionName(to) })
      : '';
  };
  for (const input of [returnDate, $('field-departureCountry'), $('field-arrivalCountry')]) {
    input.addEventListener('input', update);
  }
  update();
}

function renderEditor(record) {
  editorLanguage = language;
  errorAt('form-error');
  $('editor-title').textContent = t(`${editing ? 'edit' : 'add'}.${kind}`);
  const fields = fieldsFor(record).map(([key, label, type, required, options, hint, max]) => {
    const wide = type === 'textarea' || key === 'applicationId' || key === 'returnDate' ||
      (legacyStayEditor() && key === 'passportId');
    if (type === 'section') {
      const section = el('div', null, 'field wide form-section');
      section.append(el('h3', label));
      return section;
    }
    const field = el('div', null, `field${wide ? ' wide' : ''}`);
    field.dataset.key = key;
    const caption = el('label', `${label}${required ? ' *' : ''}`, 'trek-label');
    caption.htmlFor = `field-${key}`;
    if (type === 'date') {
      const input = el('input', null, 'trek-input');
      input.type = 'date';
      input.id = `field-${key}`;
      input.name = key;
      input.required = !!required;
      input.min = '1900-01-01';
      input.max = '2199-12-31';
      input.value = editorValue(record, key) ?? (key === 'submittedOn' ? localDate() : '');
      input.autocomplete = 'off';
      input.addEventListener('invalid', event => {
        event.preventDefault();
        if (input.form.querySelector(':invalid') !== input) return;
        const error = input.validity.valueMissing ? 'errors.required' : 'errors.invalidDate';
        errorAt('form-error', t(error, { field: label }));
        input.focus();
      });
      field.append(caption, input);
      if (hint) {
        const description = el('small', hint);
        description.id = `hint-${key}`;
        input.setAttribute('aria-describedby', description.id);
        field.append(description);
      }
      return field;
    }
    const input = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', null, `trek-${type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input'}`);
    input.id = `field-${key}`;
    input.name = key;
    input.required = !!required;
    if (type === 'select') {
      const emptyLabel = required ? t('select.placeholder') : key.endsWith('EndorsementType') ? t('select.noEndorsement') : t(key === 'applicationId' ? 'select.noApplication' : 'select.noVisa');
      input.append(new Option(emptyLabel, ''));
      for (const [value, text] of options) input.append(new Option(text, value));
    } else if (type !== 'textarea') {
      input.type = type;
      if (type === 'number') { input.min = '0'; input.max = '1000000'; input.step = '1'; }
      else input.maxLength = max ?? 160;
    } else input.maxLength = 5000;
    input.value = editorValue(record, key) ?? (key === 'status' ? kind === 'applications' ? 'submitted' : 'current' : key === 'entryLocation' ? record?.destination ?? '' : key === 'destination' && kind === 'permitStays' ? 'hongKong' : '');
    if (key === 'applicationId') input.addEventListener('change', () => {
      const application = data.applications.find(a => a.id === input.value);
      if (!application) return;
      for (const name of ['passportId', 'destination', 'type']) {
        const control = $(`field-${name}`);
        control.value = application[name];
        control.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    if (type !== 'select') input.autocomplete = 'off';
    if (key === 'departureCountry' || key === 'arrivalCountry') {
      // Keep native keyboard search and mobile pickers for the long region list.
      input.setAttribute('data-trek-native', '');
      input.addEventListener('invalid', event => {
        event.preventDefault();
        if (input.form.querySelector(':invalid') !== input) return;
        errorAt('form-error', t('errors.required', { field: label }));
        input.focus();
      });
    }
    field.append(caption, input);
    if (hint) { const hintNode = el('small', hint); hintNode.id = `hint-${key}`; input.setAttribute('aria-describedby', hintNode.id); field.append(hintNode); }
    return field;
  });
  if (legacyStayEditor()) {
    const dateRow = el('div', null, 'date-row');
    dateRow.append(...fields.filter(field => ['entryDate', 'exitDate'].includes(field.dataset.key)));
    $('fields').replaceChildren(...fields.flatMap(field => field.dataset.key === 'entryDate' ? [dateRow] : field.dataset.key === 'exitDate' ? [] : [field]));
  } else $('fields').replaceChildren(...fields);
  if (kind === 'stays' && !editing) setupReturnFields();
  if (kind === 'permits') setupPermitForm();
  if (kind === 'permitStays') setupPermitStayForm();
}

function setBusy(value) {
  busy = value;
  for (const node of $('record-form').elements) node.disabled = value;
  $('save').textContent = value ? t('editor.saving') : t('editor.save');
  if (!value && $('editor').open && editorLanguage !== language) renderEditor(Object.fromEntries(new FormData($('record-form'))));
}
$('record-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const body = Object.fromEntries(new FormData($('record-form')));
  for (const [key, , type] of fieldsFor()) if (type === 'number') body[key] = body[key] === '' ? null : Number(body[key]);
  if (kind === 'permits') {
    body.endorsements = {};
    for (const [prefix, destination] of [['hk', 'hongKong'], ['macao', 'macao']]) {
      const type = body[`${prefix}EndorsementType`];
      if (type) body.endorsements[destination] = {
        type,
        validFrom: body[`${prefix}EndorsementValidFrom`],
        validUntil: body[`${prefix}EndorsementValidUntil`],
        totalEntries: body[`${prefix}EndorsementTotalEntries`] == null || body[`${prefix}EndorsementTotalEntries`] === '' ? null : Number(body[`${prefix}EndorsementTotalEntries`]),
      };
      else body.endorsements[destination] = null;
      for (const suffix of ['Type', 'ValidFrom', 'ValidUntil', 'TotalEntries']) delete body[`${prefix}Endorsement${suffix}`];
    }
  }
  if (editing) body.id = editing.id;
  if (kind === 'applications' && editing) {
    const visa = data.visas.find(v => v.applicationId === editing.id);
    if (visa && (body.status !== 'approved' || body.passportId !== visa.passportId || body.destination.trim() !== visa.destination)) {
      errorAt('form-error', t('errors.applicationLinked')); return;
    }
  }
  if (kind === 'visas' && body.applicationId) {
    const application = data.applications.find(a => a.id === body.applicationId);
    if (!application || application.status !== 'approved' || application.passportId !== body.passportId || application.destination !== body.destination.trim()) {
      errorAt('form-error', t('errors.approvalMismatch')); return;
    }
  }
  try { window.visaValidate(kind, body, { legacyStay: legacyStayEditor() }); }
  catch (error) { errorAt('form-error', window.visaI18n.errorMessage(error, language)); return; }
  setBusy(true);
  errorAt('form-error');
  let saveError;
  try {
    const endpoint = kind === 'permitStays' ? 'permit-stays' : kind;
    const result = await invoke(`/${endpoint}/save`, { method: 'POST', body });
    $('editor').close();
    trek.notify('success', t(result?.returnId ? 'messages.crossingsSaved' : 'messages.saved'));
    await load();
  } catch (error) {
    saveError = error;
  } finally {
    setBusy(false);
    if (saveError) errorAt('form-error', t('messages.saveFailed', { message: saveError.message }));
  }
});
async function deleteRecord(recordKind, record) {
  if (busy) return;
  busy = true;
  try {
    const confirmed = await trek.confirm({ title: t(`delete.${recordKind}`), message: t('actions.confirmDelete'), confirmLabel: t('actions.deleteRecord'), cancelLabel: t('actions.keep'), danger: true });
    if (!confirmed) return;
    const endpoint = recordKind === 'permitStays' ? 'permit-stays' : recordKind;
    await invoke(`/${endpoint}?id=${encodeURIComponent(record.id)}`, { method: 'DELETE' });
    trek.notify('success', t('messages.deleted'));
    await load();
  } catch (error) { errorAt('error', error.message); }
  finally { busy = false; }
}
function selectTab(next) { if (!busy) { kind = next; if (data) render(); } }
for (const tab of $('tabs').children) tab.addEventListener('click', () => selectTab(tab.dataset.kind));
$('tabs').addEventListener('keydown', event => {
  const tabs = [...$('tabs').children].filter(tab => !tab.hidden);
  const index = tabs.indexOf(document.activeElement);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectTab(tabs[next].dataset.kind); tabs[next].focus();
});
$('add').addEventListener('click', () => openEditor());
$('retry').addEventListener('click', load);
$('reveal').addEventListener('change', () => { if (data) render(); });
for (const key of ['close', 'cancel']) $(key).addEventListener('click', () => { if (!busy) $('editor').close(); });
$('editor').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
window.addEventListener('focus', () => { if (data && data.today !== localDate() && !$('editor').open && !busy) load(); });
function applyLanguage(locale) {
  const next = resolveLanguage(locale);
  const changed = next !== language;
  language = next;
  if (changed) regionNames = new Intl.DisplayNames([language], { type: 'region' });
  t = createTranslator(language);
  document.documentElement.lang = language;
  document.title = t('page.title');
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
  $('save').textContent = t(busy ? 'editor.saving' : 'editor.save');
  if (changed) {
    if (loadFailure) errorAt('error', t('messages.loadFailed', { message: loadFailure.message }), true);
    else errorAt('error');

  }
  if ($('editor').open && !busy && editorLanguage !== language) renderEditor(Object.fromEntries(new FormData($('record-form'))));
  if (data) render();
  else renderNotice();
}
applyLanguage('en');
trek.onContext(context => {
  applyLanguage(context.locale);
  if (!initialized) { initialized = true; load(); }
});
