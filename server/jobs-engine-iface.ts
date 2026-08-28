export type EngineSpawn = {
  cmd: string
  args: string[]
  env: Record<string, string>
}

export type EngineResolverParams = {
  engine: string
  prompt: string
}

export type EngineResolver = (params: EngineResolverParams) => EngineSpawn | Promise<EngineSpawn>


export const fakeEchoResolver: EngineResolver = ({ engine, prompt }) => ({
  cmd: 'echo',
  args: [`[fake:${engine}] ${prompt}`],
  env: {},
})

import { buildEnv, resolveEngine, type EngineName, ENGINE_NAMES } from './engines'

function engineArgs(engine: EngineName, prompt: string): string[] {
  if (engine === 'codex') return ['exec', '--json', prompt]
  return ['-p', prompt, '--output-format', 'stream-json', '--verbose']
}

export const realEngineResolver: EngineResolver = async ({ engine, prompt }) => {
  if (!ENGINE_NAMES.includes(engine as EngineName)) throw new Error(`unknown engine: ${engine}`)
  const name = engine as EngineName
  return {
    cmd: resolveEngine(name).cmd,
    args: engineArgs(name, prompt),
    env: await buildEnv(name),
  }
}
