import { useEffect, useRef, useState } from 'react'
import type { AgentConnection } from '../server/agent-connections'
import type { WorkflowNode } from '../server/workflows'
import { api, apiDelete } from './studio-api'

export type ConnectionList = { builtins: string[]; connections: AgentConnection[]; presets: Array<Partial<AgentConnection>>; models: Record<string, string[]>; roles?: Record<string, { engine: string; model: string | null }> }
type Choice = { kind: 'builtin'; id: string } | { kind: 'connection'; value: AgentConnection } | { kind: 'preset'; value: Partial<AgentConnection> } | { kind: 'presets' }
type SecretsView = { zaiBaseUrl: string; zaiAuthTokenConfigured: boolean }

const BUILTIN: Record<string, { name: string; line: string; description: string }> = {
  claude: { name: 'Claude', line: 'Claude Code CLI', description: 'Uses the account signed in through the Claude Code CLI on this machine.' },
  codex: { name: 'Codex', line: 'Codex CLI', description: 'Uses the account signed in through the Codex CLI on this machine.' },
  glm: { name: 'GLM', line: 'Claude Code through z.ai', description: 'Runs Claude Code against your z.ai account. Set the base URL and token here.' },
}
const Icon = ({ id }: { id: string }) => <svg aria-hidden="true"><use href={`#${id}`} /></svg>

function GlmSettings({ report, onError }: { report: (text: string) => void; onError: (text: string) => void }) {
  const [view, setView] = useState<SecretsView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => { const response = await fetch('/api/secrets'); const data = await response.json() as SecretsView & { error?: string }; if (!response.ok) throw new Error(data.error ?? 'Could not read the z.ai settings'); setView(data); setBaseUrl(data.zaiBaseUrl) }
  useEffect(() => { void load().catch(error => onError((error as Error).message)) }, [])
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      const response = await fetch('/api/secrets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zaiBaseUrl: baseUrl, ...(token.trim() ? { zaiAuthToken: token } : {}) }) })
      const data = await response.json() as SecretsView & { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Could not save')
      setView(data); setToken(''); report('z.ai settings saved.')
    } catch (error) { onError((error as Error).message) } finally { setBusy(false) }
  }
  return <form className="field-stack" onSubmit={save}>
    <label>Z.ai base URL<input type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
    <label>Z.ai token<input type="password" autoComplete="off" value={token} placeholder={view?.zaiAuthTokenConfigured ? 'Configured · type to replace' : 'Paste your z.ai token'} onChange={event => setToken(event.target.value)} /></label>
    <p className="muted">The token is stored on this machine only and never shown again.</p>
    <button className="pill" type="submit" disabled={busy || !view}>Save</button>
  </form>
}

