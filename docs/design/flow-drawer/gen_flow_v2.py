from pathlib import Path

HERE = Path(__file__).parent
SRC = (HERE / 'src-terminal.html').read_text()

SCREENS = {
    'd-terminal': ('D', 'Canvas panel: full-width graph above the terminal'),
    'e-terminal': ('E', 'Side dock: vertical graph on the right, terminal narrows'),
    'f-terminal': ('F', 'Compact lanes: one row per path, smallest push-down'),
    'd-draft': ('D · state', 'New flow drafted by Codex, waiting for your first approval'),
    'd-auto': ('D · state', 'Approval is off: started on its own, big change applied with a notice'),
    'd-none': ('D · state', 'Quick work: the AI decided no flow was needed'),
}
LIVE_TOP_NOW = 328
LIVE_TOPS = {'d-draft': 520, 'd-auto': 520, 'd-none': 253, 'd-terminal': 520, 'e-terminal': 84, 'f-terminal': 370}
DOCK_WIDTH = 400

CHECK = '<svg viewBox="0 0 10 10"><path d="M2 5.2 4.1 7.3 8 3"/></svg>'
BANG = '<svg viewBox="0 0 10 10"><path d="M5 2.2v3.4M5 7.6v.1"/></svg>'
PLUS = '<svg viewBox="0 0 10 10"><path d="M5 2.2v5.6M2.2 5h5.6"/></svg>'
GLYPHS = {
    'join': '<svg class="fv-glyph" viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="8" r="1.6"/><path d="M4 5.1v5.8M5.4 4.3c3 .6 4.6 1.8 5.1 2.6M5.4 11.7c3-.6 4.6-1.8 5.1-2.6"/></svg>',
    'eye': '<svg class="fv-glyph" viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
}
CLOSE = '<button class="round fv-x" aria-label="Close flow"><svg><use href="#close-icon"/></svg></button>'

NODES = {
    'plan': ('claude', 'Plan the work', 'done', 'Done · 2m 10s'),
    'build_api': ('codex', 'Build API', 'done', 'Try 2 · 3m 40s'),
    'test_api': ('glm', 'API tests', 'active', 'Try 2 · 48s'),
    'migration': ('claude', 'DB migration', 'proposed', 'Proposed'),
    'build_ui': ('claude', 'Build UI', 'done', '3 sub-agents · 5m'),
    'check_ui': ('glm', 'UI check', 'done', 'Passed · 1m 12s'),
    'join': ('join', 'Join paths', 'pending', 'Waits for api'),
    'review': ('codex', 'Cross review', 'pending', 'Up next'),
    'fix': ('claude', 'Fix review notes', 'idle', 'If review fails'),
    'you': ('eye', 'Your review', 'pending', 'Last step'),
}
EDGES = [
    ('plan', 'build_api', 'done'), ('plan', 'build_ui', 'done'),
    ('build_api', 'test_api', 'flowing'), ('test_api', 'migration', 'proposed'), ('migration', 'join', 'proposed'),
    ('build_ui', 'check_ui', 'done'), ('check_ui', 'join', 'done'),
    ('join', 'review', 'idle'), ('review', 'you', 'idle'),
]
LANES = [('api', 'api path', 'flow/csv-export-api'), ('ui', 'UI path', 'flow/csv-export-ui')]
SUBAGENTS = [('Explore', 'Found the rules table component', 'done'), ('ui-designer', 'Built the export button + menu', 'done'), ('code-reviewer', 'No issues', 'done')]


def mark(status: str) -> str:
    inner = {'done': CHECK, 'failed': BANG, 'proposed': PLUS}.get(status, '')
    return f'<span class="fv-mark" data-s="{status}">{inner}</span>'


def icon(kind: str) -> str:
    return GLYPHS.get(kind) or f'<img class="fv-logo" src="assets/providers/{kind}.svg" alt="">'


def node(key: str, x: float, y: float, cls: str = 'fv-n', overrides: dict | None = None) -> str:
    kind, title, status, detail = NODES[key]
    status, detail = (overrides or {}).get(key, (status, detail))
    return f'<div class="{cls}" data-s="{status}" style="left:{x}px;top:{y}px">{icon(kind)}<strong>{title}</strong><small>{detail}</small>{mark(status)}</div>'


