ICONS = {
    'plan': '<path d="M6 3h8l3 3v11H6z"/><path d="M9 9h5M9 12h5M9 15h3"/>',
    'check': '<circle cx="10" cy="10" r="7"/><path d="m7 10 2 2 4-4"/>',
    'code': '<path d="m7 6-4 4 4 4M13 6l4 4-4 4"/>',
    'review': '<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="10" cy="10" r="2.5"/>',
}
ENGINE = {'claude': ('#d4a091', 'Claude'), 'codex': ('#bfd38b', 'Codex'), 'glm': ('#91b0dc', 'GLM')}
STEPS = [
    ('Plan', 'Inspect the request and repository', 'plan', 'Plan', 'claude'),
    ('Verify plan', 'Check the plan against the request and code', 'check', 'Review', 'codex'),
    ('Execute', 'Implement the verified plan in this workspace', 'code', 'Execute', 'glm'),
    ('Cross-family review', 'Independently review the diff and evidence', 'review', 'Review', 'codex'),
]

def icon(name, cls='st-ic'):
    return f'<svg class="{cls}" viewBox="0 0 20 20">{ICONS[name]}</svg>'

def ai_tag(role, engine):
    color, name = ENGINE[engine]
    return f'<span class="st-ai" style="--engine:{color}"><img src="providers/{engine}.svg" alt="">{role} AI · {name}</span>'

