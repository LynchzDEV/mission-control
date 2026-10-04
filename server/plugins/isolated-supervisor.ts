import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'

import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

const DEFAULT_KILL_GRACE_MS = 2000

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    console.error(`[isolated-supervisor] missing env ${name}`)
    process.exit(1)
  }
  return value
}

function graceMsFromEnv(): number {
  const raw = Number.parseInt(process.env.MC_PLUGIN_KILL_GRACE_MS ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KILL_GRACE_MS
}

const killGraceMs = graceMsFromEnv()
const sandboxConfig: SandboxRuntimeConfig = JSON.parse(requiredEnv('MC_PLUGIN_SANDBOX_CONFIG'))
const pluginCommand = requiredEnv('MC_PLUGIN_COMMAND')
const pluginCwd = requiredEnv('MC_PLUGIN_CWD')
// The wrapped command already bakes the sandbox vars (proxy, TMPDIR, SANDBOX_RUNTIME); the child gets exactly this list, never the supervisor's env.
const childEnv: Record<string, string> = {
  MC_PLUGIN_RUNTIME: 'isolated',
  MC_PLUGIN_ID: requiredEnv('MC_PLUGIN_ID'),
  MC_PLUGIN_DATA: requiredEnv('MC_PLUGIN_DATA'),
  BUN_TMPDIR: requiredEnv('BUN_TMPDIR'),
}

let child: ChildProcess | undefined
let terminating = false
let finished = false

function childExitedWithin(ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), ms)
  })
  const exited = new Promise<boolean>(resolve => {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    child.on('exit', () => resolve(true))
  })
  return Promise.race([exited, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function finish(code: number): Promise<void> {
  if (finished) return
  finished = true
  await SandboxManager.reset().catch(() => {})
  process.exit(code)
}

async function terminateChild(): Promise<void> {
  terminating = true
  if (child === undefined) return
  child.kill('SIGTERM')
  if (await childExitedWithin(killGraceMs)) {
    await finish(0)
    return
  }
  child.kill('SIGKILL')
  await childExitedWithin(killGraceMs)
  await finish(0)
}

process.on('SIGTERM', () => {
  void terminateChild().catch(async error => {
    console.error(`[isolated-supervisor] termination failed: ${error instanceof Error ? error.message : String(error)}`)
    child?.kill('SIGKILL')
    await finish(1)
  })
})

const silent = (): void => {}
process.stdin.on('error', silent)

try {
  await SandboxManager.initialize(sandboxConfig)
  const { argv } = await SandboxManager.wrapWithSandboxArgv(pluginCommand)
  await mkdir(pluginCwd, { recursive: true, mode: 0o700 })
  child = spawn(argv[0], argv.slice(1), { shell: false, cwd: pluginCwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv })
} catch (error) {
  console.error(`[isolated-supervisor] ${error instanceof Error ? error.message : String(error)}`)
  await finish(1)
}

child?.stdin?.on('error', silent)
child?.stdout?.on('error', silent)
child?.stderr?.on('error', silent)
child?.stdout?.pipe(process.stdout)
child?.stderr?.pipe(process.stderr)
if (child?.stdin !== undefined) process.stdin.pipe(child.stdin)

child?.on('exit', (code, signal) => {
  void finish(terminating || signal !== null ? 0 : (code ?? 1))
})

if (terminating) await terminateChild()
