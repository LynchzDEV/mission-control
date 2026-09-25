import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHAT_RULES, chatEnv, chatRules, ensureChatProfile } from '../server/chat-profile'
import { engineArgs, realEngineResolver } from '../server/jobs-engine-iface'
import { writeSecrets } from '../server/secrets'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mc-chat-profile-')); process.env.MISSION_CONTROL_CONFIG_DIR = dir; process.env.MC_FAKE_ENGINES = '1' })
afterEach(async () => { delete process.env.MISSION_CONTROL_CONFIG_DIR; delete process.env.MC_FAKE_ENGINES; await rm(dir, { recursive: true, force: true }) })

describe('chat rules', () => {
  test('name the API, the retry cap, the review rule and the landing call', () => {
    for (const phrase of ['POST $MC_URL/api/jobs', 'MC_CHAT_ID', 'different AI family', '/land', 'Never push', '/api/quota', 'copy them exactly, never invent them']) expect(CHAT_RULES).toContain(phrase)
    expect(CHAT_RULES.split('3 attempts per step in total (the server refuses a 4th)')).toHaveLength(3)
  })
  test('carry the chat context', () => {
    const text = chatRules({ chatId: 'root-1', home: '/Users/me/work', project: '/Users/me/work/app', edit: false, memory: 'Recent: fixed login' })
    expect(text).toContain('root-1')
    expect(text).toContain('/Users/me/work/app')
    expect(text).toContain('read-only')
    expect(text).toContain('do not write files through Bash either')
    expect(text).toContain('Recent: fixed login')
    expect(chatRules({ chatId: 'r', home: '/h', project: null, edit: true, memory: '' })).toContain('may edit files directly')
  })
  test('tell a Codex chat that direct edits are unavailable', () => {
    for (const edit of [true, false]) {
      const text = chatRules({ chatId: 'r', home: '/h', project: null, edit, memory: '', engine: 'codex' })
      expect(text).toContain('Direct edits are unavailable on Codex; every code change goes through an agent.')
      expect(text).not.toContain('may edit files directly')
      expect(text).not.toContain('read-only for direct edits')
    }
  })
})

describe('chat profile', () => {
  test('writes a slim Claude profile and maps engines to it', async () => {
    const dirs = await ensureChatProfile({ configDir: dir })
    expect(await readFile(join(dirs.claude, 'CLAUDE.md'), 'utf8')).toBe('Rules arrive as the appended system prompt.\n')
    expect(JSON.parse(await readFile(join(dirs.claude, 'settings.json'), 'utf8')).permissions.defaultMode).toBe('bypassPermissions')
    expect(chatEnv('glm', { claude: dirs.claude, codex: '/codex' })).toEqual({ CLAUDE_CONFIG_DIR: dirs.claude })
    expect(chatEnv('codex', { claude: dirs.claude, codex: '/codex' })).toEqual({ CODEX_HOME: '/codex' })
    expect(chatEnv('claude', { claude: dirs.claude, codex: '/codex' })).toEqual({})
  })
})

describe('resolver for a chat', () => {
  test('appends the rules, blocks edit tools when edit is off, and skips the worker profile', async () => {
    const spawn = await realEngineResolver({ engine: 'claude', prompt: 'hi', purpose: 'chat', edit: false, coreRules: 'RULES' })
    expect(spawn.args).toContain('--append-system-prompt')
    expect(spawn.args[spawn.args.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,MultiEdit,NotebookEdit')
    expect(spawn.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    await writeSecrets({ zaiAuthToken: 'zai-test-token' })
    const editing = await realEngineResolver({ engine: 'glm', prompt: 'hi', purpose: 'chat', edit: true, coreRules: 'RULES' })
    expect(editing.args).not.toContain('--disallowedTools')
    expect(editing.env.CLAUDE_CONFIG_DIR).toContain('chat-claude')
  })
  test('a codex chat takes the worker Codex profile and no Claude tool flags', async () => {
    const spawn = await realEngineResolver({ engine: 'codex', prompt: 'hi', purpose: 'chat', edit: false, coreRules: 'RULES' })
    expect(spawn.args).not.toContain('--disallowedTools')
    expect(spawn.env.CODEX_HOME?.endsWith('worker-codex')).toBe(true)
    expect(existsSync(join(dir, 'chat-claude'))).toBe(false)
  })
  test('a claude chat builds no profile at all', async () => {
    await realEngineResolver({ engine: 'claude', prompt: 'hi', purpose: 'chat', edit: true, coreRules: 'RULES' })
    expect(existsSync(join(dir, 'chat-claude'))).toBe(false)
    expect(existsSync(join(dir, 'worker-codex'))).toBe(false)
  })
  test('a worker job is unchanged', async () => {
    expect(engineArgs('claude', 'p')).toEqual(['-p', 'p', '--output-format', 'stream-json', '--verbose'])
    await writeSecrets({ zaiAuthToken: 'zai-test-token' })
    const worker = await realEngineResolver({ engine: 'glm', prompt: 'hi' })
    expect(worker.env.CLAUDE_CONFIG_DIR?.endsWith('worker-claude')).toBe(true)
  })
})
