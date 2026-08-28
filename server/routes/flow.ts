import { Elysia } from 'elysia'

import { requireSession } from '../auth'

export type StageState = 'done' | 'active' | 'queued' | 'future'
export type Stage = [StageState, string]
export type SessionFlow = {
  spec: Stage
  impl: Stage
  codex: Stage
  verify: Stage
  merged: Stage
}

// TODO: replace with the real pipeline source (jobs + worktrees) once P3 lands.
export const PLACEHOLDER_SESSIONS: Record<string, SessionFlow> = {
  'moni-audio-v2': {
    spec: ['done', 'CLAUDE'],
    impl: ['done', 'GLM · wt/moni-audio'],
    codex: ['queued', 'CODEX · QUEUED'],
    verify: ['active', 'CLAUDE · NOW · 4m'],
    merged: ['future', ''],
  },
  'orders-export-fix': {
    spec: ['done', 'CLAUDE'],
    impl: ['active', 'GLM · 26m · wt/orders-export'],
    codex: ['queued', 'CODEX · QUEUED'],
    verify: ['future', ''],
    merged: ['future', ''],
  },
  'campaign-occasions': {
    spec: ['done', 'CLAUDE'],
    impl: ['active', 'GLM · 11m · wt/campaign-ai'],
    codex: ['future', 'CODEX'],
    verify: ['future', ''],
    merged: ['future', ''],
  },
  'lead-csv-import': {
    spec: ['done', 'CLAUDE'],
    impl: ['active', 'GLM · 2m · wt/lead-csv'],
    codex: ['future', 'CODEX'],
    verify: ['future', ''],
    merged: ['future', ''],
  },
  'hermez-fb-retry': {
    spec: ['active', 'CLAUDE · NOW · 12m'],
    impl: ['future', 'GLM'],
    codex: ['future', 'CODEX'],
    verify: ['future', ''],
    merged: ['future', ''],
  },
}

export const DEFAULT_SESSION = 'moni-audio-v2'

export type FlowResponse = {
  source: 'placeholder' | 'live'
  current: string
  sessions: Record<string, SessionFlow>
}

export function flowSnapshot(): FlowResponse {
  return { source: 'placeholder', current: DEFAULT_SESSION, sessions: PLACEHOLDER_SESSIONS }
}

export const flowRoutes = new Elysia()
  .onBeforeHandle(requireSession)
  .get('/api/flow', () => flowSnapshot())
