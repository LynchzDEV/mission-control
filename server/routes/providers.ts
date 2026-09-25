import { Elysia } from 'elysia'

import { createConnectionStore } from '../agent-connections'
import { requireLocal } from '../auth'
import { listProviders } from '../providers'
import { modelsCache } from './models'

export const providersRoutes = new Elysia()
  .onBeforeHandle(requireLocal)
  .get('/api/providers', async () => ({ providers: await listProviders({ models: () => modelsCache.get(), connections: () => createConnectionStore().list() }) }))
