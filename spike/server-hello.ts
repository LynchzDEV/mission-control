import { buildHelloApp } from './check-elysia'

const app = buildHelloApp()
app.listen({ hostname: '127.0.0.1', port: 7997 })
console.log('LISTENING')
