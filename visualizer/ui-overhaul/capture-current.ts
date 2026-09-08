import { mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LanesPage } from '../../server/views/lanes'
import { TerminalsPage } from '../../server/views/terminals'
import { DispatchPage } from '../../server/views/dispatch'
import { ReviewPage } from '../../server/views/review'
import { SettingsPage } from '../../server/views/settings'

const destination = join(import.meta.dir, 'current')
const models = { claude: ['opus', 'sonnet', 'haiku'], glm: ['glm-5.3-flash'], codex: ['gpt-6-astra'] }
const engineProps = { defaultEngine: 'claude', defaultModel: null, models }
const pages = {
  lanes: LanesPage(),
  terminals: TerminalsPage(engineProps),
  dispatch: DispatchPage(engineProps),
  review: ReviewPage(),
  settings: SettingsPage({
    zaiBaseUrl: 'https://api.z.ai/api/anthropic',
    zaiAuthTokenConfigured: true,
    apiTokenConfigured: true,
    bind: '127.0.0.1',
    roles: { plan: { engine: 'claude', model: null }, execute: { engine: 'glm', model: null }, review: { engine: 'codex', model: null } },
    autoReview: false,
    models,
    minPasswordLength: 12,
  }),
}

await mkdir(join(destination, 'fonts'), { recursive: true })
for (const name of ['theme.css', 'theme-tokens.css', 'fonts/press-start-2p-latin.woff2']) {
  const source = join(import.meta.dir, '../../public', name)
  if (name.endsWith('.css')) {
    await Bun.write(join(destination, name), (await Bun.file(source).text()).replaceAll('/fonts/', '/current/fonts/'))
  } else {
    await copyFile(source, join(destination, name))
  }
}
for (const [name, rendered] of Object.entries(pages)) {
  const snapshot = rendered
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*href="\/vendor\/[^>]*>/gi, '')
    .replaceAll('href="/theme', 'href="/current/theme')
    .replace(/href="\/(lanes|dispatch|terminals|review|settings)"/g, 'href="/current/$1.html"')
    .replace('</head>', '<style>.rack,.task,.col{opacity:1}</style></head>')
  if (/<script\b/i.test(snapshot)) throw new Error(`Executable script in ${name}`)
  await Bun.write(join(destination, `${name}.html`), snapshot)
}
console.log(`Captured ${Object.keys(pages).length} current source views without client scripts or live data.`)
