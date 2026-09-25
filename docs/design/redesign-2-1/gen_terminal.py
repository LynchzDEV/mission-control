import gen_sidebar as sb

TERM_TEXT = '''<span class="tc">~/Desktop/kingpinggroup/mission-control</span> main
<span class="tp">❯</span> claude
╭────────────────────────────────────────────────╮
│ ✻ Welcome to Claude Code                       │
│   cwd: ~/Desktop/kingpinggroup/mission-control │
╰────────────────────────────────────────────────╯

<span class="tp">&gt;</span> fix the chat scroll after send

<span class="tk">⏺</span> Read(client/chat.ts)
  ⎿  Read 347 lines
<span class="tk">⏺</span> Update(client/chat.ts)
  ⎿  Updated with 8 additions and 2 removals
<span class="tk">⏺</span> Bash(bun test test/chat-view.test.ts)
  ⎿  12 pass · 0 fail

<span class="tp">&gt;</span> <span class="cur">▍</span>'''

NAME = 'mission-control · Claude'
DIR = '~/Desktop/kingpinggroup/mission-control'
FIND_ICON = '<svg><use href="#search-icon"/></svg>'


def logo():
    return '<span class="th-logo"><img src="providers/claude.svg" alt=""></span>'


def heading(variant):
    if variant == 'now':
        return f'''<header class="live-heading"><div><h1>{NAME}</h1><p class="muted">{DIR}</p></div><div class="live-actions"><button class="pill find-open" type="button">{FIND_ICON}Find <kbd>⌘F</kbd></button><span id="live-status">Connected · live Claude Code</span></div></header>'''
    if variant == 'a':
        return f'''<header class="th-head">{logo()}<div class="th-title"><h1>{NAME}</h1><p class="muted">{DIR}</p></div>
<span class="th-status"><i></i>Live</span><button class="th-icon" title="Find · ⌘F">{FIND_ICON}</button></header>'''
    if variant == 'b':
        return f'''<header class="th-head">{logo()}<div class="th-title"><h1>{NAME} <i class="th-dot" title="Connected · live"></i></h1><p class="muted">{DIR}</p></div>
<label class="th-find">{FIND_ICON}<input placeholder="Find in terminal"><kbd>⌘F</kbd></label></header>'''
    return ''


def body(variant):
    float_bar = ''
    if variant == 'c':
        float_bar = f'<div class="th-float">{logo()}<span class="th-name" title="{DIR}">{NAME}</span><span class="th-status"><i></i>Live</span><span class="th-sep"></span><button class="th-icon" title="Find · ⌘F">{FIND_ICON}</button></div>'
    return f'<div class="live-main th-main">{heading(variant)}<div class="term-host th-term">{float_bar}<pre>{TERM_TEXT}</pre></div></div>'


def page(variant, title, foot):
    side = f'<aside class="sb">{sb.HEAD}<nav class="sb-list">{sb.groups().replace("sb-row sel", "sb-row").replace(chr(34) + "sb-row" + chr(34) + " data-kind=" + chr(34) + "term" + chr(34) + "><span class=" + chr(34) + "sb-ic" + chr(34) + ">" + sb.TERM + "</span><span class=" + chr(34) + "sb-t" + chr(34) + ">mission-control", chr(34) + "sb-row sel" + chr(34) + " data-kind=" + chr(34) + "term" + chr(34) + "><span class=" + chr(34) + "sb-ic" + chr(34) + ">" + sb.TERM + "</span><span class=" + chr(34) + "sb-t" + chr(34) + ">mission-control", 1)}</nav>{sb.FOOT}</aside>'
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Terminal header — {title}</title>
<link rel="stylesheet" href="quiet.css"><link rel="stylesheet" href="mock.css"><link rel="stylesheet" href="sidebar-mock.css"><link rel="stylesheet" href="terminal-mock.css"></head>
<body><div class="sb-shell">{side}<main class="canvas"><div data-toolbar></div>{body(variant)}</main></div>
<p class="mock-foot">{foot}</p><script src="frame.js"></script><script>document.querySelectorAll('.toolbar nav[aria-label=Chats]').forEach(n=>n.style.visibility='hidden')</script></body></html>'''


for v, t, f in [
    ('now', 'NOW', 'NOW · server/views/shell.ts .live-heading · client/terminals.ts setStatus'),
    ('a', 'A', 'A · status pill + flat Find icon, one row — server/views/shell.ts .live-heading'),
    ('b', 'B', 'B · live dot beside the title, Find always visible as a field'),
    ('c', 'C', 'C · no header row; floating mini bar on the terminal corner'),
]:
    open(f'terminal-{v}.html', 'w').write(page(v, t, f))
