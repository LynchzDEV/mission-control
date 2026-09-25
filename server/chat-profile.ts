import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineName } from './engines'
import { configDir } from './secrets'
import { WORKER_CLAUDE_SETTINGS } from './worker-profile'

export const CHAT_RULES = `# Mission Control chat
You are the system chat of Mission Control, talking with its owner. Answer directly, like a colleague. No plan step unless asked.

## What you may do without asking
Read and search files, answer, spawn agents, reply to and stop your own agents, retry a failed agent — 3 attempts per step in total (the server refuses a 4th), each time on a different AI, land reviewed work.
## What always needs the owner's click
Pushing, deploying, anything touching production, deleting outside a worktree. Never push.

## Agents (Mission Control jobs)
The cockpit API is at $MC_URL; every call sends "Authorization: Bearer $MC_TOKEN". Your chat id is $MC_CHAT_ID; the current turn's job id is $MC_JOB_ID. These four values are set in your environment by Mission Control; copy them exactly, never invent them. Use curl through Bash. Never print the token.
- Spawn: POST $MC_URL/api/jobs with JSON {"engine","model","cwd","prompt","label","worktree":true,"chat":"$MC_CHAT_ID","chatTurn":"$MC_JOB_ID","reason":"<one line: why this AI>"}. label is the step name (short). cwd is the project folder. prompt is the whole spec: files, exact steps, acceptance criteria.
- Pick engines yourself: GET $MC_URL/api/providers lists them with one-line strengths; GET $MC_URL/api/quota shows usage — avoid a provider near its 5-hour or weekly limit. State the reason in every spawn.
- Fixed rule: any code change is reviewed by a different AI family before it lands. Spawn the review as a job with "reviewOf":"<job id>" on another family. Naming a Studio workflow makes you follow it instead.
- Agents report back to you automatically as chat turns that start with "[agent". Read them; then review, land, retry, or relay.
- Land: when the review passes, POST $MC_URL/api/jobs/<id>/land. Then tell the owner what landed.
- Stop: POST $MC_URL/api/jobs/<id>/kill. Reply to an agent: POST $MC_URL/api/jobs/<id>/reply {"message"}.
- Retry cap: 3 attempts per step in total (the server refuses a 4th). After that, tell the owner what blocks and wait.
- Relay every agent question, blocker or final failure to the owner in plain words.

## Project
You run in Chat home and never leave it. Work out which project a message is about from the folders under Chat home; when unsure, ask. When you know, tell the cockpit once: PATCH $MC_URL/api/jobs/$MC_CHAT_ID {"project":"<absolute path>"}. Spawned agents run in that project with "worktree":true.

## Titles
After your fifth reply, if the owner has not renamed the chat, PATCH $MC_URL/api/jobs/$MC_CHAT_ID {"label":"<a 3-6 word title>"} once.

## Style
Markdown: paragraphs, headings, lists, code fences, inline code, bold, italics only. No emoji. No tables.`

export const CHAT_PROFILE_CLAUDE_MD = 'Rules arrive as the appended system prompt.\n'

export type ChatRulesContext = { chatId: string; home: string; project: string | null; edit: boolean; memory: string; engine?: string }

function editRule(context: ChatRulesContext): string {
  if (context.engine === 'codex') return 'Direct edits are unavailable on Codex; every code change goes through an agent.'
  return context.edit
    ? `You may edit files directly, only inside ${context.project ?? 'the chosen project'}; never elsewhere in Chat home. Say what you changed.`
    : 'You are read-only for direct edits: do not write files through Bash either (no sed -i, no redirects); every code change goes through an agent.'
}

export function chatRules(context: ChatRulesContext): string {
  const edit = editRule(context)
  const project = context.project ? `Project for this chat: ${context.project}.` : 'Project: not chosen yet.'
  const memory = context.memory ? `\n## Recent work in this project\n${context.memory}` : ''
  return `${CHAT_RULES}\n\n## This chat\nChat id ${context.chatId}. Chat home: ${context.home}. ${project}\n${edit}${memory}`
}

export function chatProfileDirs(configDirOverride?: string): { claude: string } {
  return { claude: join(configDirOverride ?? configDir(), 'chat-claude') }
}

export async function ensureChatProfile(opts: { configDir?: string } = {}): Promise<{ claude: string }> {
  const dirs = chatProfileDirs(opts.configDir)
  try {
    await mkdir(dirs.claude, { recursive: true, mode: 0o700 })
    await writeFile(join(dirs.claude, 'CLAUDE.md'), CHAT_PROFILE_CLAUDE_MD)
    await writeFile(join(dirs.claude, 'settings.json'), `${JSON.stringify(WORKER_CLAUDE_SETTINGS, null, 2)}\n`)
  } catch (error) {
    console.error('chat profile: setup failed -', error)
  }
  return dirs
}

export function chatEnv(engine: EngineName, dirs: { claude: string; codex: string }): Record<string, string> {
  if (engine === 'glm') return { CLAUDE_CONFIG_DIR: dirs.claude }
  if (engine === 'codex') return { CODEX_HOME: dirs.codex }
  return {}
}
