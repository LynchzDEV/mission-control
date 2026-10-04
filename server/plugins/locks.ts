const inFlight = new Map<string, Promise<unknown>>()

export class PluginBusyError extends Error {
  readonly id: string

  constructor(id: string) {
    super('Another change to this plugin is in progress')
    this.name = 'PluginBusyError'
    this.id = id
  }
}

export function withPluginLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(id)) return Promise.reject(new PluginBusyError(id))
  const run = Promise.resolve().then(fn)
  inFlight.set(id, run)
  void run.catch(() => {}).then(() => {
    if (inFlight.get(id) === run) inFlight.delete(id)
  })
  return run
}
