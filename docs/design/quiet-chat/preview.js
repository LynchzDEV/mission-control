const $ = id => document.getElementById(id)
const screens = ['welcome', 'history', 'conversation', 'studio']
let chatScreen = 'welcome'
const responses = {
  'Simplify the terminal page': 'reply-simplify',
  'Fix the session reconnect': 'reply-reconnect',
  'Review the workflow builder': 'reply-workflow',
}

function showScreen(name) {
  if (name === 'studio') $('agents').close()
  dispatchEvent(new Event('quiet:design'))
  if (name !== 'studio') chatScreen = name
  for (const screen of screens) $(screen).hidden = screen !== name
  document.querySelector('.canvas').dataset.screen = name
  document.querySelector('.composer-area').hidden = name === 'studio'
  for (const id of ['search', 'new-chat', 'open-agents', 'toggle-flow']) $(id).hidden = name === 'studio'
  $('back-to-chat').hidden = name !== 'studio'
  $('open-studio').setAttribute('aria-pressed', String(name === 'studio'))
  $('flow').hidden = name === 'studio'
  document.querySelector('.stage').scrollTop = 0
}

function toggleFlow(open) {
  $('flow').dataset.open = String(open)
  $('flow').inert = !open
  $('flow').setAttribute('aria-hidden', String(!open))
  $('toggle-flow').setAttribute('aria-expanded', String(open))
}
const mobileAgents = matchMedia('(max-width: 600px)')
function showAgents() {
  if (mobileAgents.matches) $('agents').showModal()
  else $('agents').show()
}
mobileAgents.addEventListener('change', () => {
  if (!$('agents').open) return
  $('agents').close()
  showAgents()
})
$('open-agents').onclick = () => {
  if ($('agents').open) $('agents').close()
  else showAgents()
  $('open-agents').setAttribute('aria-expanded', String($('agents').open))
}
$('agents').addEventListener('close', () => $('open-agents').setAttribute('aria-expanded', String($('agents').open)))
$('agents').onkeydown = event => {
  if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); $('agents').close(); $('open-agents').focus() }
}
$('toggle-flow').onclick = () => toggleFlow($('flow').dataset.open !== 'true')
$('close-flow').onclick = () => { toggleFlow(false); $('toggle-flow').focus() }
$('open-studio').onclick = () => showScreen('studio')
$('back-to-chat').onclick = () => { showScreen(chatScreen); $('open-studio').focus() }

function setActivity(active) {
  document.querySelectorAll('.activity-empty').forEach(node => { node.hidden = active })
  document.querySelectorAll('.activity-filled').forEach(node => { node.hidden = !active })
}

function appendUserMessage(text) {
  const row = document.createElement('div')
  const bubble = document.createElement('div')
  row.className = 'msg user'
  bubble.className = 'user-message'
  bubble.textContent = text
  row.append(bubble)
  $('messages').append(row)
}

function appendAssistantMessage(templateId) {
  const row = $('assistant-row').content.firstElementChild.cloneNode(true)
  row.querySelector('time').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  row.querySelector('.msg-body').append($(templateId).content.cloneNode(true))
  row.querySelector('[data-open-agents]')?.addEventListener('click', () => $('open-agents').click())
  $('messages').append(row)
}

function showConversation(prompt) {
  appendUserMessage(prompt)
  appendAssistantMessage(responses[prompt] ?? 'reply-default')
  showScreen('conversation')
  setActivity($('messages').firstElementChild?.textContent === 'Simplify the terminal page')
  const stage = document.querySelector('.stage')
  stage.scrollTop = stage.scrollHeight
}

$('new-conversation').onclick = () => {
  $('new-chat-menu').hidePopover()
  $('messages').replaceChildren()
  $('composer').reset()
  $('message').style.height = ''
  $('agent-reply').reset()
  $('sent-reply').hidden = true
  showScreen('welcome')
  setActivity(false)
  $('message').focus()
}