def page(title, foot, canvas, legend=''):
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Studio canvas — {title}</title>
<link rel="stylesheet" href="quiet.css"><link rel="stylesheet" href="mock.css"><link rel="stylesheet" href="studio-mock.css"></head>
<body><main class="canvas"><div data-toolbar></div>
<div class="st-page">
<header class="st-edit-head"><div><h1>Plan, verify, execute, review</h1><p class="muted">Default workflow · 4 steps · Saved</p></div>
<div class="st-actions"><button class="text-button">History</button><button class="pill" disabled>Save</button><button class="pill st-run"><svg><use href="#play-icon"/></svg>Run workflow</button></div></header>
<div class="st-body"><section class="st-canvas"><div class="st-tools"><button class="st-tool"><svg><use href="#plus-icon"/></svg>Add step</button><button class="st-tool"><svg><use href="#spark-icon"/></svg>Ask AI</button>{legend}</div>{canvas}
<div class="st-zoom"><button>+</button><button>−</button><button><svg viewBox="0 0 20 20"><path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4"/></svg></button></div>
<p class="st-hint"><svg><use href="#lock-icon"/></svg>Core rules always apply · Drag to arrange · connect to set the order</p></section>
<aside class="st-panel"><p class="muted">Select a step to edit it.</p></aside></div></div></main>
<p class="mock-foot">{foot}</p><script src="frame.js"></script></body></html>'''

def edges_straight(xs, y, w, anim):
    out = []
    for i in range(len(xs) - 1):
        x1, x2 = xs[i] + w, xs[i + 1] - 8
        d = f'M {x1} {y} L {x2} {y}'
        out.append(f'<path class="st-edge" d="{d}" marker-end="url(#arrow)"/>')
        if anim == 'dash':
            out.append(f'<path class="st-flow" d="{d}"/>')
        if anim == 'dot':
            out.append(f'<circle r="3.5" class="st-dot"><animateMotion dur="1.6s" begin="0s" repeatCount="indefinite" path="{d}"/></circle>')
    return ''.join(out)

DEFS = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" fill="#8a93a8"/></marker><marker id="arrow-fail" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1 9 5 0 9z" fill="#b0556a"/></marker></defs>'

def variant_a():
    w, xs, top = 180, [50, 310, 570, 830], 140
    nodes = ''.join(f'<article class="st-node" style="left:{x}px;top:{top}px">{icon(ic)}<strong>{t}</strong><p>{d}</p><footer>{ai_tag(r, e)}</footer><i class="h l"></i><i class="h r"></i></article>' for x, (t, d, ic, r, e) in zip(xs, STEPS))
    svg = f'<svg class="st-wires" viewBox="0 0 1040 460">{DEFS}{edges_straight(xs, top + 75, w, "dash")}</svg>'
    return page('A', 'A · old node anatomy in the light theme, flat, arrows + flowing dash — client/studio.tsx node renderer, studio.css .react-flow__edge-path', f'<div class="st-graph">{svg}{nodes}</div>')

def variant_b():
    w, xs, top = 200, [40, 300, 560, 820], 190
    nodes = ''.join(f'<article class="st-pill" style="left:{x}px;top:{top}px;--engine:{ENGINE[e][0]}">{icon(ic)}<strong>{t}</strong><img src="providers/{e}.svg" alt="{ENGINE[e][1]}"><i class="h l"></i><i class="h r"></i></article>' for x, (t, d, ic, r, e) in zip(xs, STEPS))
    svg = f'<svg class="st-wires" viewBox="0 0 1040 460">{DEFS}{edges_straight(xs, top + 24, w, "dot")}</svg>'
    return page('B', 'B · compact pills, a dot travels each line — client/studio.tsx, studio.css', f'<div class="st-graph">{svg}{nodes}</div>')

def variant_c():
    lanes = [('Plan', 60), ('Review', 190), ('Execute', 320)]
    pos = [(110, 60), (350, 190), (590, 320), (830, 190)]
    states = ['done', 'done', 'running', 'waiting']
    lane_html = ''.join(f'<div class="st-lane" style="top:{y - 14}px"><span>{name}</span></div>' for name, y in lanes)
    nodes = ''
    for (x, y), (t, d, ic, r, e), s in zip(pos, STEPS, states):
        badge = {'done': '<span class="st-state done">Passed</span>', 'running': '<span class="st-state run">Running · 0:42</span>', 'waiting': '<span class="st-state">Waiting</span>'}[s]
        nodes += f'<article class="st-node sm" data-s="{s}" style="left:{x}px;top:{y}px"><div class="st-title">{icon(ic)}<strong>{t}</strong></div>{badge}<footer>{ai_tag(r, e)}</footer><i class="h l"></i><i class="h r"></i></article>'
    w, h = 190, 92
    def cy(y): return y + h / 2
    paths = []
    for i in range(3):
        (x1, y1), (x2, y2) = pos[i], pos[i + 1]
        sx, sy, tx, ty = x1 + w, cy(y1), x2 - 8, cy(y2)
        d = f'M {sx} {sy} C {sx + 60} {sy}, {tx - 60} {ty}, {tx} {ty}'
        cls = 'st-edge done' if i < 1 else 'st-edge'
        paths.append(f'<path class="{cls}" d="{d}" marker-end="url(#arrow)"/>')
        if i == 1:
            paths.append(f'<path class="st-flow" d="{d}"/>')
    rx, ry = pos[3]
    ex, ey = pos[2]
    fail = f'M {rx + w / 2} {ry + h} C {rx + w / 2} {ry + h + 120}, {ex + w + 90} {cy(ey)}, {ex + w + 8} {cy(ey) + 10}'
    paths.append(f'<path class="st-edge fail" d="{fail}" marker-end="url(#arrow-fail)"/>')
    label = f'<span class="st-edge-label fail" style="left:{rx + 70}px;top:{ry + h + 70}px">Changes requested</span>'
    svg = f'<svg class="st-wires" viewBox="0 0 1040 460">{DEFS}{"".join(paths)}</svg>'
    legend = '<span class="st-legend"><i class="pass"></i>Pass<i class="fail"></i>Fail</span>'
    return page('C', 'C · rows by role, live run state on nodes, fail edges dashed red — client/studio.tsx, server/workflow-runner.ts', f'<div class="st-graph">{lane_html}{svg}{nodes}{label}</div>', legend)

for name, fn in [('studio-canvas-a.html', variant_a), ('studio-canvas-b.html', variant_b), ('studio-canvas-c.html', variant_c)]:
    open(name, 'w').write(fn())
