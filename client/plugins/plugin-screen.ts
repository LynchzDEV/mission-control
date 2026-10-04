import { expose, type Endpoint } from 'comlink'

import { createScreenApi } from './host-api'
import { openPluginLaunch } from './launch-dialog'
import type { InstalledPlugin, ScreenApi } from './types'

type ScreenModule = { default: { mount(root: HTMLElement, mc: ScreenApi): void | Promise<void> } }

export type FrameEndpoint = { endpoint: Endpoint; close(): void }

export function createFrameEndpoint(frame: HTMLIFrameElement): FrameEndpoint {
  let relay: ((event: MessageEvent) => void) | null = null
  const close = (): void => { if (relay !== null) window.removeEventListener('message', relay); relay = null }
  const endpoint: Endpoint = {
    postMessage: (data, transfer) => { frame.contentWindow?.postMessage(data, '*', transfer ?? []) },
    addEventListener: (_type, listener) => {
      relay = (event: MessageEvent): void => { if (relay !== null && event.source === frame.contentWindow) (listener as (event: MessageEvent) => void)(event) }
      window.addEventListener('message', relay)
    },
    removeEventListener: (): void => { close() },
  }
  return { endpoint, close }
}

let teardown: (() => void) | null = null

export async function openPluginScreen(installed: InstalledPlugin): Promise<void> {
  teardown?.()
  teardown = null
  const section = document.getElementById('plugin') as HTMLElement
  const heading = document.createElement('header')
  heading.className = 'studio-heading'
  const intro = document.createElement('div')
  const name = document.createElement('h1')
  name.textContent = installed.name
  const description = document.createElement('p')
  description.className = 'muted'
  description.textContent = installed.description
  intro.append(name, description)
  heading.append(intro)
  const root = document.createElement('div')
  root.className = 'plugin-screen'
  section.replaceChildren(heading, root)
  const mc = createScreenApi(installed, openPluginLaunch)
  if (installed.runtime === 'trusted') {
    const mod = await import(`/plugin-module/${encodeURIComponent(installed.id)}/screen.js`) as ScreenModule
    await mod.default.mount(root, mc)
    return
  }
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.src = `/plugin-frame/${encodeURIComponent(installed.id)}/`
  frame.style.width = '100%'
  frame.style.height = 'calc(100vh - 140px)'
  frame.style.border = '0'
  root.append(frame)
  const exposed = createFrameEndpoint(frame)
  expose(mc, exposed.endpoint)
  teardown = exposed.close
}