function showHistory() {
  showScreen('history')
  $('chat-search').focus()
}
$('search').onclick = showHistory
$('show-history').onclick = showHistory

$('chat-search').oninput = () => {
  const query = $('chat-search').value.trim().toLowerCase()
  const items = [...document.querySelectorAll('#history .history-item')]
  items.forEach(item => { item.hidden = !item.textContent.toLowerCase().includes(query) })
  $('no-results').hidden = items.some(item => !item.hidden)
}

document.querySelectorAll('[data-chat]').forEach(button => {
  button.onclick = () => {
    $('messages').replaceChildren()
    $('sent-reply').hidden = true
    $('agent-reply').reset()
    showConversation(button.dataset.chat)
    $('message').focus()
  }
})

document.querySelectorAll('[data-dialog]').forEach(button => {
  button.onclick = () => $(button.dataset.dialog).showModal()
})

$('composer').onsubmit = event => {
  event.preventDefault()
  const prompt = $('message').value.trim()
  if (!prompt) return
  if (!$('history').hidden) $('messages').replaceChildren()
  showConversation(prompt)
  $('message').value = ''
  $('message').style.height = ''
  $('message').focus()
}
$('message').onkeydown = event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  $('composer').requestSubmit()
}
$('message').oninput = () => {
  $('message').style.height = ''
  $('message').style.height = `${Math.min(138, $('message').scrollHeight)}px`
}
$('agent-reply').onsubmit = event => {
  event.preventDefault()
  const reply = $('reply').value.trim()
  if (!reply) return
  $('sent-reply').textContent = reply
  $('sent-reply').hidden = false
  $('reply').value = ''
}
$('session').addEventListener('close', () => {
  $('project-chip').lastElementChild.textContent = $('project').value
  $('message').setAttribute('aria-label', `Message ${$('engine').value} in ${$('project').value}`)
})

const studioViews = ['home', 'templates', 'editor', 'connections', 'runs', 'rules']
let selectedStep = 0
let steps = []

