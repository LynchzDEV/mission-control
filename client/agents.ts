import { installDrawer, openDrawer, type DrawerTarget } from './thread-drawer'
export function installAgents(): void {
  if (document.querySelector('#agent-sidebar') === null) return
  installDrawer()
  addEventListener('mc:agent-open', event => openDrawer((event as CustomEvent<DrawerTarget>).detail))
}
if (typeof document !== 'undefined') installAgents()
