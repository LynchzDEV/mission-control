import type { JobRecord } from './jobs'

type NotifyOptions = {
  platform?: string
  spawn?: (command: string[], options: { stdout: 'ignore'; stderr: 'ignore' }) => { exited: Promise<number> }
}

export async function notifySlowJob(record: JobRecord, options: NotifyOptions = {}): Promise<void> {
  try {
    const minutes = Math.floor(((record.slowAt ?? Date.now()) - record.startedAt) / 60_000)
    const message = `${record.label} · ${record.turns} turns · ${minutes} min — possible loop`
    console.error(`job slow: ${message.replace(/[\r\n]+/g, ' ')}`)
    if ((options.platform ?? process.platform) !== 'darwin') return
    const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    const spawn = options.spawn ?? ((command, settings) => Bun.spawn(command, settings))
    await spawn(['osascript', '-e', `display notification "${escaped}" with title "Mission Control"`], {
      stdout: 'ignore',
      stderr: 'ignore',
    }).exited
  } catch {}
}
