'use strict';

const $ = id => document.getElementById(id);
const { createTranslator, resolveLanguage } = window.visaI18n;
let language = 'en';
let t = createTranslator(language);
let data = null;
let kind = 'passports';
let editing = null;
let busy = false;
let loadVersion = 0;
let loadFailure = null;
let initialized = false;
let datePickerCleanups = [];
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
  $('retry').disabled = true;
  $('records').setAttribute('aria-busy', 'true');
  errorAt('error');
  try {
    const result = await invoke(`/records?today=${localDate()}`);
    if (version !== loadVersion) return;
    data = result;
    data.applications ??= [];
    render();
  } catch (error) {
    if (version !== loadVersion) return;
    loadFailure = error;
    errorAt('error', t('messages.loadFailed', { message: error.message }), true);
    if (!data) $('notice').textContent = t('page.notLoaded');
  } finally {
    if (version === loadVersion) {
      $('retry').disabled = false;
      $('records').setAttribute('aria-busy', 'false');
    }
  }
}

function render() {
  $('add').disabled = false;
  $('add').textContent = t(`add.${kind}`);
  const validVisas = data.visas.filter(v => v.validFrom <= data.today && v.validUntil >= data.today).length;
  const ongoing = data.stays.filter(s => s.phase === 'ongoing').length;
  $('overview').replaceChildren(...[
    [t('metrics.passports'), data.passports.length, t('metrics.passportHint')],
    [t('metrics.visas'), validVisas, t('metrics.visaHint', { count: data.visas.length })],
    [t('metrics.stays'), data.stays.length, t('metrics.stayHint', { count: ongoing })],
  ].map(([label, count, hint]) => {
    const card = el('div', null, 'trek-card metric');
    card.append(el('span', label, 'metric-label'), el('strong', count), el('span', hint, 'trek-faint metric-label'));
    return card;
  }));
  for (const tab of $('tabs').children) {
    tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
    tab.tabIndex = tab.dataset.kind === kind ? 0 : -1;
  }
  $('records').setAttribute('aria-labelledby', `tab-${kind}`);
  $('notice').textContent = t(`notices.${kind}`);
  if (!data[kind].length) {
    const empty = el('div', null, 'empty');
    empty.append(el('h3', t(`empty.${kind}`)), el('p', kind === 'passports' ? t('empty.passportHint') : t(kind === 'visas' ? 'empty.visaHint' : kind === 'applications' ? 'empty.applicationHint' : 'empty.stayHint'), 'trek-muted'));
    $('records').replaceChildren(empty);
    return;
  }
  const list = el('div', null, 'record-list');
  const sorted = [...data[kind]].sort((a, b) => kind === 'stays' ? b.entryDate.localeCompare(a.entryDate) : kind === 'visas' ? b.validUntil.localeCompare(a.validUntil) : kind === 'applications' ? b.submittedOn.localeCompare(a.submittedOn) : b.status.localeCompare(a.status));
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
  } else {
    detail(details, t('fields.entryLocation'), record.entryLocation ?? record.destination);
    detail(details, t('fields.exitLocation'), record.exitLocation || t('values.notProvided'));
    detail(details, t('fields.travelPassport'), passportLabel(data.passports.find(p => p.id === record.passportId)), true);
    detail(details, t('fields.visaId'), visaLabel(data.visas.find(v => v.id === record.visaId)), true);
    detail(details, t('fields.stayDaysOverride'), t('values.days', { count: record.effectiveDays }));
    if (record.stayDaysOverride !== null) detail(details, t('fields.calculatedDays'), t('values.days', { count: record.calculatedDays }));
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

function applicationLabel(application) {
  return application ? `${application.destination} · ${application.type} · ${application.submittedOn}` : t('values.notLinked');
}

function fieldsFor() {
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
  return [
    ['passportId', t('fields.travelPassport'), 'select', true, passportOptions],
    ['entryLocation', t('fields.entryLocation'), 'text', true], ['exitLocation', t('fields.exitLocation'), 'text'],
    ['entryDate', t('fields.entryDate'), 'date', true], ['exitDate', t('fields.exitDate'), 'date', false, null, t('hints.exitDate')],
    ['stayDaysOverride', t('fields.stayDaysOverride'), 'number', false, null, t('hints.stayDaysOverride')],
    ['visaId', t('fields.visaId'), 'select', false, data.visas.map(v => [v.id, `${visaLabel(v)} · ${passportLabel(data.passports.find(p => p.id === v.passportId))}`]), t('hints.visaId')],
    ['notes', t('fields.notes'), 'textarea'],
  ];
}

function openEditor(record = null, defaults = {}) {
  if (busy || !data) return;
  if (kind !== 'passports' && !data.passports.length) { errorAt('error', t('messages.needPassport')); return; }
  editing = record;
  renderEditor(record ?? defaults);
  $('editor').showModal();
}

function renderEditor(record) {
  editorLanguage = language;
  errorAt('form-error');
  $('editor-title').textContent = t(`${editing ? 'edit' : 'add'}.${kind}`);
  for (const cleanup of datePickerCleanups) cleanup();
  datePickerCleanups = [];
  const fields = fieldsFor().map(([key, label, type, required, options, hint, max]) => {
    const wide = type === 'textarea' || key === 'applicationId' || (kind === 'stays' && key === 'passportId');
    const field = el('div', null, `field${wide ? ' wide' : ''}`);
    field.dataset.key = key;
    const caption = el('label', `${label}${required ? ' *' : ''}`, 'trek-label');
    caption.htmlFor = `field-${key}`;
    if (type === 'date') {
      const picker = el('div', null, 'date-picker');
      picker.id = `picker-${key}`;
      field.append(caption, picker);
      datePickerCleanups.push(window.visaDatePicker.mount(picker, {
        name: key, label, language, value: record?.[key] ?? (key === 'submittedOn' ? localDate() : ''), required: !!required,
        min: '1900-01-01', max: '2199-12-31', portalContainer: $('editor'),
        onInvalid: message => errorAt('form-error', message),
      }));
      if (hint) field.append(el('small', hint));
      return field;
    }
    const input = el(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input', null, `trek-${type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input'}`);
    input.id = `field-${key}`;
    input.name = key;
    input.required = !!required;
    if (type === 'select') {
      input.append(new Option(required ? t('select.placeholder') : t(key === 'applicationId' ? 'select.noApplication' : 'select.noVisa'), ''));
      for (const [value, text] of options) input.append(new Option(text, value));
    } else if (type !== 'textarea') {
      input.type = type;
      if (type === 'number') { input.min = '0'; input.max = '1000000'; input.step = '1'; }
      else input.maxLength = max ?? 160;
    } else input.maxLength = 5000;
    input.value = record?.[key] ?? (key === 'status' ? kind === 'applications' ? 'submitted' : 'current' : key === 'entryLocation' ? record?.destination ?? '' : '');
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
    field.append(caption, input);
    if (hint) { const hintNode = el('small', hint); hintNode.id = `hint-${key}`; input.setAttribute('aria-describedby', hintNode.id); field.append(hintNode); }
    return field;
  });
  if (kind === 'stays') {
    const dateRow = el('div', null, 'date-row');
    dateRow.append(...fields.filter(field => ['entryDate', 'exitDate'].includes(field.dataset.key)));
    $('fields').replaceChildren(...fields.flatMap(field => field.dataset.key === 'entryDate' ? [dateRow] : field.dataset.key === 'exitDate' ? [] : [field]));
  } else $('fields').replaceChildren(...fields);
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
  try { window.visaValidate(kind, body); }
  catch (error) { errorAt('form-error', window.visaI18n.errorMessage(error, language)); return; }
  setBusy(true);
  errorAt('form-error');
  try {
    await invoke(`/${kind}/save`, { method: 'POST', body });
    $('editor').close();
    trek.notify('success', t('messages.saved'));
    await load();
  } catch (error) { errorAt('form-error', error.message); }
  finally { setBusy(false); }
});
async function deleteRecord(recordKind, record) {
  if (busy) return;
  busy = true;
  try {
    const confirmed = await trek.confirm({ title: t(`delete.${recordKind}`), message: t('actions.confirmDelete'), confirmLabel: t('actions.deleteRecord'), cancelLabel: t('actions.keep'), danger: true });
    if (!confirmed) return;
    await invoke(`/${recordKind}?id=${encodeURIComponent(record.id)}`, { method: 'DELETE' });
    trek.notify('success', t('messages.deleted'));
    await load();
  } catch (error) { errorAt('error', error.message); }
  finally { busy = false; }
}
function selectTab(next) { if (!busy) { kind = next; if (data) render(); } }
for (const tab of $('tabs').children) tab.addEventListener('click', () => selectTab(tab.dataset.kind));
$('tabs').addEventListener('keydown', event => {
  const tabs = [...$('tabs').children];
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
$('editor').addEventListener('close', () => {
  for (const cleanup of datePickerCleanups) cleanup();
  datePickerCleanups = [];
});
$('editor').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
window.addEventListener('focus', () => { if (data && data.today !== localDate() && !$('editor').open && !busy) load(); });
function applyLanguage(locale) {
  const next = resolveLanguage(locale);
  const changed = next !== language;
  language = next;
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
}
applyLanguage('en');
trek.onContext(context => {
  applyLanguage(context.locale);
  if (!initialized) { initialized = true; load(); }
});
