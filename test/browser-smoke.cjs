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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.message); });
    let recordReads = 0;
    let releaseInitialLoad;
    const initialLoad = new Promise(resolve => { releaseInitialLoad = resolve; });
    await page.route('**/api/records?**', async route => {
      recordReads += 1;
      if (recordReads === 1) {
        await initialLoad;
        return route.fulfill({ status: 503, json: { error: 'Temporary test failure' } });
      }
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
    await expect(frame.locator('#notice')).toHaveText('Loading records…');
    await expect(frame.locator('#records')).toHaveAttribute('aria-busy', 'true');
    await expect(frame.locator('#add')).toBeDisabled();
    releaseInitialLoad();
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
    await expect.poll(() => frame.locator('body').evaluate(() => window.innerWidth)).toBeLessThanOrEqual(390);
    assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true, 'English mobile layout must fit the viewport');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await expect.poll(() => frame.locator('body').evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(900);
    const [toolbarBox, tabsBox, actionsBox] = await frame.locator('.toolbar').evaluate(toolbar =>
      [toolbar, toolbar.querySelector('#tabs'), toolbar.querySelector('.actions')]
        .map(node => node.getBoundingClientRect().toJSON()));
    assert.ok(tabsBox && actionsBox &&
      Math.abs((tabsBox.y + tabsBox.height / 2) - (actionsBox.y + actionsBox.height / 2)) < 1,
    `desktop tabs and actions should be centered on the same row: ${JSON.stringify({ toolbarBox, tabsBox, actionsBox })}`);
    assert.ok(toolbarBox && tabsBox && actionsBox && tabsBox.width <= toolbarBox.width - actionsBox.width - 11, 'tab background should wrap its labels instead of filling the toolbar');
    assert.ok(toolbarBox && actionsBox && toolbarBox.x + toolbarBox.width - actionsBox.x - actionsBox.width < 2, 'toolbar actions should stay at the far right');
    await setLanguage('de-DE');
    await expect(frame.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
    async function fill(key, value) {
      await frame.locator(`#field-${key}`).fill(value);
    }
    async function select(key, value) { await frame.locator(`#field-${key}`).selectOption(value, { force: true }); }
    async function save() {
      await frame.getByRole('button', { name: '保存记录', exact: true }).click();
      await expect(frame.locator('#editor')).not.toBeVisible();
      await expect(frame.locator('#records')).toHaveAttribute('aria-busy', 'false');
      await expect(frame.locator('#save')).toBeEnabled();
    }
    async function tab(name) {
      const button = frame.getByRole('tab', { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await expect(button).toHaveAttribute('aria-selected', 'true');
    }
    async function answerDelete(button, yes = true) {
      const confirmation = page.waitForEvent('dialog', { timeout: 5000 }).then(async dialog => {
        assert.equal(dialog.type(), 'confirm');
        assert.match(dialog.message(), /删除/);
        if (yes) await dialog.accept();
        else await dialog.dismiss();
      });
      await Promise.all([confirmation, button.click()]);
    }
    async function newPassport(number, status) {
      await frame.locator('#add').click();
      await fill('holder', '演示用户'); await fill('number', number); await fill('country', '中国');
      await select('status', status); await fill('issuedOn', '2020-01-01'); await fill('expiresOn', '2030-01-01');
      await expect(frame.locator('#field-expiresOn')).toHaveAttribute('type', 'date');
      await expect(frame.locator('#field-expiresOn')).toHaveAttribute('min', '1900-01-01');
      await expect(frame.locator('#field-expiresOn')).toHaveAttribute('max', '2199-12-31');
      await save();
    }
    // Locale changes must retain unsaved values in native date inputs.
    await frame.locator('#add').click();
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
    await frame.locator('#add').click();
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
    const records = frame.locator('#records');
    const cards = records.locator('article');
    const editor = frame.locator('#editor');
    const formError = frame.locator('#form-error');
    const saveButton = frame.locator('#save');
    const outbound = cards.filter({ hasText: '从中国出境 → 进入日本' });
    const returnLeg = cards.filter({ hasText: '从日本出境 → 进入中国' });
    await expect(records.getByRole('heading', { name: '还没有出入境记录' })).toBeVisible();
    await records.getByRole('button', { name: '新增', exact: true }).click();
    await expect(frame.locator('#editor-title')).toBeFocused();
    await expect(frame.locator('#field-departureCountry')).not.toBeFocused();
    await expect(frame.locator('#field-departureCountry')).toHaveValue('');
    const order = await frame.locator('#fields .field').evaluateAll(fields => fields.map(field => field.dataset.key));
    assert.ok(order.indexOf('departureCountry') < order.indexOf('arrivalCountry'));
    await expect(frame.locator('#field-returnDeparturePlace')).not.toBeVisible();
    await expect(frame.locator('#field-exitDate')).toHaveCount(0);
    await saveButton.click();
    await expect(formError).toContainText('出境国家');
    await expect(cards).toHaveCount(0);
    await select('departureCountry', 'CN'); await select('arrivalCountry', 'CN');
    await fill('crossingDate', '2026-11-01');
    const newId = await frame.locator('#field-passportId option').evaluateAll(options => options.find(o => o.value && !o.textContent.includes('旧护照')).value);
    await select('passportId', newId);
    await saveButton.click();
    await expect(formError).toContainText('不能相同');
    await select('arrivalCountry', 'JP');
    await fill('crossingDate', '2200-01-01');
    await saveButton.click();
    await expect(formError).toContainText('日期不正确');
    await fill('crossingDate', '2026-11-01');
    await fill('departurePlace', '上海浦东'); await fill('arrivalPlace', '东京羽田');
    await expect(frame.locator('#field-returnDate')).toHaveValue('');
    await save();
    await expect(cards).toHaveCount(1);
    await expect(outbound).toContainText('上海浦东');
    await expect(outbound).toContainText('东京羽田');
    await expect(outbound).toContainText('2026-11-01');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => frame.locator('body').evaluate(() => window.innerWidth)).toBeLessThanOrEqual(390);
    await frame.locator('#add').click();
    await select('departureCountry', 'CN'); await select('arrivalCountry', 'JP');
    await fill('crossingDate', '2026-11-05'); await fill('returnDate', '2026-11-04');
    await select('passportId', newId);
    const visaId = await frame.locator('#field-visaId option').nth(1).getAttribute('value');
    await select('visaId', visaId);
    await saveButton.click();
    await expect(formError).toContainText('返程日期不能早于');
    await expect(cards).toHaveCount(1);
    await fill('returnDate', '2026-11-10');
    await expect(frame.locator('#return-route')).toHaveText('从日本出境 → 进入中国');
    await fill('returnDeparturePlace', '东京成田'); await fill('returnArrivalPlace', '上海虹桥');
    await setLanguage('en');
    await expect(frame.locator('#field-departureCountry')).toHaveValue('CN');
    await expect(frame.locator('#field-returnDate')).toHaveValue('2026-11-10');
    await expect(frame.locator('#field-returnDeparturePlace')).toHaveValue('东京成田');
    await expect(frame.locator('#return-route')).toHaveText('Leave Japan → Enter China');
    await setLanguage('zh-CN');
    assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true, 'mobile page must fit the viewport');
    assert.equal(await editor.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true, 'mobile form must fit the viewport');
    await expect(saveButton).toBeVisible();

    let releaseSave;
    const pendingSave = new Promise(resolve => { releaseSave = resolve; });
    const savePath = '**/api/stays/save?**';
    const failSave = async route => {
      await pendingSave;
      await route.fulfill({ status: 503, json: { error: 'Temporary test failure' } });
    };
    await page.route(savePath, failSave);
    await saveButton.click();
    await expect(saveButton).toHaveText('正在保存…');
    await expect(saveButton).toBeDisabled();
    releaseSave();
    await expect(formError).toContainText('请再次点击“保存记录”重试');
    await expect(saveButton).toBeEnabled();
    await expect(frame.locator('#field-returnDate')).toHaveValue('2026-11-10');
    await expect(cards).toHaveCount(1);
    await page.unroute(savePath, failSave);
    await save();
    await expect(cards).toHaveCount(3);
    await expect(outbound).toHaveCount(2);
    await expect(returnLeg).toContainText('2026-11-10');
    await expect(returnLeg).toContainText('东京成田');
    await expect(returnLeg).toContainText('上海虹桥');

    await page.reload(); await setLanguage('zh-CN'); await tab('出入境记录');
    await expect(cards).toHaveCount(3);
    await expect(records).toHaveAttribute('aria-busy', 'false');
    const editReturn = returnLeg.getByRole('button', { name: '编辑', exact: true });
    await editReturn.scrollIntoViewIfNeeded();
    await editReturn.click();
    await expect(editor).toBeVisible();
    await expect(frame.locator('#field-departureCountry')).toHaveValue('JP');
    await expect(frame.locator('#field-arrivalCountry')).toHaveValue('CN');
    await expect(frame.locator('#field-returnDate')).toHaveCount(0);
    await fill('arrivalPlace', '深圳宝安');
    await save();
    await expect(returnLeg).toContainText('深圳宝安');
    await expect(outbound).toHaveCount(2);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await tab('签证');
    if (process.env.VISA_SCREENSHOT) {
      fs.mkdirSync(path.join(source, 'docs'), { recursive: true });
      await setLanguage('en');
      await frame.locator('body').screenshot({ path: path.join(source, 'docs/screenshot.png'), animations: 'disabled' });
      await setLanguage('zh-CN');
    }
    const deleteButton = frame.getByRole('button', { name: '删除', exact: true });
    await answerDelete(deleteButton, false);
    await expect(frame.locator('#records article')).toHaveCount(1);
    await answerDelete(deleteButton);
    await expect(frame.locator('#error')).toContainText('仍有关联记录');
    await expect(frame.locator('#retry')).not.toBeVisible();
    await tab('出入境记录');
    for (let remaining = 3; remaining > 0; remaining -= 1) {
      await answerDelete(cards.first().getByRole('button', { name: '删除', exact: true }));
      await expect(cards).toHaveCount(remaining - 1);
    }
    await expect(frame.getByRole('heading', { name: '还没有出入境记录' })).toBeVisible();
    await page.reload(); await setLanguage('zh-CN'); await tab('出入境记录');
    await expect(frame.getByRole('heading', { name: '还没有出入境记录' })).toBeVisible();
    await tab('签证申请');
    async function newApplication(status, place) {
      await frame.locator('#add').click();
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
    await answerDelete(approved.getByRole('button', { name: '删除', exact: true }));
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
    await frame.locator('#add').click();
    await fill('holder', '港澳演示用户'); await fill('number', 'H12345678');
    await select('status', 'current'); await fill('issuedOn', '2020-01-01'); await fill('expiresOn', '2030-01-01');
    await select('hkEndorsementType', 'personalTravel');
    await fill('hkEndorsementValidFrom', '2026-01-01'); await fill('hkEndorsementValidUntil', '2026-12-31'); await fill('hkEndorsementTotalEntries', '2');
    await save();
    await expect(frame.locator('#records')).toContainText('港澳演示用户');
    await expect(frame.locator('#records')).toContainText('香港签注');
    await expect(frame.locator('#overview .metric').filter({ hasText: '港澳通行证档案' }).locator('strong')).toHaveText('1');
    await tab('港澳出入境记录');
    await expect(frame.getByRole('heading', { name: '还没有港澳出入境记录' })).toBeVisible();
    await frame.locator('#add').click();
    const permitId = await frame.locator('#field-permitId option').nth(1).getAttribute('value');
    await select('permitId', permitId);
    await select('destination', 'hongKong');
    await fill('entryDate', '2026-11-20'); await select('entryPort', 'luohu');
    const exitPort = frame.locator('#field-exitPort');
    const exitField = frame.locator('.field[data-key="exitPort"]');
    const exitTrigger = exitField.getByRole('button');
    async function chooseExitPort(name) {
      await exitTrigger.click();
      await exitField.getByRole('option', { name, exact: true }).click();
    }
    await expect(exitPort).toHaveClass(/trek-select-native-hidden/);
    await expect(exitField).toBeHidden();
    await fill('exitDate', '2026-11-21');
    await expect(exitTrigger).toBeVisible();
    await expect(exitPort).toHaveJSProperty('required', true);
    await chooseExitPort('深圳湾');
    await save();
    const crossing = destination => frame.locator('#records article').filter({ has: frame.getByRole('heading', { name: destination, exact: true }) });
    const hongKong = crossing('香港');
    const departureDetail = card => card.locator('.details > div').filter({ has: frame.getByText('离境口岸', { exact: true }) }).locator('dd');
    await expect(hongKong.locator('.record-subtitle')).toHaveText('罗湖 / 罗湖口岸 → 深圳湾');
    await expect(departureDetail(hongKong)).toHaveText('深圳湾');
    await expect(frame.locator('#overview .metric').filter({ hasText: '港澳出入境记录' }).locator('strong')).toHaveText('1');
    await tab('港澳通行证');
    await expect(frame.locator('#records')).toContainText('1 次 / 2 次');

    await tab('港澳出入境记录');
    await hongKong.getByRole('button', { name: '编辑', exact: true }).click();
    await expect(exitPort).toHaveValue('shenzhenBay');
    await fill('exitDate', '');
    await expect(exitField).toBeHidden();
    await save();
    await expect(hongKong.locator('.record-subtitle')).toHaveText('罗湖 / 罗湖口岸 → 尚未离境');
    await expect(departureDetail(hongKong)).toHaveText('未填写');

    await frame.locator('#add').click();
    await select('permitId', permitId);
    await select('destination', 'macao');
    await fill('entryDate', '2026-11-20'); await select('entryPort', 'gongbei');
    await fill('exitDate', '2026-11-21');
    await chooseExitPort('横琴 / 莲花口岸');
    await setLanguage('en');
    await expect(exitPort).toHaveValue('hengqin');
    await expect(frame.locator('#field-entryPort')).toHaveValue('gongbei');
    await chooseExitPort('Other (enter port name)');
    await fill('exitPortOther', '澳门临时客运码头');
    await setLanguage('zh-CN');
    await expect(frame.locator('#field-exitPortOther')).toHaveValue('澳门临时客运码头');
    await save();

    const macao = crossing('澳门');
    await expect(macao.locator('.record-subtitle')).toHaveText('拱北 / 关闸 → 澳门临时客运码头');
    await expect(departureDetail(macao)).toHaveText('澳门临时客运码头');
    await page.reload(); await setLanguage('zh-CN'); await tab('港澳出入境记录');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => frame.locator('body').evaluate(() => window.innerWidth <= 390)).toBe(true);
    await expect(macao.locator('.record-subtitle')).toBeVisible();
    await expect(departureDetail(macao)).toHaveText('澳门临时客运码头');
    assert.equal(await frame.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true, 'crossings must fit the mobile viewport');
    // The real page host uses fill mode. Width-only previews leave body scrolling
    // enabled and cannot catch a missing scroll container inside the plugin.
    const phoneContext = await browser.newContext({
      viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true,
    });
    try {
      const phone = await phoneContext.newPage();
      phone.on('pageerror', error => errors.push(error.message));
      await phone.goto(`http://127.0.0.1:${port}/preview`);
      await phone.addStyleTag({ content: `
        html, body, .stage, .wrap { height: 100%; }
        body { overflow: hidden; }
        header, .hint { display: none !important; }
        .stage { padding: 0; }
        iframe { height: 100% !important; }
      ` });
      const phoneFrame = phone.frameLocator('iframe');
      await expect(phoneFrame.locator('#records')).toHaveAttribute('aria-busy', 'false');
      const context = await phoneFrame.locator('body').evaluate(() => window.trek.context);
      await phone.evaluate(context => {
        document.querySelector('iframe').contentWindow.postMessage({
          ...context,
          viewport: { formFactor: 'phone', surface: 'plugin-page', fill: true },
        }, '*');
      }, context);
      await expect(phoneFrame.locator('html')).toHaveAttribute('data-fill', '');
      const scroller = phoneFrame.locator('main');
      const session = await phoneContext.newCDPSession(phone);
      await session.send('Input.synthesizeScrollGesture', {
        x: 190, y: 640, yDistance: -400, speed: 600,
        gestureSourceType: 'touch', preventFling: true,
      });
      await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(100);
      async function assertDateFieldsFit() {
        const layout = await phoneFrame.locator('#editor').evaluate(dialog => ({
          fits: dialog.scrollWidth <= dialog.clientWidth,
          dates: [...dialog.querySelectorAll('input[type="date"]')].filter(input => input.getClientRects().length).map(input => ({
            name: input.name,
            width: input.getBoundingClientRect().width,
            available: input.parentElement.getBoundingClientRect().width,
          })),
        }));
        assert.equal(layout.fits, true, 'date fields must not make the dialog scroll horizontally');
        for (const input of layout.dates) {
          assert.ok(input.width <= input.available + 1, `${input.name} must fit its form column`);
        }
      }
      for (const recordKind of ['passports', 'visas', 'applications', 'stays', 'permits', 'permitStays']) {
        await phoneFrame.locator(`#tab-${recordKind}`).tap();
        await expect(phoneFrame.locator(`#tab-${recordKind}`)).toHaveAttribute('aria-selected', 'true');
        await phoneFrame.locator('#add').tap();
        await expect(phoneFrame.locator('#editor')).toBeVisible();
        await expect(phoneFrame.locator('#editor-title')).toBeFocused();
        await expect(phoneFrame.locator('#close')).not.toBeFocused();
        await phoneFrame.locator('#cancel').tap();
        await expect(phoneFrame.locator('#editor')).toBeHidden();
      }
      await phoneFrame.locator('#tab-stays').tap();
      await expect(phoneFrame.locator('#tab-stays')).toHaveAttribute('aria-selected', 'true');
      await phoneFrame.locator('#add').tap();
      await expect(phoneFrame.locator('#editor')).toBeVisible();
      await assertDateFieldsFit();
      await phoneFrame.locator('#field-departureCountry').selectOption('CN');
      await phoneFrame.locator('#field-arrivalCountry').selectOption('JP');
      await phoneFrame.locator('#field-crossingDate').fill('2026-11-24');
      await phoneFrame.locator('#field-returnDate').fill('2026-11-25');
      await assertDateFieldsFit();
      await phoneFrame.locator('#field-returnDate').fill('');
      await phoneFrame.locator('#field-passportId').selectOption(newId, { force: true });
      await phoneFrame.locator('#save').tap();
      await expect(phoneFrame.locator('#editor')).toBeHidden();
      const phoneCards = phoneFrame.locator('#records article');
      await expect(phoneCards).toHaveCount(1);
      await phoneCards.getByRole('button', { name: 'Edit', exact: true }).tap();
      await expect(phoneFrame.locator('#editor')).toBeVisible();
      await phoneFrame.locator('#cancel').tap();
      await expect(phoneFrame.locator('#editor')).toBeHidden();
      await phoneFrame.locator('#tab-passports').tap();
      await expect(phoneFrame.locator('#tab-passports')).toHaveAttribute('aria-selected', 'true');
    } finally {
      await phoneContext.close();
    }
    assert.deepEqual(errors, []);
    console.log('Browser smoke passed: visa and permit records, endorsement usage counts, HK/Macao departure port selection and display, visa application outcomes, single and paired crossings, departure first selection, reverse return routes, native date validation, loading and saving failure retry, language handling, persistence, guarded deletion, mobile layout, and full-page phone touch scrolling, buttons, and date field widths.');
  } finally {
    if (browser) await browser.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
