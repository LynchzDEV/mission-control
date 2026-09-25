AIS = [
    dict(id='claude', name='Claude', line='Claude Code CLI', color='#d4a091', role='Plan', models=['opus', 'sonnet', 'haiku'], usage=[('5h', 4), ('Week', 87)], note='Uses the account signed in through the Claude Code CLI on this machine.'),
    dict(id='glm', name='GLM', line='Claude Code through z.ai', color='#91b0dc', role='Execute', models=['glm-5.3', 'glm-5.3-flash'], usage=[('5h', 0)], note='Runs Claude Code against your z.ai account.'),
    dict(id='codex', name='Codex', line='Codex CLI', color='#bfd38b', role='Review', models=['gpt-5.5', 'gpt-5.5-mini'], usage=[('Week', 30)], note='Uses the account signed in through the Codex CLI on this machine.'),
]


def logo(ai, size=32):
    return f'<span class="ma-logo" style="--engine:{ai["color"]};--s:{size}px"><img src="providers/{ai["id"]}.svg" alt=""></span>'


def bars(ai):
    return ''.join(f'<div class="ma-bar"><span>{label}</span><i><b style="width:{pct}%;background:{ai["color"]}"></b></i><em>{pct}%</em></div>' for label, pct in ai['usage'])


def ready():
    return '<span class="pill-state" data-s="done">Ready</span>'


def page(title, foot, body):
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Manage AIs — {title}</title>
<link rel="stylesheet" href="quiet.css"><link rel="stylesheet" href="mock.css"><link rel="stylesheet" href="agents.css"><link rel="stylesheet" href="manage-mock.css"></head>
<body><main class="canvas"><div data-toolbar></div>
<div class="ma-page"><header class="ma-head"><div><h1>Studio</h1><p class="muted">Give your AI team a way to work.</p></div>
<nav class="ma-nav"><a>Workflows</a><a aria-current="page">Manage AIs</a><a>Runs</a><a>Rules</a></nav></header>{body}</div></main>
<p class="mock-foot">{foot}</p><script src="frame.js"></script></body></html>'''


GLM_FORM = '''<div class="ma-section"><h3>z.ai settings</h3><div class="ma-fields">
<label>Base URL<input value="https://api.z.ai/api/anthropic"></label>
<label>Token<input type="password" placeholder="Configured · type to replace"></label></div>
<p class="muted ma-small">Stored on this machine only and never shown again.</p><button class="ma-btn primary">Save</button></div>'''


def detail(ai, extra=''):
    models = ''.join(f'<span class="ma-chip">{m}</span>' for m in ai['models'])
    return f'''<header class="ma-dhead">{logo(ai, 40)}<div><h2>{ai["name"]}</h2><p class="muted">{ai["line"]}</p></div>{ready()}</header>
<p class="ma-note">{ai["note"]}</p>
<div class="ma-grid2"><div class="ma-section"><h3>Usage</h3>{bars(ai)}</div>
<div class="ma-section"><h3>Used for</h3><span class="ma-role">{ai["role"]}</span><p class="muted ma-small">Change in Workflows · Roles</p></div></div>
<div class="ma-section"><h3>Models</h3><div class="ma-chips">{models}</div></div>{extra}
<div class="ma-foot"><button class="ma-btn">Check connection</button><span class="muted ma-small">Checked when a job starts · last OK 2:46 AM</span></div>'''


def variant_a():
    rows = ''.join(f'<button class="ma-item{" sel" if ai["id"] == "glm" else ""}">{logo(ai, 28)}<span><strong>{ai["name"]}</strong><small>{ai["line"]}</small></span><i class="ma-dot"></i></button>' for ai in AIS)
    body = f'''<div class="ma-split"><aside class="ma-list"><h2>AIs <span class="muted">3 connected</span></h2>{rows}<button class="ma-add"><svg><use href="#plus-icon"/></svg>Add an AI</button></aside>
<section class="ma-detail">{detail(AIS[1], GLM_FORM)}</section></div>'''
    return page('A', 'A · list + detail, designed — client/studio-settings.tsx Connections', body)


def variant_b():
    cards = ''.join(f'''<article class="ma-card{" sel" if ai["id"] == "glm" else ""}"><header>{logo(ai, 36)}<div><strong>{ai["name"]}</strong><small>{ai["line"]}</small></div>{ready()}</header>
<div class="ma-card-body">{bars(ai)}</div><footer><span class="ma-role">{ai["role"]}</span><span class="ma-sp"></span><button class="ma-btn">Settings</button></footer></article>''' for ai in AIS)
    body = f'''<div class="ma-cards">{cards}<button class="ma-card ma-card-add"><svg><use href="#plus-icon"/></svg><strong>Add an AI</strong><small>Qwen, OpenCode, any CLI</small></button></div>
<section class="ma-drawer-note"><h3>GLM settings</h3><div class="ma-fields"><label>Base URL<input value="https://api.z.ai/api/anthropic"></label><label>Token<input type="password" placeholder="Configured · type to replace"></label></div><button class="ma-btn primary">Save</button></section>'''
    return page('B', 'B · card per AI; Settings opens below — client/studio-settings.tsx', body)


def variant_c():
    roles = [('Plan', 'Turns a request into a plan', AIS[0], 'opus'), ('Execute', 'Writes and changes code', AIS[1], 'glm-5.3'), ('Review', 'Checks work from another AI family', AIS[2], 'gpt-5.5')]
    role_rows = ''.join(f'''<div class="ma-rrow"><div><strong>{r}</strong><small>{d}</small></div><button class="ma-picker">{logo(ai, 22)}<span>{ai["name"]} · {m}</span><svg><use href="#chevron-icon"/></svg></button></div>''' for r, d, ai, m in roles)
    ai_rows = ''.join(f'''<div class="ma-arow">{logo(ai, 28)}<div class="ma-aname"><strong>{ai["name"]}</strong><small>{ai["line"]}</small></div><div class="ma-abars">{bars(ai)}</div>{ready()}<button class="ma-btn">{"Settings" if ai["id"] == "glm" else "Check"}</button></div>''' for ai in AIS)
    body = f'''<div class="ma-stack"><section class="ma-block"><h2>Who does what</h2><p class="muted ma-small">Every workflow step uses its role's AI unless the step picks one.</p>{role_rows}</section>
<section class="ma-block"><h2>Connected AIs <span class="muted">3</span></h2>{ai_rows}<button class="ma-add"><svg><use href="#plus-icon"/></svg>Add an AI</button></section></div>'''
    return page('C', 'C · roles first, AIs below — client/studio-settings.tsx, server/routes/roles.ts', body)


for name, fn in [('manage-ais-a.html', variant_a), ('manage-ais-b.html', variant_b), ('manage-ais-c.html', variant_c)]:
    open(name, 'w').write(fn())