function studioScreen(name) {
  for (const view of studioViews) $(`studio-${view}`).hidden = view !== name
  document.querySelectorAll('[data-studio]').forEach(button => {
    if (button.dataset.studio === name) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  document.querySelector('.stage').scrollTop = 0
}
document.querySelectorAll('[data-studio]').forEach(button => {
  button.onclick = () => studioScreen(button.dataset.studio)
})

function editorPanel(name) {
  for (const id of ['step-inspector', 'studio-assistant', 'studio-history']) $(id).hidden = id !== name
}

function selectStep(index) {
  selectedStep = index
  const step = steps[index]
  editorPanel('step-inspector')
  for (const field of ['step-name', 'step-instructions', 'step-engine', 'remove-step']) $(field).disabled = !step
  $('step-name').value = step?.title ?? ''
  $('step-instructions').value = step?.instructions ?? ''
  $('step-engine').value = step?.engine ?? 'Claude'
  document.querySelectorAll('.workflow-node').forEach((node, at) => node.setAttribute('aria-pressed', String(index === at)))
}

function renderSteps() {
  $('workflow-nodes').replaceChildren()
  steps.forEach((step, index) => {
    const button = document.createElement('button')
    button.className = 'workflow-node'
    button.type = 'button'
    const title = document.createElement('strong')
    const engine = document.createElement('small')
    title.textContent = step.title
    engine.textContent = step.engine
    button.append(title, engine)
    button.onclick = () => selectStep(index)
    $('workflow-nodes').append(button)
  })
  if (!steps.length) {
    const empty = document.createElement('p')
    empty.className = 'muted'
    empty.textContent = 'Your workflow starts here. Add your first step.'
    $('workflow-nodes').append(empty)
  }
  selectStep(Math.min(selectedStep, steps.length - 1))
}

function openEditor(template) {
  const titles = template === 'blank' ? [] : template === 'research' ? ['Research', 'Verify sources'] : ['Plan', 'Verify plan', 'Build', 'Review']
  steps = titles.map((title, index) => ({ title, engine: index % 2 ? 'Codex' : 'Claude', instructions: `${title} the work and report the evidence for the next step.` }))
  selectedStep = 0
  $('workflow-name').value = template === 'blank' ? 'Untitled workflow' : template === 'research' ? 'Research & verify' : 'Plan, build & review'
  $('draft-status').textContent = 'Sample draft'
  renderSteps()
  studioScreen('editor')
}
document.querySelectorAll('[data-editor]').forEach(button => { button.onclick = () => openEditor(button.dataset.editor) })
$('workflow-description').onsubmit = event => { event.preventDefault(); openEditor('default') }
$('add-step').onclick = () => {
  steps.push({ title: 'New task', engine: 'Claude', instructions: 'Describe the task and the evidence required.' })
  selectedStep = steps.length - 1
  $('draft-status').textContent = 'Unsaved changes'
  renderSteps()
  $('step-name').focus()
}
for (const [id, key] of [['step-name', 'title'], ['step-instructions', 'instructions'], ['step-engine', 'engine']]) {
  $(id).addEventListener('input', () => {
    if (!steps[selectedStep]) return
    steps[selectedStep][key] = $(id).value
    $('draft-status').textContent = 'Unsaved changes'
    const node = $('workflow-nodes').children[selectedStep]
    node.querySelector('strong').textContent = steps[selectedStep].title
    node.querySelector('small').textContent = steps[selectedStep].engine
  })
}
$('workflow-name').oninput = () => { $('draft-status').textContent = 'Unsaved changes' }
$('remove-step').onclick = () => { steps.splice(selectedStep, 1); $('draft-status').textContent = 'Unsaved changes'; renderSteps(); $('add-step').focus() }
$('ask-ai').onclick = () => editorPanel('studio-assistant')
$('workflow-history').onclick = () => editorPanel('studio-history')
$('save-workflow').onclick = () => { $('draft-status').textContent = 'Draft kept in this preview' }
$('workflow-change').onsubmit = event => {
  event.preventDefault()
  steps.splice(Math.max(0, steps.length - 1), 0, { title: 'Test', engine: 'Codex', instructions: 'Run the checks and report their results before review.' })
  selectedStep = Math.max(0, steps.length - 2)
  $('draft-status').textContent = 'Sample change · testing step added'
  renderSteps()
}
document.querySelectorAll('[data-connection]').forEach(button => {
  button.onclick = () => {
    const name = button.dataset.connection
    $('connection-name').textContent = name
    $('connection-description').textContent = ({ Claude: 'Use the account signed in through the Claude Code CLI.', Codex: 'Use the account signed in through the Codex CLI.', GLM: 'Connect Claude Code to your z.ai account.', 'Custom AI': 'Connect the local app or compatible provider you already use.' })[name]
    $('glm-settings').hidden = name !== 'GLM'
    $('custom-ai-settings').hidden = name !== 'Custom AI'
    document.querySelectorAll('[data-connection]').forEach(item => item.setAttribute('aria-pressed', String(item === button)))
  }
})
$('run-in-chat').onclick = () => {
  $('messages').replaceChildren()
  showConversation('Simplify the terminal page')
  toggleFlow(true)
}

let liveModule
async function openLive(restore = false) {
  $('new-chat-menu').hidePopover()
  try {
    liveModule ??= import('./live-terminal.js')
    const { openTerminal } = await liveModule
    await openTerminal(restore)
  } catch {
    liveModule = undefined
    $('live-error').textContent = 'Could not load the terminal. Reload and try again.'
    if (!$('live-launch').open) $('live-launch').showModal()
  }
}
document.querySelectorAll('[data-live]').forEach(button => { button.onclick = () => void openLive() })
if (location.hash === '#terminal' || new URLSearchParams(location.search).has('terminal')) void openLive(true)
