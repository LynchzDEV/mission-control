import { homedir } from 'node:os'

import { arg, emit, flag, listOpt, oneOf, stringOpt, textArg, UsageError, type Command, type Context } from '../command'
import { cell, keyValue, table } from '../format'
import { callPlugin } from './plugins'

const PLUGIN = 'clickup-board'

type Json = Record<string, unknown>
type Field = { key: string; label: string; kind: string; options: Array<{ id: string; name: string }> }
type Condition = { field: string; op: string; values: string[] }
type Group = { join: 'and' | 'or'; conditions: Condition[] }

const OPERATORS: Record<string, string> = {
  is: 'Is', is_not: 'Is not', any: 'Is any of', all: 'Is all of', none: 'Is none of', set: 'Is set', not_set: 'Is not set',
  checked: 'Is checked', unchecked: 'Is not checked',
  today: 'Today', overdue: 'Overdue', this_week: 'This week', next_week: 'Next week', last_7_days: 'Last 7 days', before: 'Before', after: 'After',
}

const OPERATORS_BY_KIND: Record<string, string[]> = {
  status: ['is', 'is_not'],
  tags: ['any', 'all', 'none', 'set', 'not_set'],
  labels: ['any', 'all', 'none', 'set', 'not_set'],
  users: ['any', 'none', 'set', 'not_set'],
  assignee: ['any', 'none', 'set', 'not_set'],
  creator: ['is', 'is_not'],
  priority: ['is', 'is_not', 'set', 'not_set'],
  option: ['is', 'is_not', 'set', 'not_set'],
  checkbox: ['checked', 'unchecked'],
  date: ['today', 'overdue', 'this_week', 'next_week', 'last_7_days', 'before', 'after', 'set', 'not_set'],
}

const VALUELESS = new Set(['set', 'not_set', 'checked', 'unchecked', 'today', 'overdue', 'this_week', 'next_week', 'last_7_days'])

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const plain = (text: string): string => text.trim().toLowerCase().replace(/[\s_-]+/g, ' ')

async function boards(ctx: Context): Promise<Json[]> {
  const list = await callPlugin(ctx.client, PLUGIN, 'boards.list')
  return Array.isArray(list) ? list.filter(isRecord) : []
}

async function findBoard(ctx: Context, wanted: string): Promise<Json> {
  const all = await boards(ctx)
  const board = all.find((candidate) => candidate.id === wanted) ?? all.find((candidate) => plain(String(candidate.name)) === plain(wanted))
  if (board === undefined) throw new UsageError(`no board "${wanted}"; see: mctl clickup boards`)
  return board
}

async function boardFields(ctx: Context, boardId: string): Promise<{ fields: Field[]; viewFilter: Json | null; me: string | null }> {
  const cached = await callPlugin(ctx.client, PLUGIN, 'board.cached', { boardId }).catch(() => null)
  const source = isRecord(cached) && Array.isArray(cached.fields) ? cached : await callPlugin(ctx.client, PLUGIN, 'board.load', { boardId })
  const record = isRecord(source) ? source : {}
  return {
    fields: Array.isArray(record.fields) ? (record.fields as Field[]) : [],
    viewFilter: isRecord(record.viewFilter) ? record.viewFilter : null,
    me: typeof record.me === 'string' ? record.me : null,
  }
}

function filtersOf(board: Json): Group {
  const raw = isRecord(board.filters) ? board.filters : {}
  return { join: raw.join === 'or' ? 'or' : 'and', conditions: Array.isArray(raw.conditions) ? (raw.conditions as Condition[]) : [] }
}

function resolveField(fields: Field[], wanted: string): Field {
  const field = fields.find((candidate) => candidate.key === wanted) ?? fields.find((candidate) => plain(candidate.label) === plain(wanted))
  if (field === undefined) throw new UsageError(`no field "${wanted}"; fields: ${fields.map((candidate) => candidate.label).join(', ')}`)
  return field
}

function operatorsOf(field: Field): string[] {
  const all = OPERATORS_BY_KIND[field.kind] ?? []
  return field.kind === 'date' && field.key !== 'due' ? all.filter((op) => op !== 'overdue') : all
}

