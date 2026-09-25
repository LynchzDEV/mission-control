const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const screens = ['welcome', 'history', 'conversation', 'studio'] as const
const agents = $('agents') as HTMLDialogElement
const flow = $('flow')
const message = $('message') as HTMLTextAreaElement
const composer = $('composer') as HTMLFormElement

function showScreen(name: (typeof screens)[number]): void {
  if (name !== 'history') { beforeHistory = null; $('search').setAttribute('aria-pressed', 'false') }
  if (name !== 'studio' && name !== 'history') beforeStudio = null
  $('open-studio').setAttribute('aria-pressed', String(name === 'studio'))
  dispatchEvent(new Event('quiet:design'))
  dispatchEvent(new CustomEvent('quiet:screen', { detail: name }))
  for (const screen of screens) $(screen).hidden = screen !== name
  ;(document.querySelector('.canvas') as HTMLElement).dataset.screen = name
  ;(document.querySelector('.stage') as HTMLElement).scrollTop = 0
}

function toggleFlow(open: boolean): void {
  flow.dataset.open = String(open)
  flow.inert = !open
  flow.setAttribute('aria-hidden', String(!open))
  $('toggle-flow').setAttribute('aria-expanded', String(open))
}

const mobileAgents = matchMedia('(max-width: 600px)')
function showAgents(): void {
  if (mobileAgents.matches) agents.showModal()
  else agents.show()
}
mobileAgents.addEventListener('change', () => {
  if (!agents.open) return
  agents.close()
  showAgents()
})
$('open-agents').onclick = () => {
  if (agents.open) agents.close()
  else showAgents()
  $('open-agents').setAttribute('aria-expanded', String(agents.open))
}
agents.addEventListener('close', () => $('open-agents').setAttribute('aria-expanded', String(agents.open)))
agents.onkeydown = (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); agents.close(); $('open-agents').focus() }
}
$('toggle-flow').onclick = () => toggleFlow(flow.dataset.open !== 'true')
$('close-flow').onclick = () => { toggleFlow(false); $('toggle-flow').focus() }





$('new-chat').onclick = () => {
  dispatchEvent(new Event('quiet:new-chat'))
  composer.reset()
  message.style.height = ''
  showScreen('welcome')
  message.focus()
}
addEventListener('quiet:show', (event) => showScreen((event as CustomEvent<(typeof screens)[number]>).detail))

let beforeHistory: { screen: (typeof screens)[number]; live: boolean } | null = null
let beforeStudio: { screen: (typeof screens)[number]; live: boolean } | null = null
function currentView(): { screen: (typeof screens)[number]; live: boolean } {
  return { screen: screens.find(screen => !$(screen).hidden) ?? 'welcome', live: (document.querySelector('.canvas') as HTMLElement).dataset.live === 'true' }
}
function leaveTo(back: { screen: (typeof screens)[number]; live: boolean }): void {
  showScreen(back.screen)
  if (back.live) dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { restore: true } }))
}
$('open-studio').onclick = () => {
  if (!$('studio').hidden) { const back = beforeStudio ?? { screen: 'welcome' as const, live: false }; beforeStudio = null; leaveTo(back); return }
  beforeStudio = currentView()
  showScreen('studio')
}
function showHistory(): void {
  beforeHistory = currentView()
  showScreen('history')
  $('search').setAttribute('aria-pressed', 'true')
  $('chat-search').focus()
}
function leaveHistory(): void {
  const back = beforeHistory ?? { screen: 'welcome' as const, live: false }
  beforeHistory = null
  $('search').setAttribute('aria-pressed', 'false')
  leaveTo(back)
}
$('search').onclick = () => { if ($('history').hidden) showHistory(); else leaveHistory() }
$('new-chat-menu').addEventListener('toggle', (event) => $('new-chat-more').setAttribute('aria-expanded', String((event as ToggleEvent).newState === 'open')))

$('chat-search').oninput = () => {
  const query = ($('chat-search') as HTMLInputElement).value.trim().toLowerCase()
  const items = [...document.querySelectorAll<HTMLElement>('#history .history-item')]
  items.forEach(item => { item.hidden = !(item.textContent ?? '').toLowerCase().includes(query) })
  $('no-results').hidden = items.some(item => !item.hidden)
}


;($('access-host') as HTMLInputElement).value = location.host
if (new URLSearchParams(location.search).get('screen') === 'studio') { history.replaceState(null, '', location.pathname); showScreen('studio') }

document.querySelectorAll<HTMLElement>('[data-dialog]').forEach(button => {
  button.onclick = () => ($(button.dataset.dialog ?? '') as HTMLDialogElement).showModal()
})

message.onkeydown = (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  composer.requestSubmit()
}
message.oninput = () => {
  message.style.height = ''
  message.style.height = `${Math.min(138, message.scrollHeight)}px`
}

document.querySelectorAll<HTMLElement>('[data-live]').forEach(button => {
  button.onclick = () => { $('new-chat-menu').hidePopover(); dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { restore: false } })) }
})

export {}
