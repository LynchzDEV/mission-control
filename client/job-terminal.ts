import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

import type { ThreadMessage } from './chat-view'
import { errorText, getJson } from './shared'
import { TERMINAL_FONT, terminalTheme } from './terminal-theme'
import { toolCard } from './tool-cards'

export type JobScreen = { write(text: string): void; reset(): void; fit(): void; dispose(): void }
export type JobWatch = { jobId: string | null; title: string; engine: string }
export type JobTerminal = { show(watch: JobWatch): void; dispose(): void }

const ESC = '\x1b'
const paint = (code: string, text: string): string => `${ESC}[${code}m${text}${ESC}[0m`
const dim = (text: string): string => paint('2', text)
const red = (text: string): string => paint('31', text)
const PREVIEW_LINES = 3
const LINE_CHARS = 400
const REFRESH_MS = 250
const NEWLINE = '\r\n'

const clip = (line: string): string => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line)
const crlf = (text: string): string => text.replace(/\r?\n/g, NEWLINE)
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

function resultPreview(output: string, failed: boolean, running: boolean): string[] {
  if (running) return [dim('  ⎿  running…')]
  const lines = output.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return [dim('  ⎿  (no output)')]
  const shown = lines.slice(0, PREVIEW_LINES).map((line, index) => `${index === 0 ? '  ⎿  ' : '     '}${clip(line)}`)
  const rest = lines.length - shown.length
  return [...shown.map(line => (failed ? red(line) : dim(line))), ...(rest > 0 ? [dim(`     … ${plural(rest, 'more line')}`)] : [])]
}

function toolBlock(message: Extract<ThreadMessage, { kind: 'tool' }>, running: boolean, index: number): string[] {
  const card = toolCard(message, running, index)
  const failed = card.status === 'failed'
  const head = `${paint(failed ? '31' : '35', '●')} ${paint('1', card.verb)}${card.target === '' ? '' : ` ${card.target}`}`
  const command = card.command !== null && card.command !== card.target ? [dim(`  $ ${clip(card.command.split('\n')[0] ?? '')}`)] : []
  return [head, ...command, ...resultPreview(card.output, failed, card.status === 'running')]
}

function block(message: ThreadMessage, running: boolean, index: number): string[] {
  if (message.kind === 'prompt') return [dim(`Instructions sent to the agent · ${plural(message.text.split('\n').length, 'line')}`)]
  if (message.kind === 'text') return [crlf(message.text)]
  if (message.kind === 'tool') return toolBlock(message, running, index)
  if (message.kind === 'result') return [message.isError ? red(`Stopped with an error · ${message.text}`) : paint('32', `Finished${message.text === '' ? '' : ` · ${message.text}`}`)]
  return []
}

export function jobTranscript(messages: readonly ThreadMessage[], running = false): string {
  const blocks = messages.map((message, index) => block(message, running, index)).filter(lines => lines.length > 0)
  return blocks.map(lines => lines.join(NEWLINE) + NEWLINE).join(NEWLINE)
}

function statusBar(): { bar: HTMLElement; logo: HTMLImageElement; name: HTMLElement; status: HTMLElement; label: HTMLElement } {
  const bar = document.createElement('div')
  bar.className = 'term-bar flow-term-bar'
  const logoWrap = document.createElement('span')
  logoWrap.className = 'term-bar-logo'
  const logo = document.createElement('img')
  logo.alt = ''
  logoWrap.append(logo)
  const name = document.createElement('span')
  name.className = 'term-bar-name'
  const status = document.createElement('span')
  status.className = 'term-bar-status flow-term-status'
  status.setAttribute('role', 'status')
  const label = document.createElement('span')
  status.append(document.createElement('i'), label)
  bar.append(logoWrap, name, status)
  return { bar, logo, name, status, label }
}