export function Connections({ list, refresh, report, onError, onConnect }: { list: ConnectionList; refresh: () => Promise<void>; report: (text: string) => void; onError: (text: string) => void; onConnect?: () => void }) {
  const [choice, setChoice] = useState<Choice>({ kind: 'builtin', id: 'claude' })
  const [editing, setEditing] = useState<Partial<AgentConnection>>({})
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [terminalArgs, setTerminalArgs] = useState('')
  const [probe, setProbe] = useState('')
  const [busy, setBusy] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const removeDialog = useRef<HTMLDialogElement | null>(null)
  const select = (value: Partial<AgentConnection>) => { setEditing({ ...value }); setArgs((value.args ?? []).join('\n')); setEnv(Object.entries(value.env ?? {}).map(([key, reference]) => `${key}=${reference}`).join('\n')); setTerminalArgs(value.terminalArgs ? value.terminalArgs.join('\n') : ''); setProbe(''); setAdvanced(!value.command) }
  const pick = (next: Choice) => { setChoice(next); if (next.kind === 'connection' || next.kind === 'preset') select(next.value) }
  const configured = choice.kind === 'connection'
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true)
    try {
      const references = Object.fromEntries(env.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const [key, reference, extra] = line.split('='); if (!key || !reference || extra) throw new Error('Use TARGET_ENV=SOURCE_ENV, one per line'); return [key.trim(), reference.trim()] }))
      const saved = await api<AgentConnection>('/connections', { ...editing, models: (editing.models ?? []).map(model => model.trim()).filter(Boolean), args: args.split('\n').filter(Boolean), env: references, terminalArgs: terminalArgs ? terminalArgs.split('\n').filter(Boolean) : editing.terminalArgs !== undefined ? [] : undefined })
      pick({ kind: 'connection', value: saved }); await refresh(); report('AI connection saved. Sign in to its app before running it.'); onConnect?.()
    } catch (error) { onError((error as Error).message) } finally { setBusy(false) }
  }
  const check = async () => { setBusy(true); try { setProbe(JSON.stringify(await api(`/connections/${editing.id}/probe`, {}), null, 2)); report('Connection checked. No task was sent.') } catch (error) { onError((error as Error).message) } finally { setBusy(false) } }
  const remove = async () => { setBusy(true); try { await apiDelete(`/connections/${editing.id}`); removeDialog.current?.close(); await refresh(); pick({ kind: 'builtin', id: 'claude' }); report('Connection removed.') } catch (error) { onError((error as Error).message) } finally { setBusy(false) } }
  const current = (test: (item: Choice) => boolean) => test(choice)

  return <section className="studio-view connections-view">
    <aside className="connection-list" aria-label="AI connections">
      <h2>Manage AIs</h2>
      {list.builtins.map(id => <button key={id} type="button" className="connection-choice" aria-pressed={current(item => item.kind === 'builtin' && item.id === id)} onClick={() => pick({ kind: 'builtin', id })}><span>{BUILTIN[id]?.name ?? id}</span><small>{BUILTIN[id]?.line ?? 'Built in'}</small></button>)}
      {list.connections.map(connection => <button key={connection.id} type="button" className="connection-choice" aria-pressed={current(item => item.kind === 'connection' && item.value.id === connection.id)} onClick={() => pick({ kind: 'connection', value: connection })}><span>{connection.name}</span><small>{connection.adapter === 'cli' ? 'Headless CLI' : connection.adapter === 'opencode' ? 'OpenCode' : 'ACP agent'} · configured</small></button>)}
      <button type="button" className="text-button" aria-pressed={current(item => item.kind === 'presets' || item.kind === 'preset')} onClick={() => pick({ kind: 'presets' })}>+ Add a connection</button>
    </aside>
    <div className="connection-settings">
      {choice.kind === 'builtin' && <><h2>{BUILTIN[choice.id]?.name ?? choice.id}</h2><p className="muted">{BUILTIN[choice.id]?.description ?? 'Built-in integration.'}</p>
        <p className="muted"><span className="status" data-state="done">Built in</span> Checked when a job starts.</p>
        {choice.id === 'glm' && <GlmSettings report={report} onError={onError} />}</>}
      {choice.kind === 'presets' && <><h2>Add a connection</h2><p className="muted">Choose the app you already use. Install it and sign in, then check the connection.</p>
        <div className="preset-list">{list.presets.map(preset => <button key={preset.id} type="button" className="preset-row" onClick={() => pick({ kind: 'preset', value: preset })}><span><strong>{preset.name}</strong><small>{preset.adapter === 'cli' ? 'Headless CLI with a {{prompt}} slot' : preset.adapter === 'opencode' ? 'OpenCode · API or local models' : preset.command ? `ACP agent · ${preset.command}` : 'ACP agent · your own command'}</small></span><Icon id="plus-icon" /></button>)}</div></>}
      {(choice.kind === 'preset' || choice.kind === 'connection') && <form className="field-stack" onSubmit={save}>
        <h2>{editing.name || 'New connection'}</h2><p className="muted">Install the app and sign in, then check the connection. Advanced settings are below.</p>
        <label>Name<input required value={editing.name ?? ''} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
        <details open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>Advanced connection settings</summary>
          <label>Connection ID<input required value={editing.id ?? ''} disabled={configured} onChange={event => setEditing({ ...editing, id: event.target.value })} /></label>
          <label>Adapter<select value={editing.adapter ?? 'acp'} onChange={event => setEditing({ ...editing, adapter: event.target.value as AgentConnection['adapter'] })}><option value="acp">ACP coding agent</option><option value="opencode">OpenCode · API / local models</option><option value="cli">Headless CLI</option></select></label>
          <label>Executable<input required value={editing.command ?? ''} placeholder="qwen" onChange={event => setEditing({ ...editing, command: event.target.value })} /></label>
          <label>Arguments · one per line<textarea rows={3} value={args} onChange={event => setArgs(event.target.value)} /><small className="muted">CLI slots: {'{{prompt}}'}, {'{{model}}'}, {'{{session}}'}. Arguments are passed directly, without a shell.</small></label>
          <label>Available model IDs · one per line<textarea rows={3} value={(editing.models ?? []).join('\n')} onChange={event => setEditing({ ...editing, models: event.target.value.split('\n') })} /></label>
          <label>Model family<input value={editing.family ?? ''} placeholder="qwen, grok, llama…" onChange={event => setEditing({ ...editing, family: event.target.value || undefined })} /><small className="muted">Used for the cross-family review when a model ID has no recognized family.</small></label>
          {editing.adapter === 'opencode' && <><label>Base URL (optional)<input type="url" value={editing.baseUrl ?? ''} placeholder="http://localhost:11434/v1" onChange={event => setEditing({ ...editing, baseUrl: event.target.value || undefined })} /></label><label>Provider ID<input value={editing.provider ?? 'custom'} onChange={event => setEditing({ ...editing, provider: event.target.value })} /></label><label>API key environment variable<input value={editing.apiKeyEnv ?? ''} placeholder="OPENROUTER_API_KEY" onChange={event => setEditing({ ...editing, apiKeyEnv: event.target.value || undefined })} /></label><p className="muted">Leave the endpoint blank to use OpenCode's configured providers.</p></>}
          <label>Environment references<textarea rows={3} value={env} placeholder="API_KEY=MY_PROVIDER_KEY" onChange={event => setEnv(event.target.value)} /><small className="muted">Names of variables available to Mission Control. Never enter credential values here.</small></label>
          <label>Authentication method (optional)<input value={editing.authMethod ?? ''} onChange={event => setEditing({ ...editing, authMethod: event.target.value || undefined })} /><small className="muted">A method ID from the capability probe, or blank to use the agent's existing sign-in.</small></label>
          {editing.adapter === 'cli' && <label>Output format<select value={editing.output ?? 'text'} onChange={event => setEditing({ ...editing, output: event.target.value as AgentConnection['output'] })}><option value="text">Plain text</option><option value="claude">Claude stream JSON</option><option value="codex">Codex JSON</option></select></label>}
          <label>Interactive terminal arguments · one per line<textarea rows={2} value={terminalArgs} onChange={event => setTerminalArgs(event.target.value)} placeholder="Leave empty for the app's default interface" /><small className="muted">Lets this agent open in a Mission Control terminal. Use {'{{instructions}}'} to pass its workflow instructions.</small></label>
        </details>
        <label className="switch-label"><input type="checkbox" role="switch" checked={editing.autoApprove === true} onChange={event => setEditing({ ...editing, autoApprove: event.target.checked })} />Allow this AI to use tools without asking each time</label>
        <div className="connection-actions"><button className="pill" type="submit" disabled={busy}>Save connection</button><button type="button" className="pill" disabled={busy || editing.adapter === 'cli' || !configured} title={editing.adapter === 'cli' ? 'CLI connections have no capability probe' : !configured ? 'Save first' : undefined} onClick={() => void check()}>Check connection</button>{configured && <button type="button" className="text-button danger" disabled={busy} onClick={() => removeDialog.current?.showModal()}>Remove connection</button>}</div>
        {probe && <details open><summary>Connection details</summary><pre className="studio-output">{probe}</pre></details>}
      </form>}
    </div>
    <dialog ref={removeDialog} className="access-dialog flat confirm-dialog" aria-labelledby="remove-connection-title">
      <header className="dialog-heading"><h2 id="remove-connection-title">Remove {editing.name}?</h2><form method="dialog"><button className="round" aria-label="Cancel"><Icon id="close-icon" /></button></form></header>
      <p className="muted">Workflows that pin this AI will show it as unavailable until you pick another.</p>
      <div className="editor-actions dialog-actions"><button type="button" className="pill" onClick={() => removeDialog.current?.close()}>Cancel</button><button type="button" className="pill danger" disabled={busy} onClick={() => void remove()}>Remove</button></div>
    </dialog>
  </section>
}

