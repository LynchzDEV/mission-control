/** @jsxImportSource @kitajs/html */
import { Elysia } from 'elysia'
import { html } from '@elysiajs/html'
import { SampleView } from './fixtures/sample-view'

const app = new Elysia()
  .use(html())
  .get('/view', () => <SampleView name="mission control" />)

app.listen({ hostname: '127.0.0.1', port: 7998 })
console.log('LISTENING')
