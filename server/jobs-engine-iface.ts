export type EngineSpawn = {
  cmd: string
  args: string[]
  env: Record<string, string>
}

export type EngineResolverParams = {
  engine: string
  prompt: string
}

export type EngineResolver = (params: EngineResolverParams) => EngineSpawn

// TODO-P-merge: replace with the real resolver from engines.ts (P2) at mount time.
export const fakeEchoResolver: EngineResolver = ({ engine, prompt }) => ({
  cmd: 'echo',
  args: [`[fake:${engine}] ${prompt}`],
  env: {},
})