def path(d: str, state: str, marker: bool = True) -> str:
    end = f' marker-end="url(#fv-arrow-{state})"' if marker else ''
    return f'<path class="fv-e" data-s="{state}" d="{d}"{end}/>'


def markers() -> str:
    tip = lambda state: f'<marker id="fv-arrow-{state}" viewBox="0 0 6 6" refX="6" refY="3" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto"><path class="fv-tip" data-s="{state}" d="M0 0L6 3L0 6Z"/></marker>'
    return '<defs>' + ''.join(tip(s) for s in ['done', 'flowing', 'proposed', 'idle', 'failed']) + '</defs>'


CODEX = '<img src="assets/providers/codex.svg" alt=""> Codex in terminal'
RUNNING_SUM = '<span class="pill-state" data-s="running">1 running</span><span class="pill-state" data-s="done">5 done</span><span class="pill-state" data-s="queued">3 waiting</span>'
STATES = {
    'change': {'meta': f'Saved workflow <b>Feature build</b> · picked by {CODEX} · v1 approved by you in the drawer, 5:41 PM', 'sum': RUNNING_SUM, 'actions': ['Pause', 'Open in Studio'], 'nodes': {}, 'edges': {}},
    'draft': {
        'meta': f'New flow drafted by {CODEX} · no saved workflow fit this task · nothing has run yet', 'sum': '<span class="pill-state" data-s="queued">Draft · 9 steps · 3 engines</span>', 'actions': ['Edit in Studio'],
        'nodes': {'plan': ('pending', 'Claude'), 'build_api': ('pending', 'Codex · worktree'), 'test_api': ('pending', 'GLM'), 'migration': ('pending', 'Claude'), 'build_ui': ('pending', 'Claude · worktree'), 'check_ui': ('pending', 'GLM'), 'join': ('pending', 'Cherry-pick both'), 'review': ('pending', 'Codex'), 'fix': ('idle', 'If review fails'), 'you': ('pending', 'Last step')},
        'edges': {edge: 'idle' for edge in ['plan>build_api', 'plan>build_ui', 'build_api>test_api', 'test_api>migration', 'migration>join', 'build_ui>check_ui', 'check_ui>join']},
        'loop': ('idle', 'if tests fail'),
        'drop': 'migration',
    },
    'auto': {
        'meta': f'Saved workflow <b>Feature build</b> · picked by {CODEX} · started on its own (approval is off)', 'sum': RUNNING_SUM, 'actions': ['Pause', 'Open in Studio'],
        'nodes': {'migration': ('pending', 'Added in v2')}, 'edges': {'test_api>migration': 'idle', 'migration>join': 'idle'},
    },
}


def header(compact: bool = False, state: str = 'change') -> str:
    cfg = STATES[state]
    meta = '' if compact else f'<small class="fv-h-meta">{cfg["meta"]}</small>'
    actions = ''.join(f'<button class="pill fv-sm">{label}</button>' for label in cfg['actions'])
    return (
        '<header class="fv-h">'
        '<div class="fv-h-title"><h2>Add CSV export to the MoNi upsell rules page</h2>'
        f'{meta}</div>'
        f'<div class="fv-h-sum">{cfg["sum"]}</div>'
        f'<div class="fv-h-actions">{actions}'
        f'{CLOSE}</div></header>'
    )


BANNERS = {
    'draft': ('<div class="fv-approve" role="alert">' + '<span class="fv-mark" data-s="active"></span>'
              '<p><b>Codex drafted a flow for this task.</b> 2 paths run at once in separate worktrees, then a join, a cross review and your review. Nothing runs until you approve (or say "go" to Codex).</p>'
              '<button class="pill fv-sm fv-ghost">Reject</button><button class="pill fv-sm fv-primary">Approve and run</button></div>'),
    'auto': ('<div class="fv-approve fv-notice" role="status">' + '<span class="fv-mark" data-s="done">' + CHECK + '</span>'
             '<p><b>v2 applied automatically.</b> Codex added a <b>DB migration</b> step to the api path because the scope grew. Approval is off in Settings, so it did not wait.</p>'
             '<button class="pill fv-sm fv-ghost">See change</button><button class="pill fv-sm fv-ghost">Turn approval on</button></div>'),
}


