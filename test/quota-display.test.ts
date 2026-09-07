import { expect, test } from 'bun:test'

import { paintOtherTokens } from '../client/quota'

test('proxy line appears for other tokens and clears on subsequent Claude-only or unavailable data', () => {
  const element = { hidden: true, textContent: '' } as HTMLElement
  paintOtherTokens(element, { available: true, otherTokens: 1234567 })
  expect(element.hidden).toBe(false)
  expect(element.textContent).toBe('+ 1,234,567 via claude binary (glm/proxy)')

  for (const quota of [{ otherTokens: 0 }, {}, { available: false, otherTokens: 123 }]) {
    paintOtherTokens(element, { available: true, otherTokens: 1234567 })
    paintOtherTokens(element, quota)
    expect(element.hidden).toBe(true)
    expect(element.textContent).toBe('')
  }
})
