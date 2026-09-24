import { Layout } from './layout'

export function StudioPage(props: { embedded?: boolean } = {}): string {
  return Layout({ ...props, title: 'Mission Control — Studio', page: 'studio', tab: 'studio', islands: ['studio'], styles: ['/js/studio.css', '/studio.css'], children: '<main id="studio-root" aria-label="Workflow Studio"><p role="status">Loading Studio…</p></main>' })
}
