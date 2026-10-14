export type LogEventName = 'capabilities' | 'child' | 'commands' | 'context' | 'models' | 'permission_request' | 'permission_resolved' | 'stderr'

export const logEvent = (name: LogEventName): string => `skd_${name}`

// ponytail: legacy mc_* log event types, drop once job logs written before Shikidan are gone
const legacyLogEvent = (name: LogEventName): string => `mc_${name}`

export function isLogEvent(type: unknown, name: LogEventName): boolean {
  return type === logEvent(name) || type === legacyLogEvent(name)
}

export function mentionsLogEvent(line: string, name: LogEventName): boolean {
  return line.includes(`"${logEvent(name)}"`) || line.includes(`"${legacyLogEvent(name)}"`)
}