def approval() -> str:
    return (
        '<div class="fv-approve" role="alert">'
        f'{mark("proposed")}'
        '<p><b>Codex wants to change the flow.</b> Add a <b>DB migration</b> step to the api path: the export needs a new column, so the scope grew.</p>'
        '<button class="pill fv-sm fv-ghost">See change</button><button class="pill fv-sm fv-ghost">Keep v1</button><button class="pill fv-sm fv-primary">Approve v2</button>'
        '</div>'
    )


def variant_d(state: str = 'change') -> str:
    cfg = STATES[state]
    w, h, step = 160, 52, 188
    x = lambda col: col * step
    ys = {'api': 40, 'ui': 150, 'mid': 95, 'fix': 190}
    place = {'plan': (0, 'mid'), 'build_api': (1, 'api'), 'test_api': (2, 'api'), 'migration': (3, 'api'), 'build_ui': (1, 'ui'), 'check_ui': (2, 'ui'), 'join': (4, 'mid'), 'review': (5, 'mid'), 'fix': (5, 'fix'), 'you': (6, 'mid')}
    dropped = cfg.get('drop')
    if dropped:
        place.pop(dropped)
    pos = {k: (x(c), ys[lane]) for k, (c, lane) in place.items()}
    edges = []
    wiring = [e for e in EDGES if dropped not in e[:2]] + ([('test_api', 'join', 'idle')] if dropped else [])
    for a, b, edge_state in wiring:
        (ax, ay), (bx, by) = pos[a], pos[b]
        sx, sy, ex, ey = ax + w, ay + h / 2, bx, by + h / 2
        bend = (ex - sx) / 2
        edges.append(path(f'M{sx} {sy}C{sx + bend} {sy} {ex - bend} {ey} {ex} {ey}', cfg['edges'].get(f'{a}>{b}', edge_state)))
    loop_state, loop_text = cfg.get('loop', ('failed', 'tests failed · retried'))
    (tx, ty), (bx, _) = pos['test_api'], pos['build_api']
    edges.append(path(f'M{tx + w / 2} {ty + h}C{tx + w / 2} {ty + h + 26} {bx + w / 2} {ty + h + 26} {bx + w / 2} {ty + h + 1}', loop_state))
    (rx, ry), (fx, fy) = pos['review'], pos['fix']
    edges.append(path(f'M{rx + 45} {ry + h}L{fx + 45} {fy}', 'idle'))
    edges.append(path(f'M{fx + 105} {fy}L{rx + 105} {ry + h + 1}', 'idle'))
    labels = (
        f'<span class="fv-elabel" data-s="{loop_state}" style="left:{bx + w / 2 + 40}px;top:{ty + h + 14}px">{loop_text}</span>'
        f'<span class="fv-elabel" style="left:{rx - 58}px;top:{ry + h + 12}px">if changes needed</span>'
    )
    bands = ''.join(
        f'<div class="fv-lane" style="left:{x(1) - 12}px;top:{ys[key] - 22}px;width:{x(last) + w + 24 - x(1)}px;height:{h + 34}px"><span>{name} · <code>{branch}</code></span></div>'
        for (key, name, branch), last in zip(LANES, [2 if dropped else 3, 2])
    )
    nodes = ''.join(node(k, *pos[k], overrides=cfg['nodes']) for k in place)
    graph = f'<div class="fv-canvas" style="width:{x(6) + w}px;height:250px">{bands}<svg class="fv-edges" aria-hidden="true">{markers()}{"".join(edges)}</svg>{labels}{nodes}</div>'
    zoom = '<div class="fv-zoom"><button class="round fv-x" aria-label="Zoom out">−</button><button class="round fv-x" aria-label="Fit">⤢</button><button class="round fv-x" aria-label="Zoom in">+</button></div>'
    banner = BANNERS.get(state) or approval()
    return f'<div class="fv-d">{header(state=state)}{banner}<div class="fv-stage">{graph}{zoom}</div></div>'


