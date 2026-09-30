import { expect, test } from 'bun:test'
import { launchWorkflowOptions, launchWorkflowRequest } from '../client/workflow-options'

const builtIn = { id: 'default', revision: 'r0', name: 'Plan, verify, execute, review' }
const research = { id: 'research', revision: 'r1', name: 'Research' }

test('with AI design as the default, every saved workflow stays pickable, the built-in one too', () => {
  expect(launchWorkflowOptions([builtIn, research], builtIn, true)).toEqual([
    ['Default · Let the AI design', ''],
    ['Plan, verify, execute, review', 'default@r0'],
    ['Research', 'research@r1'],
  ])
})

test('with a saved default, AI design is offered as a choice and the default is not listed twice', () => {
  expect(launchWorkflowOptions([builtIn, research], research, false)).toEqual([
    ['Default · Research', ''],
    ['Let the AI design', 'design'],
    ['Plan, verify, execute, review', 'default@r0'],
  ])
})

test('the chosen option becomes the terminal request fields', () => {
  expect(launchWorkflowRequest('')).toEqual({})
  expect(launchWorkflowRequest('design')).toEqual({ design: true })
  expect(launchWorkflowRequest('research@r1')).toEqual({ workflowId: 'research', revision: 'r1' })
})
