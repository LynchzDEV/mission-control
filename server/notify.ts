import type { JobRecord } from './jobs'

type NotifyOptions = {
  platform?: string
  spawn?: (command: string[], options: { stdout: 'ignore'; stderr: 'ignore' }) => { exited: Promise<number> }
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
}

export async function notifySlowJob(record: JobRecord, options: NotifyOptions = {}): Promise<void> {
  try {
    const minutes = Math.floor(((record.slowAt ?? Date.now()) - record.startedAt) / 60_000)
    const message = `${record.label} · ${record.turns} turns · ${minutes} min — possible loop`
    console.error(`job slow: ${message.replace(/[\r\n]+/g, ' ')}`)
    if ((options.platform ?? process.platform) !== 'darwin') return
    const escaped = appleScriptString(message)
    const spawn = options.spawn ?? ((command, settings) => Bun.spawn(command, settings))
    await spawn(['osascript', '-e', `display notification "${escaped}" with title "Mission Control"`], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited
  } catch {}
}

export async function notifyChat(title: string, body: string, options: NotifyOptions = {}): Promise<void> {
  try {
    if ((options.platform ?? process.platform) !== 'darwin') return
    const spawn = options.spawn ?? ((command, settings) => Bun.spawn(command, settings))
    await spawn(['osascript', '-e', `display notification "${appleScriptString(body)}" with title "${appleScriptString(title)}"`], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited
  } catch {}
}
