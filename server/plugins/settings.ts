import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { DIR_MODE, configDir, readJsonFile, writeJsonFile } from '../secrets'
import { PluginBusyError, withPluginLock } from './locks'
import { getInstalled } from './store'
import type { SettingField } from './manifest'

const SETTINGS_FILE = 'settings.json'

export type SettingsView = {
  fields: SettingField[]
  values: Record<string, string>
  configured: Record<string, boolean>
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

function settingsFile(id: string): string {
  return join('plugin-data', id, SETTINGS_FILE)
}

async function readSettings(id: string): Promise<Record<string, string>> {
  const raw = await readJsonFile(settingsFile(id))
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function writeSettings(id: string, values: Record<string, string>): Promise<void> {
  await mkdir(join(configDir(), 'plugin-data', id), { recursive: true, mode: DIR_MODE })
  await writeJsonFile(settingsFile(id), values)
}

function viewOf(fields: SettingField[], values: Record<string, string>): SettingsView {
  const secretKeys = new Set(fields.filter(field => field.type === 'secret').map(field => field.key))
  const safeValues: Record<string, string> = {}
  const configured: Record<string, boolean> = {}
  for (const field of fields) {
    const value = values[field.key]
    configured[field.key] = typeof value === 'string' && value !== ''
    if (field.type !== 'secret' && !secretKeys.has(field.key) && typeof value === 'string') safeValues[field.key] = value
  }
  return { fields, values: safeValues, configured }
}

export async function settingsView(id: string): Promise<SettingsResult<SettingsView>> {
  const installed = await getInstalled(id)
  if (installed === null) return { ok: false, status: 404, error: 'That plugin is not installed' }
  return { ok: true, value: viewOf(installed.settingsFields ?? [], await readSettings(id)) }
}

export async function setSetting(id: string, key: string, value: string | null): Promise<SettingsResult<SettingsView>> {
  const installed = await getInstalled(id)
  if (installed === null) return { ok: false, status: 404, error: 'That plugin is not installed' }
  const declared = (installed.settingsFields ?? []).find(field => field.key === key)
  if (declared === undefined) return { ok: false, status: 400, error: `Unknown setting: ${key}` }
  try {
    return await withPluginLock(id, async () => {
      const current = await readSettings(id)
      const next = { ...current }
      if (value === null) delete next[key]
      else next[key] = value
      await writeSettings(id, next)
      return { ok: true as const, value: viewOf(installed.settingsFields ?? [], next) }
    })
  } catch (error) {
    if (error instanceof PluginBusyError) return { ok: false, status: 409, error: error.message }
    throw error
  }
}

export async function getSetting(id: string, key: string): Promise<string | null> {
  return (await readSettings(id))[key] ?? null
}