function resolveOperator(field: Field, wanted: string): string {
  const allowed = operatorsOf(field)
  const op = allowed.find((candidate) => candidate === wanted || plain(OPERATORS[candidate] ?? '') === plain(wanted) || plain(candidate) === plain(wanted))
  if (op === undefined) throw new UsageError(`"${wanted}" doesn't apply to ${field.label}; use one of: ${allowed.map((candidate) => OPERATORS[candidate]).join(', ')}`)
  return op
}

function resolveValues(field: Field, op: string, wanted: string[]): string[] {
  if (VALUELESS.has(op)) return []
  if (wanted.length === 0) throw new UsageError(`${OPERATORS[op]} needs at least one --value`)
  if (op === 'before' || op === 'after') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(wanted[0]!)) throw new UsageError('dates are YYYY-MM-DD')
    return [wanted[0]!]
  }
  const people = field.kind === 'assignee' || field.kind === 'users' || field.kind === 'creator'
  return wanted.map((value) => {
    if (people && plain(value) === 'me') return 'me'
    const option = field.options.find((candidate) => candidate.id === value) ?? field.options.find((candidate) => plain(candidate.name) === plain(value))
    if (option === undefined) throw new UsageError(`no ${field.label} value "${value}"; values: ${field.options.slice(0, 15).map((candidate) => candidate.name).join(', ')}${field.options.length > 15 ? ', …' : ''}`)
    return option.id
  })
}

function describe(condition: Condition, fields: Field[]): string {
  const field = fields.find((candidate) => candidate.key === condition.field)
  const names = condition.values.map((value) => (value === 'me' ? 'Me' : field?.options.find((option) => option.id === value)?.name ?? value))
  return [field?.label ?? condition.field, OPERATORS[condition.op] ?? condition.op, names.join(', ')].filter(Boolean).join(' ')
}

async function saveFilters(ctx: Context, board: Json, next: Group): Promise<void> {
  const saved = await callPlugin(ctx.client, PLUGIN, 'boards.setFilters', { boardId: board.id, filters: next })
  const { fields } = await boardFields(ctx, String(board.id))
  emit(ctx, saved, () => filtersText(next, fields, null))
}

function filtersText(group: Group, fields: Field[], viewFilter: Json | null): string {
  const lines: string[] = []
  const rows = viewFilter && Array.isArray(viewFilter.rows) ? viewFilter.rows.filter(isRecord) : []
  for (const row of rows) lines.push(`  (view)  ${cell(row.label)} ${cell(row.op)} ${Array.isArray(row.values) ? row.values.slice(0, 4).join(', ') + (row.values.length > 4 ? ` +${row.values.length - 4}` : '') : ''}`)
  group.conditions.forEach((condition, index) => lines.push(`  ${String(index + 1).padStart(4)}  ${index > 0 ? `${group.join.toUpperCase()} ` : ''}${describe(condition, fields)}`))
  if (lines.length === 0) return 'No filters on this board.\n'
  return `${lines.join('\n')}\n`
}

function boardText(value: unknown): string {
  if (!isRecord(value)) return keyValue(value)
  const columns = Array.isArray(value.columns) ? value.columns.filter(isRecord) : []
  const board = isRecord(value.board) ? value.board : {}
  const head = `${cell(board.name)} · ${cell(value.shown)} of ${cell(value.total)} tasks · ${cell(board.folder)}\n`
  return head + columns.filter((column) => Array.isArray(column.tasks) && column.tasks.length > 0).map((column) => {
    const tasks = (column.tasks as unknown[]).filter(isRecord)
    return `\n${String(column.status).toUpperCase()} (${tasks.length})\n` + table(tasks, [
      { header: '  ID', value: (task) => `  ${cell(task.id)}` },
      { header: 'NAME', value: (task) => cell(task.name) },
      { header: 'WHO', value: (task) => (Array.isArray(task.assignees) ? task.assignees.filter(isRecord).map((who) => cell(who.initials)).join(' ') : '') || '-' },
    ])
  }).join('')
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path
}

