const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

const origin = 'http://127.0.0.1:47831'
const pages = ['lanes', 'dispatch', 'terminals', 'review', 'settings']
const widths = [320, 375, 414, 768, 1280, 1440]

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const results = []
  const errors = []
  const requests = new Set()
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => requests.add(request.url()))
    for (const variant of ['a', 'b', 'c']) {
      for (const name of pages) {
        await page.goto(`${origin}/#${variant}/${name}`)
        await page.locator('h1').waitFor()
        assert.equal(await page.locator('body').getAttribute('data-variant'), variant)
        assert.equal((await page.locator('h1').innerText()).toLowerCase(), name)
        for (const width of widths) {
          await page.setViewportSize({ width, height: width < 800 ? 900 : 960 })
          const layout = await page.evaluate(() => {
            const clipped = [...document.querySelectorAll('button, input, select, textarea, h1, h2, nav a')].flatMap(element => {
              const rect = element.getBoundingClientRect()
              if (!rect.width || !rect.height || (rect.left >= -1 && rect.right <= innerWidth + 1)) return []
              for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) return []
              }
              return [{ text: (element.textContent || element.getAttribute('aria-label') || element.tagName).trim().slice(0, 80), left: rect.left, right: rect.right }]
            })
            return { documentWidth: document.documentElement.scrollWidth, viewport: innerWidth, clipped }
          })
          results.push({ variant, page: name, width, ...layout })
          if (width === 1440 || (width === 375 && name === 'terminals')) {
            await page.screenshot({ path: join(__dirname, `${variant}-${name}-${width}.png`), fullPage: true })
          }
        }
      }
    }
    const unexpectedRequests = [...requests].filter(url => !url.startsWith(`${origin}/`) || new URL(url).pathname.startsWith('/api/'))
    const overflow = results.filter(result => result.documentWidth > result.viewport || result.clipped.length)
    writeFileSync(join(__dirname, 'layout-results.json'), JSON.stringify({ cases: results.length, errors, unexpectedRequests, overflow, results }, null, 2))
    assert.deepEqual(errors, [], 'Browser runtime errors')
    assert.deepEqual(unexpectedRequests, [], 'The preview must use only its local static assets')
    assert.deepEqual(overflow, [], 'Responsive controls overflow the viewport; see layout-results.json')
    console.log(`Passed ${results.length} layout cases; no runtime errors or live API requests.`)
  } finally {
    await browser.close()
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
