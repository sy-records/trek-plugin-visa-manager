'use strict';

const en = require('../client/locales/en.json');
const zh = require('../client/locales/zh-CN.json');

function resolveLanguage(locale) {
  if (typeof locale !== 'string') return 'en';
  const tag = locale.trim().replaceAll('_', '-').toLowerCase();
  if (tag.split('-').includes('hant') || /^zh-(tw|hk|mo)(-|$)/.test(tag)) return 'en';
  return /^zh($|-(cn|sg|hans)(-|$))/.test(tag) ? 'zh-CN' : 'en';
}

function createTranslator(locale = 'en') {
  const catalog = resolveLanguage(locale) === 'zh-CN' ? zh : en;
  const plurals = new Intl.PluralRules(resolveLanguage(locale));
  return (key, params = {}) => {
    const pluralKey = typeof params.count === 'number' ? `${key}_${plurals.select(params.count)}` : key;
    const template = catalog[pluralKey] ?? catalog[key] ?? en[pluralKey] ?? en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
  };
}

function errorMessage(error, locale) {
  const t = createTranslator(locale);
  return t(error.key, { ...error.params, ...(error.params.field ? { field: t(error.params.field) } : {}) });
}

module.exports = { resolveLanguage, createTranslator, errorMessage };