async function startSession(ctx: Context): Promise<void> {
  const taskId = arg(ctx, 'taskId')
  const boardName = stringOpt(ctx, 'board')
  const board = boardName === undefined ? undefined : await findBoard(ctx, boardName)
  const cwd = expandHome(stringOpt(ctx, 'cwd') ?? (board ? String(board.folder) : ctx.cwd))
  const dossier = await callPlugin(ctx.client, PLUGIN, 'task.dossier', { taskId })
  const markdown = isRecord(dossier) && typeof dossier.markdown === 'string' ? dossier.markdown : ''
  const written = await ctx.client.post(`/api/plugins/${PLUGIN}/context`, { name: `task-${taskId}`, markdown, cwd })
  const path = isRecord(written) ? String(written.path) : ''
  const message = stringOpt(ctx, 'message')
  const prompt = `Read the task context in ${path} before anything else.${message ? `\n\n${message}` : ''}`
  const roles = await ctx.client.get('/api/roles')
  const engine = stringOpt(ctx, 'engine') ?? (isRecord(roles) && isRecord(roles.plan) ? String(roles.plan.engine) : 'claude')
  const model = stringOpt(ctx, 'model')
  if (flag(ctx, 'terminal')) {
    const terminal = await ctx.client.post('/api/terminals', { engine, cwd, ...(model ? { model } : {}), initialPrompt: prompt, title: `ClickUp ${taskId}`.slice(0, 60) })
    emit(ctx, terminal, (value) => `Terminal ${cell(isRecord(value) ? value.id : '')} opened in ${cwd} with the task context. Open it in Mission Control.\n`)
    return
  }
  const job = await ctx.client.post('/api/jobs', { engine, ...(model ? { model } : {}), cwd, prompt, purpose: 'chat' })
  const id = isRecord(job) ? (isRecord(job.job) ? job.job.id : job.id) : ''
  emit(ctx, job, () => `Chat ${cell(id)} started in ${cwd} with the task context. Follow it with: mctl job follow ${cell(id)}\n`)
}

async function addBoard(ctx: Context): Promise<void> {
  const folder = stringOpt(ctx, 'folder')
  const link = stringOpt(ctx, 'link')
  const listId = stringOpt(ctx, 'list')
  if (folder === undefined) throw new UsageError('--folder is required (where chats and terminals open)')
  if ((link === undefined) === (listId === undefined)) throw new UsageError('give exactly one of --link or --list')
  let source: unknown = { kind: 'list', listId }
  let name = stringOpt(ctx, 'name')
  if (link !== undefined) {
    const resolved = await callPlugin(ctx.client, PLUGIN, 'link.resolve', { url: link })
    if (!isRecord(resolved)) throw new Error('ClickUp did not resolve that link')
    source = resolved.source
    name = name ?? String(resolved.name)
  }
  if (name === undefined) throw new UsageError('--name is required with --list')
  const saved = await callPlugin(ctx.client, PLUGIN, 'boards.save', { board: { name, folder, source } })
  emit(ctx, saved, (value) => `Saved board ${cell(isRecord(value) ? value.name : name)} (${cell(isRecord(value) ? value.id : '')}).\n`)
}

function treeText(value: unknown): string {
  const nodes = Array.isArray(value) ? value.filter(isRecord) : []
  if (nodes.length === 0) return 'Nothing here.\n'
  return table(nodes, [
    { header: 'KIND', value: (node) => cell(node.kind) },
    { header: 'ID', value: (node) => cell(node.id) },
    { header: 'NAME', value: (node) => cell(node.name) },
    { header: 'TASKS', value: (node) => (node.taskCount === undefined ? '' : cell(node.taskCount)) },
  ])
}

