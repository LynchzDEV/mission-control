/** @jsxImportSource @kitajs/html */

export type Tab = 'lanes' | 'dispatch' | 'terminals' | 'review' | 'settings'

export type TabLink = {
  tab: Tab
  href: string
  label: string
  key: string
}

export const TABS: TabLink[] = [
  { tab: 'lanes', href: '/lanes', label: 'Main', key: '1' },
  { tab: 'dispatch', href: '/dispatch', label: 'Dispatch', key: '2' },
  { tab: 'terminals', href: '/terminals', label: 'Terminals', key: '3' },
  { tab: 'review', href: '/review', label: 'Review', key: '4' },
  { tab: 'settings', href: '/settings', label: 'Settings', key: '5' },
]

export type LayoutProps = {
  title: string
  page: string
  meta?: JSX.Element | string
  tab?: Tab
  chrome?: boolean
  embedded?: boolean
  islands?: string[]
  vendor?: string[]
  styles?: string[]
  children?: JSX.Element | JSX.Element[] | string
}

function Drawer(): JSX.Element[] {
  return [<div class="mcd-dim" id="mc-dim"></div>, <div class="mcd" id="mc-drawer"></div>]
}

function head(title: string, vendor: string[], islands: string[], styles: string[]): JSX.Element {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>{title}</title>
      <link rel="stylesheet" href="/theme-tokens.css" />
      <link rel="stylesheet" href="/theme.css" />
      <link rel="stylesheet" href="/terminal-design.css" />
      {styles.map((href) => (
        <link rel="stylesheet" href={href} />
      ))}
      {vendor.map((file) => (
        <script src={`/vendor/${file}`}></script>
      ))}
      {islands.map((name) => (
        <script src={`/js/${name}.js`} type="module" defer></script>
      ))}
    </head>
  )
}

export function Layout(props: LayoutProps): string {
  const chrome = props.chrome !== false
  const body = (
    <body data-page={props.page}>
      {!props.embedded ? <div class="top masthead">
        <a class="l" href="/terminals" aria-label="Mission Control home">Mission Control<span class="brand-mark" aria-hidden="true">_</span></a>
        {chrome ? <><nav class="tabs" id="tabs" aria-label="Workspace">{TABS.filter(entry => entry.tab === 'terminals' || entry.tab === 'lanes').map(entry => <a href={entry.href} data-tab={entry.tab} data-key={entry.key} aria-current={entry.tab === props.tab ? 'page' : undefined} class={entry.tab === props.tab ? 'on' : ''}>{entry.label}</a>)}</nav><div class="usage-summary" id="provider-summary" aria-label="Live provider usage">{['Claude', 'GLM', 'Codex'].map(provider => <section class="provider-usage" data-unavailable="true"><div class="quota-heading"><span class="quota-provider">{provider}</span><span class="quota-period">{provider === 'Codex' ? 'Weekly' : '5h'}</span><strong>—</strong></div><span class="quota-track"></span>{provider === 'Codex' ? '' : <div class="quota-week"><span>Weekly</span><span class="quota-track"></span><span class="week-value">—</span></div>}</section>)}</div><div class="global-actions"><a href="/dispatch">New job</a><a href="/review" id="global-attention">Review <span>—</span></a><a href="/settings">Settings</a></div></> : ''}
      </div> : ''}
      <div class="body" data-tab={props.tab ?? 'gate'}>
        {props.children ?? ''}
      </div>
      {chrome ? Drawer() : ''}
    </body>
  )

  return `<!doctype html>\n${(
    <html lang="en" class={props.embedded ? 'embedded-view' : undefined}>
      {head(props.title, props.vendor ?? [], [...new Set(['workspace', 'provider-usage', ...(props.islands ?? [])])], props.styles ?? [])}
      {body}
    </html>
  )}`
}