def variant_d_none() -> str:
    rows = ''.join(f'<li class="fv-c-row" data-s="{s}">{mark(s)}{icon(e)}<strong>{t}</strong><small class="fv-time">{d}</small></li>' for e, t, s, d in [('codex', 'Fix the sidebar badge count', 'done', 'Finished · 1m 20s'), ('claude', 'Cross review', 'active', 'Working · 0m 22s')])
    return (
        '<div class="fv-d"><header class="fv-h"><div class="fv-h-title"><h2>Fix the sidebar badge count</h2>'
        f'<small class="fv-h-meta">Quick work · {CODEX} decided this does not need a flow</small></div>'
        f'<div class="fv-h-actions">{CLOSE}</div></header>'
        f'<div class="fv-none"><p>No flow for this work. The agents run directly and show here as a plain list.</p><ol class="fv-c-list">{rows}</ol></div></div>'
    )


def variant_e() -> str:
    w, h, gap = 162, 46, 66
    lx = {'api': 14, 'ui': 196, 'mid': 105}
    place = {'plan': (0, 'mid'), 'build_api': (1, 'api'), 'build_ui': (1, 'ui'), 'test_api': (2, 'api'), 'check_ui': (2, 'ui'), 'migration': (3, 'api'), 'join': (4, 'mid'), 'review': (5, 'api'), 'fix': (5, 'ui'), 'you': (6, 'api')}
    pos = {k: (lx[lane], row * gap + 22) for k, (row, lane) in place.items()}
    edges = []
    for a, b, state in EDGES:
        (ax, ay), (bx, by) = pos[a], pos[b]
        sx, sy, ex, ey = ax + w / 2, ay + h, bx + w / 2, by
        bend = (ey - sy) / 2
        edges.append(path(f'M{sx} {sy}C{sx} {sy + bend} {ex} {ey - bend} {ex} {ey}', state))
    (tx, ty), (bx, by) = pos['test_api'], pos['build_api']
    edges.append(path(f'M{tx} {ty + h / 2}C{tx - 16} {ty + h / 2} {bx - 16} {by + h / 2} {bx} {by + h / 2}', 'failed'))
    (rx, ry), (fx, fy) = pos['review'], pos['fix']
    edges.append(path(f'M{rx + w} {ry + 14}L{fx} {fy + 14}', 'idle'))
    edges.append(path(f'M{fx} {fy + 32}L{rx + w} {ry + 32}', 'idle'))
    labels = f'<span class="fv-elabel" data-s="failed" style="left:0px;top:{ty - 12}px;transform:translateX(-100%) rotate(-90deg);transform-origin:right top">retried</span>'
    heads = ''.join(f'<div class="fv-lane-h" style="left:{lx[key]}px;width:{w}px">{name}<code>{branch}</code></div>' for key, name, branch in LANES)
    nodes = ''.join(node(k, *pos[k]) for k in place)
    graph = f'<div class="fv-canvas" style="width:{lx["ui"] + w}px;height:{6 * gap + 22 + h}px">{heads}<svg class="fv-edges" aria-hidden="true">{markers()}{"".join(edges)}</svg>{labels}{nodes}</div>'
    subs = ''.join(f'<li>{mark(s)}<b>{name}</b><span>{text}</span></li>' for name, text, s in SUBAGENTS)
    detail = f'<section class="fv-e-detail"><h3>{icon("claude")} Build UI <small>selected step</small></h3><p>Worktree <code>flow/csv-export-ui</code> · 4 files changed · +212 −18</p><ul>{subs}</ul></section>'
    return f'<aside class="fv-e-dock">{header(compact=True)}{approval()}<div class="fv-stage">{graph}</div>{detail}</aside>'


