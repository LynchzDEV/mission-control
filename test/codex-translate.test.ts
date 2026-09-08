import { describe, expect, test } from 'bun:test'
import { CLAUDE_ONLY_PATTERNS, claudeOnlyScore, CODEX_INSTRUCTIONS_HEADER, translateAgentBody, translateInstructions, translateSkill } from '../server/codex-translate'

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: Use the Skill tool\n---\n${body}`
const tenLines = (claudeLines: number) => [...Array(claudeLines).fill('Use superpowers and mcp__tools'), ...Array(10 - claudeLines).fill('Review the code carefully.')].join('\n')

describe('claudeOnlyScore', () => {
  test('counts matching lines once, consistently across calls', () => {
    const fixture = 'AskUserQuestion and TodoWrite\nClean line\nAgent tool and subagent_type\n\n'
    expect(claudeOnlyScore(fixture)).toBe(2)
    expect(claudeOnlyScore(fixture)).toBe(2)
    expect(claudeOnlyScore('Clean code\nTests pass\n')).toBe(0)
    expect(claudeOnlyScore('')).toBe(0)
  })
  test('detects every Claude mechanism', () => {
    for (const token of ['AskUserQuestion', 'Agent tool', 'subagent', 'subagent_type', 'run_in_background', 'superpowers', 'ExitPlanMode', 'EnterPlanMode', 'plan mode', 'TodoWrite', 'claude-in-chrome', 'mcp__browser', 'Skill tool', 'hook', 'hooks', 'PreToolUse', 'PostToolUse', 'SessionStart', 'settings.json', 'mc-dispatch', 'cockpit-first', 'spawn an agent']) {
      expect(CLAUDE_ONLY_PATTERNS.some(pattern => pattern.test(token))).toBe(true)
    }
  })
})

describe('translateInstructions', () => {
  test('retains handwritten rules and removes Claude sections and whole dispatch bullets', () => {
    const lines = [
      '# Global rules', '', '- Coding style: use small functions.',
      '- ORCHESTRATOR: choose a worker.', '  - First nested rule', '  - Second nested rule', '  - Third nested rule',
      '- AskUserQuestion when unclear.', '- Read ~/.claude/skills/x/SKILL.md.',
      '- Read CLAUDE.md and ~/.claude/project/CLAUDE.md.', '@RTK.md', '',
      '## graphify', 'Use the graph.', '### Graph details', 'Remove these too.', '',
      '## Coding', '- Run the tests.', '- AGENT DISPATCH TABLE: ignore',
      '- AGENT PROMPT CONTRACT: ignore', '- DISPATCH ORDER: ignore', '- AGENT MODEL: ignore',
      '- Keep this rule.', '', ...Array(10).fill('- Hand-written guidance.'),
      '## Continuous-improvement rules', '- Auto-maintained tail', '### Provenance', 'Claude session tuning', 'End of tail',
    ]
    expect(lines).toHaveLength(40)
    const result = translateInstructions(lines.join('\n'))
    expect(result).toStartWith(CODEX_INSTRUCTIONS_HEADER)
    for (const text of ['Continuous-improvement', 'Auto-maintained', 'Provenance', 'ORCHESTRATOR', 'nested rule', 'graphify', 'Graph details', 'Remove these', '@RTK.md', 'AGENT DISPATCH TABLE', 'AGENT PROMPT CONTRACT', 'DISPATCH ORDER', 'AGENT MODEL', 'AskUserQuestion']) expect(result).not.toContain(text)
    expect(result).toContain('- Coding style: use small functions.')
    expect(result).toContain('- a plain-text question, then stop when unclear.')
    expect(result).toContain('~/.claude/skills/x/SKILL.md')
    expect(result).toContain('- Read AGENTS.md and ~/.claude/project/CLAUDE.md.')
    expect(result).toContain('- Run the tests.')
  })
  test('removes bullets matched in continuations, handles CRLF and preserves neighboring sentences', () => {
    const result = translateInstructions('- Remove\r\n  AGENT MODEL choice\r\n- Keep. A hook in settings.json runs PreToolUse. Check results.\r\n')
    expect(result).not.toContain('- Remove')
    expect(result).toContain('- Keep. Check results.')
    expect(result).not.toContain('settings.json')
  })
})

describe('translateSkill', () => {
  test('skips every excluded name even with clean bodies', () => {
    for (const name of ['mc-dispatch', 'configure-ecc', 'daily-retro', 'graphify', 'agent-sort', 'skill-scout', 'skill-stocktake', 'strategic-compact', 'iterative-retrieval', 'continuous-learning', 'continuous-learning-v2']) expect(translateSkill(skill(name, 'Clean body'))).toBeNull()
  })
  test('rejects residual machinery over 30% of non-empty body lines', () => {
    expect(translateSkill(skill('helper', tenLines(6)))).toBeNull()
    expect(translateSkill(skill('helper', tenLines(4) + '\n\n\n'))).toBeNull()
    expect(translateSkill(skill('helper', tenLines(3)))).not.toBeNull()
  })
  test('preserves front matter and appends provenance for a translated 1-of-10 skill', () => {
    const body = ['AskUserQuestion', ...Array(9).fill('Review code.')].join('\n')
    const result = translateSkill(skill('review', body))!
    expect(result).toStartWith('---\nname: review\ndescription: Use the Skill tool\n---\n')
    expect(result).toContain('a plain-text question, then stop')
    expect(result).toEndWith('<!-- translated for Codex by Mission Control; source ~/.claude/skills/review -->\n')
  })
  test('handles absent, malformed, quoted and CRLF front matter', () => {
    expect(translateSkill('Plain body')).toContain('skills/unknown -->')
    expect(translateSkill('---\nname: [\n---\nBody')).toBeNull()
    expect(translateSkill('---\r\nname: "mc-dispatch"\r\n---\r\nBody')).toBeNull()
    expect(translateSkill('---\r\nname: review\r\n---\r\nBody')).toStartWith('---\r\nname: review\r\n---\r\n')
  })
})

describe('translateAgentBody', () => {
  test('keeps personas and skips dispatch helpers', () => {
    expect(translateAgentBody('# agent-roonglit\nReview code carefully.\nAskUserQuestion')).toContain('a plain-text question, then stop')
    expect(translateAgentBody(tenLines(6))).toBeNull()
    expect(translateAgentBody('')).toBe('')
  })
  test('applies all common rewrites and removes hook sentences', () => {
    const result = translateAgentBody('Agent tool\nsubagent_type\nspawn an agent\nExitPlanMode\nEnterPlanMode\nplan mode\nSkill tool\nA hook invokes PostToolUse. Keep tests.\nHooks use SessionStart.\nCLAUDE.md ~/.claude/CLAUDE.md')!
    expect(result.match(/do it yourself in this thread/g)).toHaveLength(3)
    expect(result.match(/a written plan in your reply/g)).toHaveLength(3)
    expect(result).toContain('the matching skill in ~/.codex/skills')
    expect(result).toContain('Keep tests.')
    expect(result).not.toContain('PostToolUse')
    expect(result).not.toContain('SessionStart')
    expect(result).toContain('AGENTS.md ~/.claude/CLAUDE.md')
  })
})