export function createJobTerminal(host: HTMLElement, makeScreen: (element: HTMLElement) => JobScreen): JobTerminal {
  const { bar, logo, name, status, label } = statusBar()
  const surface = document.createElement('div')
  surface.className = 'term-screen flow-term-screen'
  host.replaceChildren(bar, surface)
  const screen = makeScreen(surface)
  let current: JobWatch | null = null
  let written = ''
  let generation = 0
  let stream: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let loading: Promise<void> | null = null
  let again = false

  const setStatus = (text: string, kind: 'live' | 'muted' | 'down'): void => { label.textContent = text; status.dataset.kind = kind }
  const closeStream = (): void => { stream?.close(); stream = null; clearTimeout(timer); timer = undefined }

  function draw(text: string): void {
    if (text.startsWith(written)) screen.write(text.slice(written.length))
    else { screen.reset(); screen.write(text) }
    written = text
  }

  async function load(request: number, jobId: string): Promise<void> {
    const result = await getJson(`/api/jobs/${encodeURIComponent(jobId)}/thread`)
    if (request !== generation) return
    if (!result.ok) { draw(red(`Could not load this step’s output: ${errorText(result)}`) + NEWLINE); setStatus('Unavailable', 'down'); closeStream(); return }
    const running = result.data.running === true
    draw(jobTranscript(Array.isArray(result.data.messages) ? result.data.messages as ThreadMessage[] : [], running))
    setStatus(running ? 'Live' : 'Finished', running ? 'live' : 'muted')
    if (running && stream === null) follow(request, jobId)
    if (!running) closeStream()
  }

  function refresh(request: number, jobId: string): void {
    if (loading !== null) { again = true; return }
    loading = load(request, jobId).finally(() => {
      loading = null
      if (!again || request !== generation) return
      again = false
      refresh(request, jobId)
    })
  }

  function follow(request: number, jobId: string): void {
    const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`)
    stream = source
    source.onmessage = () => { if (timer === undefined) timer = setTimeout(() => { timer = undefined; refresh(request, jobId) }, REFRESH_MS) }
    source.onerror = () => { if (stream !== source) return; closeStream(); refresh(request, jobId) }
  }

  return {
    show(watch: JobWatch): void {
      if (current !== null && current.jobId === watch.jobId && current.title === watch.title) return
      current = watch
      generation += 1
      closeStream()
      again = false
      name.textContent = watch.title
      logo.src = `/providers/${watch.engine}.svg`
      ;(logo.parentElement as HTMLElement).dataset.engine = watch.engine
      written = ''
      screen.reset()
      if (watch.jobId === null) { draw(dim('This step has not started yet.') + NEWLINE); setStatus('Waiting', 'muted'); return }
      setStatus('Loading…', 'muted')
      loading = null
      refresh(generation, watch.jobId)
    },
    dispose(): void {
      generation += 1
      closeStream()
      screen.dispose()
    },
  }
}

export function xtermScreen(element: HTMLElement): JobScreen {
  const terminal = new Terminal({ ...TERMINAL_FONT, theme: terminalTheme(), disableStdin: true, cursorBlink: false, scrollback: 10000 })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(new WebLinksAddon())
  terminal.open(element)
  const hideCursor = (): void => terminal.write(`${ESC}[?25l`)
  hideCursor()
  let frame = 0
  const fitNow = (): void => { if (element.clientWidth > 0) fit.fit() }
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fitNow) })
  observer.observe(element)
  const onTheme = (): void => { terminal.options.theme = terminalTheme() }
  document.addEventListener('mc:theme', onTheme)
  return {
    write: text => terminal.write(text),
    reset: () => { terminal.reset(); hideCursor() },
    fit: fitNow,
    dispose: () => { observer.disconnect(); document.removeEventListener('mc:theme', onTheme); terminal.dispose() },
  }
}

const flowTerm = typeof document === 'undefined' ? null : document.getElementById('flow-term')
if (flowTerm !== null) {
  const view = createJobTerminal(flowTerm, xtermScreen)
  addEventListener('quiet:job-watch', event => view.show((event as CustomEvent<JobWatch>).detail))
}
