export const MAX_QUEUE_REPOS = 8

export const isPlainRepoName = (name: string): boolean =>
  name.length > 0 && name.length <= 255 && !name.startsWith('.') && !/[/\\\0]/.test(name) && !name.includes('..')

export function repoNamesProblem(repos: readonly string[]): string | null {
  if (repos.length > MAX_QUEUE_REPOS) return `Pick at most ${MAX_QUEUE_REPOS} repos for one item`
  const bad = repos.find(name => !isPlainRepoName(name))
  if (bad !== undefined) return `Not a repo name: ${bad}`
  const twice = repos.find((name, index) => repos.indexOf(name) !== index)
  return twice === undefined ? null : `${twice} is ticked twice`
}

export const isRepoList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(name => typeof name === 'string') && repoNamesProblem(value) === null
