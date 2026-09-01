export type EngineSpawn = {
  cmd: string
  args: string[]
  env: Record<string, string>
}

export type EngineResolverParams = {
  engine: string
  prompt: string
  resumeSessionId?: string
}

export type EngineResolver = (params: EngineResolverParams) => EngineSpawn | Promise<EngineSpawn>


export const fakeEchoResolver: EngineResolver = ({ engine, prompt }) => ({
  cmd: 'echo',
  args: [`[fake:${engine}] ${prompt}`],
  env: {},
})

import { buildEnv, resolveBinary, resolveEngine, type EngineName, ENGINE_NAMES } from './engines'

// codex's `resume` subcommand parses flags before its positional id and prompt, and rejects the
// flags the plain `exec` form accepts.
export function engineArgs(engine: EngineName, prompt: string, resumeSessionId?: string): string[] {
  if (engine === 'codex') {
    return resumeSessionId === undefined
      ? ['exec', '--json', prompt]
      : ['exec', 'resume', '--json', resumeSessionId, prompt]
  }
  const resume = resumeSessionId === undefined ? [] : ['--resume', resumeSessionId]
  return [...resume, '-p', prompt, '--output-format', 'stream-json', '--verbose']
}

export function engineSupportsResume(engine: string): boolean {
  return ENGINE_NAMES.includes(engine as EngineName)
}

export const realEngineResolver: EngineResolver = async ({ engine, prompt, resumeSessionId }) => {
  if (!ENGINE_NAMES.includes(engine as EngineName)) throw new Error(`unknown engine: ${engine}`)
  const name = engine as EngineName
  return {
    cmd: resolveBinary(resolveEngine(name).cmd),
    args: engineArgs(name, prompt, resumeSessionId),
    env: await buildEnv(name),
  }
}
