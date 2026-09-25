const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const screens = ['welcome', 'history', 'conversation'] as const
const responses: Record<string, string> = {
  'Simplify the terminal page': 'reply-simplify',
  'Fix the session reconnect': 'reply-reconnect',
  'Review the workflow builder': 'reply-workflow',
}
const agents = $('agents') as HTMLDialogElement
const flow = $('flow')
const message = $('message') as HTMLTextAreaElement
const composer = $('composer') as HTMLFormElement

function showScreen(name: (typeof screens)[number]): void {
  dispatchEvent(new Event('quiet:design'))
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

function setActivity(active: boolean): void {
  document.querySelectorAll<HTMLElement>('.activity-empty').forEach(node => { node.hidden = active })
  document.querySelectorAll<HTMLElement>('.activity-filled').forEach(node => { node.hidden = !active })
}

function appendUserMessage(text: string): void {
  const row = document.createElement('div')
  const bubble = document.createElement('div')
  row.className = 'msg user'
  bubble.className = 'user-message'
  bubble.textContent = text
  row.append(bubble)
  $('messages').append(row)
}

function appendAssistantMessage(templateId: string): void {
  const row = ($('assistant-row') as HTMLTemplateElement).content.firstElementChild!.cloneNode(true) as HTMLElement
  row.querySelector('time')!.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  row.querySelector('.msg-body')!.append(($(templateId) as HTMLTemplateElement).content.cloneNode(true))
  row.querySelector('[data-open-agents]')?.addEventListener('click', () => $('open-agents').click())
  $('messages').append(row)
}

function showConversation(prompt: string): void {
  appendUserMessage(prompt)
  appendAssistantMessage(responses[prompt] ?? 'reply-default')
  showScreen('conversation')
  setActivity($('messages').firstElementChild?.textContent === 'Simplify the terminal page')
  const stage = document.querySelector('.stage') as HTMLElement
  stage.scrollTop = stage.scrollHeight
}

$('new-conversation').onclick = () => {
  $('new-chat-menu').hidePopover()
  $('messages').replaceChildren()
  composer.reset()
  message.style.height = ''
  ;($('agent-reply') as HTMLFormElement).reset()
  $('sent-reply').hidden = true
  showScreen('welcome')
  setActivity(false)
  message.focus()
}

function showHistory(): void {
  showScreen('history')
  $('chat-search').focus()
}
$('search').onclick = showHistory
$('show-history').onclick = showHistory

$('chat-search').oninput = () => {
  const query = ($('chat-search') as HTMLInputElement).value.trim().toLowerCase()
  const items = [...document.querySelectorAll<HTMLElement>('#history .history-item')]
  items.forEach(item => { item.hidden = !(item.textContent ?? '').toLowerCase().includes(query) })
  $('no-results').hidden = items.some(item => !item.hidden)
}

document.querySelectorAll<HTMLElement>('[data-chat]').forEach(button => {
  button.onclick = () => {
    $('messages').replaceChildren()
    $('sent-reply').hidden = true
    ;($('agent-reply') as HTMLFormElement).reset()
    showConversation(button.dataset.chat ?? '')
    message.focus()
  }
})

document.querySelectorAll<HTMLElement>('[data-dialog]').forEach(button => {
  button.onclick = () => ($(button.dataset.dialog ?? '') as HTMLDialogElement).showModal()
})

composer.onsubmit = (event) => {
  event.preventDefault()
  const prompt = message.value.trim()
  if (!prompt) return
  if (!$('history').hidden) $('messages').replaceChildren()
  showConversation(prompt)
  message.value = ''
  message.style.height = ''
  message.focus()
}
message.onkeydown = (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  composer.requestSubmit()
}
message.oninput = () => {
  message.style.height = ''
  message.style.height = `${Math.min(138, message.scrollHeight)}px`
}
;($('agent-reply') as HTMLFormElement).onsubmit = (event) => {
  event.preventDefault()
  const reply = ($('reply') as HTMLTextAreaElement).value.trim()
  if (!reply) return
  $('sent-reply').textContent = reply
  $('sent-reply').hidden = false
  ;($('reply') as HTMLTextAreaElement).value = ''
}
$('session').addEventListener('close', () => {
  const project = ($('project') as HTMLSelectElement).value
  $('project-chip').lastElementChild!.textContent = project
  message.setAttribute('aria-label', `Message ${($('engine') as HTMLSelectElement).value} in ${project}`)
})

document.querySelectorAll<HTMLElement>('[data-live]').forEach(button => {
  button.onclick = () => { $('new-chat-menu').hidePopover(); dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { restore: false } })) }
})
if (location.hash === '#terminal' || new URLSearchParams(location.search).has('terminal')) dispatchEvent(new CustomEvent('quiet:open-terminal', { detail: { restore: true } }))

export {}
