type SavedWorkflow = { id: string; revision: string; name: string }

export function launchWorkflowOptions(workflows: SavedWorkflow[], selected: SavedWorkflow, design: boolean): Array<[string, string]> {
  const value = (item: SavedWorkflow) => `${item.id}@${item.revision}`
  const saved = workflows.filter(item => design || value(item) !== value(selected)).map((item): [string, string] => [item.name, value(item)])
  return design ? [['Default · Let the AI design', ''], ...saved] : [[`Default · ${selected.name}`, ''], ['Let the AI design', 'design'], ...saved]
}

export function launchWorkflowRequest(value: string): { design?: true; workflowId?: string; revision?: string } {
  if (!value) return {}
  if (value === 'design') return { design: true }
  const [workflowId, revision] = value.split('@')
  return { workflowId, revision }
}
