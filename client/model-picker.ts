import { getJson, readRecord } from './shared'
export type PickerState = { selected: string; custom: boolean }

export function pickerState(list: readonly string[], current: string): PickerState {
  if (current === '') return { selected: '', custom: false }
  if (list.includes(current)) return { selected: current, custom: false }
  return { selected: '__custom__', custom: true }
}

type ModelLists = Record<string, string[]>

export function installModelPickers(): void {
  const script = document.querySelector<HTMLScriptElement>('#model-lists')
  if (script === null || script.textContent === null) return
  let lists: ModelLists
  try {
    lists = JSON.parse(script.textContent) as ModelLists
  } catch {
    return
  }

  addEventListener('mc:settings-refresh', () => void refreshDefaults())
  addEventListener('message', event => { if (event.origin === location.origin && event.source === parent && event.data?.type === 'mc:settings-refresh') void refreshDefaults() })
  let generation = 0
  const rebuilders: Array<() => void> = []
  const dirty = new WeakSet<HTMLFormElement>()
  async function refreshDefaults(): Promise<void> {
    const request = ++generation
    const [roles, models] = await Promise.all([getJson('/api/roles'), getJson('/api/models')])
    if (request !== generation || !roles.ok || !models.ok) return
    lists = Object.fromEntries(Object.entries(models.data).filter(([, value]) => Array.isArray(value) && value.every(item => typeof item === 'string'))) as ModelLists
    for (const [engineId, modelId, role] of [['term-engine', 'term-model', 'plan'], ['engine', 'model', 'execute']]) {
      const engine = document.getElementById(engineId!) as HTMLSelectElement | null
      const model = document.getElementById(modelId!) as HTMLInputElement | null
      const assignment = readRecord(roles.data[role!])
      if (!engine || !model || typeof assignment.engine !== 'string') continue
      const pristine = !engine.form || !dirty.has(engine.form)
      const currentEngine = engine.value, currentModel = model.value
      for (const option of engine.options) option.defaultSelected = option.value === assignment.engine
      model.defaultValue = typeof assignment.model === 'string' ? assignment.model : ''
      engine.value = pristine ? assignment.engine : currentEngine
      model.value = pristine ? model.defaultValue : currentModel
    }
    for (const rebuild of rebuilders) rebuild()
  }
  const listFor = (engine: string): string[] => lists[engine] ?? []

  for (const select of document.querySelectorAll<HTMLSelectElement>('select.model-pick')) {
    const engineSelect = document.querySelector<HTMLSelectElement>(`#${CSS.escape(select.dataset.modelFor ?? '')}`)
    const input = document.querySelector<HTMLInputElement>(`#${CSS.escape(select.dataset.modelInput ?? '')}`)
    if (engineSelect === null || input === null) continue

    const form = input.form
    if (form) {
      if ([...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].some(field => field.value !== field.defaultValue || (field instanceof HTMLInputElement && field.type === 'checkbox' && field.checked !== field.defaultChecked)) || [...engineSelect.options].some(option => option.selected !== option.defaultSelected)) dirty.add(form)
      form.addEventListener('input', () => dirty.add(form))
      form.addEventListener('change', () => dirty.add(form))
      form.addEventListener('reset', () => dirty.delete(form))
    }
    const rebuild = (): void => {
      select.replaceChildren()
      const addOption = (value: string, label: string): void => {
        const option = document.createElement('option')
        option.value = value
        option.textContent = label
        select.append(option)
      }
      addOption('', 'engine default')
      for (const model of listFor(engineSelect.value)) addOption(model, model)
      addOption('__custom__', 'custom…')
      const state = pickerState(listFor(engineSelect.value), input.value)
      select.value = state.selected
      input.hidden = !state.custom
    }

    select.addEventListener('change', () => {
      if (select.value === '__custom__') {
        input.hidden = false
        input.value = ''
        input.focus()
      } else {
        input.value = select.value
        input.hidden = true
      }
    })
    engineSelect.addEventListener('change', () => {
      if (pickerState(listFor(engineSelect.value), input.value).custom) input.value = ''
      rebuild()
    })
    rebuilders.push(rebuild)
    input.form?.addEventListener('reset', () => queueMicrotask(rebuild))
    rebuild()
  }
}
