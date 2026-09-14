const HEDGES = ['as appropriate', 'whichever', 'if it makes sense', 'as needed', 'as you see fit', 'up to you', 'either']
const PATH_TOKEN = /(?:^|[\s`(])(?:[\w.-]+\/)+[\w.-]+\.\w+|\b[\w-]+\.(?:ts|tsx|js|rb|py|md|css|html|json|yml|yaml|erb|sql)\b/
const STEP_HEADING = /^#{2,4}\s*Step\s+(\d+)\b.*$/gim

function section(spec: string, name: string): string | null {
  const match = new RegExp(`^#{1,4}\\s*\\**${name}\\**\\s*$([\\s\\S]*?)(?=^#{1,2}\\s|(?![\\s\\S]))`, 'im').exec(spec)
  return match === null ? null : match[1]!
}

function hedge(text: string): string | null {
  const lower = text.toLowerCase()
  return HEDGES.find((word) => new RegExp(`\\b${word}\\b`).test(lower)) ?? null
}

// ponytail: heading-shaped lint only; a prose plan with the same content still fails it — tighten the recipe, not the regexes
export function lintSpec(spec: string): string[] {
  const misses: string[] = []
  const decisions = section(spec, 'Decisions')
  const preserve = section(spec, 'Preserve')
  const steps = section(spec, 'Steps')
  const planFile = /execute tasks \d+\s*(?:\.\.|-|to)\s*\d+ of \S+/i.test(spec)
  if (decisions === null) misses.push('missing "## Decisions" section')
  if (preserve === null) misses.push('missing "## Preserve" section')
  if (steps === null && !planFile) misses.push('missing "## Steps" section or "execute tasks N..M of <plan file>" line')
  if (!/Done means all of these hold/.test(spec)) misses.push('missing acceptance baseline ("Done means all of these hold")')
  const hedgedDecision = decisions === null ? null : hedge(decisions)
  if (hedgedDecision !== null) misses.push(`hedged wording in Decisions: "${hedgedDecision}"`)
  if (steps !== null) {
    const hedgedStep = hedge(steps)
    if (hedgedStep !== null) misses.push(`hedged wording in Steps: "${hedgedStep}"`)
    const headings = [...steps.matchAll(STEP_HEADING)]
    headings.forEach((heading, index) => {
      const body = steps.slice(heading.index!, headings[index + 1]?.index)
      if (!PATH_TOKEN.test(body)) misses.push(`step ${heading[1]} names no file path`)
    })
  }
  return misses
}
