/** @jsxImportSource @kitajs/html */
import { Layout } from './layout'
import { WorkView } from './work'
export function ReviewPage(embedded = false): string {
  return Layout({ embedded, title: 'Mission Control — Review', page: 'app', tab: 'review', islands: ['nav', 'work'], children: WorkView('review') })
}
