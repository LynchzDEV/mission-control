import { createLogRedactor, readLogFile } from './jobs'
import type { LogRedactor } from './jobs'
import { readSecrets } from './secrets'

export async function logSecrets(): Promise<Array<string | null>> {
  const secrets = await readSecrets()
  return [secrets.zaiAuthToken, secrets.apiToken]
}

export function createSecretsRedactor(secrets: ReadonlyArray<string | null>): LogRedactor {
  const redactors = secrets.map((secret) => createLogRedactor(secret))
  return {
    redact: (chunk) => redactors.reduce((text, redactor) => redactor.redact(text), chunk),
    flush: () => redactors.reduce((text, redactor) => redactor.redact(text) + redactor.flush(), ''),
  }
}

export function redactAll(content: string, secrets: ReadonlyArray<string | null>): string {
  const redactor = createSecretsRedactor(secrets)
  return redactor.redact(content) + redactor.flush()
}

// Job logs are written raw by the child process, so every serving path redacts on read.
export async function readRedactedLog(path: string): Promise<string> {
  return redactAll(await readLogFile(path), await logSecrets())
}
