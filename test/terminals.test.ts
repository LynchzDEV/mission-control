import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_COLS,
  MAX_TITLE_LENGTH,
  MAX_DIMENSION,
  clampDimension,
  createRingBuffer,
  createTerminalRegistry,
  pushToRingBuffer,
  replayRingBuffer,
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

  test('accepts a non-git directory (terminals need no repo)', async () => {
    const result = await registry.createTerminal({ engine: 'claude', cwd: plain })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    registry.kill(result.terminal.id)
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

  test('close listeners fire once when the shell exits and again on kill', async () => {
    const exited = await registry.createTerminal({ engine: 'claude', cwd: repo })
    if (!exited.ok) throw new Error('unreachable')
    let exitClosed = 0
    registry.subscribe(
      exited.terminal.id,
      () => {},
      () => {
        exitClosed += 1
      },
    )
    registry.write(exited.terminal.id, 'exit\n')
    await waitFor(() => exitClosed === 1)

    const killed = await registry.createTerminal({ engine: 'claude', cwd: repo })
    if (!killed.ok) throw new Error('unreachable')
    let killClosed = 0
    registry.subscribe(
      killed.terminal.id,
      () => {},
      () => {
        killClosed += 1
      },
    )
    registry.kill(killed.terminal.id)
    expect(killClosed).toBe(1)
  })

  test('rename replaces the title and rejects blank, oversized, or unknown targets', async () => {
    const created = await registry.createTerminal({ engine: 'claude', cwd: repo })
    if (!created.ok) throw new Error('spawn failed')
    const id = created.terminal.id

    expect(registry.rename(id, '  api worktree  ')).toBe(true)
    expect(registry.get(id)?.title).toBe('api worktree')
    expect(registry.rename(id, '   ')).toBe(false)
    expect(registry.rename(id, 'x'.repeat(MAX_TITLE_LENGTH + 1))).toBe(false)
    expect(registry.get(id)?.title).toBe('api worktree')
    expect(registry.rename('missing', 'anything')).toBe(false)
    registry.kill(id)
  })

  test('write, resize, kill, replay and subscribe are no-ops for unknown ids', () => {
    expect(registry.write('missing', 'x')).toBe(false)
    expect(registry.resize('missing', 80, 24)).toBe(false)
    expect(registry.kill('missing')).toBe(false)
    expect(registry.replay('missing')).toBe('')
    expect(() => registry.subscribe('missing', () => {})()).not.toThrow()
  })
})

describe('ring buffer byte-exact trimming', () => {
  const GLYPH = '─' // U+2500, 3 bytes in UTF-8, 1 UTF-16 code unit

  test('trims to an exact byte count when the boundary lands on a character edge', () => {
    const buffer = createRingBuffer()
    pushToRingBuffer(buffer, GLYPH.repeat(5), 9)
    const replayed = replayRingBuffer(buffer)
    expect(replayed).toBe(GLYPH.repeat(3))
    expect(Buffer.byteLength(replayed, 'utf-8')).toBe(9)
  })

  test('a mid-character boundary yields one lossy leading replacement char, never a blanked replay', () => {
    const buffer = createRingBuffer()
    pushToRingBuffer(buffer, GLYPH.repeat(5), 10)
    const replayed = replayRingBuffer(buffer)
    expect(replayed).toBe(`�${GLYPH.repeat(3)}`)
    expect(replayed.length).toBeGreaterThan(0)
  })

  test('evicts whole chunks across the boundary before trimming the remainder', () => {
    const buffer = createRingBuffer()
    pushToRingBuffer(buffer, GLYPH.repeat(2), 9)
    pushToRingBuffer(buffer, GLYPH.repeat(4), 9)
    const replayed = replayRingBuffer(buffer)
    expect(replayed).toBe(GLYPH.repeat(3))
    expect(replayed).not.toContain('�')
  })
})

test('terminal cwd does not require a git repository', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir, homedir } = await import('node:os')
  const { join } = await import('node:path')
  const { mkdir, rm } = await import('node:fs/promises')
  const dir = join(homedir(), '.mc-term-nogit-test')
  await mkdir(dir, { recursive: true })
  try {
    const { validateWorkspaceCwd } = await import('../server/workspace')
    const res = await validateWorkspaceCwd(dir, homedir(), { requireGit: false })
    expect(res.ok).toBe(true)
    const strict = await validateWorkspaceCwd(dir, homedir())
    expect(strict.ok).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
