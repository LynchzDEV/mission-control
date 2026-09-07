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

  const listFor = (engine: string): string[] => lists[engine] ?? []

  for (const select of document.querySelectorAll<HTMLSelectElement>('select.model-pick')) {
    const engineSelect = document.querySelector<HTMLSelectElement>(`#${CSS.escape(select.dataset.modelFor ?? '')}`)
    const input = document.querySelector<HTMLInputElement>(`#${CSS.escape(select.dataset.modelInput ?? '')}`)
    if (engineSelect === null || input === null) continue

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
    rebuild()
  }
}
