'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  let browser, page;
  const errors = [];
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { noDefaults: true });
    assert.ok(browser.contexts()[0], 'Existing browser context required');
    page = await browser.contexts()[0].newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:47831/motion.html');
    await page.bringToFront();
    const click = selector => page.locator(selector).evaluate(el => el.click());
    const fill = (selector, text) => page.locator(selector).fill(text);
    const contains = async (selector, text) => assert.ok((await page.locator(selector).textContent()).includes(text), `${selector}: expected ${text}`);
    const waitPaused = () => page.waitForFunction(() => document.querySelector('#motion-toggle').textContent.includes('Resume'), null, { polling: 100 });
    const frames = async moving => {
      const before = await page.locator('#atmosphere').evaluate(el => el.toDataURL());
      await page.waitForTimeout(500);
      const after = await page.locator('#atmosphere').evaluate(el => el.toDataURL());
      assert.equal(before !== after, moving, moving ? 'Canvas must evolve' : 'Canvas must freeze');
    };
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await frames(true);
    await click('#motion-toggle'); await frames(false);
    await click('#motion-toggle'); await frames(true);
    await page.emulateMedia({ reducedMotion: 'reduce' }); await waitPaused(); await frames(false);
    await click('#tab-2'); await contains('#engine-label', 'Claude');
    await click('.send'); await contains('#compose-note', 'Enter a message');
    await fill('#message', 'Keep this draft'); await click('#tab-1');
    await fill('#message', 'Sample request <safe>'); await click('.send');
    await contains('#transcript', 'Sample request <safe>'); await contains('#transcript', 'Sample reply');
    await click('#tab-2'); assert.equal(await page.locator('#message').inputValue(), 'Keep this draft');
    await fill('#term-search', 'no-such-output-xyz'); await click('#find-next'); await contains('#find-status', 'No matches');
    await fill('#term-search', 'model'); await click('#find-next'); await contains('#find-status', ' of ');
    await click('#agent-1'); await click('#agent-talk');
    await click('#talk-send'); await contains('#talk-feedback', 'Enter a message');
    await fill('#talk-message', 'Keep the tabs visible'); await click('#talk-send');
    await contains('#talk-thread', 'Keep the tabs visible'); await contains('#talk-thread', 'Sample reply');
    await click('[data-close="talk-dialog"]');
    await click('#agent-log-toggle'); assert.ok(await page.locator('.agent-log').isVisible());
    await click('#agent-stop'); await click('#confirm-stop');
    await contains('#agents-recent', 'UI overhaul'); await contains('#status', 'moved to Recent');
    await click('#new-terminal');
    await page.locator('#session-model').selectOption('custom'); await fill('#custom-model', 'custom-model');
    await page.locator('#session-engine').selectOption('GLM');
    assert.equal(await page.locator('#session-model').inputValue(), 'default');
    assert.ok(!(await page.locator('#custom-label').isVisible()));
    assert.equal(await page.locator('#custom-model').inputValue(), '');
    await contains('#session-model', 'glm-5.3-flash');
    await fill('#session-name', 'Smoke terminal'); await fill('#session-repo', ' ');
    await click('#create-terminal'); await contains('#new-feedback', 'required');
    await fill('#session-repo', '~/other-repo'); await click('#create-terminal');
    await contains('#engine-label', 'GLM'); await contains('#model-label', 'glm-5.3-flash');
    await page.locator('#agents-scope').selectOption('attached');
    await contains('#agents-running', 'No running agents'); await contains('#agent-detail', 'No agent attached');
    await click('#rename-terminal'); await fill('#rename-name', ' '); await click('#save-name');
    await contains('#rename-feedback', 'non-empty');
    await fill('#rename-name', 'Smoke terminal'); await click('#save-name'); await contains('#rename-feedback', 'unchanged');
    await fill('#rename-name', 'Renamed terminal'); await click('#save-name'); await contains('#tabs', 'Renamed terminal');
    await click('#agents-toggle'); assert.equal(await page.locator('#agents-toggle').getAttribute('aria-expanded'), 'false');
    await click('#agents-toggle');
    while (await page.locator('.close-session').count()) await page.locator('.close-session').first().evaluate(el => el.click());
    await contains('#transcript', 'No sessions attached'); assert.ok(!(await page.locator('#composer').isVisible()));
    await click('#resume-terminal'); await fill('#resume-repo', '/missing-repository');
    await contains('#resume-list', 'No historical sessions');
    await fill('#resume-repo', 'mission-control'); await page.locator('.resume-row').first().evaluate(el => el.click());
    await contains('#tabs', 'resumed'); assert.ok(await page.locator('#composer').isVisible());
    await page.locator('#agents-scope').selectOption('all'); await contains('#agents-recent', 'Stopped');
    await page.emulateMedia({ reducedMotion: null });
    assert.deepEqual(errors, [], 'No page errors');
    console.log('Motion terminal smoke check passed');
  } finally {
    try { if (page) await page.close(); }
    finally { if (browser) await browser.close(); }
  }
})().catch(error => {
  console.error(`Motion smoke check failed: ${error.message.split('\n')[0]}`);
  process.exitCode = 1;
});
