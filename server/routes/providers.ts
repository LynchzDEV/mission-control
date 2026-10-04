import { Elysia } from 'elysia'

import { createConnectionStore } from '../agent-connections'
import { requireLocal } from '../auth'
import { modelDiscovery } from '../model-discovery'
import { listProviders } from '../providers'
import { modelsCache } from './models'

async function effectiveConnections() {
  const discovery = modelDiscovery()
  const connections = await createConnectionStore().list()
  for (const connection of connections) void discovery.ensureFresh(connection).catch(() => null)
  return Promise.all(connections.map(connection => discovery.effective(connection)))
}

export const providersRoutes = new Elysia()
  .onBeforeHandle(requireLocal)
  .get('/api/providers', async () => ({ providers: await listProviders({ models: () => modelsCache.get(), connections: effectiveConnections }) }))
