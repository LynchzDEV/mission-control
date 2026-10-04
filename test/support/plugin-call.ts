import { createRuntimes } from '../../server/plugins/runtimes'
import { getInstalled } from '../../server/plugins/store'

const [pluginId, method] = process.argv.slice(2)
if (pluginId === undefined || method === undefined) {
  console.error('usage: bun plugin-call.ts <plugin-id> <method>')
  process.exit(1)
}

const installed = await getInstalled(pluginId)
if (installed === null) {
  console.error('That plugin is not installed')
  process.exit(1)
}

const runtimes = await createRuntimes()
const runtime = await runtimes.getRuntime(installed)
if (!runtime.ok) {
  console.error(runtime.error)
  process.exit(1)
}

const outcome = await runtime.runtime.call(method, {})
if (!outcome.ok) {
  console.error(outcome.error)
  process.exit(1)
}
console.log(JSON.stringify(outcome.result))
