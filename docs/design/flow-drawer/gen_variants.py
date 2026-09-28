from pathlib import Path

HERE = Path(__file__).parent
SRC = (HERE / 'src-terminal.html').read_text()

SCREENS = {
    'now-terminal': ('NOW', 'Session flow as it is today'),
    'a-terminal': ('A', 'Slim strip: one row, pushes the terminal down ~64px'),
    'b-terminal': ('B', 'Titled panel: flow tabs in the header, richer nodes'),
    'c-terminal': ('C', 'Popover under the Flow button: overlays, never pushes'),
}

FLOWS = [('Fix retry-match on customer calls', 'active'), ('Upsell check for rescued orders', 'done'), ('Thai reply to customer', 'pending')]
BRANCHES = [('claude', 'Claude work', 'done', 'Finished · 4m 12s'), ('codex', 'Codex review', 'active', 'Working · 1m 08s'), ('glm', 'GLM tests', 'failed', 'Failed · exit 1')]
DIRECTION = ('Direction', 'done', 'Decided · 5:41 PM')
REVIEW = ('Your review', 'pending', 'Up next')

CHECK = '<svg viewBox="0 0 10 10"><path d="M2 5.2 4.1 7.3 8 3"/></svg>'
BANG = '<svg viewBox="0 0 10 10"><path d="M5 2.2v3.4M5 7.6v.1"/></svg>'
CHEVRON = '<svg viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3"/></svg>'
COMPASS = '<svg class="fv-glyph" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/><path d="m10.4 5.6-1.5 3.3-3.3 1.5 1.5-3.3z"/></svg>'
EYE = '<svg class="fv-glyph" viewBox="0 0 16 16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>'
CLOSE = '<button class="round fv-x" aria-label="Collapse flow"><svg><use href="#close-icon"/></svg></button>'


def mark(status: str) -> str:
    inner = {'done': CHECK, 'failed': BANG}.get(status, '')
    return f'<span class="fv-mark" data-s="{status}">{inner}</span>'


def logo(engine: str) -> str:
    return f'<img class="fv-logo" src="assets/providers/{engine}.svg" alt="">'


def variant_a() -> str:
    step = lambda icon, title, status, detail: f'<span class="fv-a-step" data-s="{status}">{icon}{title}<small>{detail}</small></span>'
    group = ''.join(f'<span class="fv-a-step" data-s="{s}" title="{d}">{logo(e)}{t}{mark(s)}</span>' for e, t, s, d in BRANCHES)
    return (
        '<div class="fv-a">'
        f'<button class="fv-a-switch" title="Switch flow"><strong>{FLOWS[0][0]}</strong><small>1 of {len(FLOWS)} flows</small>{CHEVRON}</button>'
        '<div class="fv-a-track" role="list">'
        f'{step(mark(DIRECTION[1]), DIRECTION[0], DIRECTION[1], "")}'
        '<i class="fv-a-link"></i>'
        f'<div class="fv-a-group">{group}</div>'
        '<i class="fv-a-link" data-s="idle"></i>'
        f'{step(mark(REVIEW[1]), REVIEW[0], REVIEW[1], "")}'
        '</div>'
        f'{CLOSE}</div>'
    )


def b_node(x: int, y: int, icon: str, title: str, status: str, detail: str) -> str:
    return f'<div class="fv-b-node" data-s="{status}" style="left:{x}px;top:{y}px">{icon}<strong>{title}</strong><small>{detail}</small>{mark(status)}</div>'


