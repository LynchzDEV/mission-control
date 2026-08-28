import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_COLS,
  MAX_DIMENSION,
  clampDimension,
  createTerminalRegistry,
  type TerminalRegistry,
} from '../server/terminals'
import { initScratchGitRepo } from './support/scratch-git-repo'

let configDir: string
let repo: string
let plain: string
let registry: TerminalRegistry

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'mc-terminals-config-'))
  process.env.MISSION_CONTROL_CONFIG_DIR = configDir
  process.env.MC_FAKE_ENGINES = '1'

  repo = await mkdtemp(join(homedir(), 'mc-terminals-scratch-'))
  await initScratchGitRepo(repo)
  plain = await mkdtemp(join(homedir(), 'mc-terminals-plain-'))

  registry = createTerminalRegistry()
})

afterEach(async () => {
  registry.shutdown()
  delete process.env.MISSION_CONTROL_CONFIG_DIR
  delete process.env.MC_FAKE_ENGINES
  await rm(configDir, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met within timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('clampDimension', () => {
  test('falls back for non-numeric input and clamps to the allowed range', () => {
    expect(clampDimension('80', DEFAULT_COLS)).toBe(DEFAULT_COLS)
    expect(clampDimension(Number.NaN, DEFAULT_COLS)).toBe(DEFAULT_COLS)
    expect(clampDimension(0, DEFAULT_COLS)).toBe(1)
    expect(clampDimension(99999, DEFAULT_COLS)).toBe(MAX_DIMENSION)
    expect(clampDimension(120.4, DEFAULT_COLS)).toBe(120)
  })
})

describe('createTerminal cwd validation', () => {
  test('rejects a cwd outside $HOME', async () => {
    const result = await registry.createTerminal({ engine: 'claude', cwd: '/tmp' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(400)
    expect(result.error).toBe('cwd must be under $HOME')
  })

  test('rejects a directory that is not a git repository', async () => {
    const result = await registry.createTerminal({ engine: 'claude', cwd: plain })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toBe('cwd is not a git repository')
  })

  test('rejects a cwd that does not exist', async () => {
    const result = await registry.createTerminal({ engine: 'claude', cwd: join(repo, 'nope') })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toBe('cwd does not exist')
  })

  test('rejects an unknown engine', async () => {
    const result = await registry.createTerminal({ engine: 'nonsense', cwd: repo })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error).toBe('unknown engine')
  })
})

describe('registry lifecycle over a real pty', () => {
  test('spawns, echoes a written command into the ring buffer, then kills the process', async () => {
    const created = await registry.createTerminal({ engine: 'claude', cwd: repo, cols: 100, rows: 30 })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('unreachable')

    const { id, pid, engine, cwd, title } = created.terminal
    expect(engine).toBe('claude')
    expect(cwd).toBe(repo)
    expect(title.startsWith('CLAUDE · ')).toBe(true)
    expect(pid).toBeGreaterThan(0)
    expect(registry.list().map((entry) => entry.id)).toEqual([id])
    expect(registry.get(id)?.pid).toBe(pid)

    expect(registry.write(id, 'echo ring-buffer-hi\n')).toBe(true)
    await waitFor(() => registry.replay(id).includes('ring-buffer-hi'))
    expect(registry.replay(id)).toContain('ring-buffer-hi')

    expect(registry.kill(id)).toBe(true)
    await waitFor(() => !processAlive(pid))
    expect(processAlive(pid)).toBe(false)
    expect(registry.get(id)).toBeUndefined()
    expect(registry.list()).toEqual([])
  })

  test('drops the session from the registry when the shell exits on its own', async () => {
    const created = await registry.createTerminal({ engine: 'claude', cwd: repo })
    if (!created.ok) throw new Error('unreachable')
    registry.write(created.terminal.id, 'exit\n')
    await waitFor(() => registry.get(created.terminal.id) === undefined)
    expect(registry.list()).toEqual([])
  })

  test('resize applies to the pty as seen by stty inside the session', async () => {
    const created = await registry.createTerminal({ engine: 'claude', cwd: repo, cols: 80, rows: 24 })
    if (!created.ok) throw new Error('unreachable')
    const { id } = created.terminal

    expect(registry.resize(id, 132, 43)).toBe(true)
    registry.write(id, 'stty size\n')
    await waitFor(() => registry.replay(id).includes('43 132'))
    expect(registry.replay(id)).toContain('43 132')
  })

  test('subscribers receive live output and stop after unsubscribing', async () => {
    const created = await registry.createTerminal({ engine: 'claude', cwd: repo })
    if (!created.ok) throw new Error('unreachable')
    const { id } = created.terminal

    let seen = ''
    const unsubscribe = registry.subscribe(id, (chunk) => {
      seen += chunk
    })
    registry.write(id, 'echo live-subscriber\n')
    await waitFor(() => seen.includes('live-subscriber'))

    unsubscribe()
    const frozen = seen
    registry.write(id, 'echo after-unsubscribe\n')
    await waitFor(() => registry.replay(id).includes('after-unsubscribe'))
    expect(seen).toBe(frozen)
  })

  test('write, resize, kill, replay and subscribe are no-ops for unknown ids', () => {
    expect(registry.write('missing', 'x')).toBe(false)
    expect(registry.resize('missing', 80, 24)).toBe(false)
    expect(registry.kill('missing')).toBe(false)
    expect(registry.replay('missing')).toBe('')
    expect(() => registry.subscribe('missing', () => {})()).not.toThrow()
  })
})
