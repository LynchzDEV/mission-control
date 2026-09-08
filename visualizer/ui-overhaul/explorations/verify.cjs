const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const catalog = JSON.parse(read('catalog.js'));
async function staticChecks() {
  assert.equal(catalog.length, 20);
  assert.equal(new Set(catalog.map(d => d.id)).size, 20);
  const styles = new Set();
  const assets = new Set(['index.html', 'gallery.css', 'gallery.js', 'catalog.js', 'runtime.js', 'shared.css', 'tokens.css']);
  for (const d of catalog) {
    assert.equal(d.ready, true, d.name + ' is pending');
    const html = read(d.file);
    assert.equal((html.match(/data-terminal=/g) || []).length, 2, d.name);
    assert.equal((html.match(/<canvas/g) || []).length, 1, d.name);
    assert.match(html, /Commands and messages are simulated/);
    assert.match(html, /data-action="chat"/);
    assert.match(html, /name="viewport"/);
    for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      assert.ok(!/^https?:/.test(match[1]), 'Remote asset: ' + match[1]);
      assert.ok(fs.existsSync(path.resolve(root, match[1])), 'Missing ' + match[1]);
      assets.add(match[1]);
    }
    assets.add(d.file);
    const css = read(d.file.replace('.html', '.css'));
    for (const match of css.matchAll(/url\(['"]?([^)'"]+)/g)) { assert.ok(fs.existsSync(path.resolve(root, match[1])), 'Missing CSS asset ' + match[1]); assets.add(match[1]); }
    styles.add(css.replace(/#[0-9a-f]{3,8}/gi, 'COLOR'));
    assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, d.name + ' CSS braces');
  }
  assert.equal(styles.size, 20, 'Duplicate visual stylesheet');
  for (const file of ['runtime.js', 'gallery.js', 'catalog.js', 'verify.cjs']) new vm.Script(read(file), { filename: file });
  const runtime = read('runtime.js');
  assert.ok(!/localStorage|sessionStorage|XMLHttpRequest|\bfetch\(/.test(runtime), 'Runtime has external effects');
  assert.match(runtime, /\.textContent=s\.lines\.join/);
  assert.match(read('shared.css'), /prefers-reduced-motion/);
  for (const asset of assets) {
    const response = await fetch('http://127.0.0.1:47831/explorations/' + asset);
    assert.equal(response.status, 200, 'Static route ' + asset);
  }
  console.log(`PASS: 20 ready pages, 20 distinct stylesheets, 2 terminals/page, JS syntax, asset references, ${assets.size} local HTTP routes. No browser used.`);
}
async function browserChecks() {
  const { chromium } = require('/Users/lynchz/.npm/_npx/9833c18b2d85bc59/node_modules/playwright');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { noDefaults: true });
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://127.0.0.1:47831/explorations/'));
  assert.ok(page, 'Open an owned explorations tab in Arc first.');
  const originalURL = page.url();
  const wait = (predicate, argument) => page.waitForFunction(predicate, argument, { polling: 100 });
  await page.bringToFront();
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height }));
  const cdp = await page.context().newCDPSession(page);
  const errors = [];
  const onError = error => errors.push(String(error));
  page.on('pageerror', onError);
  const metric = async (width, height) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: original.deviceScaleFactor, mobile: false });
    await wait(([w,h]) => innerWidth === w && innerHeight === h, [width,height]);
  };
  try {
    fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
    for (const d of catalog) {
      await page.bringToFront();
      await page.goto('http://127.0.0.1:47831/explorations/' + d.file);
      await metric(1512, 909);
      await wait(() => typeof window.previewState === 'function');
      assert.equal(await page.locator('[data-terminal]:visible').count(), 2, d.name);
      assert.equal(await page.locator('dialog[open]').count(), 0);
      await page.locator('#command-0').fill('draft <sample>');
      await page.locator('[data-action="focus"]').click();
      assert.equal(await page.locator('[data-terminal]:visible').count(), 1);
      await page.locator('[data-action="split"]').click();
      assert.equal(await page.locator('[data-action="focus"]').textContent(), 'Focus');
      assert.equal(await page.locator('#command-0').inputValue(), 'draft <sample>');
      await page.locator('[data-action="split"]').click();
      await page.locator('#command-0').press('Enter');
      assert.ok((await page.locator('[data-terminal="0"] pre').textContent()).includes('$ draft <sample>'));
      assert.equal(await page.locator('[data-terminal="0"] pre sample').count(), 0);
      await page.locator('[data-terminal="1"] [data-select]').click();
      await page.locator('[data-action="chat"]').click();
      assert.match(await page.locator('#panel-title').textContent(), /Review/);
      await page.locator('#chat-form button').click();
      assert.match(await page.locator('#chat-feedback').textContent(), /Write a message/);
      await page.locator('#chat-input').fill('Retained draft');
      await page.locator('#close-panel').click();
      await page.locator('[data-action="chat"]').click();
      assert.equal(await page.locator('#chat-input').inputValue(), 'Retained draft');
      await page.locator('#chat-form button').click();
      assert.match(await page.locator('#chat-messages').textContent(), /Retained draft/);
      await page.locator('#agent-state').uncheck();
      assert.equal(await page.locator('#chat-input').isDisabled(), true);
      assert.match(await page.locator('#chat-messages').textContent(), /No agent attached/);
      await page.locator('#agent-state').check();
      await page.locator('#close-panel').click();
      for (const panel of ['main', 'usage', 'settings']) {
        await page.locator(`[data-action="${panel}"]`).click();
        assert.equal(await page.locator('dialog[open]').count(), 1);
        if (panel === 'main') assert.match(await page.locator('#panel-body').textContent(), /manual/);
        if (panel === 'usage') assert.match(await page.locator('#panel-body').textContent(), /different provider measures/);
        if (panel === 'settings') { await page.locator('#type-size').selectOption('large'); await page.locator('#type-size').selectOption('normal'); }
        await page.locator('#close-panel').click();
      }
      const before = await page.locator('canvas').evaluate(c => c.toDataURL());
      await wait(previous => document.querySelector('canvas').toDataURL() !== previous, before);
      await page.locator('[data-action="motion"]').click();
      const still = await page.locator('canvas').evaluate(c => c.toDataURL());
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await page.locator('canvas').evaluate(c => c.toDataURL()), still, 'Paused canvas changed');
      await page.locator('[data-action="motion"]').click();
      await wait(previous => document.querySelector('canvas').toDataURL() !== previous, still);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await wait(() => previewState().stopped);
      const reduced = await page.locator('canvas').evaluate(c => c.toDataURL());
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await page.locator('canvas').evaluate(c => c.toDataURL()), reduced, 'Reduced-motion canvas changed');
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
      for (const width of [1512, 1000, 768, 375, 320]) {
        await metric(width, 909);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, d.name + ' overflow at ' + width);
        for (const selector of ['#command-0','#command-1','[data-action="chat"]']) {
          const box = await page.locator(selector).boundingBox();
          assert.ok(box && box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1, d.name + ' inaccessible ' + selector);
        }
      }
      await page.reload();
      await metric(1512, 909);
      await wait(() => typeof previewState === 'function');
      await page.screenshot({ path: path.join(root, 'screenshots', d.id + '.png') });
      console.log('PASS browser:', d.id, d.name);
    }
    await page.goto('http://127.0.0.1:47831/explorations/index.html');
    await wait(() => document.querySelectorAll('#choice option').length === 20);
    assert.equal(await page.locator('iframe').count(), 1);
    await page.locator('#next').click();
    assert.equal(await page.locator('#choice').inputValue(), '1');
    await page.locator('#prev').click();
    await page.locator('#next').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#choice').inputValue(), '1');
    await page.frameLocator('iframe').locator('#command-0').fill('typing');
    await page.frameLocator('iframe').locator('#command-0').press('ArrowLeft');
    assert.equal(await page.locator('#choice').inputValue(), '1');
    assert.equal(await page.locator('iframe').count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS gallery and all twenty interaction/viewport checks.');
  } finally {
    page.off('pageerror', onError);
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await page.goto(originalURL);
    try {
      await page.waitForFunction(({width,height}) => innerWidth === width && innerHeight === height, original, { polling: 100, timeout: 3000 });
    } catch {
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...original, mobile: false });
    }
    await wait(({width,height}) => innerWidth === width && innerHeight === height, original);
    await cdp.detach();
  }
}
const run = process.argv.includes('--cdp') ? browserChecks : staticChecks;
run().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
