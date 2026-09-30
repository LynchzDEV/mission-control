import { writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'

import { fakeQuery, runBridge, type BridgeControl, type BridgeLaunch, type BridgeQuery } from './chat-bridge-core'

function writeLine(line: object): void {
  writeSync(1, `${JSON.stringify(line)}\n`)
}

async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as BufferSource)
    let end = buffer.indexOf('\n')
    while (end >= 0) {
      yield buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      end = buffer.indexOf('\n')
    }
  }
  if (buffer !== '') yield buffer
}

function isControl(value: unknown): value is BridgeControl {
  if (!value || typeof value !== 'object') return false
  const control = value as Record<string, unknown>
  return control.type === 'permission' && typeof control.requestId === 'string' && ['allow_once', 'allow_always', 'deny'].includes(String(control.decision))
}

async function* controlStream(lines: AsyncIterable<string>): AsyncIterable<BridgeControl> {
  for await (const line of lines) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isControl(parsed)) yield parsed
    } catch {
      // unreadable control lines are dropped; the pending ask then times out
    }
  }
}

const realQuery = sdkQuery as unknown as BridgeQuery

async function main(): Promise<number> {
  const lines = stdinLines()
  const first = await lines.next()
  if (first.done || first.value.trim() === '') {
    writeLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Missing bridge launch input' })
    return 1
  }
  let launch: BridgeLaunch
  try {
    launch = JSON.parse(first.value) as BridgeLaunch
  } catch {
    writeLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Invalid bridge launch input' })
    return 1
  }
  const controller = new AbortController()
  process.on('SIGTERM', () => controller.abort())
  process.on('SIGINT', () => controller.abort())
  const fakeDir = process.env.MC_BRIDGE_FAKE
  return await runBridge(launch, {
    query: fakeDir === undefined || fakeDir === '' ? realQuery : fakeQuery(fakeDir),
    write: writeLine,
    controls: controlStream(lines),
    readFile: (path) => readFile(path),
    signal: controller.signal,
  })
}

if (import.meta.main) process.exit(await main())
