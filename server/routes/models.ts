import { Elysia } from 'elysia'

import { requireLocal } from '../auth'
import { listModels, type ModelLists } from '../models'
import { createQuotaCache } from '../quota'

export const modelsCache = createQuotaCache<ModelLists>(() => listModels(), 5 * 60_000)

export const modelsRoutes = new Elysia().onBeforeHandle(requireLocal).get('/api/models', () => modelsCache.get())