export function StepAttachments({ node, onChange }: { node: WorkflowNode; onChange: (patch: Partial<WorkflowNode>) => void }) {
  return <div className="step-attachments">
    <h3>Skills</h3><p>Attach instructions from a Markdown skill file. Its contents are saved with each run.</p>
    {node.skills.map((path, index) => <div className="attachment-row" key={index}><label>Skill file<input value={path} placeholder="Path to SKILL.md" onChange={event => onChange({ skills: node.skills.map((item, i) => i === index ? event.target.value : item) })} /></label><button type="button" className="round" aria-label={`Remove skill ${index + 1}`} onClick={() => onChange({ skills: node.skills.filter((_, i) => i !== index) })}><Icon id="close-icon" /></button></div>)}
    <button type="button" onClick={() => onChange({ skills: [...node.skills, ''] })}>+ Attach a skill</button>
    <h3>Tools</h3><p>The AI keeps its own tools. Attach additional tools through an ACP connection.</p>
    {node.mcpServers.map((tool, index) => <fieldset className="attachment-card" key={index}><label>Tool name<input value={tool.name} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} /></label><label>Executable<input value={tool.command} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, command: event.target.value } : item) })} /></label><label>Arguments · one per line<textarea rows={2} value={tool.args.join('\n')} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, args: event.target.value === '' ? [] : event.target.value.split('\n') } : item) })} /></label><div className="tool-environment"><span>Environment variables</span>{Object.entries(tool.env).map(([name, value], at) => <div className="environment-pair" key={at}><input aria-label={`Tool variable ${at + 1}`} placeholder="TOOL_KEY" value={name} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, env: Object.fromEntries(Object.entries(item.env).map((pair, j) => j === at ? [event.target.value, pair[1]] : pair)) } : item) })} /><input aria-label={`Server variable ${at + 1}`} placeholder="SERVER_ENV_NAME" value={value} onChange={event => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, env: { ...item.env, [name]: event.target.value } } : item) })} /><button type="button" className="round" aria-label={`Remove variable ${at + 1}`} onClick={() => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, env: Object.fromEntries(Object.entries(item.env).filter((_, j) => j !== at)) } : item) })}><Icon id="close-icon" /></button></div>)}<button type="button" onClick={() => onChange({ mcpServers: node.mcpServers.map((item, i) => i === index ? { ...item, env: { ...item.env, '': '' } } : item) })}>+ Add environment variable</button></div><small>Use existing environment variable names, never secret values.</small><button type="button" onClick={() => onChange({ mcpServers: node.mcpServers.filter((_, i) => i !== index) })}>Remove tool</button></fieldset>)}
    <button type="button" onClick={() => onChange({ mcpServers: [...node.mcpServers, { name: `tool-${node.mcpServers.length + 1}`, command: '', args: [], env: {} }] })}>+ Connect a tool</button>
    <h3>Acceptance checks</h3><p>These commands must succeed before this step can pass.</p>
    {node.checks.map((check, index) => <fieldset className="attachment-card" key={index}><label>Command<input value={check.command} onChange={event => onChange({ checks: node.checks.map((item, i) => i === index ? { ...item, command: event.target.value } : item) })} /></label><label>Arguments · one per line<textarea rows={2} value={check.args.join('\n')} onChange={event => onChange({ checks: node.checks.map((item, i) => i === index ? { ...item, args: event.target.value === '' ? [] : event.target.value.split('\n') } : item) })} /></label><label>Time limit (seconds)<input type="number" min={1} max={3600} value={check.timeoutSeconds} onChange={event => onChange({ checks: node.checks.map((item, i) => i === index ? { ...item, timeoutSeconds: Number(event.target.value) } : item) })} /></label><button type="button" onClick={() => onChange({ checks: node.checks.filter((_, i) => i !== index) })}>Remove check</button></fieldset>)}
    <button type="button" onClick={() => onChange({ checks: [...node.checks, { command: '', args: [], timeoutSeconds: 300 }] })}>+ Add a check</button>
  </div>
}
