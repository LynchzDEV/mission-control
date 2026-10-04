import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function fileUrl(path: string): string {
  return `file://${path}`
}

async function fixtureGit(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  if (await proc.exited !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

export async function fixtureSha(repo: string): Promise<string> {
  const proc = Bun.spawn(['git', '-C', repo, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  if (await proc.exited !== 0) throw new Error('git rev-parse failed')
  return out.trim()
}

export type FixtureOptions = {
  files?: Record<string, string>
  tag?: string
  message?: string
}

async function writeFiles(repo: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(repo, name, '..'), { recursive: true })
    await writeFile(join(repo, name), content)
  }
}

export async function commitFixture(repo: string, files: Record<string, string>, options: FixtureOptions = {}): Promise<void> {
  await writeFiles(repo, files)
  await fixtureGit(['add', '.'], repo)
  await fixtureGit(['commit', '-q', '-m', options.message ?? 'fixture change'], repo)
  if (options.tag !== undefined) await fixtureGit(['tag', options.tag], repo)
}

export async function linkFixture(repo: string, name: string, target: string, options: FixtureOptions = {}): Promise<void> {
  await mkdir(join(repo, name, '..'), { recursive: true })
  await symlink(target, join(repo, name))
  await fixtureGit(['add', '-A'], repo)
  await fixtureGit(['commit', '-q', '-m', options.message ?? 'fixture link'], repo)
  if (options.tag !== undefined) await fixtureGit(['tag', options.tag], repo)
}

export async function createPluginRepo(repo: string, manifest: Record<string, unknown>, options: FixtureOptions & { manifestName?: string } = {}): Promise<string> {
  await mkdir(repo, { recursive: true })
  await fixtureGit(['init', '-q', '-b', 'main'], repo)
  await fixtureGit(['config', 'user.email', 'mission-control-test@example.com'], repo)
  await fixtureGit(['config', 'user.name', 'Mission Control Test'], repo)
  await writeFiles(repo, { [options.manifestName ?? 'mc-plugin.json']: `${JSON.stringify(manifest, null, 2)}\n`, ...(options.files ?? {}) })
  await fixtureGit(['add', '.'], repo)
  await fixtureGit(['commit', '-q', '-m', options.message ?? 'fixture'], repo)
  if (options.tag !== undefined) await fixtureGit(['tag', options.tag], repo)
  return repo
}

export const TRIVIAL_SCREEN = 'export default { mount() {} }\n'

export function isolatedFixtureServer(extraMethods: Record<string, string> = {}, options: { stubborn?: boolean } = {}): string {
  const extras = Object.entries(extraMethods).map(([name, handler]) => `  ${JSON.stringify(name)}: ${handler},`).join('\n')
  const shutdownLine = options.stubborn === true
    ? '  if (message.method === \'plugin.shutdown\') return'
    : '  if (message.method === \'plugin.shutdown\') process.exit(0)'
  const trapSignal = options.stubborn === true ? 'process.on(\'SIGTERM\', () => {})\n' : ''
  return `import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
${trapSignal}
function classify(error) {
  const code = typeof error === 'object' && error !== null && error.code !== undefined ? String(error.code) : 'UNKNOWN'
  if (code === 'EPERM' || code === 'EACCES') return \`DENIED \${code}\`
  const message = error instanceof Error ? error.message : String(error)
  return \`ERROR \${code} \${message}\`
}

const handlers = {
  readFile: params => {
    try {
      return readFileSync(params.path, 'utf8')
    } catch (error) {
      return classify(error)
    }
  },
  writeAbs: params => {
    let fd
    try {
      fd = openSync(params.path, 'wx')
    } catch (error) {
      return classify(error)
    }
    closeSync(fd)
    try {
      unlinkSync(params.path)
    } catch {
      return \`ERROR could not unlink \${params.path}\`
    }
    return \`WROTE \${params.path}\`
  },
  writeData: params => {
    const dataDir = process.env.MC_PLUGIN_DATA
    if (dataDir === undefined) return 'ERROR MC_PLUGIN_DATA not set'
    try {
      writeFileSync(join(dataDir, params.name), 'fixture-data')
      return 'ok'
    } catch (error) {
      return classify(error)
    }
  },
  fetchUrl: async params => {
    try {
      const response = await fetch(params.url)
      return \`STATUS \${response.status}\`
    } catch (error) {
      return \`ERROR \${error instanceof Error ? error.message : String(error)}\`
    }
  },
  askSetting: async params => sendHostRequest('settings.get', { key: params.key }),
  crash: () => {
    process.exit(1)
  },
${extras}
}

let nextRequestId = 1
const pendingHostCalls = new Map()

function frame(message) {
  const body = JSON.stringify(message)
  return \`Content-Length: \${Buffer.byteLength(body)}\\r\\n\\r\\n\${body}\`
}

function send(message) {
  process.stdout.write(frame(message))
}

function sendHostRequest(method, params) {
  const id = nextRequestId
  nextRequestId += 1
  return new Promise((resolve, reject) => {
    pendingHostCalls.set(id, { resolve, reject })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

function handleMessage(message) {
  if (typeof message !== 'object' || message === null) return
  if (message.method === undefined && message.id !== undefined && pendingHostCalls.has(message.id)) {
    const waiter = pendingHostCalls.get(message.id)
    pendingHostCalls.delete(message.id)
    if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'host request failed'))
    else waiter.resolve(message.result ?? null)
    return
  }
  if (message.method === 'plugin.call') {
    const call = message.params ?? {}
    Promise.resolve()
      .then(() => {
        const handler = handlers[call.method]
        if (handler === undefined) throw new Error(\`unknown method: \${call.method}\`)
        return handler(call.params ?? {})
      })
      .then(result => send({ jsonrpc: '2.0', id: message.id, result: result ?? null }))
      .catch(error => send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }))
    return
  }
${shutdownLine}
}

if (process.env.MC_PLUGIN_DATA !== undefined) {
  writeFileSync(join(process.env.MC_PLUGIN_DATA, 'server.pid'), \`\${process.pid}\\n\`)
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n')
    if (headerEnd < 0) return
    const lengthLine = buffer.subarray(0, headerEnd).toString('utf8').split('\\r\\n').find(line => /^content-length:/i.test(line))
    const match = lengthLine !== undefined ? /^content-length:\\s*(\\d+)$/i.exec(lengthLine) : undefined
    if (match === undefined) process.exit(1)
    const length = Number(match[1])
    if (buffer.length < headerEnd + 4 + length) return
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')
    buffer = buffer.subarray(headerEnd + 4 + length)
    handleMessage(JSON.parse(body))
  }
})
process.stdin.on('end', () => process.exit(0))
`
}

export function isolatedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixture-plugin',
    name: 'Fixture plugin',
    version: '1.0.0',
    description: 'A fixture plugin for tests.',
    pluginApi: 1,
    runtime: 'isolated',
    screen: 'src/screen.ts',
    permissions: { network: ['api.example.com'], sessions: ['chat'], settings: true },
    settings: [{ key: 'token', label: 'Token', type: 'secret' }],
    ...overrides,
  }
}

export function trustedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return isolatedManifest({ runtime: 'trusted', permissions: { sessions: ['chat'], settings: true }, ...overrides })
}
