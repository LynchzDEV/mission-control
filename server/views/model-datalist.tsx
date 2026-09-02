/** @jsxImportSource @kitajs/html */
import { MODEL_SUGGESTIONS } from '../engines'

const SUGGESTIONS = [...new Set(Object.values(MODEL_SUGGESTIONS).flat())]

export function ModelDatalist(): JSX.Element {
  return (
    <datalist id="model-suggestions">
      {SUGGESTIONS.map((model) => (
        <option value={model} />
      ))}
    </datalist>
  )
}
