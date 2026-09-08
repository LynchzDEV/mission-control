import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TerminalsPage } from '../server/views/terminals'
import { DispatchPage } from '../server/views/dispatch'
import { ReviewPage } from '../server/views/review'
import { LanesPage } from '../server/views/lanes'
import { SettingsPage } from '../server/views/settings'
import { LoginPage, SetupPage } from '../server/views/login'
import type { ModelLists } from '../server/models'

const output = join(import.meta.dir, '../public/ui-preview')
const models: ModelLists = { claude: [], glm: [], codex: [] }
const engine = { defaultEngine: 'claude', defaultModel: null, models }
const settings = {
  zaiBaseUrl: 'https://api.z.ai/api/anthropic', zaiAuthTokenConfigured: false, apiTokenConfigured: false,
  bind: '127.0.0.1', roles: { plan: { engine: 'claude', model: null }, execute: { engine: 'codex', model: null }, review: { engine: 'codex', model: null } },
  autoReview: false, models, minPasswordLength: 12,
}
const pages: Record<string, () => string> = {
  terminals: () => TerminalsPage(engine), dispatch: () => TerminalsPage(engine), review: () => TerminalsPage(engine),
  lanes: () => TerminalsPage(engine), settings: () => TerminalsPage(engine),
  'lanes-content': () => LanesPage(true), 'dispatch-content': () => DispatchPage({ ...engine, embedded: true }),
  'review-content': () => ReviewPage(true), 'settings-content': () => SettingsPage({ ...settings, embedded: true }),
  login: LoginPage, setup: () => SetupPage({ minPasswordLength: 12 }),
}
await mkdir(output, { recursive: true })
const entries = [...new Bun.Glob('*.ts').scanSync(join(import.meta.dir, '../client'))].map((file) => join(import.meta.dir, '../client', file))
const built = await Bun.build({ entrypoints: entries, target: 'browser', root: join(import.meta.dir, '../client'), outdir: join(output, 'js'), write: true })
if (!built.success) throw new Error(built.logs.map(String).join('\n'))
await Bun.write(join(output, 'theme.css'), Bun.file(join(import.meta.dir, '../public/theme.css')))
await Bun.write(join(output, 'theme-tokens.css'), Bun.file(join(import.meta.dir, '../public/theme-tokens.css')))
for (const [name, render] of Object.entries(pages)) {
  let markup = render().replaceAll('src="/js/', 'src="/ui-preview/js/').replaceAll('href="/theme', 'href="/ui-preview/theme')
  if (name === 'settings-content') markup = markup.replace('<body ', '<body data-preview-readonly="true" ').replace('<main', '<p role="status" class="preview-notice">Preview · Settings writes disabled</p><main')
  for (const match of markup.matchAll(/src="(\/ui-preview\/js\/[^"]+)"/g)) if (!await Bun.file(join(import.meta.dir, '../public', match[1]!)).exists()) throw new Error('Missing asset: ' + match[1])
  await Bun.write(join(output, `${name}.html`), markup)
}
console.log(`Rendered actual views and ${entries.length} client bundles to ${output}. Open /ui-preview/terminals.html on the existing server. Preview settings are read-only; work data uses the same-origin server.`)