def variant_f() -> str:
    w, step, row = 150, 164, 40
    rows = {'main': 0, 'api': 1, 'ui': 2, 'fix': 3}
    place = {'plan': (0, 'main'), 'build_api': (1, 'api'), 'test_api': (2, 'api'), 'migration': (3, 'api'), 'build_ui': (1, 'ui'), 'check_ui': (2, 'ui'), 'join': (4, 'main'), 'review': (5, 'main'), 'fix': (5, 'fix'), 'you': (6, 'main')}
    pos = {k: (c * step, rows[lane] * row) for k, (c, lane) in place.items()}
    edges = []
    for a, b, state in EDGES + [('review', 'fix', 'idle')]:
        (ax, ay), (bx, by) = pos[a], pos[b]
        if (a, b) == ('review', 'fix'):
            edges.append(path(f'M{ax + 20} {ay + 30}L{ax + 20} {by + 1}', 'idle'))
            continue
        sx, sy, ex, ey = ax + w, ay + 15, bx, by + 15
        if sy == ey:
            edges.append(path(f'M{sx} {sy}L{ex} {ey}', state))
            continue
        mid, turn = ex - min(14, (ex - sx) / 2), 6 if ey > sy else -6
        edges.append(path(f'M{sx} {sy}L{mid - 3} {sy}Q{mid} {sy} {mid} {sy + turn}L{mid} {ey - turn}Q{mid} {ey} {mid + 3} {ey}L{ex} {ey}', state))
    heads = ''.join(f'<span class="fv-f-lane" style="top:{rows[key] * row}px">{name}<code>{branch}</code></span>' for key, name, branch in [('main', 'Main', 'trunk'), *LANES, ('fix', 'If review fails', '')])
    chips = []
    for key in place:
        kind, title, status, detail = NODES[key]
        x, y = pos[key]
        badge = '<em class="fv-loop" title="Tests failed once, retried">↺ 2</em>' if key in ('build_api', 'test_api') else ''
        chips.append(f'<div class="fv-chip" data-s="{status}" title="{detail}" style="left:{x}px;top:{y}px">{mark(status)}{icon(kind)}<strong>{title}</strong>{badge}</div>')
    graph = f'<div class="fv-f-body"><div class="fv-f-heads">{heads}</div><div class="fv-canvas" style="width:{6 * step + w}px;height:{3 * row + 30}px"><svg class="fv-edges" aria-hidden="true">{markers()}{"".join(edges)}</svg>{"".join(chips)}</div></div>'
    return f'<div class="fv-f">{header(compact=True)}{approval()}{graph}</div>'


def replace_flow(html: str, inner: str) -> str:
    start = html.index('<section id="flow"')
    open_end = html.index('>', start) + 1
    end = html.index('</section>', start)
    return html[:open_end] + f'<div class="flow-inner">{inner}</div>' + html[end:]


def remove_flow(html: str) -> str:
    start = html.index('<section id="flow"')
    end = html.index('</section>', start) + len('</section>')
    return html[:start] + html[end:]


def finish(name: str, html: str, extra: str = '') -> None:
    variant, text = SCREENS[name]
    html = html.replace('height: 540px', f'height: {540 + LIVE_TOP_NOW - LIVE_TOPS[name]}px')
    html = html.replace('</head>', '<link rel="stylesheet" href="drawer.css"><link rel="stylesheet" href="flow-v2.css"></head>', 1)
    html = html.replace('</body>', f'{extra}<div class="fv-label">{variant} — {text}<a href="index.html">all screens</a></div></body>', 1)
    (HERE / f'{name}.html').write_text(html)


def dock(html: str) -> str:
    narrowed = remove_flow(html).replace('width: 1332px', f'width: {1332 - DOCK_WIDTH - 12}px').replace('width: 1291px', f'width: {1291 - DOCK_WIDTH - 12}px')
    at = narrowed.index('<section id="live"')
    return narrowed[:at] + variant_e() + narrowed[at:]


finish('d-terminal', replace_flow(SRC, variant_d()))
finish('e-terminal', dock(SRC))
finish('f-terminal', replace_flow(SRC, variant_f()))
finish('d-draft', replace_flow(SRC, variant_d('draft')))
finish('d-auto', replace_flow(SRC, variant_d('auto')))
finish('d-none', replace_flow(SRC, variant_d_none()))