export const clickupCommands: Command[] = [
  {
    path: ['clickup', 'connect'],
    args: ['token'],
    summary: 'Save your ClickUp token (- reads it from stdin) and check it',
    run: async (ctx) => {
      await ctx.client.put(`/api/plugins/${PLUGIN}/settings`, { key: 'token', value: await textArg(ctx, 'token') })
      const result = await callPlugin(ctx.client, PLUGIN, 'token.check')
      emit(ctx, result, (value) => `Connected as ${cell(isRecord(value) && isRecord(value.user) ? value.user.username : '')}.\n`)
    },
  },
  {
    path: ['clickup', 'boards'],
    summary: 'List your saved ClickUp boards',
    run: async (ctx) => emit(ctx, await boards(ctx), (value) => {
      const list = Array.isArray(value) ? value.filter(isRecord) : []
      if (list.length === 0) return 'No boards yet. Add one with: mctl clickup board add --link <url> --folder <dir>\n'
      return table(list, [
        { header: 'ID', value: (board) => cell(board.id) },
        { header: 'NAME', value: (board) => cell(board.name) },
        { header: 'FILTERS', value: (board) => String(filtersOf(board).conditions.length) },
        { header: 'FOLDER', value: (board) => cell(board.folder) },
      ])
    }),
  },
  {
    path: ['clickup', 'board'],
    args: ['board'],
    options: {
      search: { type: 'string', description: 'only tasks whose name or id contains this', placeholder: 'TEXT' },
      all: { type: 'boolean', description: "ignore the board's saved filters" },
    },
    summary: 'Show a board as the screen shows it (saved filters applied)',
    run: async (ctx) => {
      const board = await findBoard(ctx, arg(ctx, 'board'))
      const view = await callPlugin(ctx.client, PLUGIN, 'board.view', { boardId: board.id, ...(stringOpt(ctx, 'search') ? { search: stringOpt(ctx, 'search') } : {}), ...(flag(ctx, 'all') ? { ignoreSaved: true } : {}) })
      emit(ctx, view, boardText)
    },
  },
  {
    path: ['clickup', 'board', 'add'],
    options: {
      link: { type: 'string', description: 'ClickUp list or board view link', placeholder: 'URL' },
      list: { type: 'string', description: 'ClickUp list id (see: mctl clickup tree)', placeholder: 'ID' },
      name: { type: 'string', description: 'board name (default: the list or view name)', placeholder: 'NAME' },
      folder: { type: 'string', description: 'folder chats and terminals open in', placeholder: 'DIR' },
    },
    summary: 'Save a board from a link or a list id',
    run: addBoard,
  },
  {
    path: ['clickup', 'board', 'remove'],
    args: ['board'],
    summary: 'Remove a saved board',
    run: async (ctx) => {
      const board = await findBoard(ctx, arg(ctx, 'board'))
      emit(ctx, await callPlugin(ctx.client, PLUGIN, 'boards.remove', { id: board.id }), () => `Removed ${cell(board.name)}.\n`)
    },
  },
  {
    path: ['clickup', 'tree'],
    options: {
      team: { type: 'string', description: 'list the spaces of this workspace', placeholder: 'ID' },
      space: { type: 'string', description: 'list the folders and lists of this space', placeholder: 'ID' },
      folder: { type: 'string', description: 'list the lists of this folder', placeholder: 'ID' },
    },
    summary: 'Browse ClickUp: workspaces, then spaces, folders and lists',
    run: async (ctx) => {
      const [kind, id] = stringOpt(ctx, 'folder') ? ['folder', stringOpt(ctx, 'folder')] : stringOpt(ctx, 'space') ? ['space', stringOpt(ctx, 'space')] : stringOpt(ctx, 'team') ? ['team', stringOpt(ctx, 'team')] : ['root', undefined]
      emit(ctx, await callPlugin(ctx.client, PLUGIN, 'tree.children', { kind, ...(id ? { id } : {}) }), treeText)
    },
  },
  {
    path: ['clickup', 'filters'],
    args: ['board'],
    options: { fields: { type: 'boolean', description: 'also list the fields and operators you can filter on' } },
    summary: "Show a board's filters (the view's own ones marked (view))",
    run: async (ctx) => {
      const board = await findBoard(ctx, arg(ctx, 'board'))
      const { fields, viewFilter } = await boardFields(ctx, String(board.id))
      const group = filtersOf(board)
      emit(ctx, { filters: group, viewFilter, ...(flag(ctx, 'fields') ? { fields } : {}) }, () => {
        let text = filtersText(group, fields, viewFilter)
        if (flag(ctx, 'fields')) text += `\nFields:\n${table(fields, [
          { header: '  FIELD', value: (field) => `  ${field.label}` },
          { header: 'OPERATORS', value: (field) => operatorsOf(field).map((op) => OPERATORS[op]).join(', ') },
        ])}`
        return text
      })
    },
  },
  {
    path: ['clickup', 'filter', 'add'],
    args: ['board', 'field', 'operator'],
    options: { value: { type: 'string', multiple: true, description: 'a value (name or id; Me for people; YYYY-MM-DD for Before/After)', placeholder: 'VALUE' } },
    summary: 'Add a filter, e.g. clickup filter add main Assignee "is any of" --value Me',
    run: async (ctx) => {
      const board = await findBoard(ctx, arg(ctx, 'board'))
      const { fields } = await boardFields(ctx, String(board.id))
      const field = resolveField(fields, arg(ctx, 'field'))
      const op = resolveOperator(field, arg(ctx, 'operator'))
      const condition = { field: field.key, op, values: resolveValues(field, op, listOpt(ctx, 'value')) }
      const group = filtersOf(board)
      await saveFilters(ctx, board, { ...group, conditions: [...group.conditions, condition] })
    },
  },
  {
    path: ['clickup', 'filter', 'remove'],
    args: ['board', 'number'],
    summary: 'Remove filter number N (see: mctl clickup filters <board>)',
    run: async (ctx) => {
      const board = await findBoard(ctx, arg(ctx, 'board'))
      const group = filtersOf(board)
      const index = Number(arg(ctx, 'number')) - 1
      if (!Number.isInteger(index) || index < 0 || index >= group.conditions.length) throw new UsageError(`filter number must be 1 to ${group.conditions.length}`)
      await saveFilters(ctx, board, { ...group, conditions: group.conditions.filter((_condition, at) => at !== index) })
    },
  },
  {
    path: ['clickup', 'filter', 'clear'],
    args: ['board'],
    summary: "Remove all of a board's filters (the view's own stay)",
    run: async (ctx) => {
      const board = await findBoard(ctx, arg(ctx, 'board'))
      await saveFilters(ctx, board, { ...filtersOf(board), conditions: [] })
    },
  },
  {
    path: ['clickup', 'filter', 'join'],
    args: ['board', 'join'],
    summary: 'Combine filters with and or or',
    run: async (ctx) => {
      const board = await findBoard(ctx, arg(ctx, 'board'))
      const join = oneOf(arg(ctx, 'join').toLowerCase(), ['and', 'or'] as const, 'join')
      await saveFilters(ctx, board, { ...filtersOf(board), join })
    },
  },
  {
    path: ['clickup', 'task'],
    args: ['taskId'],
    summary: 'Print the full task dossier (what the AI reads first)',
    run: async (ctx) => {
      const dossier = await callPlugin(ctx.client, PLUGIN, 'task.dossier', { taskId: arg(ctx, 'taskId') })
      emit(ctx, dossier, (value) => (isRecord(value) && typeof value.markdown === 'string' ? `${value.markdown.trimEnd()}\n` : keyValue(value)))
    },
  },
  {
    path: ['clickup', 'start'],
    args: ['taskId'],
    options: {
      board: { type: 'string', description: "use this board's folder", placeholder: 'BOARD' },
      terminal: { type: 'boolean', description: 'open a terminal instead of a chat' },
      cwd: { type: 'string', description: 'folder to run in (default: the board folder, then here)', placeholder: 'DIR' },
      engine: { type: 'string', description: 'AI to use (default: the plan role)', placeholder: 'ENGINE' },
      model: { type: 'string', description: 'model to use', placeholder: 'MODEL' },
      message: { type: 'string', description: 'first message after the context', placeholder: 'TEXT' },
    },
    summary: 'Start a chat or terminal on a task with its context attached',
    run: startSession,
  },
]
