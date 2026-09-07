import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testHome = mkdtempSync(join(tmpdir(), 'mc-test-home-'))
process.env.HOME = testHome
delete process.env.CLAUDE_CONFIG_DIR
delete process.env.CODEX_HOME
process.on('exit', () => rmSync(testHome, { recursive: true, force: true }))
