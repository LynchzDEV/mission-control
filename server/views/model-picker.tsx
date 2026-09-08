/** @jsxImportSource @kitajs/html */
import type { ModelLists } from '../models'

export function ModelPicker(props: {
  id: string
  engineSelectId: string
  value: string | null
  models: ModelLists
  engine: string
}): JSX.Element {
  const list = props.models[props.engine as keyof ModelLists] ?? []
  const value = props.value ?? ''
  const custom = value !== '' && !list.includes(value)
  return (
    <span class="mpick">
      <select class="model-pick" id={`${props.id}_pick`} data-model-for={props.engineSelectId} data-model-input={props.id} aria-label="Model">
        <option value="">engine default</option>
        {list.map((model) => (
          <option value={model} selected={model === value}>
            {model}
          </option>
        ))}
        <option value="__custom__" selected={custom}>
          custom…
        </option>
      </select>
      <input
        id={props.id}
        name={props.id}
        value={value}
        maxlength="100"
        autocomplete="off"
        placeholder="model id" aria-label="Custom model ID"
        hidden={!custom}
      />
    </span>
  )
}

export function ModelListsScript(models: ModelLists): JSX.Element {
  const json = JSON.stringify(models).replaceAll('<', '\\u003c')
  return (
    <script type="application/json" id="model-lists">
      {json}
    </script>
  )
}
