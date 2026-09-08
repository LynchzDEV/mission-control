import { resolve, extname } from 'node:path'
import { existsSync, statSync } from 'node:fs'

const root = import.meta.dir
const allowedTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }

Bun.serve({
  hostname: '127.0.0.1',
  port: 47831,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === '/favicon.ico') return new Response(null, { status: 204 })
    if (pathname === '/fingerprint.js') {
      const version = ['index.html', 'app.js', 'styles.css', 'tokens.css', 'fingerprint.js']
        .map(name => resolve(root, name))
        .filter(name => existsSync(name))
        .map(name => statSync(name).mtimeMs)
        .join(':')
      return new Response(version, { headers: { 'Cache-Control': 'no-store' } })
    }
    const requested = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!requested.startsWith(`${root}/`) || !allowedTypes[extname(requested)]) return new Response('Not found', { status: 404 })
    const file = Bun.file(requested)
    if (!await file.exists()) return new Response('Not found', { status: 404 })
    if (requested.endsWith('.html')) {
      const reload = `<script>let fingerprint;setInterval(async()=>{try{const r=await fetch('/fingerprint.js');const next=await r.text();if(fingerprint&&next!==fingerprint)location.reload();fingerprint=next}catch{}},1200)</script>`
      return new Response((await file.text()).replace('</body>', `${reload}</body>`), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
    }
    return new Response(file, { headers: { 'Content-Type': allowedTypes[extname(requested)], 'Cache-Control': 'no-store' } })
  },
})
console.log('Design preview: http://127.0.0.1:47831')
