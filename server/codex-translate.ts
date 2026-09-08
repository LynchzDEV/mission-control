import { parse } from 'yaml'

export const CLAUDE_ONLY_PATTERNS: RegExp[] = [
  /AskUserQuestion/i, /\bAgent tool\b/i, /subagent(?:_type)?/i,
  /run_in_background/i, /superpowers/i, /ExitPlanMode|EnterPlanMode|plan mode/i,
  /TodoWrite/i, /claude-in-chrome/i, /mcp__[a-z]/i, /Skill tool/i,
  /\bhooks?\b/i, /PreToolUse|PostToolUse|SessionStart|settings\.json/i,
  /mc-dispatch/i, /cockpit-first/i, /spawn an agent/i,
]

export const CODEX_INSTRUCTIONS_HEADER = `# Codex Global Instructions
Generated from ~/.claude/CLAUDE.md by Mission Control — edit the source, not this file.
- You run with approval_policy=never and sandbox_mode=danger-full-access: act, do not ask for permission.
- No subagents here: do every step yourself in this thread. No hooks: nothing runs before or after your commands, so run tests and checks yourself.
- Skills live in ~/.codex/skills/<name>/SKILL.md; read the one that matches the task before starting.
- When launched by Mission Control (MC_JOB_ID set) you are the worker: implement in this tree, never dispatch or post plans.
`

const SKIP = new Set([
  'mc-dispatch', 'configure-ecc', 'daily-retro', 'graphify', 'agent-sort',
  'skill-scout', 'skill-stocktake', 'strategic-compact', 'iterative-retrieval',
  'continuous-learning', 'continuous-learning-v2',
])

export function claudeOnlyScore(markdown: string): number {
  return markdown.split(/\r?\n/).filter(line => CLAUDE_ONLY_PATTERNS.some(pattern => pattern.test(line))).length
}

function rewrite(markdown: string): string {
  return markdown.split(/\r?\n/).map(line => line.split(/(?<=[.!?])\s+/)
    .filter(sentence => !(/\bhooks?\b/i.test(sentence) && /settings\.json|PreToolUse|PostToolUse|SessionStart/i.test(sentence)))
    .join(' ')
    .replace(/AskUserQuestion/gi, 'a plain-text question, then stop')
    .replace(/\bAgent tool\b|subagent(?:_type)?s?|spawn an agent/gi, 'do it yourself in this thread')
    .replace(/ExitPlanMode|EnterPlanMode|plan mode/gi, 'a written plan in your reply')
    .replace(/Skill tool/gi, 'the matching skill in ~/.codex/skills')
    .replace(/~\/\.claude\/[^\s`"'<>)]*|\bCLAUDE\.md\b/g, value => value.startsWith('~/.claude/') ? value : 'AGENTS.md'))
    .join('\n')
}

function mostlyClaudeOnly(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/).filter(line => line.trim())
  return lines.length > 0 && claudeOnlyScore(markdown) / lines.length > 0.3
}

export function translateInstructions(claudeMd: string): string {
  const lines = claudeMd.split(/\r?\n/)
  const kept: string[] = []
  let graphify = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith('## Continuous-improvement rules')) break
    if (/^# Claude Global Instructions\s*$/.test(line)) continue
    if (/^## graphify\s*$/i.test(line)) { graphify = true; continue }
    if (graphify && /^#{1,2}\s/.test(line)) graphify = false
    if (graphify || /^\s*@RTK\.md\s*$/.test(line)) continue
    if (/^- /.test(line)) {
      let end = i + 1
      while (end < lines.length && (/^\s+\S/.test(lines[end]!) || !lines[end]!.trim())) end++
      const bullet = lines.slice(i, end).join('\n')
      if (/ORCHESTRATOR|AGENT DISPATCH TABLE|AGENT PROMPT CONTRACT|DISPATCH ORDER|AGENT MODEL/i.test(bullet)) {
        i = end - 1
        continue
      }
    }
    kept.push(line)
  }
  return `${CODEX_INSTRUCTIONS_HEADER}\n${rewrite(kept.join('\n')).trim()}\n`
}

export function translateSkill(skillMd: string): string | null {
  const front = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(skillMd)
  let name = 'unknown'
  let prefix = ''
  if (front?.index === 0) {
    try {
      const metadata = parse(front[1]!)
      if (typeof metadata?.name === 'string') name = metadata.name
    } catch { return null }
    prefix = front[0]
  }
  if (SKIP.has(name)) return null
  const body = rewrite(skillMd.slice(prefix.length))
  if (mostlyClaudeOnly(body)) return null
  return `${prefix}${body.trimEnd()}\n\n<!-- translated for Codex by Mission Control; source ~/.claude/skills/${name} -->\n`
}

export function translateAgentBody(body: string): string | null {
  const translated = rewrite(body)
  return mostlyClaudeOnly(translated) ? null : translated
}
