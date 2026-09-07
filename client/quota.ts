import { readNumber, type JsonRecord } from './shared'

export function paintOtherTokens(element: HTMLElement | null, claude: JsonRecord): void {
  if (element === null) return
  const tokens = claude.available === false ? 0 : readNumber(claude.otherTokens) ?? 0
  element.hidden = tokens <= 0
  element.textContent = tokens > 0 ? `+ ${tokens.toLocaleString('en-US')} via claude binary (glm/proxy)` : ''
}
