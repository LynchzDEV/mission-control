/** @jsxImportSource @kitajs/html */
import type { ModelLists } from '../models'
import { Layout } from './layout'
import { WorkView } from './work'
export type EnginePageProps = { embedded?: boolean; defaultEngine: string; defaultModel: string | null; models: ModelLists }
export function DispatchPage(props: EnginePageProps): string {
  return Layout({ embedded: props.embedded, title: 'Mission Control — New job', page: 'app', tab: 'dispatch', islands: ['nav', 'work'], children: WorkView('compose', props) })
}
