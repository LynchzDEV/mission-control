import { handleAlertClick, type AlertData, type AlertOptions } from './attention-core'

type WindowClient = { focus(): Promise<unknown>; postMessage(message: unknown): void }
type ClickEvent = { action: string; notification: { data: AlertData; close(): void }; waitUntil(promise: Promise<unknown>): void }
type LifecycleEvent = { waitUntil(promise: Promise<unknown>): void }
type Scope = {
  addEventListener(type: 'notificationclick', listener: (event: ClickEvent) => void): void
  addEventListener(type: 'install' | 'activate', listener: (event: LifecycleEvent) => void): void
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void>; matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>; openWindow(url: string): Promise<unknown> }
  registration: { showNotification(title: string, options: AlertOptions): Promise<void> }
}

const scope = self as unknown as Scope

scope.addEventListener('install', event => { event.waitUntil(scope.skipWaiting()) })
scope.addEventListener('activate', event => { event.waitUntil(scope.clients.claim()) })
scope.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(handleAlertClick(event.action, event.notification.data, {
    post: (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === null ? undefined : JSON.stringify(body) }),
    windows: () => scope.clients.matchAll({ type: 'window', includeUncontrolled: true }),
    open: url => scope.clients.openWindow(url),
    show: (title, options) => scope.registration.showNotification(title, options),
  }))
})
