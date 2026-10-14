import { expect, test } from 'bun:test'
import { readShape } from '../server/flow-shape'
import { readNodeResult } from '../server/workflow-runner'

const resultLog = (text: string) => `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text })}\n`
const shape = { contract: 'c', paths: [{ id: 'a', title: 'A', files: ['a'], steps: [{ title: 's', instructions: 'i' }] }, { id: 'b', title: 'B', files: ['b'], steps: [{ title: 's', instructions: 'i' }] }] }

test('reads the SKD_RESULT line an agent ends with', () => {
  expect(readNodeResult(resultLog('done\nSKD_RESULT {"outcome":"pass","summary":"ok","evidence":["bun test"]}'))).toMatchObject({ outcome: 'pass', summary: 'ok' })
})

test('still reads the legacy MC_RESULT line', () => {
  expect(readNodeResult(resultLog('done\nMC_RESULT {"outcome":"fail","summary":"old","evidence":[]}'))).toMatchObject({ outcome: 'fail', summary: 'old' })
})

test('still reads the legacy MC_SHAPE line', () => {
  expect(readShape(`THE PLAN\nMC_SHAPE ${JSON.stringify(shape)}`)).toEqual({ shape })
})

test('the newest shape line wins whichever name it uses', () => {
  const other = { ...shape, contract: 'newer' }
  expect(readShape(`MC_SHAPE ${JSON.stringify(shape)}\nSKD_SHAPE ${JSON.stringify(other)}`)).toEqual({ shape: other })
})
