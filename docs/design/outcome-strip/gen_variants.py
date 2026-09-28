import re
from pathlib import Path

HERE = Path(__file__).parent
API_HOST = 'data-id="95fda1f7-f56e-4852-a774-18ff88cf4c57"'
HEAD_EXTRA = '<link rel="stylesheet" href="strip.css">'
TAIL_EXTRA = '<script src="strip.js"></script>'

SCREENS = {
    'now-terminal': ('NOW', 'Terminal as it is today'),
    'now-chat': ('NOW', 'Chat as it is today'),
    'a-terminal': ('A', 'In the session pill, next to Live'),
    'a-chat': ('A', 'Chat gets the same pill, top right'),
    'b-terminal': ('B', 'Status line along the bottom edge of the terminal'),
    'b-chat': ('B', 'Status line just above the composer'),
    'c-terminal': ('C', 'Under each session title in the sidebar'),
    'c-chat': ('C', 'Under each session title in the sidebar'),
}


def scrub(html: str) -> str:
    html = re.sub(r'/private/tmp/claude-501/[^"]*?/scratchpad/home/(api|backoffice)', r'~/Desktop/kingpinggroup/klangtech/\1', html)
    return html


def label(name: str) -> str:
    variant, text = SCREENS[name]
    return f'<div class="oc-label">{variant} — {text}<a href="index.html">all screens</a></div>'


def finish(name: str, html: str) -> None:
    html = html.replace('</head>', f'{HEAD_EXTRA}</head>', 1)
    html = html.replace('</body>', f'{label(name)}{TAIL_EXTRA}</body>', 1)
    (HERE / f'{name}.html').write_text(html)


def in_api_host(html: str, anchor: str, insert: str, after: bool = True) -> str:
    start = html.index(API_HOST)
    at = html.index(anchor, start)
    at = at + len(anchor) if after else at
    return html[:at] + insert + html[at:]


PILL_STRIP = '<span class="oc-new" data-set="{set}" data-max="20" style="padding:0 2px"></span>'
FOOT = ('<div class="oc-new" style="{pos};display:flex;align-items:center;gap:12px;padding:8px 12px;'
        'border:1px solid var(--line);border-radius:var(--r-md);corner-shape:var(--corner);'
        'background:color-mix(in srgb,#fff 45%,var(--paper));--oc-size:10px">'
        '<span style="font-size:12px;font-weight:500;color:#505e75;white-space:nowrap">This session</span>'
        '<span data-set="{set}" data-sum style="flex:1;justify-content:space-between"></span></div>')
SIDEBAR_STRIP = '<span class="oc-new" data-set="{set}" data-max="16" style="--oc-size:6px;--oc-gap:2px;margin-top:5px;width:max-content"></span>'
CHAT_ROW = ('<div class="sb-item"><a class="sb-row sel" data-kind="chat" aria-current="page" href="#">'
            '<span class="sb-ic"><svg viewBox="0 0 20 20"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/></svg></span>'
            '<span class="sb-t">Add a CSV export to the MoNi upsell rules page{strip}</span><i class="sb-dot" data-s="landed"></i></a></div>')


def sidebar_strips(html: str, sets: dict[str, str]) -> str:
    for title, name in sets.items():
        html = re.sub(rf'(<span class="sb-t">{re.escape(title)})', rf'\1{SIDEBAR_STRIP.format(set=name)}', html, count=1)
    return html


def build() -> None:
    terminal = scrub((HERE / 'src-terminal.html').read_text())
    chat = scrub((HERE / 'src-chat.html').read_text())
    (HERE / 'src-terminal.html').write_text(terminal)
    (HERE / 'src-chat.html').write_text(chat)
    finish('now-terminal', terminal)
    finish('now-chat', chat)

    a_term = in_api_host(terminal, '<button class="term-bar-status"', PILL_STRIP.format(set='terminal') + '<span class="term-bar-sep"></span>', after=False)
    finish('a-terminal', a_term)
    chat_pill = ('<div class="term-bar oc-new" style="position:sticky;top:0;margin:0 0 12px auto;width:max-content">'
                 '<span class="term-bar-logo"><svg style="width:15px;height:15px;fill:#8062bd"><use href="#spark-icon"/></svg></span>'
                 '<span class="term-bar-name">This chat</span><span class="term-bar-sep"></span>'
                 + PILL_STRIP.format(set='chat').replace(' class="oc-new"', '') + '</div>')
    finish('a-chat', chat.replace('<div id="messages"', chat_pill + '<div id="messages"', 1))

    b_term = in_api_host(terminal, '<div dir="ltr" class="ter', FOOT.format(set='terminal', pos='position:absolute;left:12px;right:12px;bottom:12px;z-index:10'), after=False)
    finish('b-terminal', b_term)
    finish('b-chat', chat.replace('<form id="composer"', FOOT.format(set='chat', pos='margin:0 0 10px') + '<form id="composer"', 1))

    finish('c-terminal', sidebar_strips(terminal, {'api · moni runtime': 'terminal', 'backoffice · e2e': 'chat'}))
    c_chat = chat.replace('class="sb-shell collapsed"', 'class="sb-shell"', 1)
    c_chat = sidebar_strips(c_chat, {'api · moni runtime': 'terminal', 'backoffice · e2e': 'chat'})
    c_chat = re.sub(r'(<p class="sb-day">Today</p>)', r'\1' + CHAT_ROW.format(strip=SIDEBAR_STRIP.format(set='chat')), c_chat, count=1)
    finish('c-chat', c_chat)


if __name__ == '__main__':
    build()