def variant_b() -> str:
    tabs = ''.join(f'<button class="fv-b-tab" aria-selected="{str(i == 0).lower()}"><i data-s="{s}"></i><span>{label}</span></button>' for i, (label, s) in enumerate(FLOWS))
    w, h, gap, col = 200, 60, 12, 244
    mid = (3 * h + 2 * gap) // 2
    nodes = [b_node(0, mid - h // 2, COMPASS, *DIRECTION)]
    edges = []
    for row, (engine, title, status, detail) in enumerate(BRANCHES):
        y = row * (h + gap)
        detail = 'Failed · exit 1 · <a href="#">open log</a>' if status == 'failed' else detail
        nodes.append(b_node(col, y, logo(engine), title, status, detail))
        cy, bend = y + h // 2, (col - w) // 2
        edges.append(f'<path class="flow-edge {"flowing" if status == "active" else "done"}" d="M{w} {mid}C{w + bend} {mid} {col - bend} {cy} {col} {cy}"/>')
        edges.append(f'<path class="flow-edge {"done" if status == "done" else ""}" d="M{col + w} {cy}C{col + w + bend} {cy} {2 * col - bend} {mid} {2 * col} {mid}"/>')
    nodes.append(b_node(2 * col, mid - h // 2, EYE, *REVIEW))
    return (
        '<div class="fv-b">'
        f'<header class="fv-b-head"><h2>Session flow</h2><div class="fv-b-tabs" role="tablist">{tabs}</div>'
        '<div class="fv-b-sum"><span class="pill-state" data-s="running">1 working</span><span class="pill-state" data-s="needs">1 failed</span></div>'
        f'{CLOSE}</header>'
        f'<div class="fv-b-graph"><svg class="edges" aria-hidden="true">{"".join(edges)}</svg>{"".join(nodes)}</div>'
        '</div>'
    )


def c_row(icon: str, title: str, status: str, detail: str, link: str = 'done') -> str:
    return f'<li class="fv-c-row" data-s="{status}" data-link="{link}">{mark(status)}{icon}<strong>{title}</strong><small class="fv-time">{detail}</small></li>'


def variant_c() -> str:
    branches = ''.join(c_row(logo(e), t, s, d) for e, t, s, d in BRANCHES)
    return (
        '<div class="fv-c" role="dialog" aria-label="Session flow">'
        f'<div class="fv-c-head"><button class="fv-c-switch"><strong>{FLOWS[0][0]}</strong><small>1 of {len(FLOWS)}</small>{CHEVRON}</button>{CLOSE}</div>'
        '<ol class="fv-c-list">'
        f'{c_row("", *DIRECTION)}'
        f'<li class="fv-c-group"><p>3 agents in parallel</p><ol class="fv-c-list" style="margin:0">{branches}</ol></li>'
        f'{c_row("", *REVIEW, link="idle")}'
        '</ol>'
        '<div class="fv-c-foot"><span>1 working · 1 failed</span><a href="#">Open in Studio</a></div>'
        '</div>'
    )


def replace_flow(html: str, inner: str) -> str:
    start = html.index('<section id="flow"')
    open_end = html.index('>', start) + 1
    end = html.index('</section>', start)
    return html[:open_end] + f'<div class="flow-inner">{inner}</div>' + html[end:]


def remove_flow(html: str) -> str:
    start = html.index('<section id="flow"')
    end = html.index('</section>', start) + len('</section>')
    return html[:start] + html[end:]


LIVE_TOP_NOW = 328
LIVE_TOPS = {'now-terminal': 328, 'a-terminal': 161, 'b-terminal': 385, 'c-terminal': 84}


def finish(name: str, html: str, extra: str = '') -> None:
    variant, text = SCREENS[name]
    html = html.replace('height: 540px', f'height: {540 + LIVE_TOP_NOW - LIVE_TOPS[name]}px')
    html = html.replace('</head>', '<link rel="stylesheet" href="drawer.css"></head>', 1)
    html = html.replace('</body>', f'{extra}<div class="fv-label">{variant} — {text}<a href="index.html">all screens</a></div></body>', 1)
    (HERE / f'{name}.html').write_text(html)


finish('now-terminal', SRC)
finish('a-terminal', replace_flow(SRC, variant_a()))
finish('b-terminal', replace_flow(SRC, variant_b()))
finish('c-terminal', remove_flow(SRC), variant_c())
