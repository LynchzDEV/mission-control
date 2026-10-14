type Env = Record<string, string | undefined>

// ponytail: legacy MISSION_CONTROL_/MC_ env reads, drop once every install runs Shikidan
const LEGACY_PREFIXES = ['MISSION_CONTROL_', 'MC_']

export function envNames(name: string): string[] {
  return [`SKD_${name}`, ...LEGACY_PREFIXES.map(prefix => `${prefix}${name}`)]
}

export function readEnv(name: string, env: Env = process.env): string | undefined {
  for (const key of envNames(name)) {
    const value = env[key]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

// ponytail: legacy MC_/MISSION_CONTROL_ child env, drop once skills, hooks and plugins read SKD_ only
function legacyExportName(name: string): string {
  return name === 'CONFIG_DIR' ? `MISSION_CONTROL_${name}` : `MC_${name}`
}

export function exportEnv(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).flatMap(([name, value]) => [[`SKD_${name}`, value], [legacyExportName(name), value]]))
}
