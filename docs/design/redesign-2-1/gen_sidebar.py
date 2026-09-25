CHAT = '<svg viewBox="0 0 20 20"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/></svg>'
TERM = '<svg><use href="#terminal-icon"/></svg>'
ITEMS = [
    ('Today', [
        ('chat', 'Fix chat scroll + markdown', 'running', '2 agents', True),
        ('term', 'mission-control · Claude', 'live', '', False),
        ('chat', 'Say-hi HTML page', 'landed', '', False),
    ]),
    ('Yesterday', [
        ('chat', 'hi', None, '', False),
        ('term', 'feed_practice · Codex', 'live', '', False),
        ('chat', 'Terminals find bar options', None, '', False),
    ]),
    ('Earlier', [
        ('chat', 'Workflow studio redesign', 'needs', '1 needs you', False),
        ('chat', 'Quota card for GLM', None, '', False),
    ]),
]


def row(kind, title, state, note, selected):
    icon = CHAT if kind == 'chat' else TERM
    dot = f'<i class="sb-dot" data-s="{state}"></i>' if state else ''
    sub = f'<small>{note}</small>' if note else ''
    return f'<a class="sb-row{" sel" if selected else ""}" data-kind="{kind}"><span class="sb-ic">{icon}</span><span class="sb-t">{title}{sub}</span>{dot}</a>'


def groups(filter_kind=None):
    out = ''
    for day, items in ITEMS:
        rows = ''.join(row(*i) for i in items if filter_kind is None or i[0] == filter_kind)
        if rows:
            out += f'<p class="sb-day">{day}</p>{rows}'
    return out


HEAD = '''<div class="sb-top"><button class="sb-icon" title="Hide sidebar"><svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 4v12"/></svg></button><span class="sp"></span><button class="sb-icon" title="Search"><svg><use href="#search-icon"/></svg></button></div>
<button class="sb-new"><svg><use href="#plus-icon"/></svg>New chat</button><button class="sb-new ghost"><svg><use href="#terminal-icon"/></svg>New terminal</button>'''

FOOT = '<div class="sb-foot"><button class="sb-link"><svg><use href="#history-icon"/></svg>All history</button></div>'


def page(title, foot, sidebar, collapsed=False):
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sidebar — {title}</title>
<link rel="stylesheet" href="quiet.css"><link rel="stylesheet" href="mock.css"><link rel="stylesheet" href="sidebar-mock.css"></head>
<body><div class="sb-shell{" collapsed" if collapsed else ""}">{sidebar}
<main class="canvas"><div data-toolbar></div>
<div class="workspace"><div class="chat-container"><div class="stage"><section class="conversation content-width"><div class="chat chat-snippet" data-include="chat-snippet.frag"></div></section></div>
<div class="composer-area content-width"><form class="composer nui-neuromorphic-inset"><textarea rows="1" placeholder="Write a message here…"></textarea><button type="button" class="round send"><svg><use href="#arrow-icon"/></svg></button></form></div></div></div></main></div>
<p class="mock-foot">{foot}</p><script src="frame.js"></script><script>document.querySelectorAll('.toolbar nav[aria-label=Chats]').forEach(n=>n.style.visibility='hidden')</script></body></html>'''


def variant_a():
    side = f'<aside class="sb">{HEAD}<nav class="sb-list">{groups()}</nav>{FOOT}</aside>'
    return page('A', 'A · ChatGPT-style list grouped by day; New chat / search move from the toolbar into the sidebar — server/views/shell.ts, client/chat.ts paintHistory', side)


def variant_b():
    running = ''.join(row(*i) for _, items in ITEMS for i in items if i[2] in ('running', 'live', 'needs'))
    filters = '<div class="sb-filter"><button aria-pressed="true">All</button><button>Chats</button><button>Terminals</button></div>'
    side = f'<aside class="sb">{HEAD}{filters}<nav class="sb-list"><p class="sb-day">Running now</p>{running}<p class="sb-day">Recent</p>{"".join(row(*i) for _, items in ITEMS for i in items if i[2] not in ("running", "live", "needs"))}</nav>{FOOT}</aside>'
    return page('B', 'B · live items pinned on top, All / Chats / Terminals filter — server/views/shell.ts', side)


def variant_c():
    icons = ''.join(f'<a class="sb-mini{" sel" if i[4] else ""}" title="{i[1]}"><span class="sb-ic">{CHAT if i[0] == "chat" else TERM}</span>{f"<i class=sb-dot data-s={i[2]}></i>" if i[2] else ""}</a>' for _, items in ITEMS for i in items if i[2])
    side = f'''<aside class="sb mini"><button class="sb-icon" title="Show sidebar"><svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M8 4v12"/></svg></button>
<button class="sb-icon accent" title="New chat"><svg><use href="#plus-icon"/></svg></button><button class="sb-icon" title="Search"><svg><use href="#search-icon"/></svg></button><span class="sb-sep"></span>{icons}<span class="sp"></span><button class="sb-icon" title="All history"><svg><use href="#history-icon"/></svg></button></aside>'''
    return page('C', 'C · collapsed state: 56px icon strip showing only live items; expands to A — server/views/shell.ts', side, collapsed=True)


for name, fn in [('sidebar-a.html', variant_a), ('sidebar-b.html', variant_b), ('sidebar-c.html', variant_c)]:
    open(name, 'w').write(fn())
