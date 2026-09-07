import { describe, expect, test } from 'bun:test'

import { pickerState } from '../client/model-picker'

describe('pickerState', () => {
  const list = ['opus', 'sonnet']

  test('empty value selects engine default', () => {
    expect(pickerState(list, '')).toEqual({ selected: '', custom: false })
  })

  test('a value in the list selects it', () => {
    expect(pickerState(list, 'opus')).toEqual({ selected: 'opus', custom: false })
  })

  test('a value outside the list selects custom', () => {
    expect(pickerState(list, 'glm-5.3-flash[1m]')).toEqual({ selected: '__custom__', custom: true })
  })
})
