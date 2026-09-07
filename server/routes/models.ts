import { Elysia } from 'elysia'

import { requireSession } from '../auth'
import { listModels, type ModelLists } from '../models'
import { createQuotaCache } from '../quota'

export const modelsCache = createQuotaCache<ModelLists>(() => listModels(), 5 * 60_000)

export const modelsRoutes = new Elysia().onBeforeHandle(requireSession).get('/api/models', () => modelsCache.get())
