'use strict';
// Isolated SDK preview + real SQLite. Requires this repository's Playwright.
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

(async () => {
  const source = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-visa-'));
  const pluginDir = path.join(scratch, 'visa-manager');
  fs.mkdirSync(pluginDir);
  for (const file of ['server', 'client', 'trek-plugin.json', 'package.json']) fs.cpSync(path.join(source, file), path.join(pluginDir, file), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'dev-fixtures.json'), JSON.stringify({ config: { hong_kong_macau_enabled: true } }));
  const localSdk = path.resolve(source, '../../plugin-sdk/dist/cli/dev.js');
  const installedSdk = path.resolve(source, 'node_modules/trek-plugin-sdk/dist/cli/dev.js');
  const sdkEntry = fs.existsSync(localSdk) ? localSdk : installedSdk;
  const sdkUrl = pathToFileURL(sdkEntry).href;
  const port = 14317 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {runDev} from ${JSON.stringify(sdkUrl)}; await runDev(${JSON.stringify(pluginDir)}, {port:${port}});`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  let serverOutput = '';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`SDK preview did not start: ${serverOutput}`)), 15000);
      child.stdout.on('data', chunk => { serverOutput += chunk; if (serverOutput.includes('themed host preview')) { clearTimeout(timeout); resolve(); } });
      child.stderr.on('data', chunk => { serverOutput += chunk; });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`SDK preview exited (${code}): ${serverOutput}`)); });
    });
    browser = await chromium.launch(fs.existsSync(chromium.executablePath()) ? { executablePath: chromium.executablePath() } : { channel: 'chrome' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.message); });
    page.on('dialog', dialog => { errors.push('Unexpected browser-native confirmation'); dialog.dismiss(); });
    let recordReads = 0;
    await page.route('**/api/records?**', route => {
      recordReads += 1;
      if (recordReads === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary test failure' }) });
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${port}/preview`);
    const frame = page.frameLocator('iframe');
    async function setLanguage(locale) {
      await expect(frame.locator('#records')).toHaveAttribute('aria-busy', 'false');
      const context = await frame.locator('body').evaluate(() => window.trek.context);
      await page.evaluate(({ context, locale }) => {
        document.querySelector('iframe').contentWindow.postMessage({ ...context, type: 'trek:context', locale }, '*');
      }, { context, locale });
      await expect(frame.locator('html')).toHaveAttribute('lang', locale === 'zh-CN' ? 'zh-CN' : 'en');
    }
    await expect(frame.locator('#refresh')).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(frame.locator('#error')).toContainText('Unable to load records');
    await setLanguage('zh-CN');
    await expect(frame.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await setLanguage('en');
    await frame.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(frame.getByRole('heading', { name: 'No passports yet' })).toBeVisible();
    await expect(frame.locator('#retry')).not.toBeVisible();
    await expect(frame.locator('#error')).not.toBeVisible();
    await expect(frame.locator('#overview')).toContainText('HK & Macao permit records');
    await expect(frame.locator('#overview')).toContainText('HK & Macao crossings');
    assert.equal(recordReads, 2, 'retry should recover the failed initial load');
    await expect(frame.getByRole('heading', { name: 'Passports & Visas', exact: true })).toBeVisible();
    await expect(frame.locator('.footnote')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true, 'English mobile layout must fit the viewport');
    await page.setViewportSize({ width: 1024, height: 1100 });
    const toolbarBox = await frame.locator('.toolbar').boundingBox();
    const tabsBox = await frame.locator('#tabs').boundingBox();
    const actionsBox = await frame.locator('.actions').boundingBox();
    assert.ok(tabsBox && actionsBox && Math.abs(tabsBox.y - actionsBox.y) < 1, 'desktop tabs and actions should stay on one row');
    assert.ok(toolbarBox && tabsBox && actionsBox && tabsBox.width < toolbarBox.width - actionsBox.width - 12, 'tab background should wrap its labels instead of filling the toolbar');
    assert.ok(toolbarBox && actionsBox && toolbarBox.x + toolbarBox.width - actionsBox.x - actionsBox.width < 2, 'toolbar actions should stay at the far right');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await setLanguage('de-DE');
    await expect(frame.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    async function fill(key, value) {
      await frame.locator(`#field-${key}`).fill(value);
    }
    async function select(key, value) { await frame.locator(`#field-${key}`).selectOption(value, { force: true }); }
    async function save() { await frame.getByRole('button', { name: '保存记录', exact: true }).click(); await expect(frame.locator('#editor')).not.toBeVisible(); }
    async function tab(name) { await frame.getByRole('tab', { name, exact: true }).click(); }
    async function answerDelete(yes = true) {
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: yes ? '删除记录' : '保留', exact: true }).click();
      await expect(confirm).not.toBeVisible();
    }
    async function assertDateRow() {
      const a = await frame.locator('#field-entryDate').boundingBox();
      const b = await frame.locator('#field-exitDate').boundingBox();
      assert.ok(Math.abs(a.y - b.y) < 2 && a.x < b.x, 'entry and departure dates must share a row');
    }

    async function newPassport(number, status) {
      await frame.getByRole('button', { name: 'Add', exact: true }).click();
      await fill('holder', '演示用户'); await fill('number', number); await fill('country', '中国');
      await select('status', status); await fill('issuedOn', '2020-01-01'); await fill('expiresOn', '2030-01-01');
      await expect(frame.locator('#field-expiresOn')).toHaveAttribute('type', 'date');
      await expect(frame.locator('#field-expiresOn')).toHaveAttribute('min', '1900-01-01');
      await expect(frame.locator('#field-expiresOn')).toHaveAttribute('max', '2199-12-31');
      await save();
    }
    // Locale changes must retain unsaved values in native date inputs.
    await frame.getByRole('button', { name: 'Add', exact: true }).click();
    await fill('holder', 'Unsaved name');
    await fill('issuedOn', '2020-01-01');
    await setLanguage('zh-CN');
    await expect(frame.getByRole('heading', { name: '新增护照', exact: true })).toBeVisible();
    await expect(frame.locator('#field-holder')).toHaveValue('Unsaved name');
    await expect(frame.locator('#field-issuedOn')).toHaveValue('2020-01-01');
    await fill('issuedOn', '2020-01-04');
    await expect(frame.locator('#field-issuedOn')).toHaveValue('2020-01-04');
    await frame.getByRole('button', { name: '取消', exact: true }).click();
    await expect(frame.locator('#editor')).not.toBeVisible();
    await newPassport('OLD001234', 'archived');
    await newPassport('NEW005678', 'current');
    await expect(frame.locator('#records')).not.toContainText('OLD001234');
    await page.reload(); await setLanguage('zh-CN');
    await expect(frame.locator('#records article')).toHaveCount(2);
    await tab('签证');
    await frame.getByRole('button', { name: 'Add', exact: true }).click();
    const oldId = await frame.locator('#field-passportId option').evaluateAll(options => options.find(o => o.textContent.includes('旧护照')).value);
    await select('passportId', oldId); await fill('destination', '日本'); await fill('type', '旅游 · 多次往返');
    await fill('number', 'VISA123456'); await fill('validFrom', '2026-01-01'); await fill('validUntil', '2029-01-01');
    await fill('totalEntries', '5'); await fill('maxStayDays', '30'); await fill('remainingEntriesOverride', '3');
    await expect(frame.locator('#fields')).not.toContainText('手动剩余');
    await expect(frame.locator('#fields')).toContainText('剩余入境次数');
    await expect(frame.locator('#field-adjustmentReason')).toHaveCount(0);
    await fill('notes', '补录前已有两次入境'); await save();
    await expect(frame.locator('#records')).toContainText('3 次');
    await expect(frame.locator('#records')).not.toContainText('（手动）');
    await expect(frame.locator('#records')).toContainText('旧护照');
    await tab('出入境记录');
    await frame.getByRole('button', { name: 'Add', exact: true }).click();
    await fill('entryLocation', '东京羽田，日本');
    await fill('exitLocation', '首尔仁川，韩国');
    await assertDateRow();
    const stayOrder = await frame.locator('#fields .field').evaluateAll(fields => fields.map(field => field.dataset.key));
    assert.ok(stayOrder.indexOf('visaId') > stayOrder.indexOf('stayDaysOverride'));
    await expect(frame.locator('#field-adjustmentReason')).toHaveCount(0);
    const newId = await frame.locator('#field-passportId option').evaluateAll(options => options.find(o => o.value && !o.textContent.includes('旧护照')).value);
    await select('passportId', newId);
    const visaId = await frame.locator('#field-visaId option').nth(1).getAttribute('value');
    await select('visaId', visaId); await fill('entryDate', '2026-11-01'); await fill('exitDate', '2026-11-04');
    await expect(frame.locator('#fields')).not.toContainText('手动停留');
    await fill('stayDaysOverride', '0'); await save();
    await expect(frame.locator('#records')).toContainText('0 天');
    await expect(frame.locator('#records')).toContainText('东京羽田，日本');
    await expect(frame.locator('#records')).toContainText('首尔仁川，韩国');
    await frame.getByRole('button', { name: '编辑', exact: true }).click();
    await fill('stayDaysOverride', '');
    await fill('exitDate', '2026-11-05');
    await expect(frame.locator('#field-exitDate')).toHaveValue('2026-11-05');
    await fill('exitDate', '');
    await expect(frame.locator('#field-exitDate')).toHaveValue('');
    await save();
    await expect(frame.locator('#records')).toContainText('尚未离境');
    await frame.getByRole('button', { name: '编辑', exact: true }).click();
    await fill('exitDate', '2026-11-04');
    await save();
    await expect(frame.locator('#records')).toContainText('4 天');
    await page.reload(); await setLanguage('zh-CN'); await tab('出入境记录');
    await expect(frame.locator('#records')).toContainText('4 天');
    await expect(frame.locator('#records')).toContainText('5678');
    await expect(frame.locator('#records')).toContainText('日本 · 旅游');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(frame.getByRole('button', { name: 'Add' })).toBeVisible();
    assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true, 'mobile layout must not overflow horizontally');
    await frame.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(frame.getByRole('button', { name: '保存记录', exact: true })).toBeVisible();
    await assertDateRow();
    await expect(frame.locator('#field-entryDate')).toBeVisible();
    await expect(frame.locator('#field-entryDate')).toHaveAttribute('type', 'date');
    await frame.getByRole('button', { name: '取消', exact: true }).click();
    await expect(frame.locator('#editor')).not.toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await tab('签证');
    if (process.env.VISA_SCREENSHOT) {
      fs.mkdirSync(path.join(source, 'docs'), { recursive: true });
      await setLanguage('en');
      await frame.locator('body').screenshot({ path: path.join(source, 'docs/screenshot.png'), animations: 'disabled' });
      await setLanguage('zh-CN');
    }
    await frame.getByRole('button', { name: '删除', exact: true }).click();
    await answerDelete(false);
    await expect(frame.locator('#records article')).toHaveCount(1);
    await frame.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    await frame.getByRole('button', { name: '删除', exact: true }).click();
    await answerDelete();
    await expect(frame.locator('#error')).toContainText('仍有关联记录');
    await expect(frame.locator('#retry')).not.toBeVisible();
    await tab('出入境记录');
    await frame.getByRole('button', { name: '删除', exact: true }).click();
    await answerDelete();
    await expect(frame.getByRole('heading', { name: '还没有出入境记录' })).toBeVisible();
    await page.reload(); await setLanguage('zh-CN'); await tab('出入境记录');
    await expect(frame.getByRole('heading', { name: '还没有出入境记录' })).toBeVisible();
    await tab('签证申请');
    async function newApplication(status, place) {
      await frame.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(frame.locator('#field-adjustmentReason')).toHaveCount(0);
      await select('passportId', oldId);
      await fill('destination', '日本'); await fill('type', '旅游');
      await select('status', status); await fill('applicationLocation', place);
      await fill('submittedOn', '2026-10-01'); await fill('decidedOn', '2026-10-10');
      await fill('notes', status === 'refused' ? '材料不足，保留拒签历史' : '申请备注');
      await save();
    }
    await newApplication('refused', '上海签证中心');
    await expect(frame.locator('#records')).toContainText('拒签');
    await expect(frame.getByRole('button', { name: '生成签证', exact: true })).toHaveCount(0);
    await newApplication('reviewing', '线上申请');
    const reviewing = frame.locator('#records article').filter({ hasText: '审核中' });
    await reviewing.getByRole('button', { name: '编辑', exact: true }).click();
    await select('status', 'approved'); await save();
    await expect(frame.locator('#records article')).toHaveCount(2);
    await frame.getByRole('button', { name: '生成签证', exact: true }).click();
    await expect(frame.getByRole('heading', { name: '新增签证', exact: true })).toBeVisible();
    await expect(frame.locator('#field-passportId')).toHaveValue(oldId);
    await expect(frame.locator('#field-destination')).toHaveValue('日本');
    await expect(frame.locator('#field-type')).toHaveValue('旅游');
    const applicationId = await frame.locator('#field-applicationId').inputValue();
    assert.ok(applicationId);
    await fill('validFrom', '2026-11-01'); await fill('validUntil', '2027-11-01');
    await save();
    await expect(frame.locator('#records article')).toHaveCount(2);
    await tab('签证申请');
    await expect(frame.getByRole('button', { name: '生成签证', exact: true })).toHaveCount(0);
    const approved = frame.locator('#records article').filter({ hasText: '获批' });
    await approved.getByRole('button', { name: '编辑', exact: true }).click();
    await select('status', 'refused');
    await frame.getByRole('button', { name: '保存记录', exact: true }).click();
    await expect(frame.locator('#form-error')).toContainText('已关联签证');
    await frame.getByRole('button', { name: '取消', exact: true }).click();
    await approved.getByRole('button', { name: '删除', exact: true }).click();
    await answerDelete();
    await expect(frame.locator('#error')).toContainText('仍有关联记录');
    await page.reload(); await setLanguage('zh-CN'); await tab('签证申请');
    await expect(frame.locator('#records article')).toHaveCount(2);
    await expect(frame.locator('#records')).toContainText('拒签');
    await expect(frame.locator('#records')).toContainText('获批');
    if (process.env.VISA_SCREENSHOT) {
      await setLanguage('en');
      await frame.locator('body').screenshot({ path: path.join(source, 'docs/applications.png'), animations: 'disabled' });
      await setLanguage('zh-CN');
    }
    await tab('出入境记录');
    await tab('港澳通行证');
    await frame.getByRole('button', { name: 'Add', exact: true }).click();
    await fill('holder', '港澳演示用户'); await fill('number', 'H12345678');
    await select('status', 'current'); await fill('issuedOn', '2020-01-01'); await fill('expiresOn', '2030-01-01');
    await select('hkEndorsementType', 'personalTravel');
    await fill('hkEndorsementValidFrom', '2026-01-01'); await fill('hkEndorsementValidUntil', '2026-12-31'); await fill('hkEndorsementTotalEntries', '2');
    await save();
    await expect(frame.locator('#records')).toContainText('港澳演示用户');
    await expect(frame.locator('#records')).toContainText('香港签注');
    await expect(frame.locator('#overview .metric').filter({ hasText: 'HK & Macao permit records' }).locator('strong')).toHaveText('1');
    await tab('港澳出入境记录');
    await frame.getByRole('button', { name: 'Add', exact: true }).click();
    await select('permitId', await frame.locator('#field-permitId option').nth(1).getAttribute('value'));
    await select('destination', 'hongKong');
    await fill('entryDate', '2026-11-20'); await select('entryPort', 'luohu');
    await fill('exitDate', '2026-11-21'); await select('exitPort', 'shenzhenBay');
    await save();
    await expect(frame.locator('#records')).toContainText('罗湖');
    await expect(frame.locator('#overview .metric').filter({ hasText: 'HK & Macao crossings' }).locator('strong')).toHaveText('1');
    await tab('港澳通行证');
    await expect(frame.locator('#records')).toContainText('1 次 / 2 次');
    assert.deepEqual(errors, []);
    console.log('Browser smoke passed: visa and permit records, endorsement usage counts, selectable HK/Macao ports, visa application outcomes, independent locations, native date inputs and constraints, date row layout, loading failure retry, language handling, persistence, guarded deletion, and mobile layout.');
  } finally {
    if (browser) await browser.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
