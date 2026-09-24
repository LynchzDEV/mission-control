const kinds = ['plan', 'verify-plan', 'implement', 'review']
const titles = ['Plan', 'Verify plan', 'Execute', 'Cross-family review']
const ids = ['plan', 'verify-plan', 'execute', 'review']
const instructions = [
  'Inspect the request and repository. Produce a concrete implementation plan, affected files, constraints, and acceptance checks. Do not modify application code.',
  'Verify the upstream plan against the request and actual code. Pass only if the plan is complete and executable. Report gaps as fail. Do not implement.',
  'Implement the verified plan in this workspace. Follow repository conventions, create a regression test when appropriate, and run relevant checks. Report files changed and real test evidence. Do not make a commit unless the request explicitly asks.',
  'Independently review the implementation and evidence against the verified plan. Inspect the actual diff and relevant files. Run appropriate checks. Pass only when no blocking findings remain; otherwise report specific findings as fail.'
]
const workflow = { id: 'default', name: 'Plan, verify, execute, review', revision: 'a741bd52895f392d', createdAt: 0, entry: 'plan', nodes: ids.map((id, i) => ({ id, title: titles[i], kind: kinds[i], instructions: instructions[i], agent: {role: ['plan','review','execute','review'][i]}, skills: [], mcpServers: [], checks: [], maxVisits: 3, position: {x:i*270,y:100} })), edges: ids.slice(0,-1).map((id,i) => ({source:id,target:ids[i+1],outcome:'pass'})) }
const policy = {revision:'7eb25692a418b',template:'# Mission Control assignment\n{{core_rules}}\n\n## Selected workflow\n{{workflow}}\n\n## Current assignment\n{{assignment}}',coreRules:'Worker scope, honest evidence, verified implementation plans and independent review remain mandatory.',implementationRules:'Follow repository instructions.',createdAt:0}
export async function fixtureApi<T>(path:string, body?:unknown):Promise<T> {
  if (body !== undefined) throw new Error('Design preview only. No workflow or settings were saved and no job was started.')
  const fixtures:Record<string,unknown> = {
    '/workflows':{workflows:[workflow],selected:workflow},
    '/workflows/default/revisions':{revisions:[workflow]},
    '/connections':{builtins:['claude','glm','codex'],connections:[],models:{claude:['claude-opus-4-6'],glm:['glm-5'],codex:['gpt-6']},presets:[{id:'grok',name:'Grok Build',adapter:'acp',command:'grok',args:['agent','stdio'],family:'grok'}]},
    '/policy':policy,'/policy/revisions':{revisions:[policy]},'/runs':{runs:[]}
  }
  if (!(path in fixtures)) throw new Error('This state is not part of the static comparison.')
  return structuredClone(fixtures[path]) as T
}
