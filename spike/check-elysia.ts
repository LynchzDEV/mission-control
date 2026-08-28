import { Elysia } from 'elysia'
import { staticPlugin } from '@elysiajs/static'
import { cookie } from '@elysiajs/cookie'
import { html } from '@elysiajs/html'

const PORT = 7997
const HOST = '127.0.0.1'

export function buildHelloApp() {
  return new Elysia()
    .use(cookie())
    .use(html())
    .use(staticPlugin({ assets: 'spike/fixtures/static', prefix: '/static' }))
    .get('/', () => 'hello from elysia spike')
}

async function main() {
  const app = buildHelloApp()
  app.listen({ hostname: HOST, port: PORT })
  await new Promise((r) => setTimeout(r, 300))

  const res = await fetch(`http://${HOST}:${PORT}/`)
  const body = await res.text()
  console.log('STATUS', res.status)
  console.log('BODY', JSON.stringify(body))

  app.stop()

  if (res.status !== 200 || body !== 'hello from elysia spike') {
    throw new Error('elysia hello check FAILED')
  }
  console.log('ELYSIA_HELLO_CHECK: PASS')
}

if (import.meta.main) {
  await main()
}
