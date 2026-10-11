import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export type StdioSpawner = () => ChildProcessWithoutNullStreams
export type RpcMessage = Record<string, unknown>
export type RpcExchange = { initialize: RpcMessage; afterInitialize?: RpcMessage; request: RpcMessage }

const record = (value: unknown): RpcMessage => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RpcMessage : {}

export async function requestOverStdio(launch: StdioSpawner, exchange: RpcExchange, timeoutMs: number): Promise<unknown> {
  let child: ChildProcessWithoutNullStreams | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      child = launch()
      const proc = child
      let pending = '', initialized = false
      const fail = () => reject(new Error('unavailable'))
      const send = (value: unknown) => proc.stdin.write(JSON.stringify(value) + '\n')
      proc.on('error', fail)
      proc.on('exit', fail)
      proc.stdout.on('end', fail)
      proc.stdout.on('error', fail)
      proc.stdin.on('error', fail)
      proc.stderr.on('error', fail)
      proc.stderr.resume()
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        pending += chunk
        if (pending.length > 1_000_000) { fail(); return }
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
          let message: RpcMessage
          try { message = record(JSON.parse(line)) } catch { continue }
          if (message.id !== (initialized ? 2 : 1)) continue
          if (message.error || !('result' in message)) { fail(); return }
          if (!initialized) {
            initialized = true
            if (exchange.afterInitialize) send(exchange.afterInitialize)
            send({ ...exchange.request, id: 2 })
          } else { resolve(message.result); return }
        }
      })
      send({ ...exchange.initialize, id: 1 })
    })
  } finally {
    clearTimeout(timer)
    if (child) { child.stdin.end(); child.stdout.destroy(); child.stderr.destroy(); if (child.exitCode === null) child.kill('SIGKILL') }
  }
}
