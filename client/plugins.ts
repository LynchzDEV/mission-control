import { getJson } from './shared'
import './plugins/marketplace'
import { openPluginScreen } from './plugins/plugin-screen'
import type { InstalledPlugin } from './plugins/types'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

$('open-marketplace').onclick = () => dispatchEvent(new CustomEvent('quiet:show', { detail: 'marketplace' }))

addEventListener('quiet:show-plugin', (event) => {
  const id = (event as CustomEvent<string>).detail
  void (async () => {
    const result = await getJson('/api/plugins')
    if (!result.ok) return
    const plugins = Array.isArray(result.data.plugins) ? result.data.plugins as InstalledPlugin[] : []
    const plugin = plugins.find(entry => entry.id === id)
    if (plugin === undefined || !plugin.enabled || plugin.screen === undefined) {
      dispatchEvent(new CustomEvent('quiet:toast', { detail: 'That plugin is not available' }))
      return
    }
    dispatchEvent(new CustomEvent('quiet:show', { detail: 'plugin' }))
    await openPluginScreen(plugin)
  })()
})

export {}
