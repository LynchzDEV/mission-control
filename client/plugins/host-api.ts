import { errorText, getJson, postJson, readRecord } from '../shared'
import { readRecentDirectories } from '../shell-launch'
import type { InstalledPlugin, ScreenApi, SessionKind, SessionRequest, SettingsView, ThemeName, ToastKind } from './types'

const NO_CHAT_PERMISSION = 'This plugin did not ask to start chats'
const NO_TERMINAL_PERMISSION = 'This plugin did not ask to start terminals'
const NO_SETTINGS_PERMISSION = 'This plugin did not ask to keep settings'

const RECENT_CWD_KEY = 'mc.term.recentCwd'

export type LaunchOpener = (kind: SessionKind, plugin: { id: string; name: string }, request: SessionRequest) => Promise<void>

const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }

export function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function allowedSession(installed: InstalledPlugin, kind: SessionKind): Error | null {
  const sessions = installed.permissions.sessions ?? []
  if (sessions.includes(kind)) return null
  return Error(kind === 'chat' ? NO_CHAT_PERMISSION : NO_TERMINAL_PERMISSION)
}

export function createScreenApi(installed: InstalledPlugin, openLaunch: LaunchOpener): ScreenApi {
  const id = installed.id
  const api: ScreenApi = {
    call: async (method, params) => {
      const result = await postJson(`/api/plugins/${encodeURIComponent(id)}/call`, { method, ...(params === undefined ? {} : { params }) })
      if (!result.ok) throw Error(errorText(result))
      return result.data.result
    },
    sessions: {
      startChat: async req => {
        const denied = allowedSession(installed, 'chat')
        if (denied !== null) throw denied
        await openLaunch('chat', { id, name: installed.name }, req)
      },
      startTerminal: async req => {
        const denied = allowedSession(installed, 'terminal')
        if (denied !== null) throw denied
        await openLaunch('terminal', { id, name: installed.name }, req)
      },
    },
    settings: {
      view: async () => {
        if (installed.permissions.settings !== true) throw Error(NO_SETTINGS_PERMISSION)
        const result = await getJson(`/api/plugins/${encodeURIComponent(id)}/settings`)
        if (!result.ok) throw Error(errorText(result))
        return {
          fields: installed.settingsFields ?? [],
          values: readRecord(result.data.values) as Record<string, string>,
          configured: readRecord(result.data.configured) as Record<string, boolean>,
        } satisfies SettingsView
      },
      set: async (key, value) => {
        if (installed.permissions.settings !== true) throw Error(NO_SETTINGS_PERMISSION)
        const response = await fetch(`/api/plugins/${encodeURIComponent(id)}/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }) })
        if (response.ok) return
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw Error(payload.error ?? `request failed (${response.status})`)
      },
    },
    folders: { recent: async () => readRecentDirectories(stored(RECENT_CWD_KEY)) },
    ui: { toast: async text => { dispatchEvent(new CustomEvent('quiet:toast', { detail: text })) } },
    theme: async () => currentTheme(),
    onTheme: async (cb: (theme: ThemeName) => void) => {
      document.addEventListener('mc:theme', () => { void cb(currentTheme()) })
    },
  }
  return api
}
