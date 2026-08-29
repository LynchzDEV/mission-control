/** @jsxImportSource @kitajs/html */

export type Tab = 'lanes' | 'dispatch' | 'terminals' | 'review' | 'settings'

export type TabLink = {
  tab: Tab
  href: string
  label: string
  key: string
}

export const TABS: TabLink[] = [
  { tab: 'lanes', href: '/lanes', label: 'LANES', key: '1' },
  { tab: 'dispatch', href: '/dispatch', label: 'DISPATCH', key: '2' },
  { tab: 'terminals', href: '/terminals', label: 'TERMINALS', key: '3' },
  { tab: 'review', href: '/review', label: 'REVIEW', key: '4' },
  { tab: 'settings', href: '/settings', label: 'SETTINGS', key: '5' },
]

export type LayoutProps = {
  title: string
  page: string
  meta?: JSX.Element | string
  tab?: Tab
  chrome?: boolean
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
      <div class="top">
        <div class="l">MISSION CONTROL</div>
        <div id="meta">{props.meta ?? ''}</div>
      </div>
      {chrome ? (
        <nav class="tabs" id="tabs">
          {TABS.map((entry) => (
            <a
              href={entry.href}
              class={entry.tab === props.tab ? 'on' : ''}
              data-key={entry.key}
              data-tab={entry.tab}
            >
              <i>{entry.key}</i>
              {entry.label}
            </a>
          ))}
        </nav>
      ) : (
        ''
      )}
      <div class="body" data-tab={props.tab ?? 'gate'}>
        {props.children ?? ''}
      </div>
      {chrome ? Drawer() : ''}
    </body>
  )

  return `<!doctype html>\n${(
    <html lang="en">
      {head(props.title, props.vendor ?? [], props.islands ?? [], props.styles ?? [])}
      {body}
    </html>
  )}`
}
