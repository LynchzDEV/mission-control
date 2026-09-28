import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowApprovalRoutes } from '../server/routes/roles'
import { readConfig } from '../server/secrets'

let dir: string
const local = (method: string, body?: unknown) => new Request('http://127.0.0.1:7777/api/flow-approval', { method, headers: { host: '127.0.0.1:7777', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: body === undefined ? undefined : JSON.stringify(body) })
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-flow-approval-')); process.env.MISSION_CONTROL_CONFIG_DIR = dir })
afterEach(async () => { delete process.env.MISSION_CONTROL_CONFIG_DIR; await rm(dir, { recursive: true, force: true }) })

test('flow approval defaults to on and can be turned off and back on', async () => {
  expect((await readConfig()).flowApproval).toBe(true)
  expect(await (await flowApprovalRoutes.handle(local('GET'))).json()).toEqual({ flowApproval: true })
  expect(await (await flowApprovalRoutes.handle(local('PUT', { flowApproval: false }))).json()).toEqual({ flowApproval: false })
  expect((await readConfig()).flowApproval).toBe(false)
  expect(await (await flowApprovalRoutes.handle(local('PUT', { flowApproval: true }))).json()).toEqual({ flowApproval: true })
})

test('flow approval rejects a non-boolean value and keeps the old one', async () => {
  const response = await flowApprovalRoutes.handle(local('PUT', { flowApproval: 'off' }))
  expect(response.status).toBe(400)
  expect((await readConfig()).flowApproval).toBe(true)
})

test('flow approval is not reachable with a Bearer token from a non-local host', async () => {
  const response = await flowApprovalRoutes.handle(new Request('http://example.com/api/flow-approval', { headers: { host: 'example.com', authorization: 'Bearer x' } }))
  expect(response.status).toBe(403)
})
