import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import { buildEnv } from '../server/engines'

const WORKTREE = resolve(import.meta.dir, '..')

function settingsPermissionMode(configDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8')) as { permissions?: { defaultMode?: unknown } }
    const mode = parsed.permissions?.defaultMode
    return typeof mode === 'string' ? mode : 'default'
  } catch {
    return 'default'
  }
}

const derived = settingsPermissionMode(join(homedir(), '.claude'))
let release!: () => void
const done = new Promise<void>(resolveDone => { release = resolveDone })
async function* stream(): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: 'Reply with the word ready' }, parent_tool_use_id: null }
  await done
}

let initPermissionMode: string | null = null
try {
  for await (const message of query({
    prompt: stream(),
    options: {
      env: await buildEnv('claude', { worker: false }),
      pathToClaudeCodeExecutable: Bun.which('claude') ?? 'claude',
      permissionMode: derived as 'default',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: '' },
    },
  })) {
    const raw = message as unknown as Record<string, unknown>
    if (message.type === 'system' && message.subtype === 'init') initPermissionMode = typeof raw.permissionMode === 'string' ? raw.permissionMode : null
    if (message.type === 'result') break
  }
} finally {
  release()
}

console.log(JSON.stringify({ fileDefaultMode: derived, initPermissionMode, match: derived === initPermissionMode }))
