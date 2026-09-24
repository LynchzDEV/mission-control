import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

await mkdir(new URL('./screenshots/', import.meta.url), { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
let creates = 0
let writes = ''
let sizes = 0
let rejectDirectory = true
let activity = false
let unavailable = false
let failOptions = false
let lastCreate
const records = []
const session = { id: 'test-terminal', engine: 'claude', cwd: '/example/project', title: 'Claude Code' }
await page.route('**/api/terminals', route => {
  if (route.request().method() === 'POST') {
    if (rejectDirectory) return route.fulfill({ status: 400, json: { error: 'directory does not exist' } })
    creates++
    lastCreate = route.request().postDataJSON()
    const record = { ...session, id: creates === 1 ? session.id : `${session.id}-${creates}`, engine: lastCreate.engine, cwd: lastCreate.cwd }
    records.push(record)
    return route.fulfill({ json: record })
  }
  return route.fulfill({ json: { sessions: records } })
})
await page.route('**/api/models', route => failOptions ? route.fulfill({ status: 503, json: { error: 'models unavailable' } }) : route.fulfill({ json: { claude: ['opus'], codex: ['test-codex'], glm: ['test-glm'], custom: ['custom-model'] } }))
await page.route('**/api/roles', route => route.fulfill({ json: { plan: { engine: 'claude', model: 'opus' } } }))
await page.route('**/api/studio/workflows', route => route.fulfill({ json: { selected: { id: 'default', revision: 'v1', name: 'Default flow' }, workflows: [{ id: 'review', revision: 'v2', name: 'Review flow' }] } }))
await page.route('**/api/jobs', route => {
  if (unavailable) return route.fulfill({ status: 503, json: { error: 'offline' } })
  const base = { engine: 'codex', cwd: session.cwd, status: 'running', startedAt: Date.now(), endedAt: null, reviewedAt: null, diffStat: '', worktree: null }
  return route.fulfill({ json: { jobs: activity ? [
    { ...base, id: 'builder', threadRoot: 'builder', terminalId: session.id, label: 'Build the requested change' },
    { ...base, id: 'other', threadRoot: 'other', terminalId: 'other-terminal', label: 'Unrelated work' },
  ] : [] } })
})
await page.route('**/api/flow?*', route => route.fulfill({ json: { sessions: activity ? { 'Build the requested change': { activityJobId: 'builder', currentActivity: 'Running checks', archived: false } } : {} } }))
await page.routeWebSocket('**/ws/terminal/*', socket => {
  socket.send('Claude Code test fixture\r\nReady> ')
  socket.onMessage(message => {
    if (typeof message === 'string') {
      const payload = JSON.parse(message)
      if (payload.type === 'resize') sizes++
    } else {
      writes += message.toString()
      socket.send(message.toString())
    }
  })
})
try {
  await page.goto('http://127.0.0.1:51947/')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('button', { name: 'Claude Code Live session', exact: true }).click()
  assert.equal(await page.locator('#live-launch input[type=password]').count(), 0)
  await page.getByLabel('Working directory', { exact: true }).fill('/example/project')
  await page.locator('#live-launch').getByRole('button', { name: 'Open Claude Code', exact: true }).click()
  await page.getByText('Could not open Claude Code: directory does not exist', { exact: true }).waitFor()
  assert.equal(creates, 0)
  rejectDirectory = false
  await page.locator('#live-launch').getByRole('button', { name: 'Open Claude Code', exact: true }).click()
  await page.getByText('Connected · live Claude Code', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.getByText('No active agents linked to this session.', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('.chat-container').getBoundingClientRect().width < innerWidth - 300)
  assert.equal(await page.locator('#agents').evaluate(node => node.matches(':modal')), false)
  const terminalWithAgents = await page.locator('#live-terminal').boundingBox()
  const agentsPanel = await page.locator('#agents').boundingBox()
  assert.ok(terminalWithAgents.x + terminalWithAgents.width <= agentsPanel.x, 'Agents must push the terminal')
  assert.equal(await page.locator('#agents .activity-filled').isVisible(), false, 'Sample agents must stay hidden in a live session')
  await page.getByRole('button', { name: 'Close agents' }).click()
  await page.getByRole('button', { name: 'Flow', exact: true }).click()
  await page.getByText('No work linked to this session yet.', { exact: true }).waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 0)
  activity = true
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.locator('#live-agents-list').getByText('Build the requested change', { exact: true }).waitFor()
  assert.equal(await page.locator('#live-agents-list').getByText('Unrelated work').count(), 0)
  await page.locator('#live-agents-list summary').click()
  await page.getByText('Running checks', { exact: true }).waitFor()
  await page.locator('#live-terminal .xterm-helper-textarea').fill('hello')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('#live-terminal').textContent.includes('hello'))
  assert.ok(writes.includes('hello'))
  await page.screenshot({ animations: 'disabled', path: new URL('./screenshots/live-agents-fixture.png', import.meta.url).pathname })
  await page.getByRole('button', { name: 'Close agents' }).click()
  await page.locator('#live-flow-steps').getByText('Working', { exact: true }).waitFor()
  await page.screenshot({ animations: 'disabled', path: new URL('./screenshots/live-flow-fixture.png', import.meta.url).pathname })
  unavailable = true
  await page.getByText('Activity unavailable: offline. Retrying…', { exact: true }).first().waitFor()
  assert.equal(await page.locator('#live-flow-steps').textContent(), '')
  unavailable = false
  await page.locator('#live-flow-steps').getByText('Working', { exact: true }).waitFor()
  assert.equal(creates, 1)
  assert.ok(sizes > 0)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('button', { name: 'Chat Design preview', exact: true }).click()
  await page.getByRole('heading', { name: 'A little space to build.' }).waitFor()
  await page.goto(`http://127.0.0.1:51947/?terminal=${session.id}#terminal`)
  await page.getByText('Connected · live Claude Code', { exact: true }).waitFor()
  assert.equal(creates, 1, 'Returning must keep the existing process')
  await page.reload()
  await page.getByText('Connected · live Claude Code', { exact: true }).waitFor()
  assert.equal(creates, 1, 'Reload must reconnect, not spawn')
  await page.getByRole('button', { name: 'Flow', exact: true }).click()
  await page.locator('#live-flow-steps').getByText('Working', { exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Agents', exact: true }).click()
  await page.locator('#live-agents-list summary').waitFor()
  await page.screenshot({ animations: 'disabled', path: new URL('./screenshots/live-panel-mobile-fixture.png', import.meta.url).pathname })
  const mobileTerminal = await page.locator('#live-terminal').boundingBox()
  const mobilePanel = await page.locator('#agents').boundingBox()
  assert.equal(await page.locator('#agents').evaluate(node => node.matches(':modal')), true)
  assert.equal(await page.locator('.chat-container').evaluate(node => node.getBoundingClientRect().width), 390)
  assert.ok(mobilePanel.x > 0 && mobilePanel.x + mobilePanel.width <= 390)
  assert.ok(mobileTerminal.width > 300)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('button', { name: 'Close agents' }).click()
  assert.ok((await page.locator('.toolbar').boundingBox()).height <= 70)
  const box = await page.locator('#live-terminal').boundingBox()
  assert.ok(box && box.width > 100 && box.y + box.height <= 844)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ animations: 'disabled', path: new URL('./screenshots/live-flow-mobile-fixture.png', import.meta.url).pathname })
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('button', { name: 'Claude Code Live session', exact: true }).click()
  await page.locator('#live-create').waitFor()
  assert.equal(await page.locator('#live-model').inputValue(), 'opus')
  assert.equal(await page.locator('#live-engine option[value=custom]').count(), 1)
  await page.locator('#live-engine').selectOption('codex')
  assert.equal(await page.locator('#live-model').inputValue(), '')
  await page.locator('#live-model').fill('test-codex')
  await page.locator('#live-workflow').selectOption('review@v2')
  await page.locator('#live-cwd').fill('/example/second')
  await page.getByRole('button', { name: 'Open Codex', exact: true }).click()
  await page.getByText('Connected · live Codex', { exact: true }).waitFor()
  assert.equal(creates, 2)
  assert.equal(lastCreate.engine, 'codex')
  assert.equal(lastCreate.model, 'test-codex')
  assert.equal(lastCreate.workflowId, 'review')
  assert.equal(lastCreate.revision, 'v2')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('button', { name: 'Claude Code Live session', exact: true }).click()
  await page.locator('#live-create').waitFor()
  await page.locator('#live-recents summary').click()
  await page.locator('#live-directories').getByRole('button', { name: '/example/second', exact: true }).click()
  assert.equal(await page.locator('#live-cwd').inputValue(), '/example/second')
  assert.equal(await page.getByRole('button', { name: 'Resume Claude', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Running', exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Close terminal launcher', exact: true }).click()
  await page.reload()
  await page.getByText('Connected · live Codex', { exact: true }).waitFor()
  assert.equal(creates, 2, 'Reload must keep the selected terminal')
  failOptions = true
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('button', { name: 'Claude Code Live session', exact: true }).click()
  await page.getByText('Could not load launch options: models unavailable. Close and reopen to retry.', { exact: true }).waitFor()
  assert.equal(await page.locator('#live-create').isVisible(), false)
  assert.equal(creates, 2)
  await page.getByRole('button', { name: 'Close terminal launcher', exact: true }).click()
  failOptions = false
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await page.getByRole('button', { name: 'Claude Code Live session', exact: true }).click()
  await page.locator('#live-create').waitFor()
  await page.setViewportSize({ width: 320, height: 844 })
  assert.equal(await page.locator('#live-launch').evaluate(node => node.scrollWidth <= node.clientWidth), true)
  assert.deepEqual(errors, [])
  console.log('PASS: password-free launch, invalid-directory recovery, real API request shape, terminal input/output, resize, return, reload, and mobile geometry (fixture transport).')
} finally {
  await browser.close()
}
