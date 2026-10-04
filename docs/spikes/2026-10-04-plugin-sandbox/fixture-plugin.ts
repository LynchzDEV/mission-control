import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node'

const connection: MessageConnection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)

function classifyFsError(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : 'UNKNOWN'
  if (code === 'EPERM' || code === 'EACCES') return `DENIED ${code}`
  const message = error instanceof Error ? error.message : String(error)
  return `ERROR ${code} ${message}`
}

function requireStringParam(params: unknown, key: string): string {
  if (typeof params === 'object' && params !== null && key in params) {
    const value = (params as Record<string, unknown>)[key]
    if (typeof value === 'string') return value
  }
  throw new Error(`missing string param: ${key}`)
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : ''
    return `${error.message}${cause}`
  }
  return String(error)
}

function sanitizeProxyUrl(value: string): string {
  return value.replace(/\/\/[^/@]+@/, '//')
}

function reportSandboxEnv(): void {
  const names = ['SANDBOX_RUNTIME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'TMPDIR']
  const pairs = names
    .filter(name => process.env[name] !== undefined)
    .map(name => `${name}=${sanitizeProxyUrl(String(process.env[name]))}`)
  connection.sendNotification('log', { message: `env ${pairs.join(' ')}` })
}

type CallHandler = (params: unknown) => unknown

const handlers: Record<string, CallHandler> = {
  readFile: params => {
    const path = requireStringParam(params, 'path')
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      return classifyFsError(error)
    }
  },
  fetchUrl: async params => {
    const url = requireStringParam(params, 'url')
    try {
      const response = await fetch(url)
      return `STATUS ${response.status}`
    } catch (error) {
      return `ERROR ${describeFetchError(error)}`
    }
  },
  writeData: params => {
    const name = requireStringParam(params, 'name')
    const dataDir = process.env.MC_PLUGIN_DATA
    if (!dataDir) return 'ERROR MC_PLUGIN_DATA not set'
    try {
      writeFileSync(join(dataDir, name), 'spike-data')
      return 'ok'
    } catch (error) {
      return classifyFsError(error)
    }
  },
  writeAbs: params => {
    const path = requireStringParam(params, 'path')
    let fd: number
    try {
      fd = openSync(path, 'wx')
    } catch (error) {
      return classifyFsError(error)
    }
    closeSync(fd)
    try {
      unlinkSync(path)
    } catch (error) {
      return `ERROR created ${path} then failed to unlink: ${classifyFsError(error)}`
    }
    return `WROTE ${path}`
  },
  askSetting: async params => {
    const key = requireStringParam(params, 'key')
    return await connection.sendRequest<string | null>('settings.get', { key })
  },
}

connection.onRequest<unknown>('plugin.call', params => {
  const call = params as { method?: unknown; params?: unknown }
  if (typeof call.method !== 'string') throw new Error('plugin.call requires a string method')
  const handler = handlers[call.method]
  if (!handler) throw new Error(`unknown method: ${call.method}`)
  return handler(call.params ?? {})
})

connection.onNotification('plugin.shutdown', () => {
  connection.dispose()
  process.exit(0)
})

reportSandboxEnv()
connection.listen()
