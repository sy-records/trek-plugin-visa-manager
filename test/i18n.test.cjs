'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTranslator, resolveLanguage } = require('../server/i18n');
const en = require('../client/locales/en.json');
const zh = require('../client/locales/zh-CN.json');

test('English is the default and unsupported languages fall back to English', () => {
  for (const locale of [undefined, null, '', 'en', 'en-GB', 'de-DE', 'zh-TW', 'zh-Hant', 'unknown', {}]) {
    assert.equal(resolveLanguage(locale), 'en');
    assert.equal(createTranslator(locale)('page.title'), 'Passports & Visas');
  }
  for (const locale of ['zh', 'zh-CN', 'zh_Hans', 'zh-Hans-CN', 'zh-SG']) {
    assert.equal(resolveLanguage(locale), 'zh-CN');
    assert.equal(createTranslator(locale)('page.title'), '护照与签证');
  }
});

test('both catalogs cover the same messages and interpolation parameters', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(en)) {
    assert.ok(en[key].trim(), `empty English message: ${key}`);
    assert.ok(zh[key].trim(), `empty Chinese message: ${key}`);
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `placeholder mismatch: ${key}`);
  }
  // User content is inserted once, with literal characters intact.
  assert.equal(createTranslator('en')('values.passportTitle', { country: '$& {other}' }), '$& {other} passport');
});

test('counted units use English plurals and Chinese units', () => {
  const t = createTranslator('en');
  assert.equal(t('values.days', { count: 1 }), '1 day');
  assert.equal(t('values.days', { count: 0 }), '0 days');
  assert.equal(t('values.entries', { count: 2 }), '2 entries');
  assert.equal(createTranslator('zh-CN')('values.entries', { count: 1 }), '1 次');
});
