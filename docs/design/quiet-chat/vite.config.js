import { fileURLToPath } from 'node:url'
import { issueSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from '../../../server/auth.ts'

const origin = 'http://127.0.0.1:51947'

export function localRequestAllowed(request, expectedOrigin) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return false
  if (`http://${request.headers.host}` !== expectedOrigin) return false
  if (request.headers.origin && request.headers.origin !== expectedOrigin) return false
  const site = request.headers['sec-fetch-site']
  const document = request.method === 'GET' && ['/', '/index.html'].includes(request.url?.split('?')[0]) && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document'
  return !site || site === 'same-origin' || site === 'none' || document
}

export default {
  define: { 'import.meta.env.VITE_WORKSPACE_DIR': JSON.stringify(process.env.VITE_WORKSPACE_DIR ?? fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '')) },
  server: {
    host: '127.0.0.1', port: 51947, strictPort: true, cors: false,
    proxy: {
      '^/api/(jobs|flow|models|roles|studio/workflows)(\\?.*)?$': 'http://127.0.0.1:7777',
      '/api/terminals': 'http://127.0.0.1:7777',
      '/ws/terminal/': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
  plugins: [{
    name: 'local-workspace-access',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!localRequestAllowed(request, origin)) { response.statusCode = 403; response.end('Local workspace access only'); return }
        if (/^\/api\/(jobs|flow|models|roles|studio\/workflows)(\?|$)/.test(request.url ?? '') && request.method !== 'GET') { response.statusCode = 405; response.end('Read-only activity'); return }
        response.setHeader('X-Frame-Options', 'DENY')
        if (request.method === 'GET' && ['/', '/index.html'].includes(request.url?.split('?')[0])) {
          try {
            response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${await issueSessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
            response.setHeader('Cache-Control', 'no-store')
          } catch { response.statusCode = 503; response.end('Could not open the local workspace'); return }
        }
        next()
      })
      server.httpServer?.prependListener('upgrade', (request, socket) => {
        if (!localRequestAllowed(request, origin) || request.headers.origin !== origin) socket.destroy()
      })
    },
  }],
}
